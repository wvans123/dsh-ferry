import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { ROUTE, start } from "../lib/index.js";
import { toPiModel } from "../lib/models.js";
import { mapSearch } from "../lib/web.js";
import { createApp, restoreCacheMarks } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { startFakeDeepSeek } from "./fake-deepseek.js";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-home-"));
const TOKEN = "dsh-ferry-test-token-0123456789";
const closers = [];
afterEach(async () => {
	while (closers.length) await closers.pop()();
});
const listen = async (server) => {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
	return `http://127.0.0.1:${server.address().port}`;
};
const user = (text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "test" } });

function plugin(url) {
	const ctx = { llm: { registerAdapter: () => ({}) }, logger: { info: () => {}, warn: () => {} }, get: () => undefined,
		emit: () => {}, effect: (fn) => fn() };
	return start(ctx, { server: url, token: TOKEN, refreshMinutes: 60 });
}
async function ask(adapter, model, messages, extra = {}) {
	const chunks = [];
	for await (const c of adapter.stream({ provider: ROUTE, model, messages, ...extra })) chunks.push(c);
	return chunks;
}
function serverWith(raw, env) {
	const dir = mkdtempSync(join(tmpdir(), "dsh-ferry-cfg-"));
	const file = join(dir, "dsh-ferry-server.json");
	writeFileSync(file, JSON.stringify({ users: [{ name: "a", token: TOKEN }], dataDir: false, ...raw }));
	return listen(createApp(loadConfig({ file, env }), { log: () => {} }).server);
}

test("DeepSeek thinks by default: DSH is told the default level, and an explicit off still turns it off", async () => {
	const ds = await startFakeDeepSeek();
	closers.push(ds.close);
	const cfg = loadConfig({ raw: { providers: { deepseek: { api: "openai", baseUrl: ds.url } } },
		env: { DSH_FERRY_DATA: "", DEEPSEEK_API_KEY: ds.state.key, DSH_FERRY_TOKEN: TOKEN } }); // Chat Completions: the fake speaks that
	const url = await listen(createApp(cfg, { log: () => {} }).server);
	const { adapter, refresh } = plugin(url);
	await refresh();
	for (const id of ["auto", "deepseek-flash", "deepseek-v4-pro"]) {
		assert.equal((await adapter.resolveModel(ROUTE, id)).reasoning.defaultEffort, "high", id);
	}
	const call = await adapter.prepareCall(ROUTE, "deepseek-flash");
	assert.equal(call.model.reasoning.defaultEffort, "high");
	// what DSH's call preparation does with it: an omitted effort becomes the default
	await ask(adapter, "deepseek-flash", [createSystemMessage("s"), user("hi")], { reasoningEffort: call.model.reasoning.defaultEffort });
	assert.deepEqual([ds.state.requests[0].body.thinking, ds.state.requests[0].body.reasoning_effort], [{ type: "enabled" }, "high"]);
	await ask(adapter, "deepseek-flash", [createSystemMessage("s"), user("hi")], { reasoningEffort: "off" });
	assert.deepEqual(ds.state.requests[1].body.thinking, { type: "disabled" });
});

test("a busy DeepSeek (503, 429) is asked again before DSH sees anything; a bad request is not", async () => {
	const ds = await startFakeDeepSeek();
	closers.push(ds.close);
	const cfg = loadConfig({ raw: { providers: { deepseek: { api: "openai", baseUrl: ds.url } } },
		env: { DSH_FERRY_DATA: "", DEEPSEEK_API_KEY: ds.state.key, DSH_FERRY_TOKEN: TOKEN } }); // Chat Completions: the fake speaks that
	const url = await listen(createApp(cfg, { log: () => {} }).server);
	const { adapter, refresh } = plugin(url);
	await refresh();
	ds.state.replies.push({ status: 503, message: "Server busy" }, { text: "fine now" });
	const ok = await ask(adapter, "deepseek-flash", [createSystemMessage("s"), user("hi")]);
	assert.equal(ok.at(-1).reason.kind, "stop");
	assert.equal(ds.state.requests.length, 2);
	ds.state.replies.push({ status: 400, message: "Invalid request" });
	const bad = await ask(adapter, "deepseek-flash", [createSystemMessage("s"), user("hi")]);
	assert.equal(bad.at(-1).reason.kind, "error");
	assert.equal(ds.state.requests.length, 3);
});

