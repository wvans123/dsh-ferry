// Server settings: a JSON file, or nothing but environment variables.
//
// Zero config: DEEPSEEK_API_KEY plus DSH_FERRY_TOKEN (or FERRY_TOKEN) serve DeepSeek's models to one user.
// A file (dsh-ferry-server.json, or --config <file>) can add users, other providers and models:
//   {
//     "port": 8790, "host": "0.0.0.0",
//     "users": [{ "name": "wesley", "tokenEnv": "DSH_FERRY_TOKEN_WESLEY" }],
//     "providers": { "deepseek": {},
//                    "kimi": { "baseUrl": "https://api.moonshot.cn/v1", "apiKeyEnv": "MOONSHOT_API_KEY" },
//                    "anthropic": {} },
//     "models": [{ "id": "deepseek-flash" }, { "id": "deepseek-v4-pro", "defaultEffort": "max" },
//                { "id": "kimi", "provider": "kimi", "model": "kimi-k2", "catalog": "moonshotai/kimi-k2" },
//                { "id": "claude", "provider": "anthropic", "model": "claude-sonnet-4-5", "catalog": "anthropic/claude-sonnet-4-5" }],
//     "defaultModel": "deepseek-flash", "summaryModel": "deepseek-flash",
//     "searchProvider": "deepseek",
//     "barkUrl": "https://api.day.app/<your key>"
//   }
// barkUrl (or BARK_URL): where phone notifications go (a long task finished, an approval waiting).
// providers: "api" is "openai" (Chat Completions, the default) or "anthropic" (Messages); "deepseek" and "anthropic" need
// no baseUrl. DeepSeek's own Anthropic-compatible API: { "baseUrl": "https://api.deepseek.com/anthropic", "api": "anthropic",
// "apiKeyEnv": "DEEPSEEK_API_KEY" }.
// models: a DeepSeek preset id needs nothing else. "catalog" names the model in pi-ai's catalog (provider/id): the plugin
// takes its size, pictures, thinking levels and protocol details from there, so other providers need no more than that.
// "defaultEffort": the thinking level DSH uses when none is chosen ("off" turns thinking off by default).
// searchProvider: whose Search and Fetch APIs answer DSH's web_search / web_fetch (default: deepseek, when configured;
// a provider other than deepseek needs a "toolsBaseUrl" speaking the same API).
import { existsSync, readFileSync } from "node:fs";

