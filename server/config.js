// Server settings: a JSON file, or nothing but environment variables.
//
// Zero config: DEEPSEEK_API_KEY plus DSH_FERRY_TOKEN (or FERRY_TOKEN) serve DeepSeek's models to one user.
// A file (dsh-ferry-server.json, or --config <file>) can add users, other OpenAI-compatible providers and models:
//   {
//     "port": 8790, "host": "0.0.0.0",
//     "users": [{ "name": "wesley", "tokenEnv": "DSH_FERRY_TOKEN_WESLEY" }],
//     "providers": { "deepseek": { "apiKeyEnv": "DEEPSEEK_API_KEY" },
//                    "other": { "baseUrl": "https://api.example.com/v1", "apiKeyEnv": "OTHER_KEY" } },
//     "models": [{ "id": "deepseek-v4-pro" }, { "id": "big", "provider": "other", "model": "big-1", "contextWindow": 200000 }],
//     "defaultModel": "deepseek-flash", "summaryModel": "deepseek-flash",
//     "searchProvider": "deepseek"
//   }
// searchProvider: whose Search and Fetch APIs answer DSH's web_search / web_fetch (default: deepseek, when configured;
// a provider other than deepseek needs a "toolsBaseUrl" speaking the same API).
// A model whose id is a DeepSeek preset needs nothing else; its sizes, prices and thinking levels come from below.
import { existsSync, readFileSync } from "node:fs";

// DeepSeek's models as pi-ai 1.3 describes them (providers/all, "deepseek"). compat and thinkingLevelMap are pi-ai's
// own vocabulary: the plugin hands them to pi-ai as they are, so DSH asks for thinking the way DeepSeek expects and
// sends earlier thinking back as reasoning_content.
const DEEPSEEK_COMPAT = { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens",
	requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek", supportsStrictMode: true };
export const PRESETS = {
	"deepseek-flash": { provider: "deepseek", model: "deepseek-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1_000_000,
		maxTokens: 384_000, vision: true, price: { input: 0.3, output: 1.2, cache_read: 0.006 }, reasoning: true,
		thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" }, compat: DEEPSEEK_COMPAT },
	"deepseek-v4-pro": { provider: "deepseek", model: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1_000_000,
		maxTokens: 384_000, vision: false, price: { input: 1.32, output: 3.96, cache_read: 0.044 }, reasoning: true,
		thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
		compat: { ...DEEPSEEK_COMPAT, supportsMidConvoSystemMessages: true } },
};
const PROVIDER_DEFAULTS = { deepseek: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY",
	toolsBaseUrl: "https://api.deepseek.com/v1/tools" } };

export function loadConfig({ file, env = process.env } = {}) {
	const path = file ?? (existsSync("dsh-ferry-server.json") ? "dsh-ferry-server.json" : null);
	const raw = path ? JSON.parse(readFileSync(path, "utf8")) : {};
	const providers = {};
	for (const [name, p] of Object.entries({ ...(raw.providers ?? { deepseek: {} }) })) {
		const d = PROVIDER_DEFAULTS[name] ?? {};
		const baseUrl = String(p.baseUrl ?? d.baseUrl ?? "").replace(/\/+$/, "");
		if (!baseUrl) throw new Error(`provider "${name}" needs a baseUrl`);
		const keyEnv = p.apiKeyEnv ?? d.apiKeyEnv;
		const toolsBaseUrl = String(p.toolsBaseUrl ?? d.toolsBaseUrl ?? "").replace(/\/+$/, "");
		providers[name] = { name, baseUrl, toolsBaseUrl, apiKey: p.apiKey ?? (keyEnv ? env[keyEnv] ?? "" : ""), keyEnv };
	}
	// web search and page reading for DSH: DeepSeek's Search and Fetch APIs, with the server's key
	const searchProvider = raw.searchProvider ?? (providers.deepseek?.toolsBaseUrl ? "deepseek" : null);
	if (searchProvider && !providers[searchProvider]?.toolsBaseUrl) {
		throw new Error(`searchProvider "${searchProvider}" needs a provider with a toolsBaseUrl`);
	}
	const models = new Map();
	for (const m of raw.models ?? Object.keys(PRESETS).map((id) => ({ id }))) {
		const def = { ...(PRESETS[m.id] ?? {}), ...m };
		if (!providers[def.provider]) throw new Error(`model "${m.id}" names provider "${def.provider}", which is not configured`);
		models.set(def.id, { contextWindow: 128_000, maxTokens: 8192, vision: false, model: def.id, ...def });
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
		users,
	};
}
