/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npx wrangler dev src/index.js` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npx wrangler publish src/index.js --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Router } from "itty-router";

const SECRET_ID_HEADER = "Bazel-Cache-Secret-Id";
const SECRET_VALUE_HEADER = "Bazel-Cache-Secret-Value";

// Cache positive results for 10 minutes, but negative results for
// only 5 seconds. This way, if someone is trying to sort out their
// authentication, they don't need to wait very long for things to
// expire before trying again.
const POSITIVE_TTL = 10 * 60 * 1000;
const NEGATIVE_TTL = 5 * 1000;
	

// Caches secrets in memory. This saves us from asking R2 for the same
// secret over and over.
class SecretCache {
	constructor() {
		this.secrets = {}
	}

	// Gets a secret. If the stored secret is expired or missing, calls
	// fetch_fn to generate the value.
	async retrieve(secret_id, fetch_fn) {
		const now = new Date();
		if (secret_id in this.secrets &&
				this.secrets[secret_id].expiration < now) {
			return this.secrets[secret_id].value;
		}

		const value = await fetch_fn();
		const ttl = value ? POSITIVE_TTL : NEGATIVE_TTL;
		this.secrets[secret_id] = {
			expiration: now + ttl,
			value: value,
		};
		return value;
	}

	// Clears out the cache. This should only be used in testing.
	flush() {
		this.secrets = {}
	}
}

// This is global so it persists for the lifetime of the worker.
let secretCache = new SecretCache();

// Helper function to fetch the contents of a small object from an R2
// bucket. Returns the contents or null if the object was not found.
async function fetchFromR2(key, bucket) {
	let obj = await bucket.get(key);
	return obj ? await obj.text() : null;
}

// Returns true if a request is authenticated, false otherwise.
async function authenticated(request, env, ctx) {
	// Currently only checks for bearer token name and value. This won't
	// scale beyond a team of a couple dozen. Certificate auth would be
	// a better choice for large teams, but I don't currently have one
	// of those.
	if (!request.headers.has(SECRET_ID_HEADER) || !request.headers.has(SECRET_VALUE_HEADER)) {
		return false;
	}

	const id = request.headers.get(SECRET_ID_HEADER);
	const key = "secrets/" + id;
	const stored_value = await secretCache.retrieve(key, async () => {
		return await fetchFromR2(key, env.BUCKET);
	});
	if (stored_value === null) {
		return false;
	}

	const user_value = request.headers.get(SECRET_VALUE_HEADER);
	// TODO: constant-time string comparison
	return user_value == stored_value;
};

// Converts a request path (e.g. "/ac/something") into its
// corresponding R2 object name (e.g. "ac/something").
//
// The argument is the string form of a URL, for example
// "request.url".
function urlToObjectName(u) {
	return new URL(u).pathname.slice(1);  // drop leading slash
}


async function handlePut(request, env, ctx) {
	if (!await authenticated(request, env, ctx)) {
		return new Response("Not authenticated", {status: 401})
	}

	let bucket = env.BUCKET;
	let put_succeeded = await bucket.put(urlToObjectName(request.url), request.body)
	if (!put_succeeded) {
		return new Response("Upload failed", {status: 500});
	}
	return new Response(":thumbs-up:", {status: 201});  // 201 Created
}

async function handleGet(request, env, ctx) {
	if (!await authenticated(request, env, ctx)) {
		return new Response("Not authenticated", {status: 401})
	}

	let bucket = env.BUCKET;
	let obj = await bucket.get(urlToObjectName(request.url));
	if (!obj) {
		return new Response("Not found", {status: 404});
	}
	return new Response(obj.body);
}


// App routing
const router = Router();
router.put('/ac/*', async (request, env, ctx) => {
	return handlePut(request, env, ctx)
});
router.put('/cas/*', async (request, env, ctx) => {
	return handlePut(request, env, ctx)
});

router.get('/ac/*', async (request, env, ctx) => {
	return handleGet(request, env, ctx)
});
router.get('/cas/*', async (request, env, ctx) => {
	return handleGet(request, env, ctx)
});

router.all("*", () => { return new Response("Not found", {status: 404}) });

export default {
	async fetch(request, env, ctx) {
		return await router.handle(request, env, ctx);
	},

	flushCaches() {
		secretCache.flush();
	},
};
