# dsh-llm-ferry

[中文](README.md)

A plugin for DeepSeek Harness (DSH) and a small server that goes with it. With it installed, DSH no longer talks to DeepSeek itself. It sends each request to a server you run, the server calls the model with its own API key, and streams the answer back.

I wrote it because DSH was unusable on my work PC: I did not want the API key on a company machine, and the company gateway drops requests bigger than about 100 KB, while DSH re-sends the whole conversation on every turn, so after a few dozen turns a single request is a few hundred KB. The plugin fixes both. If you are in a similar place, it may work for you too.

## How it works

```
work PC                                        a machine you trust (at home, say)
┌──────────────────────┐                      ┌────────────────────┐          ┌───────────┐
│ DSH + this plugin    │ ── small gzip parts ─▶ │ this server        │ ───────▶ │ DeepSeek  │
│ no key here          │ ◀── the model's reply │ the key lives here │ ◀─────── │ or others │
└──────────────────────┘                      └────────────────────┘          └───────────┘
```

The server remembers each conversation. Where DSH would send the whole conversation, the plugin sends only the part the server has not seen yet, usually one tool result of a few KB. The server puts the conversation back together, calls the model and streams the reply back unchanged.

When a lot has to go up at once (you pasted a long file), the plugin gzips it first; text usually shrinks to a fraction. If it is still big, it goes in 80 KB parts that the server joins. If the gateway still blocks a part, the plugin halves the size and tries again.

To the model this looks exactly like DSH talking to DeepSeek directly: same API, same thinking levels, earlier thinking replayed, same prefix caching, same search. Only the place it is sent from has changed.

The server logs path, size, status, time and token counts. It never logs conversation text.

## Up and running in five minutes

On the machine at home (Mac, Linux or Windows; Node 24):

```sh
export DEEPSEEK_API_KEY=sk-...
export DSH_FERRY_TOKEN=$(openssl rand -hex 16)   # the password between DSH and the server; anything of 16+ characters
npx -y github:wvans123/dsh-ferry serve
```

The server is now on `127.0.0.1:8790`. To reach it from the work PC you have to expose it; the easiest way is Cloudflare Tunnel:

```sh
cloudflared tunnel --url http://127.0.0.1:8790
```

It prints an address like `https://xxx.trycloudflare.com`. Keep it.

On the work PC (DSH 0.2.2 or newer installed):

```sh
dsh plugin --profile web add github:wvans123/dsh-ferry
```

Open that profile's `cordis.patch.yml` and add the address and the password:

```yaml
- id: llm-ferry
  config:
    server: https://xxx.trycloudflare.com
    token: <password>
```

Restart DSH. The model list comes from the server; pick `ferry/auto` in DSH and you are done.

If something does not connect, run the self-check. It says which step is broken and what to do about it:

```sh
dsh-llm-ferry doctor --upload
```

The desktop version of DSH, a company proxy with its own certificates, installing offline when GitHub is blocked, starting the server at boot: all in [docs/SETUP.md](docs/SETUP.md) (Chinese).

## What else you get

Beyond getting through the gateway, the server does a few things that help day to day.

Thinking levels. DeepSeek's thinking (off, low, high, max) can be chosen in DSH; when you choose nothing it is "high", as when DSH talks to DeepSeek directly. Earlier thinking goes back to the model as it was.

Caching. The beginning of the conversation is the same every turn, so DeepSeek serves it from cache, which is much cheaper. The hit counts DeepSeek reports are passed on to DSH and show up in its usage display.

What it costs, and how fast it is. The server writes every call's token counts, cost and time to the model's first byte to `~/.dsh-ferry/usage.jsonl`; `dsh-llm-ferry stats` sums them by day and by model, cache hit rate and median first-token time included. To keep an eye on it, set `"dailyBudget": 5` in the config: when a day's spending passes that, you get one push notification on your phone. Calls go on as normal.

When the model is busy. On a 429 or a 5xx the server waits and retries on its own, up to twice; DSH only sees a slower answer. If that is not enough and the model has a `fallback` configured, that model answers instead.

Restarts and resumed sessions. Uploaded conversations are kept on disk (`~/.dsh-ferry/store/`), so after a server restart DSH carries on without uploading again. The other way round too: when DSH restarts, resumes an old session or starts a subagent from a long chat, the plugin first asks the server how much it already holds and sends only the missing messages, so a few hundred KB of history do not pass the gateway a second time.

Other models. Kimi, GLM, Qwen, Claude: give the provider an address and a key, give the model one `catalog` line naming it in pi-ai's model catalog, and the plugin takes the context size, image support and thinking details from there.

Web search. DSH's `web_search` goes through the server too, using the server's key with DeepSeek's Search API. No key on the work PC for that either.

Phone. Install Bark, give the server its address, and you get a push when a task finishes, fails, or waits for your approval.

Long conversations. DSH compacts the context at 80% of the window by default, about 700K tokens on DeepSeek's 1M window; people who use it a lot agree the model stops following instructions well past 500K. The plugin sets the threshold to 50%.

## Is there another way?

Put the key straight into DSH: the key is on the work PC, and whole-conversation requests stop passing the gateway after a few dozen turns.

