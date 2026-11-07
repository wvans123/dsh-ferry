import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { ROUTE, start } from "../lib/index.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { startFakeDeepSeek } from "./fake-deepseek.js";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-home-"));
delete process.env.FERRY_CHUNK_BYTES;
const TOKEN = "dsh-ferry-test-token-0123456789";
const TOOLS = [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const closers = [];
afterEach(async () => {
	while (closers.length) await closers.pop()();
});

/** Our server in front of a fake DeepSeek; opts.gateway: bytes above which a stand-in gateway answers 403. */
async function setup(opts = {}) {
	const ds = await startFakeDeepSeek();
	closers.push(ds.close);
	const cfg = loadConfig({ raw: { providers: { deepseek: { api: "openai", baseUrl: ds.url } } },
		env: { DSH_FERRY_DATA: "", DEEPSEEK_API_KEY: ds.state.key, DSH_FERRY_TOKEN: TOKEN } }); // Chat Completions: the fake speaks that
	Object.assign(cfg, opts.cfg ?? {});
	const lines = [];
	const { server, store } = createApp(cfg, { log: (l) => lines.push(l) });
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => server.close(r)));
	let url = `http://127.0.0.1:${server.address().port}`;
	const seen = [];
	if (opts.gateway) {
		const target = url;
		const gw = createServer(async (req, res) => {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const body = Buffer.concat(chunks);
			seen.push({ path: req.url, bytes: body.length });
			if (body.length > opts.gateway) {
				res.writeHead(403, { "content-type": "text/html" });
				return res.end("<html>blocked</html>");
			}
			const { host: _h, "content-length": _l, connection: _c, ...headers } = req.headers;
			const up = await fetch(`${target}${req.url}`, { method: req.method, headers, body: req.method === "GET" ? undefined : body });
			res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
			if (up.body) for await (const c of up.body) res.write(c);
			res.end();
		});
		await new Promise((r) => gw.listen(0, "127.0.0.1", r));
		closers.push(() => new Promise((r) => { gw.closeAllConnections(); gw.close(r); }));
		url = `http://127.0.0.1:${gw.address().port}`;
	}
	return { ds, url, lines, store, seen };
}

const api = (url, path, init = {}) => fetch(`${url}${path}`, { ...init,
	headers: { authorization: `Bearer ${TOKEN}`, "x-ferry-protocol": "1", ...(init.headers ?? {}) } });

function plugin(url, options = {}) {
	const events = [];
	const ctx = { llm: { registerAdapter: () => ({}) }, logger: { info: () => {}, warn: (t) => events.push(t) },
		get: () => undefined, emit: (...a) => events.push(a), effect: (fn) => fn() };
	return { ...start(ctx, { server: url, token: TOKEN, refreshMinutes: 60, ...options }), events };
}

const user = (text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "test" } });
async function ask(adapter, messages, extra = {}) {
	const chunks = [];
	for await (const c of adapter.stream({ provider: ROUTE, model: "auto", messages, tools: TOOLS, ...extra })) chunks.push(c);
	return chunks;
}

test("health needs no token; everything else does, and the protocol version is checked", async () => {
	const { url } = await setup();
	assert.equal((await (await fetch(`${url}/health`)).json()).server, "dsh-ferry");
	assert.equal((await fetch(`${url}/v1/ferry/models`)).status, 401);
	assert.equal((await fetch(`${url}/v1/ferry/models`, { headers: { authorization: "Bearer wrong-token-0123456789" } })).status, 401);
	assert.equal((await api(url, "/v1/ferry/models", { headers: { "x-ferry-protocol": "2" } })).status, 426);
	assert.equal((await api(url, "/v1/ferry/probe", { method: "POST", body: "x".repeat(5000) }).then((r) => r.json())).bytes, 5000);
});

test("the model list: auto plus DeepSeek's models with their thinking levels, and what the server supports", async () => {
	const { url } = await setup();
	const body = await (await api(url, "/v1/ferry/models")).json();
	assert.deepEqual(body.features, ["gzip", "reasoning", "inline", "head", "tools"]);
	assert.deepEqual(body.models.map((m) => m.id), ["auto", "deepseek-flash", "deepseek-v4-pro"]);
	const flash = body.models[1];
	assert.equal(flash.reasoning, true);
	assert.equal(flash.compat.thinkingFormat, "deepseek");
	assert.equal(flash.thinkingLevelMap.max, "max");
	assert.equal(body.models[0].model, "deepseek-flash");
});

