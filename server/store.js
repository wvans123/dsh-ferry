// What the server keeps between requests, per user: each conversation's messages (as the JSON strings the plugin
// hashed) with their hash chain, tool lists by hash, and the parts of uploads not yet committed. Memory first; with
// a `dir`, conversations and tool lists are also written to disk and read back when the server has restarted, so DSH
// sessions do not upload everything again. Parts stay in memory. Whatever is gone (eviction, a missing file) makes
// the plugin get 409 and upload the conversation again in full.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export class Conflict extends Error {}

export class Store {
	/** limits: maxBytes (all conversations together), sessionTtlMs, partTtlMs, dir (persist here), onError(e). */
	constructor(limits = {}) {
		this.maxBytes = limits.maxBytes ?? 512 * 1024 * 1024;
		this.sessionTtlMs = limits.sessionTtlMs ?? 7 * 24 * 3600 * 1000;
		this.partTtlMs = limits.partTtlMs ?? 3600 * 1000;
		this.dir = limits.dir ?? null;
		this.onError = limits.onError ?? (() => {});
		this.sessions = new Map(); // user\0conv -> { msgs, chain, bytes, at }
		this.tools = new Map(); // user\0sha -> { json, at }
		this.parts = new Map(); // user\0upload -> { list, at }
		this.bytes = 0;
		if (this.dir) this.sweep();
	}

	/** Append messages after the first `base` ones, which must hash to `baseHash`. Returns { count, hash }. */
	commit(user, conv, base, baseHash, append, tools) {
		const key = `${user}\0${conv}`;
		let s = this.session(key);
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
		if (tools) {
			this.tools.set(`${user}\0${sha(tools)}`, { json: tools, at: Date.now() });
			if (this.dir) this.write(this.toolsFile(user, sha(tools)), tools);
		}
		if (this.dir) this.write(this.sessionFile(key), JSON.stringify(s.msgs));
		this.evict(key);
		return { count: s.msgs.length, hash: s.chain[s.msgs.length] };
	}

	/** The conversation's messages and tools for a model call; Conflict when they are not what the client expects. */
	load(user, conv, count, hash, toolsHash) {
		const s = this.session(`${user}\0${conv}`);
		if (!s || s.msgs.length < count || s.chain[count] !== hash) throw new Conflict("session not found; the client will resend");
		let tools = null;
		if (toolsHash) {
			const t = this.toolList(user, toolsHash);
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
		if (this.dir) this.remove(this.sessionFile(key));
	}

	/** Old entries out; then the least recently used conversations until all fit (never `keep`). */
	evict(keep) {
		const now = Date.now();
		for (const [k, s] of this.sessions) if (now - s.at > this.sessionTtlMs && k !== keep) this.drop(k);
		for (const [k, t] of this.tools) {
			if (now - t.at > this.sessionTtlMs) {
				this.tools.delete(k);
				const [user, h] = k.split("\0");
				if (this.dir) this.remove(this.toolsFile(user, h));
			}
		}
		for (const [k, p] of this.parts) if (now - p.at > this.partTtlMs) this.parts.delete(k);
		if (this.bytes <= this.maxBytes) return;
		// out of memory only: the file stays, so the conversation can come back from disk when it is used again
		for (const [k] of [...this.sessions].sort((a, b) => a[1].at - b[1].at)) {
			if (this.bytes <= this.maxBytes) break;
			if (k !== keep) {
				this.bytes -= this.sessions.get(k).bytes;
				this.sessions.delete(k);
			}
		}
	}

	// ---- disk ----

	/** A conversation from memory, or read back from its file. */
	session(key) {
		let s = this.sessions.get(key);
		if (s || !this.dir) return s;
		const text = this.read(this.sessionFile(key));
		if (!text) return undefined;
		try {
			const msgs = JSON.parse(text);
			if (!Array.isArray(msgs) || msgs.some((m) => typeof m !== "string")) throw new Error("not a message list");
			const chain = [""];
			for (const m of msgs) chain.push(sha(chain[chain.length - 1] + m));
			s = { msgs, chain, bytes: msgs.reduce((n, m) => n + m.length, 0), at: Date.now() };
		} catch (e) {
			this.onError(new Error(`unreadable ${this.sessionFile(key)}: ${e.message}`));
			this.remove(this.sessionFile(key));
			return undefined;
		}
		this.sessions.set(key, s);
		this.bytes += s.bytes;
		return s;
	}

	toolList(user, hash) {
		const key = `${user}\0${hash}`;
		let t = this.tools.get(key);
		if (t || !this.dir) return t;
		const json = this.read(this.toolsFile(user, hash));
		if (!json) return undefined;
		t = { json, at: Date.now() };
		this.tools.set(key, t);
		return t;
	}

	userDir(user) {
		return join(this.dir, sha(user).slice(0, 32));
	}

	sessionFile(key) {
		const [user, conv] = key.split("\0");
		return join(this.userDir(user), `${sha(conv)}.json`);
	}

	toolsFile(user, hash) {
		return join(this.userDir(user), `tools-${/^[0-9a-f]{64}$/.test(hash) ? hash : sha(hash)}.json`);
	}

	read(file) {
		if (!this.dir || !existsSync(file)) return null;
		try {
			return readFileSync(file, "utf8");
		} catch (e) {
			this.onError(e);
			return null;
		}
	}

	/** Whole file, written beside and renamed into place: a crash mid-write leaves the old copy, not half a new one. */
	write(file, text) {
		if (!this.dir) return;
		try {
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(`${file}.tmp`, text);
			renameSync(`${file}.tmp`, file);
		} catch (e) {
			this.onError(e);
		}
	}

	remove(file) {
		if (!this.dir) return;
		try {
			rmSync(file, { force: true });
		} catch (e) {
			this.onError(e);
		}
	}

	/** At start: files older than the session TTL, and leftovers of interrupted writes, go. */
	sweep() {
		try {
			mkdirSync(this.dir, { recursive: true });
			const now = Date.now();
			for (const user of readdirSync(this.dir)) {
				const dir = join(this.dir, user);
				if (!statSync(dir).isDirectory()) continue;
				for (const f of readdirSync(dir)) {
					const file = join(dir, f);
					if (f.endsWith(".tmp") || now - statSync(file).mtimeMs > this.sessionTtlMs) rmSync(file, { force: true });
				}
			}
		} catch (e) {
			this.onError(e);
		}
	}
}
