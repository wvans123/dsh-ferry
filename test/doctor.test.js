import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { doctor, patchSettings } from "../lib/doctor.js";
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

const PATCH = (server, token) => `- id: agent-default-model
  config:
    provider: ferry
- id: llm-ferry
  config:
    server: ${server}
    token: '${token}'
    chunkBytes: 65536
- id: something-else
  config:
    server: http://not-this
`;

/** A pretend Windows home with DSH's desktop profile, the plugin installed and a patch file. */
function machine(files, extra = {}) {
	return {
		home: "C:\\Users\\me", platform: "win32", env: { DSH_HOME: "/dsh" }, exists: (f) => f in files,
		read: (f) => files[f], ...extra,
	};
}

test("the llm-ferry entry is read from a profile's patch file, and only that entry", () => {
	assert.deepEqual(patchSettings(PATCH("https://ferry.example", "abc")), { server: "https://ferry.example", token: "abc", chunkBytes: 65536 });
	assert.deepEqual(patchSettings("- id: other\n  config:\n    server: x\n"), {});
});

test("all good: plugin, server, token, models; Windows: a labelled workspace, a too-broad one, no PowerShell 7", async () => {
	const url = await listen(createApp(loadConfig({ env: { DSH_FERRY_TOKEN: TOKEN, DEEPSEEK_API_KEY: "sk-x" } }), { log: () => {} }).server);
	const files = {
		"/dsh/profiles/desktop": true,
		"/dsh/profiles/desktop/node_modules/dsh-llm-ferry/package.json": JSON.stringify({ version: "9.9.9" }),
		"/dsh/profiles/desktop/cordis.patch.yml": PATCH(url, TOKEN),
	};
	const ran = [];
	const { lines, failed } = await doctor({ workspaces: ["D:\\work\\specs", "C:\\Users\\me\\Desktop"] }, machine(files, {
		exec: (cmd, args) => {
			ran.push([cmd, ...args].join(" "));
			if (cmd === "icacls" && args[0].includes("specs")) return "D:\\work\\specs Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)\n";
			if (cmd === "icacls") return "C:\\Users\\me\\Desktop NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n";
			if (cmd === "where.exe" && args[0] === "rg") return "C:\\tools\\rg.exe";
			throw new Error("not found");
		},
	}));
	const text = lines.map((l) => `${l.level} ${l.text}`).join("\n");
	assert.equal(failed, false, text);
	assert.match(text, /ok plugin dsh-llm-ferry 9\.9\.9 is installed in DSH profile "desktop"/);
	assert.match(text, new RegExp(`ok server ${url.replace(/[.]/g, "\\.")} \\(from /dsh/profiles/desktop/cordis.patch.yml\\)`));
	assert.match(text, /ok server answers in \d+ ms: dsh-ferry/);
	assert.match(text, /ok models: auto, deepseek-flash, deepseek-v4-pro/);
	assert.match(text, /warn .*specs carries the DSH sandbox's Low integrity label.*setintegritylevel "\(OI\)\(CI\)Medium" \/T \/C/);
	assert.match(text, /warn .*Desktop is too broad for a DSH workspace/);
	assert.match(text, /warn no PowerShell 7/);
	assert.match(text, /ok ripgrep \(rg\) is there/);
});

test("a wrong token, and a gateway page instead of the server, are told apart", async () => {
	const url = await listen(createApp(loadConfig({ env: { DSH_FERRY_TOKEN: TOKEN, DEEPSEEK_API_KEY: "sk-x" } }), { log: () => {} }).server);
	const bad = await doctor({ server: url, token: "wrong-token-0123456789" }, machine({}, { platform: "darwin" }));
	assert.equal(bad.failed, true);
	assert.match(bad.lines.map((l) => l.text).join("\n"), /turned the token down/);

	const gateway = await listen(createServer((req, res) => {
		res.writeHead(302, { location: "https://gateway.corp.example/confirm", "content-type": "text/html" });
		res.end("<html>please confirm</html>");
	}));
	const blocked = await doctor({ server: gateway, token: TOKEN }, machine({}, { platform: "darwin" }));
	assert.match(blocked.lines.map((l) => l.text).join("\n"), /not the Ferry server \(sent to https:\/\/gateway\.corp\.example\/confirm\).*confirmation page/);
	assert.match(blocked.lines.map((l) => l.text).join("\n"), /not installed/);
});
