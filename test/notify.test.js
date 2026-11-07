import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { createNotifier } from "../lib/notify.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";

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

/** A stand-in for api.day.app/<key>: records each push. */
async function fakeBark() {
	const pushes = [];
	const url = await listen(createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		pushes.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ code: 200, message: "success" }));
	}));
	return { url: `${url}/test-key`, pushes };
}

const session = (id, origin) => ({ id, header: { origin } });
const ev = (type, time, data = {}) => ({ type, time, data });

test("a long task that ends, and an approval left waiting, reach the phone; short tasks and answered approvals do not", async () => {
	const sent = [];
	const timers = new Map();
	let next = 0;
	const n = createNotifier({ server: "http://s", token: "t", notifyAfterSeconds: 60, approvalNotifySeconds: 60 }, {
		fetch: async (url, init) => { sent.push({ url, ...JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true })); },
		setTimeout: (fn) => { const id = ++next; timers.set(id, fn); return id; },
		clearTimeout: (id) => timers.delete(id),
	});
	const s = session("s1");
	n.onEvent(s, ev("session/title", 0, { title: "整理 38.331 RRC 重配置" }));
	n.onEvent(s, ev("turn/start", 1_000));
	n.onEvent(s, ev("turn/end", 20_000, { reason: { kind: "completed" } })); // 19 s: no
	n.onEvent(s, ev("turn/start", 30_000));
	n.onEvent(s, ev("approval/asked", 31_000, { id: "a1", toolName: "bash" }));
	n.onEvent(s, ev("approval/decided", 40_000, { id: "a1", outcome: "allowed-once" })); // answered: no
	n.onEvent(s, ev("approval/asked", 41_000, { id: "a2", toolName: "write" }));
	for (const fn of timers.values()) fn(); // a minute passes with a2 unanswered
	n.onEvent(s, ev("turn/end", 30_000 + 5 * 60_000, { reason: { kind: "error" } }));
	n.onEvent(session("child", "subagent"), ev("turn/start", 0));
	n.onEvent(session("child", "subagent"), ev("turn/end", 10 * 60_000, { reason: { kind: "completed" } })); // a subagent: no
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(sent.map((x) => [x.url, x.title, x.body, x.kind]), [
		["http://s/v1/ferry/notify", "DSH 等你批准", "整理 38.331 RRC 重配置 · write", "approval"],
		["http://s/v1/ferry/notify", "DSH 出错停下了", "整理 38.331 RRC 重配置 · 用时 5 分钟", "done"],
	]);
});

test("the server pushes through Bark; approvals are time-sensitive; no Bark address is said plainly", async () => {
	const bark = await fakeBark();
	const url = await listen(createApp(loadConfig({ env: { DSH_FERRY_DATA: "", DSH_FERRY_TOKEN: TOKEN, BARK_URL: bark.url } }), { log: () => {} }).server);
	const n = createNotifier({ server: url, token: TOKEN });
	await n.send("DSH 等你批准", "任务 · bash", "approval");
	await n.send("DSH 完成了", "任务 · 用时 3 分钟", "done");
	assert.deepEqual(bark.pushes.map((p) => [p.path, p.body.title, p.body.level, p.body.group]), [
		["/test-key", "DSH 等你批准", "timeSensitive", "DSH"], ["/test-key", "DSH 完成了", undefined, "DSH"]]);

	const bare = await listen(createApp(loadConfig({ env: { DSH_FERRY_DATA: "", DSH_FERRY_TOKEN: TOKEN } }), { log: () => {} }).server);
	const said = [];
	const quiet = createNotifier({ server: bare, token: TOKEN }, { say: (t) => said.push(t) });
	await quiet.send("x", "y", "done");
	await quiet.send("x", "y", "done");
	assert.equal(said.length, 1, "said once, not every time");
	assert.match(said[0], /no Bark address/);
});
