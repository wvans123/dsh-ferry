import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { webProviders } from "../lib/web.js";

const TOKEN = "dsh-ferry-test-token-0123456789";
const closers = [];
afterEach(async () => {
	while (closers.length) await closers.pop()();
});
const listen = async (server) => {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => server.close(r)));
	return `http://127.0.0.1:${server.address().port}`;
};

/** A stand-in for DeepSeek's /v1/tools: records what it was asked. */
async function fakeTools() {
	const asked = [];
	const url = await listen(createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		asked.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(req.url.endsWith("/search")
			? { results: [{ url: "https://www.3gpp.org/ftp/Specs", title: "3GPP Specs", snippet: "Specification archive", summary: "All series", date: "2026-10-01" },
				{ url: "https://example.com/x", title: "", snippet: "", date: null }] }
			: { content: "# Page\nhello" }));
	}));
	return { url, asked };
}

async function server(env, tools) {
	const cfg = loadConfig({ env: { DSH_FERRY_TOKEN: TOKEN, ...env } });
	if (tools) cfg.providers.deepseek.toolsBaseUrl = tools;
	return listen(createApp(cfg, { log: () => {} }).server);
}

test("web_search goes through the server, which adds its own DeepSeek key", async () => {
	const ds = await fakeTools();
	const url = await server({ DEEPSEEK_API_KEY: "sk-server-key" }, ds.url);
	const cfg = { server: url, token: TOKEN, features: ["gzip", "reasoning", "tools"] };
	const web = webProviders(cfg);
	assert.equal(web.search.available(), true);
	const result = await web.search.search({ query: "3GPP TS 38.331", maxResults: 5 });
	assert.deepEqual(result.sources[0], { url: "https://www.3gpp.org/ftp/Specs", title: "3GPP Specs", snippet: "Specification archive",
		summary: "All series", publishedAt: "2026-10-01" });
	assert.deepEqual(result.sources[1], { url: "https://example.com/x" });
	assert.deepEqual(ds.asked[0], { path: "/search", auth: "Bearer sk-server-key", body: { query: "3GPP TS 38.331", count: 5, need_content: false } });
	const page = await web.fetch.fetch({ url: "https://example.com/x" });
	assert.equal(page.body.content, "# Page\nhello");
	assert.equal(ds.asked[1].path, "/fetch");
});

test("the Ferry server's own search and page reading are used when that is what it offers", async () => {
	const asked = [];
	const url = await listen(createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		asked.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(req.url === "/v1/ferry/search"
			? { engine: "deepseek", results: [{ title: "TS 38.331", url: "https://www.3gpp.org/38331", snippet: "RRC", date: "" }] }
			: { url: "https://www.3gpp.org/38331", title: "TS 38.331", chars: 9, via: "direct", text: "RRC text.", next_offset: null }));
	}));
	const web = webProviders({ server: url, token: TOKEN, features: ["refs", "search", "extract", "read"] });
	assert.equal(web.search.available(), true);
	assert.deepEqual((await web.search.search({ query: "38.331", maxResults: 3 })).sources,
		[{ url: "https://www.3gpp.org/38331", title: "TS 38.331", snippet: "RRC" }]);
	assert.deepEqual(asked[0], { path: "/v1/ferry/search", body: { query: "38.331", count: 3 } });
	const page = await web.fetch.fetch({ url: "https://www.3gpp.org/38331" });
	assert.deepEqual([page.body.content, page.truncated, asked[1].path], ["RRC text.", false, "/v1/ferry/read"]);
});

test("the server says whether it can search; the provider is not offered when it cannot", async () => {
	const withKey = await server({ DEEPSEEK_API_KEY: "sk-server-key" });
	const without = await server({});
	const features = async (url) => (await (await fetch(`${url}/v1/ferry/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).features;
	assert.ok((await features(withKey)).includes("tools"));
	assert.ok(!(await features(without)).includes("tools"));
	assert.equal(webProviders({ server: without, token: TOKEN, features: ["gzip"] }).search.available(), false);
	const res = await fetch(`${without}/v1/tools/search`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" });
	assert.equal(res.status, 503);
});
