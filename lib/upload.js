// Sending a conversation's new messages to the Ferry server in small requests, and what to do when one is stopped.
// Ported from ferry's client/lib/upload.mjs; keep the two in step.
//
// A company web gateway may stop request bodies above some size, answering HTTP 403 with its own page. So no body
// sent is bigger than the current part size: a commit that is bigger goes up in parts first, then a tiny commit names
// them. When a request is stopped, the part size is halved for the rest of the process and the part sent again (the
// server keeps parts by number, so a smaller part simply takes the place of a bigger one).
import { randomUUID } from "node:crypto";

export const MIN_CHUNK = 8 * 1024;
// The work PC's gateway stops bodies a little above 100 KB; parts stay under that with room to spare
export const DEFAULT_CHUNK = 80 * 1024;
export const MAX_TRIES = 3; // retries after the first attempt

/** Statuses of answers that did not come from the Ferry server (no JSON) and are worth sending again. */
const RETRY_STATUS = new Set([403, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

export const isJson = (res) => !!res.headers?.get?.("content-type")?.includes("json");

/** An answer from something in the way (gateway page, Cloudflare error page), not from the Ferry server. */
export const recoverableAnswer = (res) => !isJson(res) && RETRY_STATUS.has(res.status);

/** A network error that may go away: the connection dropped or timed out. Not our own abort. */
export function recoverableError(e, signal) {
	if (signal?.aborted || e?.name === "AbortError") return false;
	const text = `${e?.message ?? ""} ${e?.cause?.code ?? ""} ${e?.cause?.message ?? ""}`;
	return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|terminated|network/i.test(text);
}

/** Half the part size, never below 8 KB (and never above what was just sent). */
export const shrunk = (chunk, sent = chunk) => Math.max(MIN_CHUNK, Math.floor(Math.min(chunk, sent) / 2 / 1024) * 1024);

/**
 * The commit sender. state.chunk is the part size now (it only shrinks). deps:
 *   post(path, body, signal)   -> Response (may throw)
 *   sleep(ms), say(text)       -> backoff, a note for the log (said once)
 *   gatewayConfirm(res)        -> true when the answer is a gateway's "confirm in the browser" page (no resize helps)
 */
export function createUploader(state, deps) {
	const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	let said = false;

	async function attempt(path, body, signal) {
		let res;
		try {
			res = await deps.post(path, body, signal);
		} catch (e) {
			if (!recoverableError(e, signal)) throw e;
			return { error: e };
		}
		return { res };
	}

	/**
	 * Send `bytes` as a commit; returns the final Response. A stopped request is sent again (3 times at most, with a
	 * short wait), in smaller parts when it was a gateway's 403. The last stopped answer is returned for the caller to
	 * look at; a network error that stays throws an Error with the reason.
	 */
	async function commit(bytes, q, signal) {
		const before = state.chunk;
		try {
			return await send(bytes, q, signal);
		} finally {
			if (state.chunk < before && !said) {
				said = true;
				deps.say?.(`The network stopped a request (HTTP 403). Parts of at most ${Math.round(state.chunk / 1024)} KB from now on.`);
			}
		}
	}

	async function send(bytes, q, signal) {
		const total = bytes.length;
		let upload = null;
		let seq = 0;
		let offset = 0;
		let tries = 0;
		for (;;) {
			const finishing = upload && offset >= total;
			const direct = !upload && total <= state.chunk;
			let path;
			let body;
			if (direct) {
				path = `/v1/ferry/commit?${q}`;
				body = bytes;
			} else if (finishing) {
				const f = new URLSearchParams(q);
				f.set("upload", upload);
				f.set("parts", String(seq));
				path = `/v1/ferry/commit?${f}`;
				body = Buffer.alloc(0);
			} else {
				upload ??= randomUUID();
				path = `/v1/ferry/upload/${upload}/${seq}`;
				body = bytes.subarray(offset, offset + state.chunk);
			}
			const r = await attempt(path, body, signal);
			if (r.res && !recoverableAnswer(r.res)) {
				if (!r.res.ok || direct || finishing) return r.res;
				offset += body.length;
				seq++;
				tries = 0;
				continue;
			}
			// stopped on the way
			if ((r.res && deps.gatewayConfirm?.(r.res)) || tries >= MAX_TRIES) {
				if (r.res) return r.res;
				throw new Error(`could not reach the Ferry server (${r.error?.cause?.code ?? r.error?.message}) after ${tries + 1} tries`);
			}
			tries++;
			if (r.res?.status === 403 && body.length > MIN_CHUNK) state.chunk = Math.min(state.chunk, shrunk(state.chunk, body.length));
			await sleep(500 * 2 ** (tries - 1));
		}
	}
	return { commit };
}

/**
 * The largest size that passes, found by halving the gap between the last size that passed and the first that failed,
 * down to `precision` KB. test(kb) -> true when a body of that size gets through. Returns 0 when even `low` fails.
 */
export async function findLimit(test, passed, failed, precision = 8) {
	let lo = passed;
	let hi = failed;
	while (hi - lo > precision) {
		const mid = Math.round((lo + hi) / 2);
		if (await test(mid)) lo = mid;
		else hi = mid;
	}
	return lo;
}

/** A part size a little under the largest size that passed (a size on the edge may fail now and then), in bytes. */
export const suggestChunk = (passedKb) => Math.max(8, Math.floor((passedKb * 0.8) / 4) * 4) * 1024;
