import { foo, default as worker } from "./index";
import { Miniflare } from "miniflare";


describe("Bazel cache", () => {
	let env = undefined;

	beforeEach(() => {
		env = getMiniflareBindings();
	});

	test("foo", () => {
		console.log(env);
		console.log(worker);
		expect(foo()).toBe("bar");
	});
});
