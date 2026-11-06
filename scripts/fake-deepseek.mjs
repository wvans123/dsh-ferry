// A fake api.deepseek.com for trying the DSH Ferry server with a real DSH and no API key. It thinks out loud
// (reasoning_content), reads the file named in the task with DSH's read tool, then reports what the file says.
// Every request body goes to the log file, so you can check what DSH sent (thinking settings, replayed thinking).
//   node scripts/fake-deepseek.mjs <log.jsonl> [port]     (key: sk-fake-deepseek)
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [log, port = "9200"] = process.argv.slice(2);
createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), path: req.url, auth: req.headers.authorization === "Bearer sk-fake-deepseek", body })}\n`);
	if (req.url.startsWith("/v1/tools/")) { // DeepSeek's Search and Fetch APIs
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify(req.url.endsWith("/search")
			? { results: [{ url: "https://www.3gpp.org/ftp/Specs/archive/38_series/38.331", title: `Result for ${body.query}`,
				snippet: "TS 38.331 NR RRC protocol specification", summary: "Radio Resource Control (RRC) protocol for NR.", date: "2026-10-01" }] }
			: { content: `# ${body.url}\nPage text.` }));
	}
	const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk",
		model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream" });
	send({ role: "assistant", content: "" });
	const msgs = body.messages ?? [];
	const last = msgs.at(-1);
	const thinking = body.thinking?.type === "enabled";
	const readTool = (body.tools ?? []).find((t) => t.function?.name === "read");
	const searchFor = msgs.filter((m) => m.role === "user").map((m) => /Search the web for (.+?)[."]/.exec(JSON.stringify(m.content ?? ""))?.[1])
		.filter(Boolean).at(-1);
	const hasSearch = (body.tools ?? []).some((t) => t.function?.name === "web_search");
	if (last?.role !== "tool" && searchFor && hasSearch) {
		send({ tool_calls: [{ index: 0, id: `call_${msgs.length}`, type: "function", function: { name: "web_search",
			arguments: JSON.stringify({ queries: [searchFor] }) } }] });
		send({}, "tool_calls");
	} else if (last?.role === "tool") {
		if (thinking) send({ reasoning_content: "The tool returned the file. I will quote it." });
		const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
		send({ content: `FILE SAYS: ${text.slice(0, 300)}` });
		send({}, "stop");
	} else if (readTool) {
		if (thinking) send({ reasoning_content: "I need to read the file before answering." });
		const asked = msgs.filter((m) => m.role === "user").map((m) => /Read (.+?) and/.exec(JSON.stringify(m.content ?? ""))?.[1]);
		const want = asked.filter(Boolean).at(-1) ?? "notes.txt";
		const key = Object.keys(readTool.function.parameters?.properties ?? {})[0] ?? "path";
		send({ tool_calls: [{ index: 0, id: `call_${msgs.length}`, type: "function", function: { name: "read",
			arguments: JSON.stringify({ [key]: want }) } }] });
		send({}, "tool_calls");
	} else {
		send({ content: "Reading a notes file" });
		send({}, "stop");
	}
	const prompt = JSON.stringify(msgs).length >> 2;
	res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: prompt,
		completion_tokens: 20, total_tokens: prompt + 20, prompt_cache_hit_tokens: Math.floor(prompt * 0.8),
		prompt_cache_miss_tokens: prompt - Math.floor(prompt * 0.8) } })}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}).listen(Number(port), "127.0.0.1", () => console.error(`fake DeepSeek on http://127.0.0.1:${port}`));
