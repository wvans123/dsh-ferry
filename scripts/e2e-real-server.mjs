// Two turns against a real Ferry server running ferry's selftest/fake_llm.py in "basic" mode (turn 1 asks to read
// "Project Titan/notes.txt", turn 2 echoes the file back). Usage:
//   FERRY_SERVER=http://127.0.0.1:8799 FERRY_TOKEN=... node scripts/e2e-real-server.mjs
import assert from "node:assert/strict";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { ROUTE, start } from "../lib/index.js";

const ctx = {
	llm: { registerAdapter: () => ({}) },
	logger: { info: (t) => console.log(t), warn: (t) => console.log(t) },
	get: () => undefined,
	emit: () => {},
	effect: (fn) => fn(),
};
const { adapter, refresh } = start(ctx, { chunkBytes: 16 * 1024 });
await refresh();
const models = await adapter.listModels(ROUTE);
console.log("models:", models.map((m) => m.name).join(", "));
assert.ok(models.length > 0, "the server lists models");

const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
async function ask(messages) {
	const chunks = [];
	for await (const c of adapter.stream({ provider: ROUTE, model: models[0].id, messages, tools })) chunks.push(c);
	return chunks;
}

const padding = "Background notes. ".repeat(3000); // ~54 KB: goes up in 16 KB parts
const history = [createSystemMessage("You are a test agent."),
	createUserMessage({ content: [{ type: "text", text: `${padding}\nRead Project Titan/notes.txt and tell me what it says.` }], source: { kind: "test" } })];
const first = await ask(history);
const call = first.find((c) => c.type === "block-end" && c.block.type === "tool-call")?.block;
assert.ok(call, `turn 1 asks for a tool: ${JSON.stringify(first.at(-1))}`);
console.log("turn 1:", call.name, call.arguments);

history.push(
	createAssistantMessage({ content: [call], source: { provider: ROUTE, model: models[0].id, replayState: first.at(-1).replayState } }),
	createToolResultMessage({ callId: ToolCallId(call.id), content: [{ type: "text", text: "Ticket EMP-12345: ship the Titan report." }], isError: false }),
);
const second = await ask(history);
const text = second.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
console.log("turn 2:", text.slice(0, 200));
assert.equal(second.at(-1).reason.kind, "stop");
assert.match(text, /EMP-12345/);
console.log("OK");
