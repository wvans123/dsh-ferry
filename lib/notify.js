// Phone notifications (Bark) for things worth looking up for: a long task finished, or an approval nobody has answered
// for a minute. Sent to the server (POST /v1/ferry/notify), which holds the Bark address and pushes; this computer
// talks to nothing but the server. The Ferry server and the DSH Ferry server both take it.
const minutes = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`);
const OUTCOME = { completed: "完成了", error: "出错停下了", aborted: "被停止了" };

/**
 * cfg: { server, token, headers, notifyAfterSeconds, approvalNotifySeconds } (0 turns either off).
 * deps: fetch, say(text), setTimeout/clearTimeout (tests). Returns { onEvent(session, event), send }.
 */
export function createNotifier(cfg, deps = {}) {
	const fetchImpl = deps.fetch ?? ((...a) => fetch(...a));
	const later = deps.setTimeout ?? setTimeout;
	const cancel = deps.clearTimeout ?? clearTimeout;
	const sessions = new Map(); // session id -> { started, title }
	const waiting = new Map(); // approval id -> timer
	let warned = false;

	async function send(title, body, kind) {
		try {
			const res = await fetchImpl(`${cfg.server}/v1/ferry/notify`, {
				method: "POST",
				headers: { ...(cfg.headers ?? {}), "content-type": "application/json", "x-ferry-protocol": "1", authorization: `Bearer ${cfg.token}` },
				body: JSON.stringify({ title, body, kind }),
			});
			const answer = await res.json().catch(() => ({}));
			if (!res.ok || answer.ok === false) throw new Error(answer.error?.message ?? answer.error ?? `HTTP ${res.status}`);
		} catch (e) {
			if (!warned) deps.say?.(`phone notification not sent: ${e.message}`);
			warned = true;
		}
	}

	function onEvent(session, event) {
		if (session?.header?.origin === "subagent") return; // the parent's own turn reports the outcome
		const id = String(session?.id ?? "");
		const s = sessions.get(id) ?? { started: 0, title: "" };
		sessions.set(id, s);
		const after = Number(cfg.notifyAfterSeconds ?? 60) * 1000;
		const approvalAfter = Number(cfg.approvalNotifySeconds ?? 60) * 1000;
		switch (event?.type) {
			case "session/title":
				s.title = String(event.data?.title ?? "").slice(0, 60);
				break;
			case "turn/start":
				s.started = event.time ?? Date.now();
				break;
			case "turn/end": {
				const took = (event.time ?? Date.now()) - s.started;
				const kind = event.data?.reason?.kind;
				if (after > 0 && s.started && took >= after && OUTCOME[kind]) {
					void send(`DSH ${OUTCOME[kind]}`, `${s.title || "任务"} · 用时 ${minutes(took)}`, "done");
				}
				s.started = 0;
				break;
			}
			case "approval/asked":
				if (approvalAfter > 0 && event.data?.id) {
					const tool = String(event.data.toolName ?? "");
					waiting.set(event.data.id, later(() => {
						waiting.delete(event.data.id);
						void send("DSH 等你批准", `${s.title || "任务"} · ${tool}`, "approval");
					}, approvalAfter));
				}
				break;
			case "approval/decided": {
				const timer = waiting.get(event.data?.id);
				if (timer !== undefined) cancel(timer);
				waiting.delete(event.data?.id);
				break;
			}
		}
	}

	return { onEvent, send };
}
