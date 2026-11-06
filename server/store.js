// What the server keeps between requests, per user: each conversation's messages (as the JSON strings the plugin
// hashed) with their hash chain, tool lists by hash, and the parts of uploads not yet committed. Memory only: when a
// conversation is gone (restart, eviction) the plugin gets 409 and uploads it again in full.
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export class Conflict extends Error {}

export class Store {
	/** limits: maxBytes (all conversations together), sessionTtlMs, partTtlMs. */
	constructor(limits = {}) {
		this.maxBytes = limits.maxBytes ?? 512 * 1024 * 1024;
		this.sessionTtlMs = limits.sessionTtlMs ?? 7 * 24 * 3600 * 1000;
		this.partTtlMs = limits.partTtlMs ?? 3600 * 1000;
		this.sessions = new Map(); // user\0conv -> { msgs, chain, bytes, at }
		this.tools = new Map(); // user\0sha -> { json, at }
		this.parts = new Map(); // user\0upload -> { list, at }
		this.bytes = 0;
	}

	/** Append messages after the first `base` ones, which must hash to `baseHash`. Returns { count, hash }. */
	commit(user, conv, base, baseHash, append, tools) {
		const key = `${user}\0${conv}`;
		let s = this.sessions.get(key);
		if (base === 0) {
			if (s) this.drop(key);
			s = { msgs: [], chain: [""], bytes: 0, at: Date.now() };
			this.sessions.set(key, s);
		} else if (!s || base > s.msgs.length || s.chain[base] !== baseHash) {
			throw new Conflict("conversation not found or changed; the client will resend");
		}
		if (base < s.msgs.length) { // the conversation went back (an edit, a retry): forget what came after
			for (const m of s.msgs.splice(base)) s.bytes -= m.length;
			s.chain.length = base + 1;
		}
		for (const m of append) {
			if (typeof m !== "string") throw new Error("append items must be JSON strings");
			s.msgs.push(m);
			s.chain.push(sha(s.chain[s.chain.length - 1] + m));
			s.bytes += m.length;
		}
		this.bytes = [...this.sessions.values()].reduce((n, x) => n + x.bytes, 0);
		s.at = Date.now();
		if (tools) this.tools.set(`${user}\0${sha(tools)}`, { json: tools, at: Date.now() });
		this.evict(key);
		return { count: s.msgs.length, hash: s.chain[s.msgs.length] };
	}

	/** The conversation's messages and tools for a model call; Conflict when they are not what the client expects. */
	load(user, conv, count, hash, toolsHash) {
		const s = this.sessions.get(`${user}\0${conv}`);
		if (!s || s.msgs.length < count || s.chain[count] !== hash) throw new Conflict("session not found; the client will resend");
		let tools = null;
		if (toolsHash) {
			const t = this.tools.get(`${user}\0${toolsHash}`);
			if (!t) throw new Conflict("tools not found; the client will resend");
			t.at = Date.now();
			tools = JSON.parse(t.json);
		}
		s.at = Date.now();
		return { messages: s.msgs.slice(0, count).map((m) => JSON.parse(m)), tools };
	}

	putPart(user, upload, seq, body) {
		const key = `${user}\0${upload}`;
		const p = this.parts.get(key) ?? { list: [], at: Date.now() };
		p.list[seq] = body;
		p.at = Date.now();
		this.parts.set(key, p);
	}

	/** The upload's first `count` parts joined, then forgotten. */
	takeParts(user, upload, count) {
		const key = `${user}\0${upload}`;
		const p = this.parts.get(key);
		if (!p) throw new Error("upload not found");
		const list = p.list.slice(0, count);
		if (list.length !== count || list.some((b) => !b)) throw new Error(`upload incomplete: ${list.filter(Boolean).length} of ${count} parts`);
		this.parts.delete(key);
		return Buffer.concat(list);
	}

	drop(key) {
		const s = this.sessions.get(key);
		if (s) this.bytes -= s.bytes;
		this.sessions.delete(key);
	}

	/** Old entries out; then the least recently used conversations until all fit (never `keep`). */
	evict(keep) {
		const now = Date.now();
		for (const [k, s] of this.sessions) if (now - s.at > this.sessionTtlMs && k !== keep) this.drop(k);
		for (const [k, t] of this.tools) if (now - t.at > this.sessionTtlMs) this.tools.delete(k);
		for (const [k, p] of this.parts) if (now - p.at > this.partTtlMs) this.parts.delete(k);
		if (this.bytes <= this.maxBytes) return;
		for (const [k] of [...this.sessions].sort((a, b) => a[1].at - b[1].at)) {
			if (this.bytes <= this.maxBytes) break;
			if (k !== keep) this.drop(k);
		}
	}
}
