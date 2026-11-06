// Every model call in DSH leaves through Ferry, whatever other plugins or your own settings choose.
//
// 1. DSH's llm/stream waterfall sees every model request before an adapter does. A request for any route but Ferry's is
//    handed to Ferry instead: the same model id when the server offers it, else "auto". Other plugins (reviewers,
//    routers, title writers, model plugins of their own) keep working; their calls just go through Ferry.
// 2. fetch() to a well-known model API from inside DSH is refused, so a plugin that talks to a model by itself cannot
//    go around Ferry either. node:http and other clients are not covered; the company network is the last line there.
export const MODEL_API_HOSTS = [
	"api.deepseek.com", "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "aiplatform.googleapis.com",
	"api.moonshot.cn", "api.moonshot.ai", "open.bigmodel.cn", "api.z.ai", "dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com",
	"openrouter.ai", "api.x.ai", "api.mistral.ai", "api.groq.com", "api.together.xyz", "api.fireworks.ai", "api.minimax.chat",
	"api.minimaxi.com", "ark.cn-beijing.volces.com", "qianfan.baidubce.com", "api.siliconflow.cn", "api.perplexity.ai",
	"api.cohere.com", "chat.deepseek.com",
];

const hostOf = (input) => {
	try {
		return new URL(typeof input === "string" || input instanceof URL ? input : input?.url).hostname.toLowerCase();
	} catch {
		return "";
	}
};

/** Whether this host is a model API to keep closed (the host itself or a subdomain of a listed one). */
export const isModelApi = (host, allow = []) => !allow.includes(host)
	&& MODEL_API_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * The llm/stream listener (bound to DSH's LlmRuntime). route: Ferry's route id; offered(): model ids the server offers;
 * efforts(model): Promise of the thinking levels that model takes; say(text): a note in DSH's log.
 */
export function rerouteToFerry(route, offered, efforts, say) {
	const told = new Set();
	return function (options, next) {
		if (options.provider === route) return next();
		const runtime = this;
		const model = offered().includes(options.model) ? options.model : "auto";
		const key = `${options.provider}/${options.model}`;
		if (!told.has(key)) {
			told.add(key);
			say(`a request for ${key} goes through Ferry as ${route}/${model}`);
		}
		const { reasoningEffort, ...rest } = options;
		return (async function* () {
			// a level the other route knows but Ferry's model does not take would fail the call: leave it to the default
			const keep = reasoningEffort !== undefined && (await efforts(model).catch(() => undefined))?.includes(reasoningEffort);
			yield* runtime.stream({ ...rest, provider: route, model, ...(keep ? { reasoningEffort } : {}) });
		})();
	};
}

/** Refuse fetch() to model APIs; returns the function that puts the original fetch back. */
export function guardFetch(server, allow = [], say = () => {}) {
	const original = globalThis.fetch;
	if (original.ferryGuard) return () => {};
	const own = hostOf(server);
	const guarded = function (input, init) {
		const host = hostOf(input);
		if (host && host !== own && isModelApi(host, allow)) {
			say(`blocked a direct request to ${host}: model APIs are reached only through the Ferry server`);
			return Promise.reject(new TypeError(`dsh-llm-ferry: ${host} is a model API; DSH reaches models only through the Ferry server ` +
				"(allowDirectHosts in the plugin settings lets a host through)"));
		}
		return original.call(this, input, init);
	};
	guarded.ferryGuard = true;
	globalThis.fetch = guarded;
	return () => {
		if (globalThis.fetch === guarded) globalThis.fetch = original;
	};
}
