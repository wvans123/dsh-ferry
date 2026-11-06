// Where the Ferry server is and the token for it. The plugin's own settings win; otherwise the same places the ferry
// client reads: FERRY_SERVER / FERRY_TOKEN, <FERRY_HOME>/config.json (written by `ferry login`), and the zero-config
// server on this computer (<FERRY_HOME>/local-server.json).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const readJson = (file) => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
};

export function readFerryConfig(options = {}, env = process.env) {
	const home = env.FERRY_HOME ?? join(homedir(), ".ferry");
	const saved = readJson(join(home, "config.json")) ?? {};
	let server = options.server || env.FERRY_SERVER || saved.server || "";
	let token = options.token || env.FERRY_TOKEN || saved.token || "";
	if (!server) {
		const local = readJson(join(home, "local-server.json"));
		server = local?.url ?? `http://127.0.0.1:${env.FERRY_PORT ?? 8787}`;
		token ||= local?.token ?? "";
	}
	return {
		server: String(server).replace(/\/+$/, ""),
		token: String(token),
		chunkBytes: Number(options.chunkBytes ?? saved.chunkBytes) || 512 * 1024,
		headers: saved.headers ?? {},
		project: options.project ?? env.FERRY_PROJECT ?? "",
		refreshMinutes: Number(options.refreshMinutes) || 5,
	};
}
