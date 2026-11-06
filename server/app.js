// The DSH Ferry server: takes a conversation from dsh-llm-ferry in small pieces, puts it back together and asks the
// model (DeepSeek by default, or any OpenAI-compatible API). Same wire protocol as the Ferry server, so the plugin
// works with either.
//   GET  /health                                   no token needed
//   GET  /v1/ferry/models                          models this server offers, and what it supports ("features")
//   POST /v1/ferry/probe                           how big a request gets through (the body is thrown away)
//   POST /v1/ferry/upload/{upload}/{seq}           one part of a big upload
//   POST /v1/ferry/commit?conv=&base=&base_hash=[&upload=&parts=][&encoding=gzip]
//   POST /v1/chat/completions                      OpenAI-style; its "ferry" field names the stored conversation
// No conversation text is logged.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { Conflict, Store } from "./store.js";

export const PROTOCOL = "1";
export const FEATURES = ["gzip", "reasoning"];
const MAX_UNZIPPED = 64 * 1024 * 1024;

const digest = (s) => createHash("sha256").update(s).digest();

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/** cfg from loadConfig. deps (tests): fetch, log(line). Returns { server, store }. */
export function createApp(cfg, deps = {}) {
	const fetchImpl = deps.fetch ?? ((...a) => fetch(...a));
	const log = deps.log ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));
	const store = deps.store ?? new Store({ maxBytes: cfg.maxSessionBytes });
	const tokens = cfg.users.map((u) => ({ name: u.name, hash: digest(u.token) }));
	const version = deps.version ?? "dev";

	function userOf(req) {
		const auth = req.headers.authorization ?? "";
		const given = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-api-key"] ?? "");
		if (!given) return null;
		const h = digest(given);
		return tokens.find((t) => timingSafeEqual(t.hash, h))?.name ?? null;
	}

	async function readBody(req) {
		const chunks = [];
		let size = 0;
		for await (const c of req) {
			size += c.length;
			if (size > cfg.maxBodyBytes) throw new HttpError(413, `request body exceeds the ${cfg.maxBodyBytes}-byte limit`);
			chunks.push(c);
		}
		return Buffer.concat(chunks);
	}

	const send = (res, status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	function describe(id, m) {
		const p = cfg.providers[m.provider];
		return { id, name: id === "auto" ? `auto (${m.name ?? m.id})` : (m.name ?? id), provider: "", model: m.model, api: "openai",
			contextWindow: m.contextWindow, maxTokens: m.maxTokens, vision: !!m.vision, price: m.price ?? {}, ready: !!p.apiKey,
			...(m.reasoning !== undefined ? { reasoning: !!m.reasoning } : {}),
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			...(m.compat ? { compat: m.compat } : {}) };
	}

	function models() {
		const list = [describe("auto", cfg.models.get(cfg.defaultModel))];
		for (const [id, m] of cfg.models) list.push(describe(id, m));
		return { models: list, sessionStore: "memory", features: FEATURES };
	}

	async function commit(req, user, url) {
		const q = url.searchParams;
		const body = await readBody(req);
		let raw = body;
		try {
			if (q.get("upload")) raw = store.takeParts(user, q.get("upload"), Number(q.get("parts")));
			if (q.get("encoding") === "gzip") raw = gunzipSync(raw, { maxOutputLength: MAX_UNZIPPED });
		} catch (e) {
			throw new HttpError(400, e.message);
		}
		const blob = JSON.parse(raw.toString("utf8"));
		if (!Array.isArray(blob.append)) throw new HttpError(400, "append must be a list");
		return store.commit(user, q.get("conv"), Number(q.get("base")), q.get("base_hash") ?? "", blob.append, blob.tools ?? null);
	}

	async function chat(req, res, user) {
		const payload = JSON.parse((await readBody(req)).toString("utf8"));
		const ref = payload.ferry;
		delete payload.ferry;
		if (ref) {
			const { messages, tools } = store.load(user, ref.conv, ref.count, ref.hash, ref.tools_hash);
			payload.messages = messages;
			if (tools) payload.tools = tools;
		}
		const wanted = ref?.purpose === "summary" && cfg.summaryModel ? cfg.summaryModel
			: payload.model === "auto" || !payload.model ? cfg.defaultModel : payload.model;
		const m = cfg.models.get(wanted);
		if (!m) throw new HttpError(404, `model "${payload.model}" is not offered by this server`);
		const p = cfg.providers[m.provider];
		if (!p.apiKey) throw new HttpError(503, `no API key for provider "${p.name}" on the server (${p.keyEnv ?? "apiKey"})`);
		payload.model = m.model;

		const stop = new AbortController();
		res.on("close", () => { if (!res.writableFinished) stop.abort(); }); // the client went away: stop the model too
		let up;
		try {
			up = await fetchImpl(`${p.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
				body: JSON.stringify(payload),
				signal: stop.signal,
			});
		} catch (e) {
			throw new HttpError(502, `could not reach ${p.name} (${p.baseUrl}): ${e.cause?.code ?? e.message}`);
		}
		res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json",
			"cache-control": "no-cache", "x-accel-buffering": "no" });
		if (up.body) for await (const chunk of up.body) res.write(chunk);
		res.end();
		return { model: m.id, upstream: up.status, messages: payload.messages?.length ?? 0 };
	}

	async function handle(req, res) {
		const url = new URL(req.url, "http://x");
		const path = url.pathname;
		if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, server: "dsh-ferry", version, protocol: PROTOCOL });
		const proto = req.headers["x-ferry-protocol"];
		if (proto && String(proto).split(".")[0] !== PROTOCOL) {
			throw new HttpError(426, `client protocol ${proto}, server protocol ${PROTOCOL}: update the older side`);
		}
		const user = userOf(req);
		if (!user) throw new HttpError(401, "invalid or missing token");
		req.user = user;

		if (req.method === "GET" && path === "/v1/ferry/models") return send(res, 200, models());
		if (req.method !== "POST") throw new HttpError(404, "not found");
		if (path === "/v1/ferry/probe") return send(res, 200, { bytes: (await readBody(req)).length });
		const part = path.match(/^\/v1\/ferry\/upload\/([\w-]{1,64})\/(\d{1,6})$/);
		if (part) {
			store.putPart(user, part[1], Number(part[2]), await readBody(req));
			return send(res, 200, { ok: true });
		}
		if (path === "/v1/ferry/commit") return send(res, 200, await commit(req, user, url));
		if (path === "/v1/chat/completions") return chat(req, res, user);
		throw new HttpError(404, "not found");
	}

	const server = createServer(async (req, res) => {
		const started = Date.now();
		let status = 200;
		let extra = {};
		try {
			extra = (await handle(req, res)) ?? {};
			status = res.statusCode;
		} catch (e) {
			status = e instanceof HttpError ? e.status : e instanceof Conflict ? 409 : e instanceof SyntaxError ? 400 : 500;
			if (!res.headersSent) send(res, status, { error: { message: status === 500 ? `server error: ${e.message}` : e.message } });
			else res.end();
		}
		log({ at: new Date().toISOString(), user: req.user ?? null, path: new URL(req.url, "http://x").pathname,
			status, ms: Date.now() - started, ...(typeof extra === "object" ? extra : {}) });
	});
	return { server, store };
}
