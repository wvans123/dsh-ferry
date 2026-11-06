// DSH's web_search (and, when chosen, web_fetch) through the server: the server searches with its own key, so this
// computer needs no search key and only the query goes out, to the server. Two server dialects, by the features the
// server lists: "tools" (DSH Ferry server: DeepSeek's Search and Fetch APIs at /v1/tools/search and /fetch), and
// "search" / "read" (the Ferry server: /v1/ferry/search and /v1/ferry/read).
const SEARCH_DESCRIPTION = {
	en: "Searches through your Ferry server with the server's own search key. Nothing goes out from this computer but the query to the server.",
	zh: "经你的 Ferry 服务端搜索（用服务端自己的搜索 Key），这台电脑只把搜索词发给服务端。",
};
const FETCH_DESCRIPTION = {
	en: "Reads public pages on your Ferry server. Cannot reach intranet addresses; keep local fetch for those.",
	zh: "由 Ferry 服务端读公网页面。读不到内网地址，内网页面用本机抓取。",
};

/** Search results (DeepSeek Search API or Ferry server: {results: [{url, title, snippet, summary?, date}]}) for DSH. */
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
	const has = (f) => !!(cfg.server && cfg.token && cfg.features?.includes(f));
	async function call(path, body, signal) {
		const res = await fetchImpl(`${cfg.server}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: { ...(cfg.headers ?? {}), "content-type": "application/json", "x-ferry-protocol": "1", authorization: `Bearer ${cfg.token}` },
			body: JSON.stringify(body),
			signal,
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`Ferry server ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`Ferry server ${path} answered something that is not JSON (HTTP ${res.status}); a gateway page?`);
		}
	}
	return {
		search: {
			id: "ferry-search",
			title: "Ferry server",
			description: SEARCH_DESCRIPTION,
			available: () => has("tools") || has("search"),
			async search(request, signal) {
				const count = Math.min(10, request.maxResults ?? 10);
				return mapSearch(has("tools")
					? await call("/v1/tools/search", { query: request.query, count, need_content: false }, signal)
					: await call("/v1/ferry/search", { query: request.query, count }, signal));
			},
		},
		fetch: {
			id: "ferry-fetch",
			title: "Ferry server",
			description: FETCH_DESCRIPTION,
			available: () => has("tools") || has("read"),
			async fetch(request, signal) {
				const body = has("tools") ? await call("/v1/tools/fetch", { url: request.url }, signal)
					: await call("/v1/ferry/read", { url: request.url }, signal);
				const content = body?.content ?? body?.text;
				if (typeof content !== "string") throw new Error("the server's page answer has no text");
				return { url: body.url ?? request.url, statusCode: 200, body: { kind: "text", content }, truncated: !!body.next_offset };
			},
		},
	};
}
