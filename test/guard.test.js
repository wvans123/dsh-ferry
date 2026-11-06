import assert from "node:assert/strict";
import { test } from "node:test";
import { guardFetch, isModelApi, rerouteToFerry } from "../lib/guard.js";

async function collect(iterable) {
	const out = [];
	for await (const x of iterable) out.push(x);
	return out;
}

test("a request for another route is handed to Ferry: same model id when offered, else auto", async () => {
	const sent = [];
	const runtime = { stream: (o) => { sent.push(o); return (async function* () { yield { type: "finish", reason: { kind: "stop" } }; })(); } };
	const notes = [];
	const listener = rerouteToFerry("ferry", () => ["auto", "deepseek-flash"], async (m) => (m === "deepseek-flash" ? ["off", "low", "high", "max"] : ["off", "high"]),
		(t) => notes.push(t));
	let passed = false;
	await collect(listener.call(runtime, { provider: "ferry", model: "auto", messages: [] }, () => { passed = true; return (async function* () {})(); }));
	assert.ok(passed, "Ferry's own requests go on unchanged");
	assert.equal(sent.length, 0);

	await collect(listener.call(runtime, { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "low", messages: [] }, () => assert.fail("not the other adapter")));
	assert.deepEqual([sent[0].provider, sent[0].model, sent[0].reasoningEffort], ["ferry", "deepseek-flash", "low"]);
	await collect(listener.call(runtime, { provider: "free-models", model: "kimi-k3", reasoningEffort: "xhigh", messages: [] }, () => assert.fail()));
	assert.deepEqual([sent[1].provider, sent[1].model, sent[1].reasoningEffort], ["ferry", "auto", undefined]);
	assert.equal(notes.length, 2);
	assert.match(notes[1], /free-models\/kimi-k3 goes through Ferry as ferry\/auto/);
});

test("fetch to a model API is refused; the Ferry server and other sites are not", async () => {
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (input) => { calls.push(String(input?.url ?? input)); return new Response("ok"); };
	const notes = [];
	const restore = guardFetch("https://ferry.example.com", ["api.openai.com"], (t) => notes.push(t));
	try {
		await assert.rejects(fetch("https://api.deepseek.com/chat/completions", { method: "POST" }), /api\.deepseek\.com is a model API/);
		await assert.rejects(fetch(new URL("https://eu.api.anthropic.com/v1/messages")), /model API/);
		await assert.rejects(fetch(new Request("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")), /model API/);
		assert.equal((await fetch("https://ferry.example.com/v1/ferry/models")).status, 200);
		assert.equal((await fetch("https://www.3gpp.org/ftp/Specs")).status, 200);
		assert.equal((await fetch("https://api.openai.com/v1/models")).status, 200, "allowDirectHosts lets a host through");
		assert.deepEqual(calls, ["https://ferry.example.com/v1/ferry/models", "https://www.3gpp.org/ftp/Specs", "https://api.openai.com/v1/models"]);
		assert.equal(notes.length, 3);
	} finally {
		restore();
		globalThis.fetch = original;
	}
	assert.equal(isModelApi("api.deepseek.com"), true);
	assert.equal(isModelApi("deepseek.com"), false);
});
