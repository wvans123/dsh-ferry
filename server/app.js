// The DSH Ferry server: takes a conversation from dsh-llm-ferry in small pieces, puts it back together and asks the
// model (DeepSeek by default, or any OpenAI-compatible API). Same wire protocol as the Ferry server, so the plugin
// works with either.
//   GET  /health                                   no token needed
//   GET  /v1/ferry/models                          models this server offers, and what it supports ("features")
//   POST /v1/ferry/probe                           how big a request gets through (the body is thrown away)
//   POST /v1/ferry/upload/{upload}/{seq}           one part of a big upload
//   POST /v1/ferry/commit?conv=&base=&base_hash=[&upload=&parts=][&encoding=gzip]
//   POST /v1/chat/completions                      OpenAI-style; its "ferry" field names the stored conversation
//   POST /anthropic/v1/messages                    the same for models behind an Anthropic Messages API
//   POST /v1/tools/search, /v1/tools/fetch         DeepSeek's Search and Fetch APIs, with the server's key
//   POST /v1/ferry/notify                          a phone notification through Bark
// No conversation text is logged.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { Conflict, Store } from "./store.js";

export const PROTOCOL = "1";
const MAX_UNZIPPED = 64 * 1024 * 1024;

const digest = (s) => createHash("sha256").update(s).digest();
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);

