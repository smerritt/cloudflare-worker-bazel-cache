/**
   This is a Bazel cache written as a Cloudflare worker. See README.md
   for instructions.
 */

import { Router } from 'itty-router';

const TOKEN_ID_HEADER = 'Bazel-Cache-Token-Id';
const TOKEN_VALUE_HEADER = 'Bazel-Cache-Token-Value';

// Cache positive results for 10 minutes, but negative results for
// only 5 seconds. This way, if someone is trying to sort out their
// authentication, they don't need to wait very long for things to
// expire before trying again.
const POSITIVE_TTL = 10 * 60 * 1000;
const NEGATIVE_TTL = 5 * 1000;

// After this much time without being accessed, an object is
// considered stale.
const STALENESS_THRESHOLD = 86400 * 14; // Two weeks in seconds

// How many stale objects to delete at a time.
const STALE_OBJECT_BATCH_SIZE = 100;

// Caches tokens in memory. This saves us from asking R2 for the same
// token over and over.
class TokenCache {
  constructor () {
    this.tokens = {};
  }

  // Gets a token. If the stored token is expired or missing, calls
  // fetchFn to generate the value.
  async retrieve (tokenId, fetchFn) {
    const now = new Date();
    if (tokenId in this.tokens &&
        this.tokens[tokenId].expiration < now) {
      return this.tokens[tokenId].value;
    }

    const value = await fetchFn();
    const ttl = value ? POSITIVE_TTL : NEGATIVE_TTL;
    this.tokens[tokenId] = {
      expiration: now + ttl,
      value
    };
    return value;
  }

  // Clears out the cache. This should only be used in testing.
  flush () {
    this.tokens = {};
  }
}

// This is global so it persists for the lifetime of the worker.
const tokenCache = new TokenCache();

// Helper function to fetch the contents of a small object from an R2
// bucket. Returns the contents or null if the object was not found.
async function fetchFromR2 (key, bucket) {
  const obj = await bucket.get(key);
  return obj ? await obj.text() : null;
}

// Returns true if a request is authenticated, false otherwise.
async function authenticated (request, env, ctx) {
  // Currently only checks for bearer token name and value. This won't
  // scale beyond a team of a couple dozen. Certificate auth would be
  // a better choice for large teams, but I don't currently have one
  // of those.
  if (!request.headers.has(TOKEN_ID_HEADER) || !request.headers.has(TOKEN_VALUE_HEADER)) {
    return false;
  }

  const id = request.headers.get(TOKEN_ID_HEADER);
  const key = 'tokens/' + id;
  const storedValue = await tokenCache.retrieve(key, async () => {
    return await fetchFromR2(key, env.BUCKET);
  });
  if (storedValue === null) {
    return false;
  }

  const userValue = request.headers.get(TOKEN_VALUE_HEADER);
  // TODO: constant-time string comparison
  return userValue === storedValue;
}

// Converts a request path (e.g. "/ac/something") into its
// corresponding R2 object name (e.g. "ac/something").
//
// The argument is the string form of a URL, for example
// that given by request.url
function urlToObjectName (u) {
  return new URL(u).pathname.slice(1); // drop leading slash
}

async function handlePut (request, env, ctx) {
  if (!await authenticated(request, env, ctx)) {
    return new Response('Not authenticated', { status: 401 });
  }

  // Before accepting the upload, we make sure there's an entry in the
  // database for it. It's important that the database contain a
  // superset of the objects actually in the bucket so that we never
  // lose track of objects.
  const objKey = urlToObjectName(request.url);

  // Database time is seconds, not milliseconds. SQLite uses a
  // variable-length integer encoding where smaller numbers take up
  // less space, and we don't need sub-second precision here.
  //
  // We could probably get away with dekaseconds or even hectoseconds,
  // but seconds should be fine for now.
  const nowInEpochSeconds = Math.floor(Date.now() / 1000);
  await env.__D1_BETA__DB.prepare(
    'INSERT INTO CacheEntries (key, last_used) VALUES (?1, ?2) ' +
      'ON CONFLICT(key) DO UPDATE SET last_used=excluded.last_used')
    .bind(objKey, nowInEpochSeconds)
    .run();

  const bucket = env.BUCKET;
  const putSucceeded = await bucket.put(objKey, request.body);
  if (!putSucceeded) {
    return new Response('Upload failed', { status: 500 });
  }
  return new Response(':thumbs-up:', { status: 201 }); // 201 Created
}

