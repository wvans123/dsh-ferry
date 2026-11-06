#!/usr/bin/env node
// dsh-llm-ferry probe [--save] [--server <url>] [--token <token>]
//   Finds how big a request gets through the network to the Ferry server and the part size to use;
//   --save keeps that size in ~/.ferry/config.json, where the plugin (and the ferry client) read it.
// dsh-llm-ferry serve [--config <file>] [--port <n>] [--host <addr>]
//   Runs the DSH Ferry server (server/): DeepSeek by default; see server/config.js for the settings.
import { readFileSync } from "node:fs";
import { readFerryConfig, saveChunkBytes } from "../lib/config.js";
import { probeLimit } from "../lib/probe.js";

const USAGE = "usage: dsh-llm-ferry probe [--save] [--server <url>] [--token <token>]\n" +
	"       dsh-llm-ferry serve [--config <file>] [--port <n>] [--host <addr>]";
const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === "serve") await serve();
else if (args[0] === "probe") await probe();
else {
	console.log(USAGE);
	process.exit(args[0] === "--help" || args[0] === "-h" ? 0 : 2);
}

async function serve() {
	const { loadConfig } = await import("../server/config.js");
	const { createApp } = await import("../server/app.js");
	let cfg;
	try {
		cfg = loadConfig({ file: flag("--config") });
	} catch (e) {
		console.error(`dsh-llm-ferry serve: ${e.message}`);
		process.exit(1);
	}
	if (flag("--port")) cfg.port = Number(flag("--port"));
	if (flag("--host")) cfg.host = flag("--host");
	const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
	const { server } = createApp(cfg, { version });
	server.listen(cfg.port, cfg.host, () => {
		console.error(`DSH Ferry server ${version} on http://${cfg.host}:${cfg.port}`);
		for (const [id, m] of cfg.models) {
			const p = cfg.providers[m.provider];
			console.error(`  ${id}${id === cfg.defaultModel ? " (auto)" : ""}: ${p.name} ${m.model}${p.apiKey ? "" : `  [no key: set ${p.keyEnv}]`}`);
		}
		console.error(`  users: ${cfg.users.map((u) => u.name).join(", ")}`);
	});
	const stop = () => server.close(() => process.exit(0));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

async function probe() {
	const cfg = readFerryConfig({ server: flag("--server"), token: flag("--token") });
	console.log(`Ferry server: ${cfg.server}; parts now at most ${Math.round(cfg.chunkBytes / 1024)} KB`);
	const result = await probeLimit(cfg, { say: (line) => console.log(`  ${line}`) });
	if (result.old) {
		console.log("This Ferry server has no upload test; update it.");
		process.exit(1);
	}
	if (!result.chunkBytes) {
		if (result.limitKb === 0) {
			console.log("Even 16 KB does not get through: this is not about size (token, address, or ask IT).");
			process.exit(1);
		}
		console.log(`Sizes up to ${result.limitKb} KB get through: size is not the problem here.`);
		process.exit(0);
	}
	const kb = Math.round(result.chunkBytes / 1024);
	console.log(`The limit is about ${result.limitKb} KB. Parts of ${kb} KB fit.`);
	if (args.includes("--save")) console.log(`Saved chunkBytes = ${result.chunkBytes} in ${saveChunkBytes(result.chunkBytes)}. Restart DSH to use it.`);
	else console.log(`To use it: dsh-llm-ferry probe --save   (or set chunkBytes: ${result.chunkBytes} in the plugin settings)`);
}