const sleep = (ms, signal) => new Promise((resolve) => {
	const t = setTimeout(resolve, ms);
	signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * DeepSeek's Messages API, asked the way DSH's own DeepSeek adapter asks it: thinking { type: "enabled" } with the level
 * in output_config.effort (pi-ai writes Claude's "adaptive" form; DeepSeek takes both, this keeps requests identical).
 */
export function deepseekThinking(payload) {
	if (payload.thinking?.type === "adaptive") payload.thinking = { type: "enabled" };
	if (payload.thinking?.type === "enabled") delete payload.thinking.display;
}

/**
 * Put back the prompt-cache markers the plugin took out before syncing (they move every turn, so they are not part of
 * the stored conversation). marks: [[message index, block index, cache_control]], counted with "__system__" first.
 */
export function restoreCacheMarks(msgs, marks) {
	for (const [i, j, cc] of marks) {
		const m = msgs[i];
		if (!m) continue;
		let at = j;
		if (typeof m.content === "string") {
			m.content = [{ type: "text", text: m.content }];
			at = 0;
		}
		const block = Array.isArray(m.content) ? m.content.at(at) : null;
		if (block && typeof block === "object") block.cache_control = cc;
	}
}

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
		const label = m.name ?? m.id;
		return { id, name: id === "auto" ? `auto (${label})` : (m.name ?? id), provider: "", model: m.model, api: m.api,
			price: m.price ?? {}, ready: !!p.apiKey,
			...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
			...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
			...(m.vision !== undefined ? { vision: !!m.vision } : {}),
			...(m.catalog ? { catalog: m.catalog } : {}),
			...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
			...(m.reasoning !== undefined ? { reasoning: !!m.reasoning } : {}),
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			...(m.compat ? { compat: m.compat } : {}) };
	}

	const searcher = () => (cfg.searchProvider ? cfg.providers[cfg.searchProvider] : null);

	function models() {
		const list = [describe("auto", cfg.models.get(cfg.defaultModel))];
		for (const [id, m] of cfg.models) list.push(describe(id, m));
		// "tools": /v1/tools/search and /fetch answer (a name of its own: the Ferry server's "search" is another API)
		return { models: list, sessionStore: "memory", features: ["gzip", "reasoning", ...(searcher()?.apiKey ? ["tools"] : [])] };
	}

	/** POST /v1/ferry/notify {title, body, kind}: push to the phone through Bark. Same as the Ferry server's. */
	async function notify(req) {
		const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
		if (!cfg.barkUrl) return { ok: false, error: "no Bark address on the server (barkUrl or BARK_URL)" };
		const payload = { title: String(b.title ?? "DSH").slice(0, 80), body: String(b.body ?? "").slice(0, 500), group: "DSH",
			...(b.kind === "approval" ? { level: "timeSensitive" } : {}) };
		try {
			const r = await fetchImpl(cfg.barkUrl, { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
			return r.ok ? { ok: true, kind: b.kind ?? "" } : { ok: false, error: `Bark answered HTTP ${r.status}` };
		} catch (e) {
			return { ok: false, error: `cannot reach Bark: ${e.cause?.code ?? e.message}` };
		}
	}

	async function tools(req, res, op) {
		const p = searcher();
		if (!p?.apiKey) throw new HttpError(503, "this server has no web search: it needs a DeepSeek API key");
		const body = await readBody(req);
		let up;
		try {
			up = await fetchImpl(`${p.toolsBaseUrl}/${op}`, { method: "POST", redirect: "manual", body,
				headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` }, signal: AbortSignal.timeout(90_000) });
		} catch (e) {
			throw new HttpError(502, `could not reach ${p.name}'s ${op} API: ${e.cause?.code ?? e.message}`);
		}
		res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
		res.end(Buffer.from(await up.arrayBuffer()));
		return { upstream: up.status };
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

	/**
	 * POST to the model's API; a busy or failing upstream (429, 5xx, 529 "overloaded") is asked again after a short
	 * wait, at most twice, before anything has been sent back: DSH sees one slower answer instead of an error.
	 */
	async function upstream(url, init, signal, name) {
		for (let attempt = 0; ; attempt++) {
			let up;
			try {
				up = await fetchImpl(url, { ...init, signal });
			} catch (e) {
				if (signal.aborted || attempt >= 2) throw new HttpError(502, `could not reach ${name}: ${e.cause?.code ?? e.message}`);
				await sleep(1000 * 3 ** attempt, signal);
				continue;
			}
			if (!RETRY_STATUS.has(up.status) || attempt >= 2) return { up, retries: attempt };
			const after = Number(up.headers.get("retry-after"));
			await up.body?.cancel().catch(() => {});
			await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 1000 * 3 ** attempt, signal);
		}
	}

	/** api "openai": /v1/chat/completions; "anthropic": /anthropic/v1/messages. Both stream the model's answer back as is. */
	async function chat(req, res, user, api) {
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
		if (m.api !== api) throw new HttpError(400, `model "${wanted}" speaks the ${m.api} API, not ${api}`);
		const p = cfg.providers[m.provider];
		if (!p.apiKey) throw new HttpError(503, `no API key for provider "${p.name}" on the server (${p.keyEnv ?? "apiKey"})`);
		payload.model = m.model;

		let url;
		let headers;
		if (api === "anthropic") {
			restoreCacheMarks(payload.messages ?? [], ref?.cache ?? []);
			if (payload.messages?.[0]?.role === "__system__") payload.system = payload.messages.shift().content;
			if (p.dialect === "deepseek") deepseekThinking(payload);
			url = /\/v1$/.test(p.baseUrl) ? `${p.baseUrl}/messages` : `${p.baseUrl}/v1/messages`;
			headers = { "content-type": "application/json", "x-api-key": p.apiKey,
				"anthropic-version": req.headers["anthropic-version"] ?? "2023-06-01",
				...(req.headers["anthropic-beta"] ? { "anthropic-beta": req.headers["anthropic-beta"] } : {}) };
		} else {
			url = `${p.baseUrl}/chat/completions`;
			headers = { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` };
		}

		const stop = new AbortController();
		res.on("close", () => { if (!res.writableFinished) stop.abort(); }); // the client went away: stop the model too
		const { up, retries } = await upstream(url, { method: "POST", headers, body: JSON.stringify(payload) }, stop.signal,
			`${p.name} (${p.baseUrl})`);
		res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json",
			"cache-control": "no-cache", "x-accel-buffering": "no" });
		if (up.body) for await (const chunk of up.body) res.write(chunk);
		res.end();
		return { model: m.id, upstream: up.status, messages: payload.messages?.length ?? 0, ...(retries ? { retries } : {}) };
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
		if (path === "/v1/ferry/notify") {
			const answer = await notify(req);
			send(res, 200, answer);
			return { notify: answer.ok };
		}
		const part = path.match(/^\/v1\/ferry\/upload\/([\w-]{1,64})\/(\d{1,6})$/);
		if (part) {
			store.putPart(user, part[1], Number(part[2]), await readBody(req));
			return send(res, 200, { ok: true });
		}
		if (path === "/v1/ferry/commit") return send(res, 200, await commit(req, user, url));
		if (path === "/v1/chat/completions") return chat(req, res, user, "openai");
		if (path === "/anthropic/v1/messages") return chat(req, res, user, "anthropic");
		if (path === "/v1/tools/search" || path === "/v1/tools/fetch") return tools(req, res, path.slice(10));
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
