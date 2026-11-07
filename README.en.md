# dsh-llm-ferry

[中文](README.md)

Run DeepSeek Harness (DSH) on a locked-down work computer. The API key lives on a server you own; every model call from DSH goes to that server first, which calls the model. Requests carry only what is new, compressed and cut into small parts, so they get through a company gateway that stops big requests.

One plugin and one server, both in this repository. The server uses nothing beyond Node's built-in modules.

## The problem

Three things get in the way of an agent on a work PC:

1. The key must not be on that machine (audited, screenshotted, synced).
2. The gateway stops big requests, often around 100 KB. An agent re-sends the whole conversation on every turn, so after a few dozen turns one request is hundreds of KB.
3. The proxy inspects HTTPS. You would rather not have the full text of every model call cross it again and again.

Here the work PC talks only to your server, sending compressed, token-protected increments in small parts. The server rebuilds the conversation and calls the model with its own key.

## How it works

```
work PC                                           your machine at home
┌──────────────────────┐  small gzip increments  ┌────────────────────┐        ┌───────────┐
│ DSH + dsh-llm-ferry  │ ──────────────────────▶ │ dsh-ferry server   │ ─────▶ │ DeepSeek  │
│ (no key)             │ ◀────────────────────── │ (key lives here)   │ ◀───── │ or others │
└──────────────────────┘    the model's stream   └────────────────────┘        └───────────┘
```

- Incremental sync. The server keeps each conversation; the plugin sends only the messages it has not seen (usually one tool result), then a request of a few hundred bytes. A small increment rides inside the model request itself: one round trip per turn.
- Compress, then cut. Big increments are gzipped (text shrinks to a fraction) and, if still big, sent in 80 KB parts the server joins. A 403 from the gateway halves the part size and retries.
- Exactly like DSH talking to DeepSeek itself. DeepSeek's Anthropic-compatible API, thinking levels, thinking replayed on the next turn, prefix caching, the Search API: all as in DSH's own DeepSeek plugin, just sent from the server.
- The only way out. Whatever plugins or settings DSH has, every model call leaves through this plugin; direct `fetch` calls to model APIs are refused.
- No conversation text in logs. The server logs path, size, status, time and token counts.

## Five minutes

At home (Node 24; Mac, Linux or Windows):

```sh
export DEEPSEEK_API_KEY=sk-...
export DSH_FERRY_TOKEN=$(openssl rand -hex 16)   # any string of 16+ characters
npx -y github:wvans123/dsh-ferry serve
cloudflared tunnel --url http://127.0.0.1:8790    # expose it; you get an https address
```

On the work PC (DSH 0.2.2 or newer):

```sh
dsh plugin --profile web add github:wvans123/dsh-ferry
```

Put the address and token in the profile's `cordis.patch.yml`, restart DSH:

```yaml
- id: llm-ferry
  config:
    server: https://xxx.trycloudflare.com
    token: <token>
```

Models come from the server; pick `ferry/auto` or a named one in DSH. Then let the self-check tell you what is not connected yet and what to do:

```sh
dsh-llm-ferry doctor --upload
```

Desktop DSH, company proxy and certificates, offline install, running as a service: [docs/SETUP.md](docs/SETUP.md) (Chinese).

## What you get

| | |
|---|---|
| Through the gateway | every request under 80 KB (measurable, adjustable); big conversations gzipped and cut |
| Fewer round trips | small increments ride in the model request: one round trip per turn |
| Thinking | DeepSeek's levels (off, low, high, max) selectable in DSH, "high" by default; earlier thinking replayed as is |
| Caching | stable prefix; DeepSeek's cache hits reported to DSH and recorded on the server |
| Cost | `dsh-llm-ferry stats`: tokens, hit rate and cost by day and model; `dailyBudget` sends one Bark push when passed |
| Robustness | retries on 429/5xx before anything is sent back; a `fallback` model when that is not enough; conversations survive a server restart |
| Other models | Kimi, GLM, Qwen, Claude: a provider with address and key, a model with one `catalog` line; abilities come from pi-ai's catalog |
| Search | DSH's `web_search` through the server's DeepSeek Search API; no key on the work PC |
| Phone | Bark: a task finished, failed, or waits for your approval |
| Small things | compaction at half the context window (DeepSeek stops listening well past 500K tokens); a note when plugin and server versions differ |

## Why not just…

Put the key in DSH: the key is on the work PC, and whole-conversation requests stop passing the gateway after a few dozen turns.

A plain reverse proxy (nginx, a Worker) to DeepSeek: solves the key, not the request size, and the proxy sees the full text.

The original [Ferry](https://github.com/wvans123/ferry): same protocol, more features (model pools, admin page, rules, memory, Feishu). This is its light version, doing only what DSH needs; the plugin connects to either server.

## Configuration

Plugin (`config` of the `llm-ferry` entry in `cordis.patch.yml`; all optional): `server`, `token` (else `~/.ferry/config.json` or `FERRY_SERVER` / `FERRY_TOKEN`), `chunkBytes` (default 81920; `dsh-llm-ferry probe --save` measures and stores it), `compress` (default on), `refreshMinutes` (model list, default 5), `notifyAfterSeconds` / `approvalNotifySeconds` (Bark, default 60, 0 off), `allowDirectHosts`.

Server (`dsh-ferry-server.json`, `serve --config <file>`; with no file it serves DeepSeek's two models to one user):

```json
{
  "users": [{ "name": "me", "tokenEnv": "DSH_FERRY_TOKEN" }],
  "providers": {
    "deepseek": {},
    "kimi": { "baseUrl": "https://api.moonshot.cn/v1", "apiKeyEnv": "MOONSHOT_API_KEY" },
    "anthropic": {}
  },
  "models": [
    { "id": "deepseek-flash", "fallback": "deepseek-v4-pro" },
    { "id": "deepseek-v4-pro", "defaultEffort": "max" },
    { "id": "kimi", "provider": "kimi", "model": "kimi-k2.6", "catalog": "moonshotai/kimi-k2.6" },
    { "id": "claude", "provider": "anthropic", "model": "claude-haiku-4-5", "catalog": "anthropic/claude-haiku-4-5" }
  ],
  "defaultModel": "deepseek-flash",
  "summaryModel": "deepseek-flash",
  "barkUrl": "https://api.day.app/<key>",
  "dailyBudget": 5,
  "dataDir": "~/.dsh-ferry"
}
```

All settings are described at the top of `server/config.js`.

Commands: `dsh-llm-ferry serve`, `doctor [--upload]`, `probe [--save]`, `stats [--days N]`.

## Status

- Verified on a Mac with the real DSH 0.2.2 and the real DeepSeek API: thinking, replay, cache hits, search, a 300 KB conversation through a 100 KB fake gateway, Bark, resumed sessions.
- Not yet installed on an actual corporate Windows PC. Unit tests run on Windows in CI; `doctor` exists for that machine.
- Out of scope: plugins that bypass `fetch`; images pass through the parts but slowly.
- One kind of token, no rate limiting: the server is meant for you alone.

Docs are in Chinese: [docs/SETUP.md](docs/SETUP.md), [docs/WORK-PC.md](docs/WORK-PC.md), [docs/USING-DSH.md](docs/USING-DSH.md), [docs/PLUGINS.md](docs/PLUGINS.md).
