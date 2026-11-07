# dsh-llm-ferry

[English](README.en.md)

这是一个 DeepSeek Harness（下面简称 DSH）的插件，外加一个配套的服务端。装上以后，DSH 不再自己去连 DeepSeek，而是把请求发到你自己的服务端，由服务端拿着 API Key 去调模型，再把回复传回来。

我写它是因为公司电脑上装了 DSH 却用不了：Key 不敢放在公司电脑上，公司网关又会拦掉大于 100 KB 左右的请求，而 DSH 每一轮都把整段对话发给模型，聊几十轮以后一个请求就有几百 KB。这个插件把这两件事都解决了。如果你也在类似的环境里，可以试试。

## 它是怎么工作的

```
公司电脑                                       家里的电脑（或任何一台你信得过的机器）
┌──────────────────────┐                      ┌────────────────────┐          ┌──────────┐
│ DSH + 这个插件       │ ── 小块的压缩数据 ──▶ │ 这个服务端         │ ───────▶ │ DeepSeek │
│ 没有 Key             │ ◀── 模型的回复 ────── │ Key 放在这里       │ ◀─────── │ 或别家   │
└──────────────────────┘                      └────────────────────┘          └──────────┘
```

服务端记着每段对话。DSH 每一轮本来要发整段对话，插件只把服务端还没有的那部分发过去，一般就是上一轮的一条工具结果，几 KB。服务端把对话拼完整，调模型，把模型的回复原样流回来。

遇到一次要发很多内容的时候（比如你贴了一个很长的文件），插件先把内容 gzip 压缩，文字一般能压到原来的几分之一；还是太大，就按 80 KB 一块切开发，服务端收齐再拼起来。要是网关还拦，插件把块减半再发。

对模型来说，这和 DSH 直接连 DeepSeek 没有区别：走的是同一个接口，思考档位、上一轮的思考内容、前缀缓存、搜索，都一样，只是出发点换成了服务端。

服务端的日志只记路径、大小、状态、用时和 token 数，不记对话内容。

## 五分钟跑起来

家里的电脑上（Mac、Linux、Windows 都可以，需要 Node 24）：

```sh
export DEEPSEEK_API_KEY=sk-...
export DSH_FERRY_TOKEN=$(openssl rand -hex 16)   # 这是你和服务端之间的口令，自己随便编一个也行，至少 16 个字符
npx -y github:wvans123/dsh-ferry serve
```

这样服务端就在 `127.0.0.1:8790` 上跑起来了。要让公司电脑能连上，得把它开到外网，最省事的是 Cloudflare Tunnel：

```sh
cloudflared tunnel --url http://127.0.0.1:8790
```

它会打印一个 `https://xxx.trycloudflare.com` 的地址，记下来。

公司电脑上（先装好 DSH 0.2.2 以上）：

```sh
dsh plugin --profile web add github:wvans123/dsh-ferry
```

然后打开 DSH 这个 profile 的 `cordis.patch.yml`，加上服务端地址和口令：

```yaml
- id: llm-ferry
  config:
    server: https://xxx.trycloudflare.com
    token: <口令>
```

重启 DSH。模型列表会从服务端拿过来，在 DSH 里选 `ferry/auto` 就能用了。

哪里不通的话，跑一下自检，它会说清楚是哪一步的问题、该怎么办：

```sh
dsh-llm-ferry doctor --upload
```

用 DSH 桌面版、公司有代理和自签证书、公司电脑上不了 GitHub 要离线装、服务端想开机自启：这些在 [docs/SETUP.md](docs/SETUP.md) 里一步步写了。

## 装好以后多了什么

除了能过网关这件事，服务端顺手还做了几件对日常使用有用的事。

思考档位。DeepSeek 的思考（关、低、高、最高）在 DSH 里能选，不选就是"高"，和直连 DeepSeek 时一样。上一轮的思考内容会原样带回去，模型不会"失忆"。

缓存。对话的前面部分每轮都一样，DeepSeek 会命中缓存，便宜很多。DeepSeek 报的命中数会传给 DSH，你在 DSH 的用量里能看到。

