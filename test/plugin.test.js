import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { ROUTE, start } from "../lib/index.js";
import { startFakeFerry } from "./fake-server.js";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-home-")); // not this computer's ferry settings
delete process.env.FERRY_CHUNK_BYTES;
const TOOLS = [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
let server;
afterEach(() => server?.close());

function plugin(f, options = {}) {
	const events = [];
	const ctx = {
		llm: { registerAdapter: (routes, adapter) => events.push(["register", routes, adapter]) },
		logger: { info: () => {}, warn: (t) => events.push(["warn", t]) },
		get: () => undefined,
		emit: (...a) => events.push(a),
		effect: (fn) => fn(),
	};
	const p = start(ctx, { server: f.url, token: f.state.token, refreshMinutes: 60, ...options });
	return { ...p, events };
}

const user = (text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "test" } });

async function ask(adapter, messages, extra = {}) {
	const chunks = [];
	for await (const c of adapter.stream({ provider: ROUTE, model: "auto", messages, tools: TOOLS, ...extra })) chunks.push(c);
	return chunks;
}

/** The answer's tool call and the next two messages (the call, its result), as DSH appends them. */
function afterToolCall(chunks) {
	const call = chunks.find((c) => c.type === "block-end" && c.block.type === "tool-call").block;
	const finish = chunks.at(-1);
	return [
		createAssistantMessage({ content: [call], source: { provider: ROUTE, model: "auto", replayState: finish.replayState } }),
		createToolResultMessage({ callId: ToolCallId(call.id), content: [{ type: "text", text: "contents of a.txt" }], isError: false }),
	];
}

test("the model list comes from the server and DSH hears when it changes", async () => {
	server = await startFakeFerry();
	const { adapter, refresh, events } = plugin(server);
	assert.deepEqual(events.find((e) => e[0] === "register")[1], [ROUTE]);
	await refresh();
	const models = await adapter.listModels(ROUTE);
	assert.deepEqual(models.map((m) => m.name), ["auto", "kiro/claude-opus-4-5"]);
	const info = await adapter.resolveModel(ROUTE, "auto");
	assert.equal(info.context.contextWindow, 200000);
	assert.equal(info.reasoning, undefined); // the ferry client does not offer thinking levels for this one either

	const updates = () => events.filter((e) => e[0] === "llm/models-updated").length;
	assert.equal(updates(), 1);
	await refresh(); // same list: nothing to tell
	assert.equal(updates(), 1);
	server.state.models.push({ id: "gpt-5", api: "openai", contextWindow: 400000, maxTokens: 64000, provider: "openai", model: "gpt-5" });
	await refresh();
	assert.equal(updates(), 2);
	assert.ok((await adapter.listModels(ROUTE)).some((m) => m.id === "gpt-5"));
});

