// `dsh-llm-ferry doctor`: what stands between this (work) computer and a working DSH + Ferry, checked in one go.
// Each finding says what to do next. deps (tests): fetch, exec(cmd, args) -> stdout, env, platform, home, exists, read.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { readFerryConfig } from "./config.js";
import { probeLimit } from "./probe.js";

/** The llm-ferry entry's settings from a profile's cordis.patch.yml (flat keys only; no YAML library). */
export function patchSettings(text) {
	const out = {};
	const lines = String(text ?? "").split(/\r?\n/);
	const start = lines.findIndex((l) => /^\s*-\s*id:\s*['"]?llm-ferry['"]?\s*$/.test(l));
	if (start < 0) return out;
	for (const line of lines.slice(start + 1)) {
		if (/^\s*-\s/.test(line)) break; // the next entry
		const m = line.match(/^\s{4,}(server|token|chunkBytes|compress)\s*:\s*(.+?)\s*$/);
		if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
	}
	if (out.chunkBytes) out.chunkBytes = Number(out.chunkBytes);
	if (out.compress) out.compress = out.compress !== "false";
	return out;
}

const mask = (t) => (t ? `${t.slice(0, 4)}…${t.slice(-2)} (${t.length} chars)` : "(none)");

/**
 * options: { profile, workspaces[], upload, server, token }. Returns { lines: [{ level: "ok"|"warn"|"fail"|"info", text }],
 * failed }. Never throws for a failed check.
 */
export async function doctor(options = {}, deps = {}) {
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const home = deps.home ?? homedir();
	const exists = deps.exists ?? existsSync;
	const read = deps.read ?? ((f) => readFileSync(f, "utf8"));
	const exec = deps.exec ?? ((cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }));
	const fetchImpl = deps.fetch ?? ((...a) => fetch(...a));
	const lines = [];
	const say = (level, text) => lines.push({ level, text });

	// 1. the plugin in the DSH profile
	const dshHome = env.DSH_HOME || join(home, ".dsh");
	const profile = options.profile ?? (exists(join(dshHome, "profiles", "desktop")) ? "desktop" : "web");
	const profileDir = join(dshHome, "profiles", profile);
	const pkg = join(profileDir, "node_modules", "dsh-llm-ferry", "package.json");
	if (exists(pkg)) say("ok", `plugin dsh-llm-ferry ${JSON.parse(read(pkg)).version} is installed in DSH profile "${profile}"`);
	else say("fail", `dsh-llm-ferry is not installed in ${profileDir}: dsh plugin --profile ${profile} add github:wvans123/dsh-ferry`);
	const patchFile = join(profileDir, "cordis.patch.yml");
	const fromPatch = exists(patchFile) ? patchSettings(read(patchFile)) : {};

	// 2. where the server and token come from
	const cfg = readFerryConfig({ ...fromPatch, ...(options.server ? { server: options.server } : {}), ...(options.token ? { token: options.token } : {}) }, env);
	const source = options.server ? "--server" : fromPatch.server ? patchFile : env.FERRY_SERVER ? "FERRY_SERVER" : "~/.ferry/config.json or the default";
	say(cfg.token ? "ok" : "fail", `server ${cfg.server} (from ${source}), token ${mask(cfg.token)}`);
	if (!cfg.token) say("info", `put server and token under "- id: llm-ferry" in ${patchFile} (see docs/SETUP.md)`);

	// 3. company proxy and certificates
	const dotEnv = exists(join(dshHome, ".env")) ? read(join(dshHome, ".env")) : "";
	const proxy = env.HTTPS_PROXY || env.https_proxy || (dotEnv.match(/^\s*HTTPS_PROXY\s*=\s*(\S+)/im) ?? [])[1];
	say("info", proxy ? `proxy: ${proxy}` : "proxy: none set (fine if this network needs none; else setx HTTPS_PROXY \"http://<proxy>:<port>\")");
	const ca = env.NODE_EXTRA_CA_CERTS;
	if (ca && !exists(ca)) say("fail", `NODE_EXTRA_CA_CERTS points to ${ca}, which does not exist`);
	else if (ca) say("ok", `extra certificates: ${ca}`);
	else if (env.NODE_USE_SYSTEM_CA === "1") say("ok", "certificates: the system store (NODE_USE_SYSTEM_CA=1)");
	else say("info", "certificates: Node's own only; behind a proxy that inspects HTTPS, setx NODE_USE_SYSTEM_CA 1");

	// 4. the server: reachable, really the Ferry server, token accepted
	let ok = false;
	try {
		const started = Date.now();
		const h = await fetchImpl(`${cfg.server}/health`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
		const ms = Date.now() - started;
		if (!h.headers.get("content-type")?.includes("json")) {
			const where = h.headers.get("location");
			say("fail", `${cfg.server}/health answered HTTP ${h.status} that is not the Ferry server${where ? ` (sent to ${where})` : ""}: ` +
				"probably the company gateway's confirmation page; open the server address in the browser, confirm, run doctor again");
		} else {
			const body = await h.json();
			say("ok", `server answers in ${ms} ms: ${body.server ?? "ferry"} ${body.version ?? ""}`.trim());
			const m = await fetchImpl(`${cfg.server}/v1/ferry/models`, { headers: { authorization: `Bearer ${cfg.token}`, "x-ferry-protocol": "1" },
				signal: AbortSignal.timeout(20_000) });
			if (m.status === 401) say("fail", "the server turned the token down: it must equal the server's DSH_FERRY_TOKEN");
			else if (!m.ok) say("fail", `model list: HTTP ${m.status}`);
			else {
				const list = await m.json();
				const ready = (list.models ?? []).filter((x) => x.ready !== false);
				say(ready.length ? "ok" : "fail", `models: ${(list.models ?? []).map((x) => x.id).join(", ") || "none"}` +
					(ready.length ? "" : " (none ready: the server has no API key)"));
				say("info", `server can: ${(list.features ?? []).join(", ") || "basic sync only"}`);
				ok = ready.length > 0;
			}
		}
	} catch (e) {
		const why = e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.cause?.message ?? e.message;
		say("fail", `cannot reach ${cfg.server}: ${why} (proxy, certificates, or the server is down)`);
	}

	// 5. how big a request gets through (optional: sends test data)
	if (options.upload && ok) {
		const r = await probeLimit(cfg, { fetch: fetchImpl });
		if (r.chunkBytes) say(cfg.chunkBytes <= r.chunkBytes ? "ok" : "warn", `the network stops requests above about ${r.limitKb} KB; parts are ${Math.round(cfg.chunkBytes / 1024)} KB` +
			(cfg.chunkBytes <= r.chunkBytes ? "" : `: too big, run dsh-llm-ferry probe --save`));
		else if (r.limitKb) say("ok", `requests up to ${r.limitKb} KB get through`);
	}

	// 6. Windows: the sandbox's Low integrity label on workspaces, PowerShell 7, ripgrep
	if (platform === "win32") {
		for (const w of options.workspaces ?? []) {
			const dir = win32.resolve(w);
			const broad = dir === win32.parse(dir).root || [home, ...["Desktop", "Documents", "Downloads"].map((d) => win32.join(home, d))]
				.some((b) => b.toLowerCase() === dir.toLowerCase());
			if (broad) say("warn", `${dir} is too broad for a DSH workspace: the sandbox marks everything under it; use a folder of its own`);
			try {
				const acl = exec("icacls", [dir]);
				if (/Low Mandatory Level/i.test(acl)) {
					say("warn", `${dir} carries the DSH sandbox's Low integrity label: files in it count as "from the Internet" (Office Protected View, ` +
						`build tools "Access is denied"). With DSH closed: icacls "${dir}" /setintegritylevel "(OI)(CI)Medium" /T /C`);
				} else say("ok", `${dir}: no Low integrity label`);
			} catch (e) {
				say("info", `could not read the label of ${dir}: ${e.message.split("\n")[0]}`);
			}
		}
		const has = (cmd) => { try { exec("where.exe", [cmd]); return true; } catch { return false; } };
		say(has("pwsh") ? "ok" : "warn", has("pwsh") ? "PowerShell 7 (pwsh) is there" : "no PowerShell 7: DSH falls back to Windows PowerShell 5.1 (no &&, odd quoting); install PowerShell 7 if allowed");
		say(has("rg") ? "ok" : "info", has("rg") ? "ripgrep (rg) is there" : "no ripgrep (rg): searches are slower; winget install BurntSushi.ripgrep.MSVC if allowed");
	}

	return { lines, failed: lines.some((l) => l.level === "fail") };
}
