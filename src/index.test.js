import { readFileSync } from "fs";
import { default as worker } from "./index";
import { Readable } from "stream";


// Converts a ReadableStream to a Blob. This slurps the whole thing
// into memory, so this shouldn't be done in production code.
async function streamToBlob(rstream) {
	let chunks = [];
	for await (const chunk of rstream) {
		chunks.push(chunk);
	}
	return new Blob(chunks)
}


describe("Bazel cache", () => {
	let env = undefined;
	const ctx = new ExecutionContext();
	const secret_id = "squirrel";
	const secret_value = "many buried nuts";

	const authedHeaders = new Headers({
		"Bazel-Cache-Secret-Id": secret_id,
		"Bazel-Cache-Secret-Value": secret_value,
	});

	beforeAll(async() => {
		env = getMiniflareBindings();

		env.__D1_BETA__DB.exec(readFileSync("schema.sql").toString());
	});

	beforeEach(async () => {
		await env.BUCKET.put("secrets/" + secret_id, secret_value);

		worker.flushCaches();
	});

	test("it requires authentication for PUT /ac", async () => {
		let req = new Request("https://localhost/ac/foo", {
			method: "PUT",
		});
		let resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(401);
	});

	test("it requires authentication for PUT /cas", async () => {
		let req = new Request("https://localhost/cas/foo", {
			method: "PUT",
		});
		let resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(401);
	});

	test("it requires authentication for GET /ac", async () => {
		let req = new Request("https://localhost/ac/foo", {
			method: "GET",
		});
		let resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(401);
	});

	test("it requires authentication for GET /cas", async () => {
		let req = new Request("https://localhost/cas/foo", {
			method: "GET",
		});
		let resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(401);
	});

	test("it requires authentication for GET /cas repeatedly", async () => {
		let req = new Request("https://localhost/cas/foo", {
			method: "GET",
		});
		let resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(401);
		resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(401);
	});

	test("it has a default handler that 404s", async () => {
		let req = new Request("https://localhost/blah/blah/fishcakes");
		let resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(404);
	});

	test("it stores uploaded files in R2", async () => {
		const bodyContents = new Blob(["fee fi fo fum"]);

		let req = new Request("https://localhost/cas/abc123def456", {
			method: "PUT",
			headers: authedHeaders,
			body: bodyContents.stream(),
			duplex: "half",
		});
		let resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(201);

		let r2_obj = await env.BUCKET.get("cas/abc123def456");
		let r2_obj_contents = await streamToBlob(await r2_obj.body);
		expect(r2_obj_contents).toStrictEqual(bodyContents);
	});

	test("it retrieves files from R2", async () => {
		const fileContents = new Blob([
			"lorem ipsum et cetera blah blah Carthago delenda est"
		]);
		let result = await env.BUCKET.put("ac/an-action", fileContents.stream());
		expect(result).not.toBe(null);

		let req = new Request("https://localhost/ac/an-action", {
			headers: authedHeaders,
		});
		let resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(200);
	});

	test("it adds files to the database on upload", async () => {
		const bodyContents = new Blob(["great balls of fire"]);
		const testStartTimeUnixSeconds = Math.floor(Date.now() / 1000);

		let req = new Request("https://localhost/cas/111", {
			method: "PUT",
			headers: authedHeaders,
			body: bodyContents.stream(),
			duplex: "half",
		});
		let resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(201);

		const db = env.__D1_BETA__DB;
		const { results } = await db.prepare("SELECT last_used FROM CacheEntries WHERE key = ?1")
					.bind("cas/111")
					.all();

		expect(results.length).toBe(1);
		expect(results[0].last_used).toBeGreaterThanOrEqual(testStartTimeUnixSeconds);
	});

	test("it updates the last-used time on a PUT that overwrites a file", async () => {
		const objKey = "cas/wallace_and_gromit";
		const bodyContents = new Blob(["gouda cheddar edam stilton halloumi gruyere brie wensleydale"]);
		const testStartTimeUnixSeconds = Math.floor(Date.now() / 1000);
		const db = env.__D1_BETA__DB;

		// Ensure the object already exists (in the DB, at least) prior to the PUT.
		await db.prepare('INSERT INTO CacheEntries (key, last_used) VALUES (?1, ?2)')
				.bind(objKey, 100)  // long, long ago
				.run();

		let req = new Request("https://localhost/" + objKey, {
			method: "PUT",
			headers: authedHeaders,
			body: bodyContents.stream(),
			duplex: "half",
		});
		let resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(201);

		const { results } = await db.prepare("SELECT last_used FROM CacheEntries WHERE key = ?1")
					.bind(objKey)
					.all();

		expect(results.length).toBe(1);
		expect(results[0].last_used).toBeGreaterThanOrEqual(testStartTimeUnixSeconds);
	});

	test("it updates the timestamp on GET", async() => {
		// Ensure the object already exists in the DB and in R2.
		const objKey = "ac/lunch";
		const bodyContents = new Blob(["super carne asada burrito with pinto beans"]);
		const testStartTimeUnixSeconds = Math.floor(Date.now() / 1000);
		const db = env.__D1_BETA__DB;

		await db.prepare('INSERT INTO CacheEntries (key, last_used) VALUES (?1, ?2)')
			.bind(objKey, 100)  // long, long ago
			.run();
		await env.BUCKET.put(objKey, bodyContents.stream());
		
		const req = new Request("https://localhost/" + objKey, {
			method: "GET",
			headers: authedHeaders,
		});
		const resp = await worker.fetch(req, env, ctx);
		expect(resp.status).toBe(200);
		await getMiniflareWaitUntil(ctx);

		const { results } = await db.prepare("SELECT last_used FROM CacheEntries WHERE key = ?1")
					.bind(objKey)
					.all();
		expect(results.length).toBe(1);
		expect(results[0].last_used).toBeGreaterThanOrEqual(testStartTimeUnixSeconds);
	});


});
