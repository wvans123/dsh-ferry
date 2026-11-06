// A real check against a DSH Ferry server that holds a real DeepSeek key (costs a few cents). Usage:
//   FERRY_SERVER=http://127.0.0.1:8790 FERRY_TOKEN=... node scripts/check-real-deepseek.mjs [model]
// Checks: the model list; a two-turn tool call with thinking on "high" (DeepSeek accepts the thinking sent back);
// a repeat of the same prefix shows cache hits; web search through the server.
import assert from "node:assert/strict";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { ROUTE, start } from "../lib/index.js";

const model = process.argv[2] ?? "deepseek-flash";
const ctx = { llm: { registerAdapter: () => ({}) }, logger: { info: () => {}, warn: (t) => console.log(t) },
	get: () => undefined, emit: () => {}, effect: (fn) => fn() };
const { adapter, refresh, web } = start(ctx, {});
await refresh();
const models = await adapter.listModels(ROUTE);
console.log("models:", models.map((m) => m.id).join(", "));
assert.ok(models.some((m) => m.id === model), `${model} is offered`);
const info = await adapter.resolveModel(ROUTE, model);
console.log("thinking levels:", info.reasoning?.efforts.map((e) => e.id).join(", ") ?? "none");

const tools = [{ name: "read", description: "Read a text file from the workspace and return its contents.",
	parameters: { type: "object", properties: { path: { type: "string", description: "file path" } }, required: ["path"] } }];
// a long, stable system prompt: DeepSeek caches prefixes, so the later calls should report cache hits
const rules = Array.from({ length: 120 }, (_, i) => `Rule ${i + 1}: keep answers short, cite file names exactly, and never invent file contents.`).join("\n");
const system = createSystemMessage(`You are a careful assistant working in a project folder.\n${rules}`);
async function ask(messages, effort) {
	const chunks = [];
	for await (const c of adapter.stream({ provider: ROUTE, model, messages, tools, ...(effort ? { reasoningEffort: effort } : {}) })) chunks.push(c);
	const end = chunks.at(-1);
	assert.notEqual(end.reason.kind, "error", JSON.stringify(end.reason));
	return chunks;
}
const usageOf = (chunks) => chunks.find((c) => c.type === "usage")?.usage ?? {};

const thinkText = (chunks) => chunks.filter((c) => c.type === "reasoning-delta").map((c) => c.text).join("");
// DeepSeek decides how much to think: an easy question with a tool at hand often goes straight to the tool. A question
// that needs working out shows the thinking comes back to DSH.
const puzzle = await ask([system, createUserMessage({ content: [{ type: "text",
	text: "How many prime numbers are there between 1 and 60? Work it out, then give only the number." }], source: { kind: "check" } })], "high");
const puzzleThought = thinkText(puzzle);
console.log(`thinking: ${puzzleThought.length} chars, answer "${puzzle.filter((c) => c.type === "text-delta").map((c) => c.text).join("").trim()}"`);
assert.ok(puzzleThought.length > 0, "DeepSeek thought and the thinking reached DSH");

const history = [system, createUserMessage({ content: [{ type: "text",
	text: "Read notes.txt with the read tool, then think about whether its deadline is realistic and give the ticket number." }], source: { kind: "check" } })];
const first = await ask(history, "high");
const blocks = first.filter((c) => c.type === "block-end").map((c) => c.block);
const call = blocks.find((b) => b.type === "tool-call");
console.log(`turn 1: thought ${thinkText(first).length} chars; tool ${call?.name} ${call?.arguments}; usage ${JSON.stringify(usageOf(first))}`);
assert.ok(call, "DeepSeek asked for the tool");

history.push(
	createAssistantMessage({ content: blocks, source: { provider: ROUTE, model, replayState: first.at(-1).replayState } }),
	createToolResultMessage({ callId: ToolCallId(call.id), content: [{ type: "text", text: "Ticket EMP-12345: ship the Titan report by Friday." }], isError: false }),
);
const second = await ask(history, "high");
const answer = second.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
console.log(`turn 2: thought ${thinkText(second).length} chars; "${answer.slice(0, 160)}"; usage ${JSON.stringify(usageOf(second))}`);
assert.match(answer, /EMP-12345/); // DeepSeek took the replayed assistant turn (its reasoning_content) without complaint

// one more tool round whose first turn did think, so thinking that is not empty goes back to DeepSeek
history.push(
	createAssistantMessage({ content: second.filter((c) => c.type === "block-end").map((c) => c.block),
		source: { provider: ROUTE, model, replayState: second.at(-1).replayState } }),
	createUserMessage({ content: [{ type: "text", text: "Now think step by step: if the report takes 3 days and today is Tuesday, can it ship by Friday? Answer yes or no with one reason." }], source: { kind: "check" } }),
);
const third = await ask(history, "high");
console.log(`turn 3: thought ${thinkText(third).length} chars; "${third.filter((c) => c.type === "text-delta").map((c) => c.text).join("").slice(0, 160)}"`);

const again = await ask(history, "high");
const cached = usageOf(again).cacheReadTokens ?? 0;
console.log(`repeat: cache hits ${cached} tokens; usage ${JSON.stringify(usageOf(again))}`);
assert.ok(cached > 0, "DeepSeek reported cache hits and DSH got them");

const off = await ask([system, createUserMessage({ content: [{ type: "text", text: "Say OK." }], source: { kind: "check" } })]);
assert.equal(off.filter((c) => c.type === "reasoning-delta").length, 0, "no level chosen: no thinking");
console.log("no level: no thinking, as expected");

if (web.search.available()) {
	const found = await web.search.search({ query: "3GPP TS 38.331 NR RRC specification", maxResults: 3 });
	console.log("search:", found.sources.map((s) => s.url).join(" | "));
	assert.ok(found.sources.length > 0, "search found something");
} else console.log("search: the server offers none (no DeepSeek key for tools?)");
console.log("OK");