test("commit keeps the hash chain: a wrong base is 409, a gzip upload in parts is put back together", async () => {
	const { url, store } = await setup();
	const msgs = [JSON.stringify({ role: "system", content: "s" }), JSON.stringify({ role: "user", content: "hi".repeat(30000) })];
	const blob = gzipSync(Buffer.from(JSON.stringify({ append: msgs, tools: null })));
	const half = Math.ceil(blob.length / 2);
	for (const [i, part] of [blob.subarray(0, half), blob.subarray(half)].entries()) {
		assert.equal((await api(url, `/v1/ferry/upload/u1/${i}`, { method: "POST", body: part })).status, 200);
	}
	const ack = await (await api(url, "/v1/ferry/commit?conv=c1&base=0&base_hash=&upload=u1&parts=2&encoding=gzip", { method: "POST" })).json();
	assert.equal(ack.count, 2);
	assert.equal(ack.hash, sha(sha(msgs[0]) + msgs[1]));
	const wrong = await api(url, "/v1/ferry/commit?conv=c1&base=2&base_hash=nope", { method: "POST",
		body: JSON.stringify({ append: [] }) });
	assert.equal(wrong.status, 409);
	assert.equal(store.sessions.size, 1);
});

test("DSH asks DeepSeek to think; the thinking comes back to DSH and goes back to DeepSeek on the next turn", async () => {
	const { url, ds } = await setup();
	const { adapter, refresh } = plugin(url);
	await refresh();
	const info = await adapter.resolveModel(ROUTE, "deepseek-flash");
	assert.deepEqual(info.reasoning.efforts.map((e) => e.id), ["off", "low", "high", "max"]);

	ds.state.replies.push({ reasoning: "I should read the file first.", tool: { name: "read", args: { path: "a.txt" } }, cacheHit: 0 },
		{ reasoning: "The file says hello.", text: "a.txt says hello", cacheHit: 900 });
	const history = [createSystemMessage("You are a test."), user("read a.txt")];
	const first = await ask(adapter, history, { reasoningEffort: "high" });
	const sent1 = ds.state.requests[0].body;
	assert.deepEqual(sent1.thinking, { type: "enabled" });
	assert.equal(sent1.reasoning_effort, "high");
	assert.equal(sent1.model, "deepseek-flash");
	assert.equal(first.filter((c) => c.type === "reasoning-delta").map((c) => c.text).join(""), "I should read the file first.");

	const blocks = first.filter((c) => c.type === "block-end").map((c) => c.block);
	const call = blocks.find((b) => b.type === "tool-call");
	history.push(
		createAssistantMessage({ content: blocks, source: { provider: ROUTE, model: "auto", replayState: first.at(-1).replayState } }),
		createToolResultMessage({ callId: ToolCallId(call.id), content: [{ type: "text", text: "hello" }], isError: false }),
	);
	const second = await ask(adapter, history, { reasoningEffort: "high" });
	const replayed = ds.state.requests[1].body.messages.find((m) => m.role === "assistant");
	assert.equal(replayed.reasoning_content, "I should read the file first.");
	assert.equal(replayed.tool_calls[0].function.name, "read");
	const usage = second.find((c) => c.type === "usage").usage;
	assert.equal(usage.cacheReadTokens, 900);
	assert.equal(second.at(-1).reason.kind, "stop");
});

test("no level chosen: thinking is switched off", async () => {
	const { url, ds } = await setup();
	const { adapter, refresh } = plugin(url);
	await refresh();
	await ask(adapter, [createSystemMessage("s"), user("hi")]);
	assert.deepEqual(ds.state.requests[0].body.thinking, { type: "disabled" });
	assert.equal(ds.state.requests[0].body.reasoning_effort, undefined);
});

test("compressed uploads: a 300 KB conversation passes a 100 KB gateway in one request", async () => {
	const { url, seen, ds } = await setup({ gateway: 100 * 1024 });
	const { adapter, refresh } = plugin(url);
	await refresh();
	const notes = Array.from({ length: 7000 }, (_, i) => `Note ${i}: the Titan report is due on day ${i % 30}.`).join("\n");
	assert.ok(notes.length > 300 * 1024, `${notes.length}`);
	const chunks = await ask(adapter, [createSystemMessage("s"), user(notes)]);
	assert.equal(chunks.at(-1).reason.kind, "stop");
	const posts = seen.filter((r) => r.path.startsWith("/v1/ferry/"));
	assert.ok(posts.every((r) => r.bytes <= 100 * 1024), JSON.stringify(posts));
	assert.ok(!posts.some((r) => r.path.startsWith("/v1/ferry/upload/")), "no parts needed");
	assert.ok(posts.some((r) => r.path.includes("encoding=gzip")));
	assert.equal(ds.state.requests[0].body.messages[1].content, notes);
});

test("compress: false sends plain text in parts", async () => {
	const { url, seen } = await setup({ gateway: 100 * 1024 });
	const { adapter, refresh } = plugin(url, { compress: false });
	await refresh();
	await ask(adapter, [createSystemMessage("s"), user("z".repeat(200 * 1024))]);
	assert.ok(seen.some((r) => r.path.startsWith("/v1/ferry/upload/")));
	assert.ok(!seen.some((r) => r.path.includes("encoding=gzip")));
});