// DeepSeek's models as pi-ai 1.3 describes them (providers/all, "deepseek"). compat and thinkingLevelMap are pi-ai's
// own vocabulary: the plugin hands them to pi-ai as they are, so DSH asks for thinking the way DeepSeek expects and
// sends earlier thinking back as reasoning_content.
const DEEPSEEK_COMPAT = { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens",
	requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek", supportsStrictMode: true };
// defaultEffort "high": DeepSeek thinks unless told not to, as when DSH talks to it directly.
// By default DeepSeek is reached the way DSH's own DeepSeek adapter reaches it: its Anthropic-compatible Messages API,
// thinking as { type: "enabled" } plus output_config.effort, and (Flash) a changed system prompt sent inside the
// history so the cached prefix survives. "api": "openai" on the deepseek provider uses Chat Completions instead.
const LEVELS = { flash: { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	pro: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } };
const DEEPSEEK = {
	"deepseek-flash": { name: "DeepSeek V4.1 Flash", vision: true, price: { input: 0.3, output: 1.2, cache_read: 0.006 },
		levels: LEVELS.flash, midConvoSystem: { anthropic: true, openai: false } },
	"deepseek-v4-pro": { name: "DeepSeek V4 Pro", vision: false, price: { input: 1.32, output: 3.96, cache_read: 0.044 },
		levels: LEVELS.pro, midConvoSystem: { anthropic: false, openai: true } },
};
/** The preset for one DeepSeek model on the given API (pi-ai's terms for thinking and protocol details). */
export function deepseekPreset(id, api) {
	const d = DEEPSEEK[id];
	const mid = d.midConvoSystem[api] ? { supportsMidConvoSystemMessages: true } : {};
	return { provider: "deepseek", model: id, name: d.name, contextWindow: 1_048_576, maxTokens: 384_000, vision: d.vision,
		price: d.price, reasoning: true, thinkingLevelMap: d.levels, defaultEffort: "high",
		compat: api === "anthropic" ? { forceAdaptiveThinking: true, ...mid } : { ...DEEPSEEK_COMPAT, ...mid } };
}
export const PRESETS = Object.fromEntries(Object.keys(DEEPSEEK).map((id) => [id, deepseekPreset(id, "anthropic")]));
const PROVIDER_DEFAULTS = {
	deepseek: { baseUrl: { anthropic: "https://api.deepseek.com/anthropic", openai: "https://api.deepseek.com" },
		apiKeyEnv: "DEEPSEEK_API_KEY", toolsBaseUrl: "https://api.deepseek.com/v1/tools", api: "anthropic", dialect: "deepseek" },
	anthropic: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", api: "anthropic" },
};

/** file: the JSON settings file; raw: the same settings as an object (tests). */
export function loadConfig({ file, raw: given, env = process.env } = {}) {
	const path = file ?? (given || !existsSync("dsh-ferry-server.json") ? null : "dsh-ferry-server.json");
	const raw = given ?? (path ? JSON.parse(readFileSync(path, "utf8")) : {});
	const providers = {};
	for (const [name, p] of Object.entries({ ...(raw.providers ?? { deepseek: {} }) })) {
		const d = PROVIDER_DEFAULTS[name] ?? {};
		const api = p.api ?? d.api ?? "openai";
		if (api !== "openai" && api !== "anthropic") throw new Error(`provider "${name}": api must be "openai" or "anthropic"`);
		const fallback = typeof d.baseUrl === "object" ? d.baseUrl[api] : d.baseUrl;
		const baseUrl = String(p.baseUrl ?? fallback ?? "").replace(/\/+$/, "");
		if (!baseUrl) throw new Error(`provider "${name}" needs a baseUrl`);
		const keyEnv = p.apiKeyEnv ?? d.apiKeyEnv;
		const toolsBaseUrl = String(p.toolsBaseUrl ?? d.toolsBaseUrl ?? "").replace(/\/+$/, "");
		// "deepseek": DeepSeek's own API behind it (also for a provider of another name pointing at api.deepseek.com)
		const dialect = p.dialect ?? d.dialect ?? (/\/\/api\.deepseek\.com(\/|$)/.test(baseUrl) ? "deepseek" : undefined);
		providers[name] = { name, baseUrl, toolsBaseUrl, api, dialect, apiKey: p.apiKey ?? (keyEnv ? env[keyEnv] ?? "" : ""), keyEnv };
	}
	// web search and page reading for DSH: DeepSeek's Search and Fetch APIs, with the server's key
	const searchProvider = raw.searchProvider ?? (providers.deepseek?.toolsBaseUrl ? "deepseek" : null);
	if (searchProvider && !providers[searchProvider]?.toolsBaseUrl) {
		throw new Error(`searchProvider "${searchProvider}" needs a provider with a toolsBaseUrl`);
	}
	const models = new Map();
	for (const m of raw.models ?? Object.keys(PRESETS).map((id) => ({ id }))) {
		const presetProvider = m.provider ?? "deepseek";
		const preset = DEEPSEEK[m.id] && providers[presetProvider] ? deepseekPreset(m.id, providers[presetProvider].api) : {};
		const def = { ...preset, ...m };
		if (!providers[def.provider]) throw new Error(`model "${m.id}" names provider "${def.provider}", which is not configured`);
		if (def.catalog !== undefined && !/^[\w.-]+\/.+$/.test(def.catalog)) throw new Error(`model "${m.id}": catalog is "provider/model-id"`);
		// a catalog model's size and abilities come from the catalog (the plugin looks them up); others get plain defaults
		const plain = def.catalog ? {} : { contextWindow: 128_000, maxTokens: 8192, vision: false };
		models.set(def.id, { ...plain, model: def.id, ...def, api: providers[def.provider].api });
	}
	const defaultModel = raw.defaultModel ?? models.keys().next().value;
	if (!models.has(defaultModel)) throw new Error(`defaultModel "${defaultModel}" is not one of the models`);
	if (raw.summaryModel && !models.has(raw.summaryModel)) throw new Error(`summaryModel "${raw.summaryModel}" is not one of the models`);

	const users = (raw.users ?? [{ name: "default", tokenEnv: env.DSH_FERRY_TOKEN ? "DSH_FERRY_TOKEN" : "FERRY_TOKEN" }])
		.map((u) => ({ name: u.name, token: u.token ?? env[u.tokenEnv] ?? "" }));
	const weak = users.filter((u) => u.token.length < 16);
	if (weak.length) throw new Error(`token missing or shorter than 16 characters for: ${weak.map((u) => u.name).join(", ")}` +
		" (set DSH_FERRY_TOKEN, or tokens in the config file)");

	return {
		host: raw.host ?? env.HOST ?? "127.0.0.1",
		port: Number(raw.port ?? env.PORT ?? 8790),
		maxBodyBytes: raw.maxBodyBytes ?? 1_000_000,
		maxSessionBytes: raw.maxSessionBytes ?? 512 * 1024 * 1024,
		providers,
		models,
		defaultModel,
		summaryModel: raw.summaryModel ?? null,
		searchProvider,
		// Bark (iPhone) push address, https://api.day.app/<key>: phone notifications the plugin asks for
		barkUrl: String(raw.barkUrl ?? env.BARK_URL ?? env.FERRY_BARK_URL ?? "").replace(/\/+$/, ""),
		users,
	};
}