test("server not up yet: the model list is asked again within seconds, not after five minutes", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const events = [];
	let up = false;
	const realFetch = globalThis.fetch;
	server = await startFakeFerry();
	const ctx = {
		llm: { registerAdapter: () => {} }, logger: { info: () => {}, warn: () => {} }, get: () => undefined,
		emit: (...a) => events.push(a), effect: (fn) => fn(),
	};
	const url = server.url;
	// the "server" answers only once it is up
	globalThis.fetch = (input, init) => (up ? realFetch(input, init) : Promise.reject(new TypeError("fetch failed")));
	try {
		start(ctx, { server: url, token: server.state.token, refreshMinutes: 5 });
		await new Promise((r) => setImmediate(r));
		assert.equal(events.length, 0);
		up = true;
		t.mock.timers.tick(15_000);
		for (let i = 0; i < 20 && !events.length; i++) await new Promise((r) => setImmediate(r));
		assert.deepEqual(events[0], ["llm/models-updated", ROUTE]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("each turn uploads only the new messages; the model gets the whole conversation", async () => {
	server = await startFakeFerry();
	const { adapter, refresh } = plugin(server);
	await refresh();
	server.state.replies.push({ tool: { name: "read", args: { path: "a.txt" } } }, { text: "a.txt says hello" });

	const history = [createSystemMessage("You are a test."), user("read a.txt")];
	const first = await ask(adapter, history);
	assert.equal(first.at(-1).reason.kind, "tool-calls");
	history.push(...afterToolCall(first));
	const second = await ask(adapter, history);
	assert.equal(second.at(-1).reason.kind, "stop");
	assert.ok(second.some((c) => c.type === "text-delta" && c.text.includes("hello")));

	const [c1, c2] = server.state.commits;
	assert.deepEqual([c1.base, c1.appended, c1.withTools], [0, 2, true]);
	assert.deepEqual([c2.base, c2.appended, c2.withTools], [2, 2, false]); // the tool list went up once
	assert.equal(server.state.chats[1].messages.length, 4);
	assert.equal(server.state.chats[1].ferry.purpose, "agent");
	assert.equal(server.state.chats[1].tools[0].function.name, "read");
	const chat = server.state.requests.filter((r) => r.path === "/v1/chat/completions");
	assert.ok(chat.every((r) => r.bytes < 2000), "the model request only names the server's copy");
});

test("when the server lost its copy, the conversation goes up again in full", async () => {
	server = await startFakeFerry({ loseOnce: true });
	const { adapter, refresh } = plugin(server);
	await refresh();
	const chunks = await ask(adapter, [createSystemMessage("s"), user("hi")]);
	assert.equal(chunks.at(-1).reason.kind, "stop");
	assert.deepEqual(server.state.commits.map((c) => c.base), [0, 0]);
	assert.equal(server.state.chats.length, 1);
});

test("a gateway that stops big requests: smaller parts, and the answer still arrives", async () => {
	server = await startFakeFerry({ blockAbove: 20 * 1024 });
	const { adapter, refresh } = plugin(server, { chunkBytes: 64 * 1024 });
	await refresh();
	const big = "x".repeat(50 * 1024);
	const chunks = await ask(adapter, [createSystemMessage("s"), user(big)]);
	assert.equal(chunks.at(-1).reason.kind, "stop");
	assert.ok(server.state.requests.some((r) => r.status === 403));
	assert.ok(server.state.requests.filter((r) => r.status === 200).every((r) => r.bytes <= 20 * 1024));
	assert.ok(JSON.stringify(server.state.chats[0].messages).includes(big));
});

test("the default part size passes a gateway that stops bodies above 100 KB without a single 403", async () => {
	server = await startFakeFerry({ blockAbove: 100 * 1024 });
	const { adapter, refresh } = plugin(server, { chunkBytes: undefined });
	await refresh();
	const big = "y".repeat(300 * 1024);
	const chunks = await ask(adapter, [createSystemMessage("s"), user(big)]);
	assert.equal(chunks.at(-1).reason.kind, "stop");
	assert.deepEqual(server.state.requests.filter((r) => r.status !== 200), []);
	assert.ok(server.state.requests.filter((r) => r.path.startsWith("/v1/ferry/upload/")).length >= 4);
});

test("context summaries are marked for the server's summary model", async () => {
	server = await startFakeFerry();
	const { adapter, refresh } = plugin(server);
	await refresh();
	await ask(adapter, [createSystemMessage("s"), user("summarise")], { purpose: "compaction" });
	assert.equal(server.state.chats[0].ferry.purpose, "summary");
});

test("a wrong token is reported, not retried", async () => {
	server = await startFakeFerry();
	const { adapter, refresh } = plugin(server);
	await refresh();
	server.state.token = "another-token-0123456789";
	const chunks = await ask(adapter, [createSystemMessage("s"), user("hi")]);
	const end = chunks.at(-1);
	assert.equal(end.reason.kind, "error");
	assert.match(JSON.stringify(end), /token rejected/);
});