花了多少钱，快不快。服务端把每次调用的 token 数、费用和模型吐出第一个字用了多久记在 `~/.dsh-ferry/usage.jsonl` 里，`dsh-llm-ferry stats` 按天、按模型给你列出来，包括缓存命中率和首字时间。想控制一下，配置里写 `"dailyBudget": 5`，当天超过这个数时手机上收到一条提醒，调用照常。

模型忙的时候。DeepSeek 返回 429 或 5xx，服务端先自己等一下重试，最多两次，DSH 那边只是慢一点。还不行的话，如果你给这个模型配了 `fallback`，就换那个模型回答。

重启和续聊。传上来的对话存在磁盘上（`~/.dsh-ferry/store/`），服务端重启后 DSH 接着用，不用重传。反过来也一样：DSH 重启、恢复一个旧会话、从长对话里派出子任务，插件先问一句服务端手里有多少，只把差的那几条发过去，几百 KB 的历史不用再走一遍网关。

别家的模型。Kimi、GLM、通义、Claude 都能接：在配置里给服务商填地址和 Key，给模型写一行 `catalog`，指向 pi-ai 模型目录里的名字，上下文多大、能不能看图、怎么开思考，插件都从目录里取，不用你填。

网页搜索。DSH 的 `web_search` 也经服务端，用服务端的 Key 调 DeepSeek 的搜索 API，公司电脑上同样不用放 Key。

手机通知。装个 Bark，服务端配上地址，任务跑完、出错、或者有操作等你批准，手机上会收到一条。

长对话。DSH 默认用掉 80% 的上下文才自动压缩，在 DeepSeek 的 1M 窗口上大约是 70 万 token；用的人普遍反映过了 50 万模型就不太听话了。插件把这个阈值改到 50%。

## 不用这个，有别的办法吗

直接在 DSH 里填 Key：Key 就在公司电脑上了；而且每个请求带整段对话，聊几十轮就过不了网关。

用 nginx 或 Cloudflare Worker 做个反向代理转发到 DeepSeek：Key 的问题解决了，但请求还是整段对话，大小问题还在；代理也看得到全部内容。

