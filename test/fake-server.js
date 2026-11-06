// A small Ferry server for the tests: the sync protocol (hash chain, parts, 409), the model list and an
// OpenAI-style streaming chat that answers from a script.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export const MODELS = [
	{ id: "auto", api: "openai", contextWindow: 200000, maxTokens: 8192, vision: true, provider: "ferry", model: "deepseek-chat" },
	{ id: "claude-opus-4-5", api: "anthropic", contextWindow: 200000, maxTokens: 32000, vision: true, provider: "kiro", model: "claude-opus-4-5" },
];

/** opts: blockAbove (bytes; bigger bodies get a gateway's 403 page), loseOnce (the first chat answers 409),
 * noProbe (an old server without /v1/ferry/probe). */
export async function startFakeFerry(opts = {}) {
	const state = {
		token: "test-token-0123456789",
		models: structuredClone(MODELS),
		sessions: new Map(), // conv -> [message json strings]
		tools: new Map(), // sha -> tools json
		parts: new Map(), // upload id -> [Buffer]
		commits: [], // { base, appended, bytes }
		chats: [], // { model, messages, ferry }
		requests: [], // { path, bytes, status }
		replies: [], // script: { text } or { tool: { name, args } }
		loseOnce: !!opts.loseOnce,
	};
	const chain = (msgs) => msgs.reduce((h, m) => sha(h + m), "");
	const json = (res, status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks);
		const url = new URL(req.url, "http://x");
		const log = { path: url.pathname, bytes: body.length, status: 200 };
		state.requests.push(log);
		if (opts.blockAbove && body.length > opts.blockAbove) {
			log.status = 403;
			res.writeHead(403, { "content-type": "text/html" });
			return res.end("<html>blocked by the gateway</html>");
		}
		const auth = req.headers.authorization ?? `Bearer ${req.headers["x-api-key"] ?? ""}`;
		if (auth !== `Bearer ${state.token}`) return json(res, (log.status = 401), { error: { message: "bad token" } });

		if (url.pathname === "/v1/ferry/probe") {
			if (opts.noProbe) return json(res, (log.status = 404), { detail: "Not Found" });
			return json(res, 200, { bytes: body.length });
		}

		if (req.method === "GET" && url.pathname === "/v1/ferry/models") return json(res, 200, { models: state.models, sessionStore: "memory" });

		const part = url.pathname.match(/^\/v1\/ferry\/upload\/([^/]+)\/(\d+)$/);
		if (part) {
			const list = state.parts.get(part[1]) ?? [];
			list[Number(part[2])] = body;
			state.parts.set(part[1], list);
			return json(res, 200, { ok: true });
		}

		if (url.pathname === "/v1/ferry/commit") {
			const conv = url.searchParams.get("conv");
			const base = Number(url.searchParams.get("base"));
			let raw = body;
			if (url.searchParams.get("upload")) {
				const list = state.parts.get(url.searchParams.get("upload")) ?? [];
				raw = Buffer.concat(list.slice(0, Number(url.searchParams.get("parts"))));
			}
			const have = state.sessions.get(conv) ?? [];
			if (base > have.length || chain(have.slice(0, base)) !== url.searchParams.get("base_hash")) {
				return json(res, (log.status = 409), { error: "base mismatch" });
			}
			const blob = JSON.parse(raw.toString("utf8"));
			if (blob.tools) state.tools.set(sha(blob.tools), blob.tools);
			const msgs = [...have.slice(0, base), ...blob.append];
			state.sessions.set(conv, msgs);
			state.commits.push({ base, appended: blob.append.length, bytes: raw.length, withTools: !!blob.tools });
			return json(res, 200, { count: msgs.length, hash: chain(msgs) });
		}

		if (url.pathname === "/v1/chat/completions") {
			const payload = JSON.parse(body.toString("utf8"));
			const ref = payload.ferry;
			if (state.loseOnce) {
				state.loseOnce = false;
				state.sessions.clear();
			}
			const msgs = state.sessions.get(ref?.conv);
			if (!ref || !msgs || msgs.length !== ref.count || chain(msgs) !== ref.hash) {
				return json(res, (log.status = 409), { error: { message: "session not found; the client will resend" } });
			}
			state.chats.push({ model: payload.model, messages: msgs.map((m) => JSON.parse(m)), ferry: ref,
				tools: ref.tools_hash ? JSON.parse(state.tools.get(ref.tools_hash) ?? "null") : null });
			const reply = state.replies.shift() ?? { text: "ok" };
			res.writeHead(200, { "content-type": "text/event-stream" });
			const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk",
				model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			send({ role: "assistant", content: "" });
			if (reply.tool) {
				send({ tool_calls: [{ index: 0, id: "call_1", type: "function",
					function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] });
				send({}, "tool_calls");
			} else {
				send({ content: reply.text });
				send({}, "stop");
			}
			res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
			res.write("data: [DONE]\n\n");
			return res.end();
		}
		json(res, (log.status = 404), { error: "not found" });
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${server.address().port}`;
	return { url, state, close: () => new Promise((r) => server.close(r)) };
}
