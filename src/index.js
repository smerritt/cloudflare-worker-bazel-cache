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


// Returns true if a request is authenticated, false otherwise.
async function authenticated(request, env, ctx) {
	// Currently only checks for bearer token name and value. This won't
	// scale beyond a team of a couple dozen. Certificate auth would be
	// a better choice for large teams, but I don't currently have one
	// of those.
	if (!request.headers.has(SECRET_ID_HEADER) || !request.headers.has(SECRET_VALUE_HEADER)) {
		return false;
	}

	let id = request.headers.get(SECRET_ID_HEADER);
	let user_value = request.headers.get(SECRET_VALUE_HEADER);

	let secret_object = await env.BUCKET.get("secrets/" + id);
	if (!secret_object) {
		return false;
	}

	// TODO: constant-time string comparison
	let stored_value = await secret_object.text();
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
};
