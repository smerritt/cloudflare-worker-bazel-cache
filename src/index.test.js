import { readFileSync } from 'fs';
import worker from './index';

/* global expect, test, Blob, beforeAll, beforeEach,
   getMiniflareWaitUntil, getMiniflareBindings, ExecutionContext, describe */

// Converts a ReadableStream to a Blob. This slurps the whole thing
// into memory, so this shouldn't be done in production code.
async function streamToBlob (rstream) {
  const chunks = [];
  for await (const chunk of rstream) {
    chunks.push(chunk);
  }
  return new Blob(chunks);
}

describe('Bazel cache', () => {
  let env;
  const ctx = new ExecutionContext();
  const tokenId = 'squirrel';
  const tokenValue = 'many buried nuts';

  const authedHeaders = new Headers({
    'Bazel-Cache-Token-Id': tokenId,
    'Bazel-Cache-Token-Value': tokenValue
  });

  beforeAll(async () => {
    env = getMiniflareBindings();

    env.__D1_BETA__DB.exec(readFileSync('schema.sql').toString());
  });

  beforeEach(async () => {
    await env.BUCKET.put('tokens/' + tokenId, tokenValue);

    worker.flushCaches();
  });

  test('it requires authentication for PUT /ac', async () => {
    const req = new Request('https://localhost/ac/foo', {
      method: 'PUT'
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(401);
  });

  test('it requires authentication for PUT /cas', async () => {
    const req = new Request('https://localhost/cas/foo', {
      method: 'PUT'
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(401);
  });

  test('it requires authentication for GET /ac', async () => {
    const req = new Request('https://localhost/ac/foo', {
      method: 'GET'
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(401);
  });

  test('it requires authentication for GET /cas', async () => {
    const req = new Request('https://localhost/cas/foo', {
      method: 'GET'
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(401);
  });

  test('it requires authentication for GET /cas repeatedly', async () => {
    const req = new Request('https://localhost/cas/foo', {
      method: 'GET'
    });
    let resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(401);
    resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(401);
  });

  test('it handles a missing auth token in R2', async () => {
    const badAuthHeaders = new Headers({
      'Bazel-Cache-Token-Id': 'noSuchThing',
      'Bazel-Cache-Token-Value': '151a86101365-abc31cb4ee18'
    });

    const req = new Request('https://localhost/cas/foo', {
      method: 'GET',
      headers: badAuthHeaders
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(401);
  });

  test('it has a default handler that 404s', async () => {
    const req = new Request('https://localhost/blah/blah/fishcakes');
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(404);
  });

  test('it stores uploaded files in R2', async () => {
    const bodyContents = new Blob(['fee fi fo fum']);

    const req = new Request('https://localhost/cas/abc123def456', {
      method: 'PUT',
      headers: authedHeaders,
      body: bodyContents.stream(),
      duplex: 'half'
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(201);

    const r2Obj = await env.BUCKET.get('cas/abc123def456');
    const r2ObjContents = await streamToBlob(await r2Obj.body);
    expect(r2ObjContents).toStrictEqual(bodyContents);
  });

  test('it retrieves files from R2', async () => {
    const fileContents = new Blob([
      'lorem ipsum et cetera blah blah Carthago delenda est'
    ]);
    const result = await env.BUCKET.put('ac/an-action', fileContents.stream());
    expect(result).not.toBe(null);

    const req = new Request('https://localhost/ac/an-action', {
      headers: authedHeaders
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(200);
  });

  test('it adds files to the database on upload', async () => {
    const bodyContents = new Blob(['great balls of fire']);
    const testStartTimeUnixSeconds = Math.floor(Date.now() / 1000);

    const req = new Request('https://localhost/cas/111', {
      method: 'PUT',
      headers: authedHeaders,
      body: bodyContents.stream(),
      duplex: 'half'
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(201);

    const db = env.__D1_BETA__DB;
    const { results } = await db.prepare('SELECT last_used FROM CacheEntries WHERE key = ?1')
      .bind('cas/111')
      .all();

    expect(results.length).toBe(1);
    expect(results[0].last_used).toBeGreaterThanOrEqual(testStartTimeUnixSeconds);
  });

  test('it 404s when the file is not in R2', async () => {
    const req = new Request('https://localhost/ac/nope-not-here', {
      headers: authedHeaders
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(404);
  });

  test('it updates the last-used time on a PUT that overwrites a file', async () => {
    const objKey = 'cas/wallace_and_gromit';
    const bodyContents = new Blob(['gouda cheddar edam stilton halloumi gruyere brie wensleydale']);
    const testStartTimeUnixSeconds = Math.floor(Date.now() / 1000);
    const db = env.__D1_BETA__DB;

    // Ensure the object already exists (in the DB, at least) prior to the PUT.
    await db.prepare('INSERT INTO CacheEntries (key, last_used) VALUES (?1, ?2)')
      .bind(objKey, 100) // long, long ago
      .run();

    const req = new Request('https://localhost/' + objKey, {
      method: 'PUT',
      headers: authedHeaders,
      body: bodyContents.stream(),
      duplex: 'half'
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(201);

    const { results } = await db.prepare('SELECT last_used FROM CacheEntries WHERE key = ?1')
      .bind(objKey)
      .all();

    expect(results.length).toBe(1);
    expect(results[0].last_used).toBeGreaterThanOrEqual(testStartTimeUnixSeconds);
  });

  test('it updates the timestamp on GET', async () => {
    // Ensure the object already exists in the DB and in R2.
    const objKey = 'ac/lunch';
    const bodyContents = new Blob(['super carne asada burrito with pinto beans']);
    const testStartTimeUnixSeconds = Math.floor(Date.now() / 1000);
    const db = env.__D1_BETA__DB;

    await db.prepare('INSERT INTO CacheEntries (key, last_used) VALUES (?1, ?2)')
      .bind(objKey, 100) // long, long ago
      .run();
    await env.BUCKET.put(objKey, bodyContents.stream());

    const req = new Request('https://localhost/' + objKey, {
      method: 'GET',
      headers: authedHeaders
    });
    const resp = await worker.fetch(req, env, ctx);
    expect(resp.status).toBe(200);
    await getMiniflareWaitUntil(ctx);

    const { results } = await db.prepare('SELECT last_used FROM CacheEntries WHERE key = ?1')
      .bind(objKey)
      .all();
    expect(results.length).toBe(1);
    expect(results[0].last_used).toBeGreaterThanOrEqual(testStartTimeUnixSeconds);
  });

  describe('scheduled callback', () => {
    const freshRowCount = Math.floor(2.5 * worker.STALE_OBJECT_BATCH_SIZE);
    const expiredTimeUnixSeconds = (Math.floor(Date.now() / 1000)) - worker.STALENESS_THRESHOLD - 1;

    beforeEach(async () => {
      const testStartTimeUnixSeconds = Math.floor(Date.now() / 1000);
      const stmt = env.__D1_BETA__DB.prepare('INSERT INTO CacheEntries (key, last_used) VALUES (?1, ?2)');
      for (let i = 0; i < freshRowCount; i++) {
        // We put in one expired and one unexpired object.
        await stmt.bind('ac/' + i + '_stale', expiredTimeUnixSeconds - i)
          .run();
        await env.BUCKET.put('ac/' + i + '_stale', new Blob(['stale ' + i]).stream());

        await stmt.bind('ac/' + i + '_fresh', testStartTimeUnixSeconds - i)
          .run();
        await env.BUCKET.put('ac/' + i + '_fresh', new Blob(['fresh ' + i]).stream());
      }
    });

    test('it removes the expired rows from the DB', async () => {
      await worker.scheduled('not sure what goes here', env, ctx);

      let results = await env.__D1_BETA__DB.prepare(
        'SELECT COUNT(*) AS c FROM CacheEntries WHERE last_used < ?1')
        .bind(expiredTimeUnixSeconds)
        .all();
      expect(results.results[0].c).toBe(0);

      results = await env.__D1_BETA__DB.prepare(
        'SELECT COUNT(*) AS c FROM CacheEntries WHERE last_used > ?1')
        .bind(expiredTimeUnixSeconds)
        .all();
      expect(results.results[0].c).toBe(freshRowCount);
    });

    test('it removes the expired objects from R2', async () => {
      await worker.scheduled('not sure what goes here', env, ctx);

      let freshCount = 0;
      let staleCount = 0;
      let bogonCount = 0;

      const listing = await env.BUCKET.list({ prefix: 'ac/' });

      // Sanity check: all the results fit in the first page of
      // listings.
      expect(listing.truncated).toBe(false);

      for (const obj of listing.objects) {
        if (obj.key.includes('stale')) {
          staleCount++;
        } else if (obj.key.includes('fresh')) {
          freshCount++;
        } else {
          bogonCount++;
        }
      }

      // Test sanity: there's nothing unexpected in the bucket
      expect(bogonCount).toEqual(0);
      expect(staleCount).toEqual(0);
      expect(freshCount).toEqual(freshRowCount);
    });
  });
});
