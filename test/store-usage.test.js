import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Conflict, Store } from "../server/store.js";
import { appendUsage, costOf, formatStats, normalize, readUsage, summarize, usageTap } from "../server/usage.js";

const M = ["{\"role\":\"system\",\"content\":\"s\"}", "{\"role\":\"user\",\"content\":\"hi\"}", "{\"role\":\"assistant\",\"content\":\"yo\"}"];

test("a store with a dir: conversations and tools come back in a new Store; dropping removes the file", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-ferry-store-"));
	const a = new Store({ dir });
	const ack = a.commit("u", "conv-1", 0, "", M.slice(0, 2), "[{\"name\":\"read\"}]");
	const toolsHash = [...a.tools.keys()][0].split("\0")[1];
	const b = new Store({ dir });
	assert.equal(b.sessions.size, 0);
	const got = b.load("u", "conv-1", ack.count, ack.hash, toolsHash);
	assert.deepEqual(got.messages.map((m) => m.role), ["system", "user"]);
	assert.deepEqual(got.tools, [{ name: "read" }]);
	// appending on the restarted server continues the chain
	const ack2 = b.commit("u", "conv-1", ack.count, ack.hash, [M[2]], null);
	assert.equal(ack2.count, 3);
	assert.equal(new Store({ dir }).load("u", "conv-1", 3, ack2.hash).messages.length, 3);
	// another user cannot see it
	assert.throws(() => b.load("v", "conv-1", ack.count, ack.hash), Conflict);
	b.drop("u\0conv-1");
	assert.throws(() => new Store({ dir }).load("u", "conv-1", 3, ack2.hash), Conflict);
	assert.ok(!readdirSync(dir).some((d) => readdirSync(join(dir, d)).some((f) => !f.startsWith("tools-"))));
});

test("start-up sweep: stale files and half-written temp files go, fresh ones stay; a broken file is not fatal", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-ferry-store-"));
	const a = new Store({ dir, sessionTtlMs: 1000 });
	const ack = a.commit("u", "old", 0, "", M.slice(0, 1), null);
	a.commit("u", "new", 0, "", M.slice(0, 1), null);
	const userDir = join(dir, readdirSync(dir)[0]);
	const old = join(userDir, readdirSync(userDir).find((f) => f.endsWith(".json")));
	const past = (Date.now() - 10_000) / 1000;
	utimesSync(old, past, past);
	writeFileSync(join(userDir, "x.json.tmp"), "half");
	writeFileSync(join(userDir, "broken.json"), "{not json");
	const errors = [];
	const b = new Store({ dir, sessionTtlMs: 1000, onError: (e) => errors.push(e.message) });
	assert.ok(!existsSync(old));
	assert.ok(!existsSync(join(userDir, "x.json.tmp")));
	assert.equal(readdirSync(userDir).filter((f) => f.endsWith(".json")).length, 2);
	const read = (conv) => { try { return b.load("u", conv, 1, ack.hash).messages.length; } catch { return "gone"; } };
	assert.deepEqual([read("old"), read("new")].sort(), [1, "gone"]);
	// a corrupt file is reported, removed, and answered as missing
	writeFileSync(b.sessionFile("u\0bad"), "{not json");
	assert.throws(() => b.load("u", "bad", 1, ack.hash), Conflict);
	assert.match(errors.join("\n"), /unreadable/);
	assert.ok(!existsSync(b.sessionFile("u\0bad")));
});

test("without a dir nothing touches the disk", () => {
	const s = new Store();
	s.commit("u", "c", 0, "", M, "[]");
	s.drop("u\0c");
	s.evict();
	assert.equal(s.dir, null);
});

