import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { probeLimit } from "../lib/probe.js";
import { startFakeFerry } from "./fake-server.js";

let server;
afterEach(() => server?.close());
const cfgOf = (f) => ({ server: f.url, token: f.state.token });

test("a gateway that stops bodies above 100 KB: the limit is found and the part size stays under it", async () => {
	server = await startFakeFerry({ blockAbove: 100 * 1024 });
	const lines = [];
	const r = await probeLimit(cfgOf(server), { say: (l) => lines.push(l) });
	assert.ok(r.limitKb >= 96 && r.limitKb <= 100, `limit ${r.limitKb} KB`);
	assert.equal(r.chunkBytes, 80 * 1024);
	assert.ok(lines.some((l) => l.includes("128 KB stopped (HTTP 403")));
});

test("nothing stopped up to 900 KB: size is not the problem", async () => {
	server = await startFakeFerry();
	assert.deepEqual(await probeLimit(cfgOf(server)), { limitKb: 900, chunkBytes: undefined });
});

test("an old server without the probe says so", async () => {
	server = await startFakeFerry({ noProbe: true });
	assert.deepEqual(await probeLimit(cfgOf(server)), { old: true });
});

test("dsh-llm-ferry probe --save keeps the size in ~/.ferry/config.json next to what was there", async () => {
	server = await startFakeFerry({ blockAbove: 60 * 1024 });
	const home = mkdtempSync(join(tmpdir(), "ferry-home-"));
	writeFileSync(join(home, "config.json"), JSON.stringify({ server: server.url, token: server.state.token }));
	const bin = new URL("../bin/dsh-llm-ferry.js", import.meta.url).pathname;
	const { stdout } = await promisify(execFile)(process.execPath, [bin, "probe", "--save"],
		{ env: { DSH_FERRY_DATA: "", ...process.env, FERRY_HOME: home, FERRY_SERVER: "", FERRY_TOKEN: "" } });
	assert.match(stdout, /The limit is about 5\d KB/);
	const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
	assert.equal(saved.server, server.url);
	assert.ok(saved.chunkBytes >= 40 * 1024 && saved.chunkBytes < 60 * 1024, `chunkBytes ${saved.chunkBytes}`);
});
