// DeepSeek the way DSH's own DeepSeek adapter reaches it: the Anthropic-compatible Messages API (the server's default).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { ROUTE, start } from "../lib/index.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-home-"));
const TOKEN = "dsh-ferry-test-token-0123456789";
const KEY = "sk-deepseek-test";
const TOOLS = [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
const closers = [];
afterEach(async () => {
	while (closers.length) await closers.pop()();
});
const listen = async (server) => {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
	return `http://127.0.0.1:${server.address().port}`;
};

/** DeepSeek's /anthropic/v1/messages: thinks (with a signature), then calls read or answers. */
async function fakeDeepSeekMessages() {
	const requests = [];
	const url = await listen(createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		requests.push({ path: req.url, key: req.headers["x-api-key"], body });
		res.writeHead(200, { "content-type": "text/event-stream" });
		const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		ev("message_start", { message: { id: `m${requests.length}`, type: "message", role: "assistant", model: body.model, content: [],
			stop_reason: null, usage: { input_tokens: 3000, output_tokens: 1, cache_read_input_tokens: requests.length > 1 ? 2800 : 0 } } });
		let i = 0;
		if (body.thinking?.type === "enabled") {
			ev("content_block_start", { index: i, content_block: { type: "thinking", thinking: "" } });
			ev("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: `Thinking turn ${requests.length}.` } });
			ev("content_block_delta", { index: i, delta: { type: "signature_delta", signature: `sig-${requests.length}` } });
			ev("content_block_stop", { index: i++ });
		}
		const answered = body.messages.at(-1)?.content?.some?.((b) => b.type === "tool_result");
		if (!answered) {
			ev("content_block_start", { index: i, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } });
			ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.txt\"}" } });
			ev("content_block_stop", { index: i });
			ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } });
		} else {
			ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
			ev("content_block_delta", { index: i, delta: { type: "text_delta", text: "a.txt says hello" } });
			ev("content_block_stop", { index: i });
			ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } });
		}
		ev("message_stop", {});
		res.end();
	}));
	return { url, requests };
}

async function setup() {
	const ds = await fakeDeepSeekMessages();
	const cfg = loadConfig({ raw: { providers: { deepseek: { baseUrl: ds.url } } }, env: { DEEPSEEK_API_KEY: KEY, DSH_FERRY_TOKEN: TOKEN } });
	cfg.providers.deepseek.dialect = "deepseek"; // the fake's address is not api.deepseek.com
	const url = await listen(createApp(cfg, { log: () => {} }).server);
	const ctx = { llm: { registerAdapter: () => ({}) }, logger: { info: () => {}, warn: () => {} }, get: () => undefined,
		emit: () => {}, effect: (fn) => fn() };
	const plugin = start(ctx, { server: url, token: TOKEN, refreshMinutes: 60 });
	await plugin.refresh();
	return { ds, ...plugin };
}
const user = (text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "test" } });
async function ask(adapter, messages, extra = {}) {
	const chunks = [];
	for await (const c of adapter.stream({ provider: ROUTE, model: "auto", messages, tools: TOOLS, ...extra })) chunks.push(c);
	return chunks;
}

test("by default DeepSeek is asked through its Messages API, like DSH's own DeepSeek adapter", async () => {
	const { adapter } = await setup();
	const info = await adapter.resolveModel(ROUTE, "deepseek-flash");
	assert.equal(info.context.contextWindow, 1_048_576);
	assert.deepEqual(info.reasoning.efforts.map((e) => e.id), ["off", "low", "high", "max"]);
	assert.equal(info.reasoning.defaultEffort, "high");
	assert.equal(info.systemPromptUpdate, "in-history", "a changed system prompt follows the history, as in DSH's adapter");
	const pro = await adapter.resolveModel(ROUTE, "deepseek-v4-pro");
	assert.deepEqual(pro.reasoning.efforts.map((e) => e.id), ["off", "high", "max"]);
});

test("thinking goes out as DeepSeek expects it, and comes back with its signature on the next turn", async () => {
	const { adapter, ds } = await setup();
	const history = [createSystemMessage("You are a test."), user("read a.txt")];
	const first = await ask(adapter, history, { reasoningEffort: "high" });
	const sent = ds.requests[0];
	assert.deepEqual([sent.path, sent.key, sent.body.model], ["/v1/messages", KEY, "deepseek-flash"]);
	assert.deepEqual(sent.body.thinking, { type: "enabled" });
	assert.deepEqual(sent.body.output_config, { effort: "high" });
	assert.match(JSON.stringify(sent.body.system), /You are a test/);
	assert.equal(first.filter((c) => c.type === "reasoning-delta").map((c) => c.text).join(""), "Thinking turn 1.");

	const blocks = first.filter((c) => c.type === "block-end").map((c) => c.block);
	const call = blocks.find((b) => b.type === "tool-call");
	history.push(
		createAssistantMessage({ content: blocks, source: { provider: ROUTE, model: "auto", replayState: first.at(-1).replayState } }),
		createToolResultMessage({ callId: ToolCallId(call.id), content: [{ type: "text", text: "hello" }], isError: false }),
	);
	const second = await ask(adapter, history, { reasoningEffort: "high" });
	assert.equal(second.at(-1).reason.kind, "stop");
	const replayed = ds.requests[1].body.messages.find((m) => m.role === "assistant");
	const thinking = replayed.content.find((b) => b.type === "thinking");
	assert.deepEqual([thinking.thinking, thinking.signature], ["Thinking turn 1.", "sig-1"]);
	assert.equal(second.find((c) => c.type === "usage").usage.cacheReadTokens, 2800);
});

test("off means off: thinking disabled, no effort", async () => {
	const { adapter, ds } = await setup();
	await ask(adapter, [createSystemMessage("s"), user("hi")], { reasoningEffort: "off" });
	assert.deepEqual(ds.requests[0].body.thinking, { type: "disabled" });
	assert.equal(ds.requests[0].body.output_config, undefined);
});

test("api: openai on the deepseek provider switches back to Chat Completions", () => {
	const cfg = loadConfig({ raw: { providers: { deepseek: { api: "openai" } } }, env: { DEEPSEEK_API_KEY: KEY, DSH_FERRY_TOKEN: TOKEN } });
	assert.equal(cfg.providers.deepseek.baseUrl, "https://api.deepseek.com");
	assert.equal(cfg.models.get("deepseek-flash").api, "openai");
	assert.equal(cfg.models.get("deepseek-flash").compat.thinkingFormat, "deepseek");
	const dflt = loadConfig({ env: { DEEPSEEK_API_KEY: KEY, DSH_FERRY_TOKEN: TOKEN } });
	assert.equal(dflt.providers.deepseek.baseUrl, "https://api.deepseek.com/anthropic");
	assert.equal(dflt.providers.deepseek.dialect, "deepseek");
});
