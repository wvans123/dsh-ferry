// One model request through the Ferry server. DSH re-sends the whole conversation on every request; this uploads only
// the messages the server has not seen yet (in parts when they are big), then sends a tiny request that refers to the
// server's copy. The server rebuilds the full request and calls the model. If the server has lost its copy, the
// conversation is uploaded again automatically. Ported from ferry's client/lib/sync.mjs; keep the two in step.
import { createHash, randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createUploader, DEFAULT_CHUNK, isJson } from "./upload.js";

export const PROTOCOL = "1"; // the Ferry protocol's major version; the server answers 426 when it differs
/** Carries DSH's request purpose from the adapter's header hook to here; never sent. */
export const PURPOSE_HEADER = "x-ferry-dsh-purpose";
// per process, so two sessions with the same opening never share a server copy (DSH's session id is used when known)
const SALT = randomUUID();

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export class FerryError extends Error {}

/** DSH's purpose -> the server's: context summaries and titles may go to the server's cheaper summary model. */
export const ferryPurpose = (dsh) => (dsh === "compaction" || dsh === "session-title" ? "summary" : "agent");

/**
 * Anthropic requests carry prompt-cache markers on the last message, which move every turn. Take them out (and write
 * a one-block text message as a plain string) so the synced conversation stays the same from turn to turn; the server
 * puts the markers back. Returns [[message, block, cache_control]].
 */
export function takeCacheMarks(list) {
	const marks = [];
	list.forEach((m, i) => {
		if (!Array.isArray(m.content) || m.role === "__system__") return;
		m.content.forEach((b, j) => {
			if (b && typeof b === "object" && b.cache_control) {
				marks.push([i, j, b.cache_control]);
				delete b.cache_control;
			}
		});
		const only = m.content.length === 1 ? m.content[0] : null;
		if (only?.type === "text" && Object.keys(only).length === 2) m.content = only.text;
	});
	return marks;
}

/**
 * cfg: { server, token, chunkBytes, headers, project, sessionStore }. deps (tests): fetch, sleep, say, apis.
 * Returns { streamSimple } with pi-ai's provider signature.
 */
