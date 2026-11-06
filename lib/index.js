// DSH model plugin: the models of a Ferry server, asked through Ferry's small incremental uploads.
//
// DSH's own llm-pi-ai adapter (PiAiAdapter) does everything on the DSH side: converting messages, images, reasoning
// levels, turning the answer back into DSH's stream. This plugin hands it one route, "ferry", whose model list comes
// from the server (refreshed every few minutes) and whose requests go through sync.js instead of straight to a model.
import { LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";
import { defaultProviderAuthContext, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { readFerryConfig } from "./config.js";
import { fetchModels, toPiModel } from "./models.js";
import { createFerrySync, PURPOSE_HEADER } from "./sync.js";
import { webProviders } from "./web.js";

export const name = "llm-ferry";
export const inject = ["llm"];
export const ROUTE = "ferry";

// No defaults here: an empty field falls back to ~/.ferry/config.json and the environment (config.js)
export const Config = z.object({
	server: z.string().description("Ferry server address; empty: the one ferry login saved (~/.ferry/config.json)"),
	token: z.string().role("secret").description("Ferry token; empty: the one ferry login saved"),
	chunkBytes: z.natural().min(8192).description("Largest upload part in bytes; empty: ~/.ferry/config.json, else 81920 (80 KB). " +
		"`dsh-llm-ferry probe --save` measures it"),
	project: z.string().description("Project name for the server's rules/<project>.md"),
	compress: z.boolean().description("Compress uploads when the server supports it (default on); turn off if the network stops compressed bodies"),
	refreshMinutes: z.natural().min(1).description("How often the model list is fetched again (minutes, default 5)"),
});

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

/**
 * llm-pi-ai's adapter, plus the thinking level each server model wants by default ("defaultEffort"): DSH puts it into a
 * request that names none, so DeepSeek thinks as it does when DSH talks to it directly; choosing "off" still turns it off.
 */
export class FerryAdapter extends PiAiAdapter {
	constructor(options, defaults) {
		super(options);
		this.defaults = defaults; // () => Map(model id -> effort)
	}

	withDefault(model, info) {
		const effort = this.defaults().get(model);
		const r = info.reasoning;
		if (!effort || !r || r.defaultEffort !== undefined || !r.efforts.some((e) => e.id === effort)) return info;
		return { ...info, reasoning: { ...r, defaultEffort: effort } };
	}

	async resolveModel(provider, model, signal) {
		return this.withDefault(model, await super.resolveModel(provider, model, signal));
	}

	async prepareCall(provider, model, signal) {
		const call = await super.prepareCall(provider, model, signal);
		return { ...call, model: this.withDefault(model, call.model) };
	}
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

	let efforts = new Map();
	const adapter = new FerryAdapter({
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
	}, () => efforts);
	ctx.llm.registerAdapter([ROUTE], adapter);
	const web = webProviders(cfg);
	ctx.inject?.(["web"], (child) => {
		child.effect(() => child.web.registerSearchProvider(web.search));
		child.effect(() => child.web.registerFetchProvider(web.fetch));
	});

	let active = true;
	const refresh = async () => {
		try {
			const got = await fetchModels(cfg);
			cfg.sessionStore = got.sessionStore;
			cfg.features = got.features;
			if (!active || JSON.stringify(got.models) === JSON.stringify(models)) return;
			models = got.models;
			efforts = new Map(models.filter((m) => m.defaultEffort).map((m) => [m.id, m.defaultEffort]));
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
	return { adapter, refresh, web };
}