test("summaries go to the summary model; DeepSeek's errors reach DSH as they are", async () => {
	const { url, ds } = await setup({ cfg: { summaryModel: "deepseek-v4-pro" } });
	const { adapter, refresh } = plugin(url);
	await refresh();
	await ask(adapter, [createSystemMessage("s"), user("summarise")], { purpose: "compaction" });
	assert.equal(ds.state.requests[0].body.model, "deepseek-v4-pro");
	ds.state.replies.push({ status: 400, message: "This model's maximum context length is 1000000 tokens" });
	const failed = await ask(adapter, [createSystemMessage("s"), user("too long")]);
	assert.equal(failed.at(-1).reason.kind, "error");
	assert.match(JSON.stringify(failed.at(-1)), /CONTEXT_WINDOW_EXCEEDED|maximum context length/);
});

test("another OpenAI-compatible provider from the config file: its address, key and model name", async () => {
	const other = await startFakeDeepSeek();
	closers.push(other.close);
	other.state.key = "sk-other-provider";
	const dir = mkdtempSync(join(tmpdir(), "dsh-ferry-cfg-"));
	const file = join(dir, "dsh-ferry-server.json");
	(await import("node:fs")).writeFileSync(file, JSON.stringify({
		users: [{ name: "a", token: TOKEN }],
		providers: { other: { baseUrl: `${other.url}/v1`, apiKeyEnv: "OTHER_KEY" } },
		models: [{ id: "big", provider: "other", model: "big-model-1", contextWindow: 200000, maxTokens: 16000, name: "Big One" }],
	}));
	const cfg = loadConfig({ file, env: { DSH_FERRY_DATA: "", OTHER_KEY: "sk-other-provider" } });
	assert.equal(cfg.searchProvider, null);
	const { server } = createApp(cfg, { log: () => {} });
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => server.close(r)));
	const url = `http://127.0.0.1:${server.address().port}`;
	const { adapter, refresh } = plugin(url);
	await refresh();
	assert.deepEqual((await adapter.listModels(ROUTE)).map((m) => m.name), ["auto (Big One)", "Big One"]);
	const out = await ask(adapter, [createSystemMessage("s"), user("hi")], { model: "big" });
	assert.equal(out.at(-1).reason.kind, "stop");
	assert.deepEqual([other.state.requests[0].path, other.state.requests[0].auth, other.state.requests[0].body.model],
		["/v1/chat/completions", "Bearer sk-other-provider", "big-model-1"]);
	assert.ok(!(await (await api(url, "/v1/ferry/models")).json()).features.includes("tools"));
});

test("DeepSeek turning the server's key down reaches DSH as an error", async () => {
	const { url, ds } = await setup();
	const { adapter, refresh } = plugin(url);
	await refresh();
	ds.state.key = "another-key";
	const res = await ask(adapter, [createSystemMessage("s"), user("hi")]);
	assert.match(JSON.stringify(res.at(-1)), /Authentication Fails|401/);
});

test("a server without a DeepSeek key says so instead of calling out", async () => {
	let called = 0;
	const { server } = createApp(loadConfig({ env: { DSH_FERRY_DATA: "", DSH_FERRY_TOKEN: TOKEN } }), { log: () => {}, fetch: async () => { called++; } });
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => server.close(r)));
	const url = `http://127.0.0.1:${server.address().port}`;
	assert.ok((await api(url, "/v1/ferry/models").then((r) => r.json())).models.every((m) => m.ready === false));
	const { adapter, refresh } = plugin(url);
	await refresh();
	const out = await ask(adapter, [createSystemMessage("s"), user("hi")]);
	assert.match(JSON.stringify(out.at(-1)), /no API key for provider .*deepseek.*DEEPSEEK_API_KEY/);
	assert.equal(called, 0);
});