test("a model from pi-ai's catalog: its size, pictures, thinking levels and protocol come from there", () => {
	const m = toPiModel({ id: "kimi", name: "Kimi", api: "openai", catalog: "moonshotai/kimi-k2.6", price: {} }, ROUTE);
	assert.equal(m.upstreamProvider, "moonshotai");
	assert.equal(m.reasoning, true);
	assert.equal(m.compat.thinkingFormat, "deepseek");
	assert.deepEqual(m.input, ["text", "image"]);
	assert.equal(m.contextWindow, 262144);
	assert.ok(m.cost.input > 0);
	const plain = toPiModel({ id: "x", api: "openai", catalog: "nobody/nothing" }, ROUTE);
	assert.equal(plain.upstreamProvider, undefined);
	assert.equal(plain.contextWindow, 128000);
});

test("Claude (or any Anthropic Messages API): system prompt and cache marks put back, the provider's key, streamed back", async () => {
	const seen = [];
	const anthropic = await listen(createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		seen.push({ path: req.url, key: req.headers["x-api-key"], version: req.headers["anthropic-version"], body: JSON.parse(Buffer.concat(chunks).toString()) });
		res.writeHead(200, { "content-type": "text/event-stream" });
		const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [],
			stop_reason: null, usage: { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } } });
		ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello from Claude" } });
		ev("content_block_stop", { index: 0 });
		ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
		ev("message_stop", {});
		res.end();
	}));
	const url = await serverWith({
		providers: { anthropic: { baseUrl: anthropic, apiKeyEnv: "ANTHROPIC_API_KEY" } },
		models: [{ id: "claude", provider: "anthropic", model: "claude-haiku-4-5", catalog: "anthropic/claude-haiku-4-5", name: "Claude Haiku" }],
	}, { ANTHROPIC_API_KEY: "sk-ant-test" });
	const { adapter, refresh } = plugin(url);
	await refresh();
	const info = await adapter.resolveModel(ROUTE, "claude");
	assert.ok(info.context.contextWindow >= 200000);
	const out = await ask(adapter, "claude", [createSystemMessage("You are Claude in a test."), user("hi")]);
	assert.equal(out.at(-1).reason.kind, "stop", JSON.stringify(out.at(-1)));
	assert.equal(out.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "Hello from Claude");
	assert.equal(out.find((c) => c.type === "usage").usage.cacheReadTokens, 800);
	const got = seen[0];
	assert.deepEqual([got.path, got.key, got.version, got.body.model], ["/v1/messages", "sk-ant-test", "2023-06-01", "claude-haiku-4-5"]);
	assert.match(JSON.stringify(got.body.system), /You are Claude in a test/);
	assert.ok(!got.body.messages.some((m) => m.role === "__system__"));
	assert.match(JSON.stringify(got.body.messages.at(-1)), /cache_control/, "the moving cache mark is back on the last message");
});

