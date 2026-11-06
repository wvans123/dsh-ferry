// The models the Ferry server offers this user, as pi-ai model definitions. Mirrors modelDef in ferry's
// client/lib/sync.mjs so DSH and the ferry client see the same models with the same abilities.
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

let catalog = null;
/** pi-ai's own entry for a model it knows (Claude, GPT): whether it thinks, and how to ask it to. */
export function knownModel(name) {
	if (!catalog) {
		catalog = new Map();
		for (const provider of ["anthropic", "openai"]) {
			try {
				for (const m of getBuiltinModels(provider)) catalog.set(m.id, { ...m, provider });
			} catch {
				// a pi-ai version laid out differently: no thinking settings, everything else works
			}
		}
	}
	return catalog.get(String(name ?? "").replace(/^.*\//, ""));
}

/** One server model (GET /v1/ferry/models) as a pi-ai model on DSH route `route`. */
export function toPiModel(m, route) {
	const known = knownModel(m.model);
	const anthropic = m.api === "anthropic";
	// thinking: for the Claude and GPT models pi-ai knows to think
	const thinks = !!known?.reasoning && (anthropic ? known.provider === "anthropic" : known.provider === "openai");
	return {
		id: m.id,
		// shown under its provider's name ("kiro/claude-opus-5.5"); "auto" and pooled models have none
		name: m.provider && m.provider !== "ferry" ? `${m.provider}/${m.id}` : m.id,
		api: anthropic ? "anthropic-messages" : "openai-completions",
		provider: route,
		baseUrl: "", // set per request from the server address (sync.js)
		reasoning: thinks,
		...(thinks && known.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
		// relays drop Claude's in-conversation effort and system messages (ferry #9): ask at the top, keep extras off
		...(thinks && anthropic && known.compat ? { compat: { ...known.compat, supportsMidConvoEffort: false,
			supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false } } : {}),
		input: m.vision ? ["text", "image"] : ["text"],
		cost: { input: m.price?.input ?? 0, output: m.price?.output ?? 0,
			cacheRead: m.price?.cache_read ?? m.price?.input ?? 0, cacheWrite: m.price?.cache_write ?? m.price?.input ?? 0 },
		contextWindow: m.contextWindow ?? 128000,
		maxTokens: m.maxTokens ?? 8192,
	};
}

/** GET /v1/ferry/models: { models, sessionStore }. Throws with a short reason when the server cannot be asked. */
export async function fetchModels(cfg, fetchImpl = fetch, signal) {
	const res = await fetchImpl(`${cfg.server}/v1/ferry/models`, {
		headers: { "x-ferry-protocol": "1", ...(cfg.headers ?? {}), ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
		redirect: "manual",
		signal,
	});
	if (!res.headers.get("content-type")?.includes("json")) throw new Error(`HTTP ${res.status}, not from the Ferry server`);
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	const body = await res.json();
	return { models: Array.isArray(body.models) ? body.models : [], sessionStore: body.sessionStore };
}
