// What each model call used and cost, read off the answer as it streams by, kept one line per call in usage.jsonl
// (no conversation text), and added up for `dsh-llm-ferry stats`.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** {input, cache_read, cache_write, output} from an OpenAI or an Anthropic usage object; input is the uncached part. */
export function normalize(u) {
	if (!u || typeof u !== "object") return null;
	if ("input_tokens" in u || "output_tokens" in u) { // Anthropic
		return { input: u.input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0,
			cache_write: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 };
	}
	if ("prompt_tokens" in u || "completion_tokens" in u) { // OpenAI; DeepSeek adds prompt_cache_hit_tokens
		const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
		return { input: (u.prompt_tokens ?? 0) - hit, cache_read: hit, cache_write: 0, output: u.completion_tokens ?? 0 };
	}
	return null;
}

/** Dollars (or whatever unit the prices are in) for a call; prices are per million tokens. */
export function costOf(u, price = {}) {
	const per = (n, p) => ((n ?? 0) * (p ?? 0)) / 1e6;
	return Math.round((per(u.input, price.input) + per(u.cache_read, price.cache_read ?? price.input)
		+ per(u.cache_write, price.cache_write ?? price.input) + per(u.output, price.output)) * 1e8) / 1e8;
}

/**
 * Watches an SSE answer for its usage. OpenAI puts it in the last chunk (stream_options.include_usage); Anthropic
 * splits it between message_start (input) and message_delta (output). tap.write(chunk) as the chunk goes by;
 * tap.usage() when the answer is done.
 */
export function usageTap(api) {
	let rest = "";
	let found = null;
	const take = (obj) => {
		if (api === "anthropic") {
			if (obj.type === "message_start") found = normalize(obj.message?.usage) ?? found;
			else if (obj.type === "message_delta" && obj.usage) found = { ...(found ?? { input: 0, cache_read: 0, cache_write: 0 }), output: obj.usage.output_tokens ?? 0 };
		} else if (obj.usage) {
			found = normalize(obj.usage) ?? found;
		}
	};
	return {
		write(chunk) {
			rest += Buffer.from(chunk).toString("utf8"); // fetch gives Uint8Arrays, whose toString is not text
			const lines = rest.split("\n");
			rest = lines.pop();
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				try {
					take(JSON.parse(line.slice(5)));
				} catch {
					// not JSON (the [DONE] marker, a partial line): nothing to read
				}
			}
		},
		usage: () => found,
	};
}

/** One line to the usage file; the folder is made when missing. */
export function appendUsage(file, record) {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** The usage file's lines from the last `days` days, newest last. */
export function readUsage(file, days = 30) {
	if (!existsSync(file)) return [];
	const since = Date.now() - days * 86_400_000;
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return null;
		}
	}).filter((r) => r && Date.parse(r.at) >= since);
}

/** Totals by day and by model: { days: [{ day, ...totals }], models: [{ model, ...totals }], total }. */
export function summarize(records) {
	const empty = () => ({ calls: 0, input: 0, cache_read: 0, cache_write: 0, output: 0, cost: 0 });
	const add = (t, r) => {
		t.calls++;
		for (const k of ["input", "cache_read", "cache_write", "output"]) t[k] += r.usage?.[k] ?? 0;
		t.cost += r.cost ?? 0;
	};
	const byDay = new Map();
	const byModel = new Map();
	const total = empty();
	for (const r of records) {
		const day = String(r.at).slice(0, 10);
		if (!byDay.has(day)) byDay.set(day, { day, ...empty() });
		if (!byModel.has(r.model)) byModel.set(r.model, { model: r.model, ...empty() });
		add(byDay.get(day), r);
		add(byModel.get(r.model), r);
		add(total, r);
	}
	const hit = (t) => (t.input + t.cache_read ? t.cache_read / (t.input + t.cache_read) : 0);
	const done = (t) => ({ ...t, hit: hit(t), cost: Math.round(t.cost * 1e4) / 1e4 });
	return { days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map(done),
		models: [...byModel.values()].sort((a, b) => b.cost - a.cost).map(done), total: done(total) };
}

/** The stats as text for the terminal. */
export function formatStats(summary, days) {
	const n = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e4 ? `${Math.round(x / 1e3)}K` : String(x));
	const pct = (x) => `${Math.round(x * 100)}%`;
	const row = (label, t) => `${label.padEnd(12)} ${String(t.calls).padStart(6)} ${n(t.input + t.cache_read).padStart(8)} ${pct(t.hit).padStart(5)} ${n(t.output).padStart(8)} ${t.cost.toFixed(2).padStart(9)}`;
	const lines = [`last ${days} days`, `${"".padEnd(12)} ${"calls".padStart(6)} ${"input".padStart(8)} ${"cache".padStart(5)} ${"output".padStart(8)} ${"cost".padStart(9)}`];
	for (const d of summary.days) lines.push(row(d.day, d));
	lines.push(row("total", summary.total), "");
	for (const m of summary.models) lines.push(row(m.model, m));
	return lines.join("\n");
}