test("a small turn rides inside the model request: no commit of its own; the server's copy survives a restart", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-ferry-data-"));
	const { url, ds, lines, store } = await setup({ cfg: { storeDir: join(dir, "store"), usageFile: join(dir, "usage.jsonl") } });
	store.dir = join(dir, "store"); // setup made the store before the cfg change; the server would have read it from cfg
	const { adapter, refresh } = plugin(url);
	await refresh();
	ds.state.replies.push({ tool: { name: "read", args: { path: "a.txt" } }, cacheHit: 0 }, { text: "done", cacheHit: 900 });
	const history = [createSystemMessage("s"), user("read a.txt")];
	const first = await ask(adapter, history);
	const call = first.filter((c) => c.type === "block-end").map((c) => c.block).find((b) => b.type === "tool-call");
	history.push(createAssistantMessage({ content: [call] }), createToolResultMessage({ toolCallId: call.id, content: [{ type: "text", text: "hello" }] }));
	// as if the server had been restarted: memory empty, files still there
	store.sessions.clear();
	store.tools.clear();
	const second = await ask(adapter, history);
	assert.equal(second.at(-1).reason.kind, "stop");
	const paths = lines.map((l) => l.path);
	assert.ok(!paths.includes("/v1/ferry/commit"), JSON.stringify(paths));
	const chats = lines.filter((l) => l.path === "/v1/chat/completions");
	const total = ds.state.requests[1].body.messages.length; // system, user, assistant (call), tool result, as pi-ai lays them out
	assert.ok(total >= 4, String(total));
	assert.deepEqual(chats.map((c) => [c.status, c.inline, c.messages]), [[200, 2, 2], [200, total - 2, total]]);
	assert.deepEqual(chats[1].usage, { input: 100, cache_read: 900, cache_write: 0, output: 50 });
	assert.ok(chats[1].cost > 0 && chats[1].cost < chats[0].cost, JSON.stringify(chats.map((c) => c.cost)));
	const written = (await import("node:fs")).readFileSync(join(dir, "usage.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(written.map((w) => w.usage.cache_read), [0, 900]);
	assert.equal(written[0].model, "deepseek-flash");
});

test("with memory only, a lost conversation makes the plugin send it in full once, and the turn still succeeds", async () => {
	const { url, ds, lines, store } = await setup();
	const { adapter, refresh } = plugin(url);
	await refresh();
	const history = [createSystemMessage("s"), user("hi")];
	await ask(adapter, history);
	store.sessions.clear();
	history.push(createAssistantMessage({ content: [{ type: "text", text: "hello" }] }), user("again"));
	const out = await ask(adapter, history);
	assert.equal(out.at(-1).reason.kind, "stop");
	const chats = lines.filter((l) => l.path === "/v1/chat/completions").map((c) => c.status);
	assert.deepEqual(chats, [200, 409, 200]);
	assert.equal(ds.state.requests[1].body.messages.length, 4);
});

test("a plugin that starts fresh on an old conversation asks the server what it holds and sends only the rest", async () => {
	const { url, ds, lines } = await setup();
	const one = plugin(url);
	await one.refresh();
	ds.state.replies.push({ tool: { name: "read", args: { path: "a.txt" } } }, { text: "done" });
	const history = [createSystemMessage("s"), user("read a.txt")];
	const first = await ask(one.adapter, history);
	const call = first.filter((c) => c.type === "block-end").map((c) => c.block).find((b) => b.type === "tool-call");
	history.push(createAssistantMessage({ content: [call] }), createToolResultMessage({ toolCallId: call.id, content: [{ type: "text", text: "x".repeat(60_000) }] }));
	await ask(one.adapter, history);
	assert.ok(!lines.some((l) => l.path === "/v1/ferry/head")); // small so far, or already known: no question asked
	const held = ds.state.requests[1].body.messages.length;
	// DSH restarted (or a resumed session): a new plugin instance that knows nothing, the server still holds the conversation
	history.push(createAssistantMessage({ content: [{ type: "text", text: "done" }] }), user("and b.txt?"));
	const two = plugin(url);
	await two.refresh();
	const out = await ask(two.adapter, history);
	assert.equal(out.at(-1).reason.kind, "stop");
	const after = lines.slice(lines.findIndex((l) => l.path === "/v1/ferry/head"));
	assert.deepEqual(after.map((l) => [l.path, l.status]), [["/v1/ferry/head", 200], ["/v1/chat/completions", 200]]);
	const chat = after[1];
	assert.deepEqual([chat.inline, chat.messages], [2, held + 2], JSON.stringify(chat)); // only the two new messages went up
	assert.equal(typeof chat.ttft, "number");
	// a conversation the server never saw: the question is answered 404 and the whole thing goes up, no error
	const three = plugin(url);
	await three.refresh();
	const fresh = await ask(three.adapter, [createSystemMessage("other"), user("a"), createAssistantMessage({ content: [{ type: "text", text: "b".repeat(60_000) }] }), user("c")]);
	assert.equal(fresh.at(-1).reason.kind, "stop");
	assert.deepEqual(lines.slice(-3).map((l) => [l.path, l.status]), [["/v1/ferry/head", 404], ["/v1/ferry/commit", 200], ["/v1/chat/completions", 200]]);
});

test("a request before the model list has arrived (a resumed session) waits for it instead of failing", async () => {
	const { url } = await setup();
	const { adapter } = plugin(url); // no refresh() here: the plugin's own first fetch is still on its way
	const out = await ask(adapter, [createSystemMessage("s"), user("hi")]);
	assert.equal(out.at(-1).reason.kind, "stop");
});
