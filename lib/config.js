// Where the Ferry server is and the token for it. The plugin's own settings win; otherwise the same places the ferry
// client reads: FERRY_SERVER / FERRY_TOKEN, <FERRY_HOME>/config.json (written by `ferry login`, `ferry config set` and
// `dsh-llm-ferry probe --save`), and the zero-config server on this computer (<FERRY_HOME>/local-server.json).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHUNK, MIN_CHUNK } from "./upload.js";

const readJson = (file) => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
};

const ferryHome = (env) => env.FERRY_HOME ?? join(homedir(), ".ferry");

export function readFerryConfig(options = {}, env = process.env) {
	const home = ferryHome(env);
	const saved = readJson(join(home, "config.json")) ?? {};
	let server = options.server || env.FERRY_SERVER || saved.server || "";
	let token = options.token || env.FERRY_TOKEN || saved.token || "";
	if (!server) {
		const local = readJson(join(home, "local-server.json"));
		server = local?.url ?? `http://127.0.0.1:${env.FERRY_PORT ?? 8787}`;
		token ||= local?.token ?? "";
	}
	const chunk = Number(options.chunkBytes || env.FERRY_CHUNK_BYTES || saved.chunkBytes) || DEFAULT_CHUNK;
	return {
		server: String(server).replace(/\/+$/, ""),
		token: String(token),
		chunkBytes: Math.max(MIN_CHUNK, chunk),
		headers: saved.headers ?? {},
		project: options.project ?? env.FERRY_PROJECT ?? "",
		compress: options.compress ?? true,
		notifyAfterSeconds: options.notifyAfterSeconds ?? 60,
		approvalNotifySeconds: options.approvalNotifySeconds ?? 60,
		allowDirectHosts: Array.isArray(options.allowDirectHosts) ? options.allowDirectHosts.map((h) => String(h).toLowerCase()) : [],
		refreshMinutes: Number(options.refreshMinutes) || 5,
	};
}

/** Keep a measured part size in <FERRY_HOME>/config.json, where the ferry client reads it too. Returns the file. */
export function saveChunkBytes(bytes, env = process.env) {
	const home = ferryHome(env);
	const file = join(home, "config.json");
	mkdirSync(home, { recursive: true });
	writeFileSync(file, JSON.stringify({ ...(readJson(file) ?? {}), chunkBytes: bytes }, null, 2), { encoding: "utf8", mode: 0o600 });
	return file;
}
