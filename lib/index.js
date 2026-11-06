// DSH model plugin: the models of a Ferry server, asked through Ferry's small incremental uploads.
//
// DSH's own llm-pi-ai adapter (PiAiAdapter) does everything on the DSH side: converting messages, images, reasoning
// levels, turning the answer back into DSH's stream. This plugin hands it one route, "ferry", whose model list comes
// from the server (refreshed every few minutes) and whose requests go through sync.js instead of straight to a model.
import { LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { defaultProviderAuthContext, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { readFerryConfig } from "./config.js";
import { fetchModels, toPiModel } from "./models.js";
import { createFerrySync, PURPOSE_HEADER } from "./sync.js";

export const name = "llm-ferry";
export const inject = ["llm"];
export const ROUTE = "ferry";

// llm-pi-ai's own defaults for a route it resolves from settings (its config.ts)
const ROUTE_DEFAULTS = {
	streamIdleTimeoutMs: 300_000,
	maxRequestImageBytes: 20 * 1024 * 1024,
	maxRequestImages: 50,
	imageOffloadCountQuantum: 10,
	requestImagePixelBudget: 2048 * 2048,
	requestImageMaxBytes: 1024 * 1024,
};

/** llm-pi-ai's resolved route for these server models; every request goes through `sync`. */
export function routeProfile(models, sync, route = ROUTE) {
	const piModels = models.map((m) => toPiModel(m, route));
	const send = (model, context, options) => sync.streamSimple(model, context, options);
	return {
		provider: route,
		displayName: "Ferry",
		...ROUTE_DEFAULTS,
		retryPolicy: resolveRetryPolicy(undefined, `llm-ferry: provider "${route}" retryPolicy`),
		piProvider: {
			id: route,
			name: "Ferry",
			// the adapter resolves the token (resolveApiKey) and hands it over per request
			auth: { apiKey: { name: "Ferry", resolve: ({ credential }) => Promise.resolve({
				auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: "Ferry" }) } },
			getModels: () => piModels,
			stream: send,
			streamSimple: send,
		},
		modelErrors: new Map(),
		configuredMaxTokens: new Map(),
	};
}

/** options (the plugin's entry in the DSH profile): server, token, project, chunkBytes, refreshMinutes; all optional. */
export function apply(ctx, options = {}) {
	start(ctx, options);
}

/** apply's work; returns what tests drive: the adapter and the model-list refresh. */
export function start(ctx, options = {}) {
	const cfg = readFerryConfig(options);
	const sync = createFerrySync(cfg, { say: (text) => ctx.logger.info(`llm-ferry: ${text}`) });
	let models = [];
	let profiles = new Map([[ROUTE, routeProfile(models, sync)]]);

	const adapter = new PiAiAdapter({
		profiles: () => profiles,
		resolveApiKey: async () => {
			if (cfg.token) return cfg.token;
			throw new LlmError(`llm-ferry: no Ferry token; set token in the plugin settings or run ferry login (server ${cfg.server})`,
				"MISSING_CREDENTIAL");
		},
		auth: { credentials: new InMemoryCredentialStore(), authContext: defaultProviderAuthContext() },
		// DSH's request purpose (compaction, session title) rides to sync.js in a header that is taken out there
		prepareHeaders: (request, headers) => {
			if (request.purpose) headers.set(PURPOSE_HEADER, request.purpose);
			return headers;
		},
		resolveAttachments: () => ctx.get("attachments"),
		resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
			attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),
	});
	ctx.llm.registerAdapter([ROUTE], adapter);

	let active = true;
	const refresh = async () => {
		try {
			const got = await fetchModels(cfg);
			cfg.sessionStore = got.sessionStore;
			if (!active || JSON.stringify(got.models) === JSON.stringify(models)) return;
			models = got.models;
			profiles = new Map([[ROUTE, routeProfile(models, sync)]]);
			ctx.emit("llm/models-updated", ROUTE);
		} catch (e) {
			ctx.logger.warn(`llm-ferry: could not get the model list from ${cfg.server}: ${e.message}`);
		}
	};
	ctx.effect(() => {
		void refresh();
		const timer = setInterval(refresh, cfg.refreshMinutes * 60_000);
		timer.unref?.();
		return () => {
			active = false;
			clearInterval(timer);
		};
	});
	return { adapter, refresh };
}
