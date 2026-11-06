// A stand-in for api.deepseek.com/chat/completions: records every request and answers from a script in DeepSeek's
// streaming format (reasoning_content deltas, tool calls, usage with prompt_cache_hit_tokens).
import { createServer } from "node:http";

export async function startFakeDeepSeek() {
	const state = { requests: [], replies: [], key: "sk-test-deepseek-key" };
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		state.requests.push({ path: req.url, auth: req.headers.authorization, body });
		if (req.headers.authorization !== `Bearer ${state.key}`) {
			res.writeHead(401, { "content-type": "application/json" });
			return res.end(JSON.stringify({ error: { message: "Authentication Fails" } }));
		}
		const reply = state.replies.shift() ?? { text: "ok" };
		if (reply.status) {
			res.writeHead(reply.status, { "content-type": "application/json" });
			return res.end(JSON.stringify({ error: { message: reply.message } }));
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "ds-1", object: "chat.completion.chunk",
			model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
		send({ role: "assistant", content: "" });
		if (reply.reasoning) for (const piece of reply.reasoning.match(/.{1,8}/g)) send({ reasoning_content: piece });
		if (reply.tool) {
			send({ tool_calls: [{ index: 0, id: "call_ds_1", type: "function",
				function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] });
			send({}, "tool_calls");
		} else {
			send({ content: reply.text });
			send({}, "stop");
		}
		const hit = reply.cacheHit ?? 0;
		res.write(`data: ${JSON.stringify({ id: "ds-1", object: "chat.completion.chunk", choices: [], usage: {
			prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050,
			prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: 1000 - hit } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) };
}