async function handleGet (request, env, ctx) {
  if (!await authenticated(request, env, ctx)) {
    return new Response('Not authenticated', { status: 401 });
  }

  const objKey = urlToObjectName(request.url);

  // See handlePut for rationale behind using seconds.
  const nowInEpochSeconds = Math.floor(Date.now() / 1000);

  // There's no need to wait for this to complete before serving the
  // file. In the worst case, the last-used update fails and the object
  // expires prematurely.
  //
  // Recall that object lifetimes are days or weeks; if the object is
  // popular, then a subsequent GET will probably succeed in updating
  // its last-used time. If it's unpopular, then it might expire
  // early, but hardly anyone will care. Also, this is a cache; if an
  // object goes missing, Bazel will rebuild and replace it.
  ctx.waitUntil(
    env.__D1_BETA__DB.prepare('UPDATE CacheEntries SET last_used=?1 WHERE key=?2')
      .bind(nowInEpochSeconds, objKey)
      .run());

  const bucket = env.BUCKET;
  const obj = await bucket.get(urlToObjectName(request.url));
  if (!obj) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(obj.body);
}

// App routing
const router = Router();
router.put('/ac/*', async (request, env, ctx) => {
  return handlePut(request, env, ctx);
});
router.put('/cas/*', async (request, env, ctx) => {
  return handlePut(request, env, ctx);
});

router.get('/ac/*', async (request, env, ctx) => {
  return handleGet(request, env, ctx);
});
router.get('/cas/*', async (request, env, ctx) => {
  return handleGet(request, env, ctx);
});

router.all('*', () => { return new Response('Not found', { status: 404 }); });

// Generates keys for stale objects needing deletion.
//
// Yields batches of size STALE_OBJECT_BATCH_SIZE.
async function * getStaleObjectsFromDB (dbHandle) {
  let marker = ''; // Largest value from last set of results
  const staleTime = Math.floor(Date.now() / 1000 - STALENESS_THRESHOLD);

  while (true) {
    const results = await dbHandle.prepare('SELECT key FROM CacheEntries WHERE key > ?1 AND last_used <= ?2 LIMIT ?3')
      .bind(marker, staleTime, STALE_OBJECT_BATCH_SIZE)
      .all();

    const rows = results.results;
    if (rows.length === 0) {
      return;
    }

    const keys = [];
    for (const row of rows) {
      keys.push(row.key);
    }
    marker = keys[keys.length - 1];
    yield keys;
  }
}

// Deletes the rows for the given keys.
async function deleteKeysFromDB (dbHandle, keys) {
  const placeholders = keys.map(() => '?').join(',');
  const sql = ('DELETE FROM CacheEntries WHERE key IN (' +
               placeholders + ')');
  await dbHandle.prepare(sql).bind(...keys).run();
}

export default {
  // Handles HTTP requests.
  async fetch (request, env, ctx) {
    return await router.handle(request, env, ctx);
  },

  // Handles scheduled invocations from cron triggers.
  async scheduled (request, env, ctx) {
    for await (const keys of getStaleObjectsFromDB(env.__D1_BETA__DB)) {
      // handlePut creates the DB entry before the object to ensure
      // that the DB is a superset of the bucket. We delete from R2
      // before the DB for the same reason.
      env.BUCKET.delete(keys);

      await deleteKeysFromDB(env.__D1_BETA__DB, keys);
    }
  },

  // These are exported only to help in writing tests.
  flushCaches () {
    tokenCache.flush();
  },

  STALE_OBJECT_BATCH_SIZE,
  STALENESS_THRESHOLD
};
