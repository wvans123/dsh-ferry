// DSH's web_search (and, when chosen, web_fetch) through the server: the server calls DeepSeek's Search and Fetch APIs
// with its own key, so this computer needs no DeepSeek key and nothing goes to DeepSeek from here. Used when the server
// says it can ("tools" in its features); the DSH Ferry server can when it has a DeepSeek key.
const SEARCH_DESCRIPTION = {
	en: "Searches through your Ferry server (DeepSeek Search API with the server's key). Nothing goes out from this computer but the query to the server.",
	zh: "经你的 Ferry 服务端搜索（服务端用自己的 Key 调 DeepSeek 搜索 API），这台电脑只把搜索词发给服务端。",
};
const FETCH_DESCRIPTION = {
	en: "Reads public pages through your Ferry server (DeepSeek Fetch API). Cannot reach intranet addresses; keep local fetch for those.",
	zh: "经 Ferry 服务端读公网页面（DeepSeek Fetch API）。读不到内网地址，内网页面用本机抓取。",
};

/** Search API results as DSH's search result (the shape dsh-web-deepseek-api produces). */
export function mapSearch(body) {
	if (!body || !Array.isArray(body.results)) throw new Error("the server's search answer has no results list");
	const sources = body.results.filter((r) => typeof r?.url === "string" && r.url).map((r) => ({
		url: r.url,
		...(r.title ? { title: String(r.title) } : {}),
		...(r.snippet ? { snippet: String(r.snippet) } : {}),
		...(r.summary ? { summary: String(r.summary) } : {}),
		...(r.date ? { publishedAt: String(r.date) } : {}),
	}));
	return { sources, truncated: false };
}

/** The two providers for ctx.web; cfg is the plugin's live config (features change when the model list is fetched). */
export function webProviders(cfg, fetchImpl = (...a) => fetch(...a)) {
	const ready = () => !!(cfg.server && cfg.token && cfg.features?.includes("tools"));
	async function call(op, body, signal) {
		const res = await fetchImpl(`${cfg.server}/v1/tools/${op}`, {
			method: "POST",
			redirect: "manual",
			headers: { ...(cfg.headers ?? {}), "content-type": "application/json", "x-ferry-protocol": "1", authorization: `Bearer ${cfg.token}` },
			body: JSON.stringify(body),
			signal,
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`Ferry server ${op} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`Ferry server ${op} answered something that is not JSON (HTTP ${res.status}); a gateway page?`);
		}
	}
	return {
		search: {
			id: "ferry-search",
			title: "Ferry server",
			description: SEARCH_DESCRIPTION,
			available: ready,
			search: async (request, signal) => mapSearch(await call("search",
				{ query: request.query, count: Math.min(10, request.maxResults ?? 10), need_content: false }, signal)),
		},
		fetch: {
			id: "ferry-fetch",
			title: "Ferry server",
			description: FETCH_DESCRIPTION,
			available: ready,
			fetch: async (request, signal) => {
				const body = await call("fetch", { url: request.url }, signal);
				if (typeof body?.content !== "string") throw new Error("the server's fetch answer has no content");
				return { url: request.url, statusCode: 200, body: { kind: "text", content: body.content }, truncated: false };
			},
		},
	};
}