test("usage: both API shapes normalised, cost from per-million prices", () => {
	assert.deepEqual(normalize({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900 }),
		{ input: 100, cache_read: 900, cache_write: 0, output: 50 });
	assert.deepEqual(normalize({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 200 } }),
		{ input: 800, cache_read: 200, cache_write: 0, output: 50 });
	assert.deepEqual(normalize({ input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 20, output_tokens: 7 }),
		{ input: 10, cache_read: 500, cache_write: 20, output: 7 });
	assert.equal(normalize({}), null);
	const price = { input: 0.3, output: 1.2, cache_read: 0.006 };
	assert.equal(costOf({ input: 1_000_000, cache_read: 0, cache_write: 0, output: 0 }, price), 0.3);
	assert.equal(costOf({ input: 100, cache_read: 900, cache_write: 0, output: 50 }, price), 0.0000954);
	assert.equal(costOf({ input: 5, output: 5 }, {}), 0);
});

test("usageTap reads the usage out of an SSE stream split anywhere, for OpenAI and for Anthropic", () => {
	const openai = usageTap("openai");
	const text = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":50,\"prompt_cache_hit_tokens\":900}}\n\ndata: [DONE]\n\n";
	for (let i = 0; i < text.length; i += 7) openai.write(new Uint8Array(Buffer.from(text.slice(i, i + 7))));
	assert.deepEqual(openai.usage(), { input: 100, cache_read: 900, cache_write: 0, output: 50 });

	const anthropic = usageTap("anthropic");
	anthropic.write(Buffer.from("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":500,\"output_tokens\":1}}}\n\n"));
	anthropic.write(Buffer.from("event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":70}}\n\n"));
	assert.deepEqual(anthropic.usage(), { input: 10, cache_read: 500, cache_write: 0, output: 70 });
	assert.equal(usageTap("openai").usage(), null);
});

test("usage file: appended, read back by age, summed by day and model, shown as a table", () => {
	const file = join(mkdtempSync(join(tmpdir(), "dsh-ferry-usage-")), "deep", "usage.jsonl");
	const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
	appendUsage(file, { at: day(0), model: "deepseek-flash", usage: { input: 100, cache_read: 900, cache_write: 0, output: 50 }, cost: 0.0001, ttft: 1200 });
	appendUsage(file, { at: day(0), model: "deepseek-v4-pro", usage: { input: 1000, cache_read: 0, cache_write: 0, output: 10 }, cost: 0.0014, ttft: 3400 });
	appendUsage(file, { at: day(40), model: "deepseek-flash", usage: { input: 1, cache_read: 0, cache_write: 0, output: 1 }, cost: 1 });
	writeFileSync(file, "not json\n", { flag: "a" });
	const records = readUsage(file, 30);
	assert.equal(records.length, 2);
	const s = summarize(records);
	assert.equal(s.days.length, 1);
	assert.deepEqual([s.total.calls, s.total.input, s.total.cache_read, s.total.output, s.total.cost], [2, 1100, 900, 60, 0.0015]);
	assert.equal(Math.round(s.total.hit * 100), 45);
	assert.deepEqual(s.models.map((m) => m.model), ["deepseek-v4-pro", "deepseek-flash"]);
	const text = formatStats(s, 30);
	assert.match(text, /last 30 days/);
	assert.match(text, /total\s+2\s+2000\s+45%\s+60\s+0\.00/);
	assert.match(text, /deepseek-flash\s+1\s+1000\s+90%\s+50\s+0\.00\s+1\.2s/);
	assert.match(text, /total\s.*\s3\.4s$/m); // the median of two is the upper one; old records without ttft leave the column blank
	assert.equal(summarize([{ at: day(0), model: "x", usage: {}, cost: 0 }]).total.ttft, null);
	assert.deepEqual(readUsage(join(file, "..", "missing.jsonl")), []);
});

test("version note: which side to update, nothing when equal or unknown", async () => {
	const { versionNote } = await import("../lib/models.js");
	assert.match(versionNote("0.11.0", "0.12.0"), /update the plugin/);
	assert.match(versionNote("0.12.0", "0.11.3"), /update the server/);
	assert.equal(versionNote("0.12.0", "0.12.0"), null);
	assert.equal(versionNote("0.12.0", null), null);
	assert.equal(versionNote("0.12.0", "dev"), null);
});