test("cache marks go back where the plugin took them out", () => {
	const msgs = [{ role: "__system__", content: [{ type: "text", text: "s" }] }, { role: "user", content: "hello" },
		{ role: "user", content: [{ type: "text", text: "a" }, { type: "image", source: {} }] }];
	restoreCacheMarks(msgs, [[1, 0, { type: "ephemeral" }], [2, 1, { type: "ephemeral" }], [9, 0, {}]]);
	assert.deepEqual(msgs[1].content, [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
	assert.deepEqual(msgs[2].content[1].cache_control, { type: "ephemeral" });
});

test("search results: DeepSeek's in-page position (#1#49#1) is taken off the address", () => {
	const { sources } = mapSearch({ results: [{ url: "https://www.etsi.org/x.pdf#1#13#1", title: "t", snippet: "s", date: null },
		{ url: "https://example.com/page#section", title: "", snippet: "", date: null }] });
	assert.deepEqual(sources.map((s) => s.url), ["https://www.etsi.org/x.pdf", "https://example.com/page#section"]);
});

test("fallback: a model that stays busy, cannot be reached or has no key hands the request to its fallback", async () => {
	const ds = await startFakeDeepSeek();
	closers.push(ds.close);
	const other = await startFakeDeepSeek();
	closers.push(other.close);
	other.state.key = "sk-other";
	const raw = { providers: { deepseek: { api: "openai", baseUrl: ds.url }, other: { baseUrl: other.url, apiKeyEnv: "OTHER_KEY" } },
		models: [{ id: "deepseek-flash", fallback: "spare" }, { id: "spare", provider: "other", model: "spare-1" }] };
	const lines = [];
	const url = await listen(createApp(loadConfig({ raw, env: { DSH_FERRY_DATA: "", DEEPSEEK_API_KEY: ds.state.key, DSH_FERRY_TOKEN: TOKEN, OTHER_KEY: "sk-other" } }),
		{ log: (l) => lines.push(l) }).server);
	const { adapter, refresh } = plugin(url);
	await refresh();
	// busy three times: the retries run out, the fallback answers
	ds.state.replies.push({ status: 503, message: "busy" }, { status: 503, message: "busy" }, { status: 503, message: "busy" });
	other.state.replies.push({ text: "spare here" });
	const out = await ask(adapter, "deepseek-flash", [createSystemMessage("s"), user("hi")]);
	assert.equal(out.at(-1).reason.kind, "stop");
	assert.equal(other.state.requests.at(-1).body.model, "spare-1");
	assert.equal(lines.at(-1).fallback, "spare");
	assert.equal(lines.at(-1).model, "spare");
	// a bad request is the model's answer, not a reason to switch
	ds.state.replies.push({ status: 400, message: "Invalid request" });
	const bad = await ask(adapter, "deepseek-flash", [createSystemMessage("s"), user("hi")]);
	assert.equal(bad.at(-1).reason.kind, "error");
	assert.equal(other.state.requests.length, 1);
	// no key for the first: straight to the fallback
	const noKey = await listen(createApp(loadConfig({ raw, env: { DSH_FERRY_DATA: "", DSH_FERRY_TOKEN: TOKEN, OTHER_KEY: "sk-other" } }), { log: () => {} }).server);
	const second = plugin(noKey);
	await second.refresh();
	other.state.replies.push({ text: "spare again" });
	assert.equal((await ask(second.adapter, "deepseek-flash", [createSystemMessage("s"), user("hi")])).at(-1).reason.kind, "stop");
	assert.equal(other.state.requests.length, 2);
	// the config checks the fallback
	assert.throws(() => loadConfig({ raw: { models: [{ id: "deepseek-flash", fallback: "nope" }] }, env: { DSH_FERRY_TOKEN: TOKEN } }), /fallback "nope"/);
});

test("daily budget: one Bark message when today's cost passes it; the model list carries the server's version", async () => {
	const ds = await startFakeDeepSeek();
	closers.push(ds.close);
	const pushes = [];
	const bark = await listen(createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		pushes.push(JSON.parse(Buffer.concat(chunks).toString()));
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	}));
	const lines = [];
	const cfg = loadConfig({ raw: { providers: { deepseek: { api: "openai", baseUrl: ds.url } }, dailyBudget: 0.0001 },
		env: { DSH_FERRY_DATA: "", DEEPSEEK_API_KEY: ds.state.key, DSH_FERRY_TOKEN: TOKEN, BARK_URL: `${bark}/k` } });
	const url = await listen(createApp(cfg, { log: (l) => lines.push(l), version: "7.7.7" }).server);
	const list = await (await fetch(`${url}/v1/ferry/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
	assert.equal(list.version, "7.7.7");
	const { adapter, refresh } = plugin(url);
	await refresh();
	for (let i = 0; i < 3; i++) await ask(adapter, "deepseek-flash", [createSystemMessage("s"), user("hi")]);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(pushes.length, 1, JSON.stringify(pushes));
	assert.match(pushes[0].title, /预算/);
	assert.equal(lines.filter((l) => /daily budget/.test(l.warn ?? "")).length, 1);
});