原来的 [Ferry](https://github.com/wvans123/ferry)：协议是同一套，功能多得多（多个模型组成的池、管理页面、规则、记忆、飞书）。这个项目是它的精简版，只做 DSH 需要的那些。插件两种服务端都能连。

## 配置

插件这边，`cordis.patch.yml` 里 `llm-ferry` 的 `config` 下可以写这些，都可以不写：

| 项 | 意思 |
|---|---|
| `server`、`token` | 服务端地址和口令。不写的话，插件去读 `~/.ferry/config.json`（Ferry 的 `ferry login` 写的）或者环境变量 `FERRY_SERVER`、`FERRY_TOKEN` |
| `chunkBytes` | 每块多大，默认 81920（80 KB）。`dsh-llm-ferry probe --save` 能实测你的网关放多大，然后存起来 |
| `compress` | 要不要压缩上传，默认压。有的网络会拦压缩数据，那就设成 false |
| `refreshMinutes` | 多久去服务端刷新一次模型列表，默认 5 分钟 |
| `notifyAfterSeconds`、`approvalNotifySeconds` | 任务跑多久、审批等多久才发手机通知，默认 60 秒，0 是不发 |
| `allowDirectHosts` | 允许 DSH 直连的模型接口地址。默认一个都不允许，见下面"只从服务端出去" |

服务端这边，什么都不配就是把 DeepSeek 的两个模型给一个用户用。要改，写一个 `dsh-ferry-server.json`，启动时 `serve --config 这个文件`。一个把常见项都用上的例子：

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

几个说明：

- `fallback`：这个模型忙、挂了或者没配 Key 的时候，改问另一个。两个模型得是同一种接口（DeepSeek 预设默认走 Anthropic 接口，Kimi 这类走 OpenAI 接口），服务端启动时会检查。
- `summaryModel`：DSH 压缩上下文、起标题这类活儿用哪个模型，一般选便宜的。
- `dataDir`：对话和用量记录放哪。写 `false` 就只放内存。
- DeepSeek 默认走它的 Anthropic 兼容接口，和 DSH 自带的 DeepSeek 插件一样。想走 OpenAI 格式，写 `"deepseek": { "api": "openai" }`。
- 全部的项和解释在 `server/config.js` 文件开头的注释里。

命令一共四个：

| 命令 | 做什么 |
|---|---|
| `dsh-llm-ferry serve` | 启动服务端 |
| `dsh-llm-ferry doctor [--upload]` | 在公司电脑上自检：插件装没装、地址口令对不对、代理和证书、网关放多大、Windows 工作区常见的坑 |
| `dsh-llm-ferry probe [--save]` | 实测网关放多大的请求 |
| `dsh-llm-ferry stats [--days N]` | 看用量、费用和首字时间 |

## 只从服务端出去

既然 Key 不在公司电脑上，就要保证 DSH 不会从别的路把请求直接发给模型。DSH 的每个模型请求发出前都要经过同一个地方（`llm/stream`），插件就守在那里：不管请求是发给哪条路线的，统统交给服务端。所以你装别的插件、改默认模型，甚至把 DSH 自带的 DeepSeek 插件重新打开，都没关系，请求还是经服务端出去。另外，插件或 DSH 自己用 `fetch` 去连常见的模型接口（api.deepseek.com、api.openai.com、api.anthropic.com、Kimi、GLM、通义、OpenRouter 这些），会被直接拒绝；真有需要放行的，写在 `allowDirectHosts` 里。网页搜索也一样，换成了服务端的。

管不到的是那些不走 `fetch`（比如用 node:http）或者把东西发到名单之外地址的插件，比如有的看图插件会把图片传到它自己的云端。这类插件别装。哪些能装、哪些要留意，见 [docs/PLUGINS.md](docs/PLUGINS.md)。

## 代码在哪

DSH 自带的模型插件 llm-pi-ai 负责 DSH 这一侧的事（消息格式、图片、思考、回复）。这个插件给它加了一条叫 `ferry` 的路线：模型列表从服务端来，发送的部分换成 Ferry 的协议，在 `lib/sync.js` 和 `lib/upload.js` 里，是从 Ferry 客户端移植过来的，两边要一起改。服务端在 `server/` 下，是一个普通的 `node:http` 服务：收块、拼对话、调模型、把流转回去、记用量。接口列表在 `server/app.js` 开头。

插件大约 1100 行，服务端大约 800 行，测试 59 个。

## 测试

```sh
npm install
npm test
```

CI 在 Linux 和 Windows 上跑。想对着真的 DeepSeek 检查一遍（思考、思考回传、缓存命中、搜索，花几分钱）：`FERRY_SERVER=... FERRY_TOKEN=... node scripts/check-real-deepseek.mjs`。没有 Key 又想用真的 DSH 试一试：`scripts/fake-deepseek.mjs` 是一个假的 DeepSeek，会思考、会调读文件的工具，把服务端配置里 deepseek 的 `baseUrl` 指向它就行。

## 现在到什么程度

- 在 Mac 上用真的 DSH 0.2.2 和真的 DeepSeek 跑通了：思考、思考回传、缓存命中、搜索、300 KB 的对话过 100 KB 的假网关、Bark 通知、恢复会话。
- 还没有在一台真正的公司 Windows 电脑上装过。Windows 上的单元测试在 CI 里跑；`doctor` 就是为那台电脑准备的。
- 绕开 `fetch` 的插件管不住。图片能走切块传上去，但慢。
- 服务端只有口令这一道门，没有限流。它是给你自己用的，别开给别人。

## 其他文档

- [docs/SETUP.md](docs/SETUP.md)：从零配置：桌面版和命令行版 DSH、公司代理和证书、离线安装、服务端开机自启。
- [docs/WORK-PC.md](docs/WORK-PC.md)：在公司电脑上用顺手：自检、工作区的坑、PowerShell、AGENTS.md 模板、linux.do 上大家的经验。
- [docs/USING-DSH.md](docs/USING-DSH.md)：把 DSH 用好：预设、AGENTS.md、技能、子 agent、插件。
- [docs/PLUGINS.md](docs/PLUGINS.md)：和别的插件一起用。
- [docs/IM.md](docs/IM.md)：在微信、企业微信、飞书里派任务。
- [templates/AGENTS.md](templates/AGENTS.md)：管住模型的手的规矩模板。