A reverse proxy (nginx, a Cloudflare Worker) forwarding to DeepSeek: the key problem is solved, the size problem is not, and the proxy sees everything.

The original [Ferry](https://github.com/wvans123/ferry): the same protocol with far more features (pools of models, an admin page, rules, memory, Feishu). This project is its light version and does only what DSH needs. The plugin connects to either server.

## Configuration

On the plugin side, under `config` of the `llm-ferry` entry in `cordis.patch.yml`, all optional:

| Setting | Meaning |
|---|---|
| `server`, `token` | The server's address and password. If missing, the plugin reads `~/.ferry/config.json` (written by Ferry's `ferry login`) or the environment variables `FERRY_SERVER` and `FERRY_TOKEN` |
| `chunkBytes` | Part size, default 81920 (80 KB). `dsh-llm-ferry probe --save` measures what your gateway lets through and stores it |
| `compress` | Whether to gzip uploads, default on. Some networks block compressed data; then set it to false |
| `refreshMinutes` | How often the model list is fetched again, default 5 |
| `notifyAfterSeconds`, `approvalNotifySeconds` | How long a task must run, or an approval wait, before a phone push; default 60, 0 turns it off |
| `allowDirectHosts` | Model API hosts DSH may still reach directly. None by default; see "The only way out" below |

On the server side, no config at all serves DeepSeek's two models to one user. To change that, write a `dsh-ferry-server.json` and start with `serve --config <file>`. An example using the common settings:

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

A few notes:

- `fallback`: the model to ask when this one is busy, down or has no key. Both must speak the same API (DeepSeek's presets use its Anthropic-compatible API; Kimi and the like use the OpenAI one). The server checks this at start.
- `summaryModel`: the model DSH's context compaction and title generation use; pick a cheap one.
- `dataDir`: where conversations and the usage file go. `false` keeps everything in memory.
- DeepSeek uses its Anthropic-compatible API by default, like DSH's own DeepSeek plugin. For the OpenAI format write `"deepseek": { "api": "openai" }`.
- Every setting is explained in the comment at the top of `server/config.js`.

There are four commands:

| Command | What it does |
|---|---|
| `dsh-llm-ferry serve` | Start the server |
| `dsh-llm-ferry doctor [--upload]` | Self-check on the work PC: plugin installed, address and password right, proxy and certificates, gateway limit, common Windows workspace problems |
| `dsh-llm-ferry probe [--save]` | Measure how big a request the gateway lets through |
| `dsh-llm-ferry stats [--days N]` | Usage, cost and first-token time |

## The only way out

Since the key is not on the work PC, DSH must not have any other way of reaching a model. Every model request in DSH passes one place before it leaves (`llm/stream`), and the plugin sits there: whatever route a request names, it is handed to the server. So you can install other plugins, change the default model, even switch DSH's own DeepSeek plugin back on, and requests still leave through the server. Besides that, any `fetch` from a plugin or from DSH itself to a well-known model API (api.deepseek.com, api.openai.com, api.anthropic.com, Kimi, GLM, Qwen, OpenRouter and so on) is refused; if you really need one, list it in `allowDirectHosts`. Web search is swapped to the server's as well.

What this cannot catch: plugins that avoid `fetch` (node:http, say) or send to a host not on the list, like an image plugin uploading pictures to its own cloud. Do not install those. [docs/PLUGINS.md](docs/PLUGINS.md) says which plugins are fine.

## Where the code is

DSH's own model plugin, llm-pi-ai, handles the DSH side (message formats, images, thinking, replies). This plugin gives it one more route called `ferry`: the model list comes from the server, and sending is replaced by Ferry's protocol in `lib/sync.js` and `lib/upload.js`, ported from the Ferry client (the two must change together). The server is under `server/`, a plain `node:http` service: receive parts, rebuild the conversation, call the model, stream back, record usage. The list of endpoints is at the top of `server/app.js`.

About 1100 lines of plugin, 800 of server, 59 tests.

## Tests

```sh
npm install
npm test
```

CI runs on Linux and Windows. To check against the real DeepSeek (thinking, replay, cache hits, search; costs a few cents): `FERRY_SERVER=... FERRY_TOKEN=... node scripts/check-real-deepseek.mjs`. To try the real DSH without a key, `scripts/fake-deepseek.mjs` is a fake DeepSeek that thinks and calls the read tool; point the server config's deepseek `baseUrl` at it.

## Where it stands

- Works on a Mac with the real DSH 0.2.2 and the real DeepSeek API: thinking, replay, cache hits, search, a 300 KB conversation through a 100 KB fake gateway, Bark pushes, resumed sessions.
- Not yet installed on an actual corporate Windows PC. The unit tests run on Windows in CI; `doctor` was written for that machine.
- Plugins that avoid `fetch` cannot be stopped. Images go through the parts, slowly.
- The server has one kind of password and no rate limiting. It is meant for you alone.

The other docs are in Chinese: [docs/SETUP.md](docs/SETUP.md), [docs/WORK-PC.md](docs/WORK-PC.md), [docs/USING-DSH.md](docs/USING-DSH.md), [docs/PLUGINS.md](docs/PLUGINS.md).
