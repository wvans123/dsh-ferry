import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFerryConfig } from "../lib/config.js";

const home = (files) => {
	const dir = mkdtempSync(join(tmpdir(), "ferry-home-"));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body));
	return dir;
};

test("ferry login's config is used when the plugin has no settings", () => {
	const FERRY_HOME = home({ "config.json": { server: "https://ferry.example/", token: "t-from-login" } });
	const cfg = readFerryConfig({}, { FERRY_HOME });
	assert.equal(cfg.server, "https://ferry.example");
	assert.equal(cfg.token, "t-from-login");
});

test("plugin settings win over the environment, the environment over ferry login", () => {
	const FERRY_HOME = home({ "config.json": { server: "https://a", token: "a" } });
	const env = { FERRY_HOME, FERRY_SERVER: "https://b", FERRY_TOKEN: "b" };
	assert.equal(readFerryConfig({}, env).server, "https://b");
	assert.equal(readFerryConfig({ server: "https://c", token: "c" }, env).token, "c");
});

test("no server set: the Ferry server on this computer", () => {
	const FERRY_HOME = home({ "local-server.json": { url: "http://127.0.0.1:9999", token: "local" } });
	assert.deepEqual([readFerryConfig({}, { FERRY_HOME }).server, readFerryConfig({}, { FERRY_HOME }).token],
		["http://127.0.0.1:9999", "local"]);
	assert.equal(readFerryConfig({}, { FERRY_HOME: home({}) }).server, "http://127.0.0.1:8787");
});
