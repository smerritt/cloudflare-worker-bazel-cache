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
	const secret_id = "squirrel";
	const secret_value = "many buried nuts";

	const authedHeaders = new Headers({
		"Bazel-Cache-Secret-Id": secret_id,
		"Bazel-Cache-Secret-Value": secret_value,
	});

	beforeEach(async () => {
		env = getMiniflareBindings();
		await env.BUCKET.put("secrets/" + secret_id, secret_value);

		worker.flushCaches();
	});

	test("it requires authentication for PUT /ac", async () => {
		let req = new Request("https://localhost/ac/foo", {
			method: "PUT",
		});
		let resp = await worker.fetch(req, env);
		expect(resp.status).toBe(401);
	});

	test("it requires authentication for PUT /cas", async () => {
		let req = new Request("https://localhost/cas/foo", {
			method: "PUT",
		});
		let resp = await worker.fetch(req, env);
		expect(resp.status).toBe(401);
	});

	test("it requires authentication for GET /ac", async () => {
		let req = new Request("https://localhost/ac/foo", {
			method: "GET",
		});
		let resp = await worker.fetch(req, env);
		expect(resp.status).toBe(401);
	});

	test("it requires authentication for GET /cas", async () => {
		let req = new Request("https://localhost/cas/foo", {
			method: "GET",
		});
		let resp = await worker.fetch(req, env);
		expect(resp.status).toBe(401);
	});

	test("it requires authentication for GET /cas repeatedly", async () => {
		let req = new Request("https://localhost/cas/foo", {
			method: "GET",
		});
		let resp = await worker.fetch(req, env);
		expect(resp.status).toBe(401);
		resp = await worker.fetch(req, env);
		expect(resp.status).toBe(401);
	});

	test("it has a default handler that 404s", async () => {
		let req = new Request("https://localhost/blah/blah/fishcakes");
		let resp = await worker.fetch(req, env);
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
		let resp = await worker.fetch(req, env);
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
		let resp = await worker.fetch(req, env);
		expect(resp.status).toBe(200);
	});
});
