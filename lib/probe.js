// How big a request gets through the network between this computer and the Ferry server. Sends plain filler text of
// growing sizes to the server's /v1/ferry/probe (it reads the body and throws it away), then narrows down the limit.
// The same test as `ferry doctor --upload`.
import { findLimit, suggestChunk } from "./upload.js";

export const LADDER = [16, 64, 128, 256, 512, 900]; // KB; 900 stays under the server's 1 MB body limit

/**
 * cfg: { server, token, headers }. deps: fetch, say(line). Resolves to
 * { limitKb, chunkBytes } (chunkBytes: the part size to use, undefined when size is not the problem),
 * or { old: true } when the server has no probe.
 */
export async function probeLimit(cfg, deps = {}) {
	const fetchImpl = deps.fetch ?? ((...a) => fetch(...a));
	const say = deps.say ?? (() => {});
	const send = async (kb) => {
		const body = "ferry upload test ".repeat(Math.ceil((kb * 1024) / 18)).slice(0, kb * 1024);
		try {
			const res = await fetchImpl(`${cfg.server}/v1/ferry/probe`, { method: "POST", body, redirect: "manual",
				headers: { ...(cfg.headers ?? {}), "x-ferry-protocol": "1", "Content-Type": "application/octet-stream",
					...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
				signal: AbortSignal.timeout(60000) });
			if (res.status === 404) return "old";
			if (res.ok && res.headers.get("content-type")?.includes("json")) return true;
			return `HTTP ${res.status}${res.headers.get("server") ? ` from ${res.headers.get("server")}` : ""}`;
		} catch (e) {
			return e.cause?.code ?? e.message;
		}
	};
	let passed = 0;
	let failed = 0;
	for (const kb of LADDER) {
		const r = await send(kb);
		if (r === "old") return { old: true };
		say(r === true ? `${kb} KB gets through` : `${kb} KB stopped (${r})`);
		if (r !== true) {
			failed = kb;
			break;
		}
		passed = kb;
	}
	if (!failed) return { limitKb: passed, chunkBytes: undefined };
	say(`looking for the limit between ${passed} KB and ${failed} KB ...`);
	const limitKb = await findLimit(async (kb) => {
		const ok = (await send(kb)) === true;
		say(`  ${kb} KB: ${ok ? "gets through" : "stopped"}`);
		return ok;
	}, passed, failed, 4);
	return { limitKb, chunkBytes: limitKb ? suggestChunk(limitKb) : undefined };
}