export function createFerrySync(cfg, deps = {}) {
	const fetchImpl = deps.fetch ?? ((...a) => fetch(...a));
	const apis = deps.apis ?? { anthropic: anthropicMessagesApi(), openai: openAICompletionsApi() };
	const known = new Map(); // conv -> { count, hash } the server has acknowledged
	const knownTools = new Set(); // tool lists (sha256 of their JSON) the server keeps
	// one upload at a time: several subagents starting together send their first, biggest requests one after another
	let uploading = Promise.resolve();
	const oneAtATime = (fn) => {
		const run = uploading.then(fn, fn);
		uploading = run.catch(() => {});
		return run;
	};

	const headers = (extra = {}) => ({ "User-Agent": `Ferry/${PROTOCOL} dsh-llm-ferry`, ...(cfg.headers ?? {}),
		"x-ferry-protocol": PROTOCOL, ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}), ...extra });
	const post = (path, body, signal) => fetchImpl(`${cfg.server}${path}`, {
		method: "POST", headers: headers({ "Content-Type": "application/octet-stream" }), redirect: "manual", body, signal });

	// the part size now: it only gets smaller, when the network stops a request
	const sizes = { chunk: Number(cfg.chunkBytes) || DEFAULT_CHUNK };
	const uploader = createUploader(sizes, {
		post,
		sleep: deps.sleep,
		say: deps.say,
		gatewayConfirm: (res) => res.status >= 300 && res.status < 400, // a redirect to a confirmation page: smaller parts do not help
	});

	function commit(conv, base, baseHash, blob, signal) {
		const q = new URLSearchParams({ conv, base: String(base), base_hash: baseHash });
		return oneAtATime(() => uploader.commit(Buffer.from(blob, "utf8"), q, signal).catch((e) => {
			if (e instanceof FerryError || signal?.aborted) throw e;
			throw new FerryError(`Could not reach the Ferry server (${cfg.server}): ${e.message}. Send the message again.`);
		}));
	}

	async function shrink(payload, signal, api, sessionId, purpose) {
		if (!payload || !Array.isArray(payload.messages)) return payload;
		if (cfg.sessionStore === "none") { // the server keeps nothing between calls: always send everything
			known.clear();
			knownTools.clear();
		}
		let list = structuredClone(payload.messages);
		let marks = [];
		if (api === "anthropic") { // the system prompt is a separate field there: sync it as the first item
			list = [...(payload.system !== undefined ? [{ role: "__system__", content: structuredClone(payload.system) }] : []), ...list];
			marks = takeCacheMarks(list);
		}
		const msgs = list.map((m) => JSON.stringify(m));
		const conv = sha((sessionId || SALT) + (msgs[0] ?? "") + (msgs[1] ?? ""));
		const chain = [""];
		for (const s of msgs) chain.push(sha(chain[chain.length - 1] + s));
		const toolsJson = Array.isArray(payload.tools) && payload.tools.length ? JSON.stringify(payload.tools) : null;
		const toolsHash = toolsJson ? sha(toolsJson) : null;

		const prev = known.get(conv);
		const base = prev && prev.count <= msgs.length && chain[prev.count] === prev.hash ? prev.count : 0;
		const blob = (b, withTools) => JSON.stringify({ append: msgs.slice(b), tools: withTools ? toolsJson : null });

		let res = await commit(conv, base, chain[base], blob(base, toolsHash && !knownTools.has(toolsHash)), signal);
		if (res.status === 409) res = await commit(conv, 0, "", blob(0, !!toolsHash), signal); // the server's copy differs or is gone
		if (res.status === 401) throw new FerryError("Ferry token rejected by the server: check the token in the plugin settings or ~/.ferry/config.json.");
		if (res.status === 426) throw new FerryError(`Ferry plugin and server versions do not match: ${await res.text()}`);
		if (!isJson(res)) {
			const via = res.headers.get("server") ?? res.headers.get("via") ?? "unknown";
			throw new FerryError(`The Ferry server did not get this request: HTTP ${res.status} from ${via}. If the company gateway ` +
				`wants a confirmation, open ${cfg.server}/ in the browser, confirm, then send the message again.`);
		}
		if (!res.ok) throw new FerryError(`Ferry sync failed: HTTP ${res.status} ${await res.text()}`);
		const ack = await res.json();
		if (ack.count !== msgs.length || ack.hash !== chain[msgs.length]) {
			known.delete(conv);
			throw new FerryError("Ferry server state does not match this plugin; it will resend on the next try");
		}
		known.set(conv, ack);
		if (toolsHash) knownTools.add(toolsHash);
		const { messages: _m, tools: _t, system: _s, ...rest } = payload;
		if (api !== "anthropic" && _s !== undefined) rest.system = _s;
		return { ...rest, messages: [], ferry: { conv, count: ack.count, hash: ack.hash, tools_hash: toolsHash, purpose,
			...(marks.length ? { cache: marks } : {}) } };
	}

	function errorEvent(model, message) {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		return { type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api,
			provider: model.provider, model: model.id, usage, stopReason: "error", errorMessage: message, timestamp: Date.now() } };
	}

	function errorStream(model, message) {
		const stream = createAssistantMessageEventStream();
		stream.push(errorEvent(model, message));
		stream.end();
		return stream;
	}

	// The server can lose its copy between our commit and the model call (restart, cleanup). It then answers 409
	// before any output; forget what we think the server has and run the request once more, which uploads it in full.
	const SESSION_LOST = /\b409\b|session not found|tools not found/i;

	function streamSimple(model, context, options = {}) {
		if (!cfg.server || !cfg.token) {
			return errorStream(model, "Ferry is not set up: set server and token in the plugin settings, or run ferry login on this computer.");
		}
		const { [PURPOSE_HEADER]: dshPurpose, ...given } = options.headers ?? {};
		const purpose = ferryPurpose(dshPurpose);
		const api = model.api === "anthropic-messages" ? "anthropic" : "openai";
		// provider "ferry" whatever the route is called: pi-ai has quirks for some provider names (deepseek, openai)
		const inner = { ...model, provider: "ferry", baseUrl: api === "anthropic" ? `${cfg.server}/anthropic` : `${cfg.server}/v1` };
		const attempt = () => apis[api].streamSimple(inner, context, {
			...options,
			apiKey: cfg.token,
			headers: { ...given, ...(cfg.headers ?? {}), "x-ferry-protocol": PROTOCOL,
				...(cfg.project ? { "x-ferry-project": encodeURIComponent(cfg.project) } : {}) }, // headers must be ASCII
			onPayload: async (payload, m) => {
				const replaced = options.onPayload ? await options.onPayload(payload, m) : undefined;
				return shrink(replaced ?? payload, options.signal, api, options.sessionId, purpose);
			},
		});
		const out = createAssistantMessageEventStream();
		(async () => {
			for (let i = 0; i < 2; i++) {
				const held = []; // a "start" event is held until we know the attempt produced output
				let committed = false;
				let retry = false;
				for await (const ev of attempt()) {
					if (!committed) {
						if (ev.type === "start") {
							held.push(ev);
							continue;
						}
						if (ev.type === "error" && i === 0 && SESSION_LOST.test(ev.error?.errorMessage ?? "")) {
							known.clear();
							knownTools.clear();
							retry = true;
							break;
						}
						committed = true;
						for (const h of held) out.push(h);
					}
					out.push(ev);
				}
				if (!retry) break;
			}
			out.end();
		})().catch((e) => {
			out.push(errorEvent(model, String(e?.message ?? e)));
			out.end();
		});
		return out;
	}

	return { streamSimple, sizes };
}
