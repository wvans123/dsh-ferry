// Against a real Ferry server running ferry's selftest/fake_llm.py in "basic" mode (turn 1 asks to read
// "Project Titan/notes.txt", turn 2 echoes the file back), through a local stand-in for the company gateway that
// stops request bodies above 100 KB with a 403 page. Checks the upload probe, then two turns with a 300 KB message
// at the default part size. Usage:
//   FERRY_SERVER=http://127.0.0.1:8799 FERRY_TOKEN=... node scripts/e2e-real-server.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { ROUTE, start } from "../lib/index.js";
import { probeLimit } from "../lib/probe.js";

const LIMIT = 100 * 1024;
const upstream = process.env.FERRY_SERVER.replace(/\/+$/, "");
const token = process.env.FERRY_TOKEN;
const seen = [];
const gateway = createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = Buffer.concat(chunks);
	seen.push({ path: req.url.split("?")[0], bytes: body.length, blocked: body.length > LIMIT });
	if (body.length > LIMIT) {
		res.writeHead(403, { "content-type": "text/html", server: "fake-gateway" });
		return res.end("<html>Request blocked by the company gateway</html>");
	}
	const { host: _h, "content-length": _l, connection: _c, ...headers } = req.headers;
	const up = await fetch(`${upstream}${req.url}`, { method: req.method, headers, body: req.method === "GET" ? undefined : body });
	res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k))));
	if (up.body) for await (const c of up.body) res.write(c);
	res.end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const server = `http://127.0.0.1:${gateway.address().port}`;

// 1. the probe finds the gateway's limit
const probe = await probeLimit({ server, token }, { say: (l) => console.log(`probe: ${l}`) });
console.log("probe result:", probe);
assert.ok(probe.limitKb >= 96 && probe.limitKb <= 100, `limit found: ${probe.limitKb} KB`);
assert.equal(probe.chunkBytes, 80 * 1024);
seen.length = 0;

// 2. two turns at the default part size, nothing stopped
const ctx = {
	llm: { registerAdapter: () => ({}) },
	logger: { info: (t) => console.log(t), warn: (t) => console.log(t) },
	get: () => undefined,
	emit: () => {},
	effect: (fn) => fn(),
};
const { adapter, refresh } = start(ctx, { server, token });
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

const padding = "Background notes. ".repeat(17000); // ~300 KB
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

const posts = seen.filter((r) => r.path !== "/v1/ferry/models");
console.log("through the gateway:", posts.map((r) => `${r.path.replace(/\/v1\/ferry\/upload\/[^/]+/, "/upload")} ${Math.round(r.bytes / 1024)}KB`).join(", "));
assert.deepEqual(posts.filter((r) => r.blocked), [], "nothing stopped by the gateway");
assert.ok(Math.max(...posts.map((r) => r.bytes)) <= 80 * 1024);
gateway.closeAllConnections();
gateway.close();
console.log("OK");
