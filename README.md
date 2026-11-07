# dsh-llm-ferry

[English](README.en.md)

让 DeepSeek Harness（DSH）在管得很严的电脑上也能用：API Key 放在你自己的服务端，DSH 的每个模型请求都先到服务端、再到模型；请求只带新增的内容，压缩后拆成小块，过得了公司网关。

一个插件加一个服务端，都在这个仓库里。服务端只用 Node 自带的模块，没有依赖。

## 解决什么问题

工作电脑上跑 DSH，常见三道坎：

1. Key 不能放在工作电脑上。公司机器可能被审计、被截屏、被同步；Key 放上去就等于公开。
2. 公司网关拦大请求。常见的上限在 100 KB 左右，而 agent 每一轮都把整段对话发给模型，几十轮以后一个请求就是几百 KB，直接被拦。
3. 代理会拆 HTTPS 看内容。你不想让模型调用的原文在那条路上走太多次。

这个项目的做法：工作电脑只和你自己的服务端说话，发的是加过密钥、压缩过、拆成小块的增量；服务端拼回完整对话，再用你的 Key 调模型。

## 怎么做的

```
工作电脑                                        家里电脑（或任意一台你信任的机器）
┌──────────────────────┐   小块、增量、gzip    ┌────────────────────┐          ┌──────────┐
│ DSH + dsh-llm-ferry  │ ────────────────────▶ │ dsh-ferry 服务端   │ ───────▶ │ DeepSeek │
│ （没有 Key）         │ ◀──────────────────── │ （Key 在这里）     │ ◀─────── │ 或别家   │
└──────────────────────┘      模型的流式回复   └────────────────────┘          └──────────┘
```

- 增量上传。服务端记着每段对话，插件每轮只发服务端没有的消息（通常是一条工具结果），再发一个几百字节的模型请求。一条工具结果这种小增量直接夹在模型请求里，一轮就一次往返。
- 压缩再切块。大的增量先 gzip（文字一般压到几分之一），还大就按 80 KB 切块传，服务端拼起来。被网关拦（403）自动减半重发。
- 和 DSH 直连 DeepSeek 一模一样地调。走 DeepSeek 的 Anthropic 兼容接口，思考档位、思考内容回传、前缀缓存、搜索 API，都和 DSH 自带的 DeepSeek 插件一致，只是从服务端发出。
- 只从服务端出去。DSH 里不论装什么插件、怎么改配置，模型请求最后都经这个插件到服务端；直连模型接口的 `fetch` 一律拒绝。
- 对话不落日志。服务端日志只有路径、大小、状态、用时和 token 数，没有对话文字。

## 五分钟上手

家里的电脑（Mac、Linux、Windows 都行，装 Node 24）：

```sh
export DEEPSEEK_API_KEY=sk-...
export DSH_FERRY_TOKEN=$(openssl rand -hex 16)   # 自己编也行，至少 16 个字符
npx -y github:wvans123/dsh-ferry serve
cloudflared tunnel --url http://127.0.0.1:8790    # 开到外网，拿到一个 https 地址
```

工作电脑（装好 DSH 0.2.2 以上）：

```sh
dsh plugin --profile web add github:wvans123/dsh-ferry
```

在 profile 的 `cordis.patch.yml` 里填服务端地址和令牌，重启 DSH：

```yaml
- id: llm-ferry
  config:
    server: https://xxx.trycloudflare.com
    token: <令牌>
```

模型列表从服务端来，DSH 里选 `ferry/auto` 或具体模型就能用。装完跑一下自检，它会告诉你哪里没通、怎么办：

```sh
dsh-llm-ferry doctor --upload
```

桌面版 DSH、公司代理和证书、离线安装、后台常驻：[docs/SETUP.md](docs/SETUP.md)。

## 装上以后你得到什么

| 事情 | 做法 |
|---|---|
| 过网关 | 每个请求都在 80 KB 以下（可测可调），大对话 gzip 后切块 |
| 省往返 | 小增量夹在模型请求里，一轮一次往返；没依赖的工具调用 DSH 本来就并行 |
| 思考 | DeepSeek 的档位（关、低、高、最高）在 DSH 里能选，不选默认"高"；上一轮的思考原样带回 |
| 缓存 | 前缀不变，DeepSeek 的缓存命中原样报给 DSH；服务端也记一份 |
| 费用 | `dsh-llm-ferry stats` 按天、按模型看 token、命中率、花费；`dailyBudget` 超了 Bark 提醒一次 |
| 稳 | 模型忙（429、5xx）服务端先重试；还不行换 `fallback` 模型；服务端重启不丢对话，不用重传 |
| 别家模型 | Kimi、GLM、通义、Claude：服务商填地址和 Key，模型写一行 `catalog`，能力从 pi-ai 的目录取 |
| 搜索 | DSH 的 `web_search` 走服务端的 DeepSeek 搜索 API，工作电脑不用 Key |
| 手机 | Bark：任务跑完、出错、等你批准，推一条到手机 |
| 省心 | 压缩阈值降到上下文一半（DeepSeek 过了 50 万 token 就不太听话）；插件和服务端版本不一致会提醒 |

## 为什么不直接……

直接在 DSH 里填 Key：Key 在工作电脑上；一个请求带整段对话，几十轮后过不了网关。

普通反向代理（nginx、Cloudflare Worker）转发到 DeepSeek：Key 的问题解决了，大请求的问题没有，代理看到的还是原文。

原来的 [Ferry](https://github.com/wvans123/ferry)：同一套协议，功能更多（多模型池、管理页、规则、记忆、飞书）。这个项目是它的轻量版，只做 DSH 需要的事；插件两种服务端都能连。

## 配置一览

插件（`cordis.patch.yml` 里 `llm-ferry` 的 `config`，都可省）：

| 项 | 意思 |
|---|---|
| `server`、`token` | 服务端地址和令牌。不填则读 `~/.ferry/config.json`（`ferry login` 写的）或 `FERRY_SERVER`、`FERRY_TOKEN` |
| `chunkBytes` | 每块上限，默认 81920；`dsh-llm-ferry probe --save` 实测后写入 |
| `compress` | 压缩上传，默认开；网络拦压缩数据时关 |
| `refreshMinutes` | 模型列表刷新间隔，默认 5 |
| `notifyAfterSeconds`、`approvalNotifySeconds` | Bark 的触发时长，默认 60，0 关 |
| `allowDirectHosts` | 允许直连的模型接口地址（默认一个都不允许） |

服务端（`dsh-ferry-server.json`，`serve --config <文件>`；什么都不写就是 DeepSeek 两个模型给一个用户）：

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

- `fallback`：这个模型忙、挂了或没 Key 时，改问另一个。两个得是同一种接口（DeepSeek 预设默认是 Anthropic 接口，Kimi 这类是 OpenAI 接口），服务端启动时会检查。
- `summaryModel`：上下文压缩和起标题用的便宜模型。
- `dataDir`：对话和 `usage.jsonl` 放哪，`false` 只放内存。
- DeepSeek 默认走 Anthropic 兼容接口；要 OpenAI 格式，`"deepseek": { "api": "openai" }`。
- 全部项见 `server/config.js` 开头的注释。

命令：

| 命令 | 做什么 |
|---|---|
| `dsh-llm-ferry serve` | 起服务端 |
| `dsh-llm-ferry doctor [--upload]` | 工作电脑自检：插件、地址、令牌、代理、网关、Windows 工作区的坑 |
| `dsh-llm-ferry probe [--save]` | 实测网关放多大的请求 |
| `dsh-llm-ferry stats [--days N]` | 用量和费用 |

## 只从服务端出去

DSH 的每个模型请求发出前都经过同一个关口（`llm/stream`），插件守在这里：请求的不是 Ferry 的路线，就交给 Ferry 发出。所以别的插件自带的模型路线、复查答案或按任务换模型的插件、重新打开的 DSH 自带 DeepSeek 插件，都能用，只是都经服务端出去。插件或 DSH 自己用 `fetch` 直连常见模型接口（api.deepseek.com、api.openai.com、api.anthropic.com、Kimi、GLM、通义、OpenRouter 等）一律拒绝，确实要放行的写 `allowDirectHosts`。网页搜索同样换成服务端的。

管不到的是绕开 `fetch`（node:http）或发到名单外地址的插件，比如把图片发到自己云端的看图插件。这类别装，见 [docs/PLUGINS.md](docs/PLUGINS.md)。

## 怎么实现的

DSH 自带的模型插件 llm-pi-ai 负责 DSH 这一侧的全部转换（消息、图片、思考、回复）。本插件给它一条叫 `ferry` 的路线：模型来自服务端，发送换成 Ferry 协议（`lib/sync.js`、`lib/upload.js`，从 ferry 客户端移植，两边一起改）。服务端（`server/`）是一个普通的 `node:http` 服务：收块、拼对话、调模型、转发流、记用量。协议细节见 `server/app.js` 开头。

代码量：插件约 1100 行，服务端约 800 行，测试 59 个。

## 测试

```sh
npm install
npm test
```

CI 在 Linux 和 Windows 上跑。对着真 DeepSeek 检查一遍（思考、回传、缓存、搜索，花几分钱）：`FERRY_SERVER=... FERRY_TOKEN=... node scripts/check-real-deepseek.mjs`。没有 Key 想用真的 DSH 试：`scripts/fake-deepseek.mjs` 是一个会思考、会调工具的假 DeepSeek。

## 状态和边界

- 在 Mac 上用真 DSH 0.2.2 和真 DeepSeek 跑通：思考、回传、缓存命中、搜索、300 KB 对话过 100 KB 假网关、Bark 通知、恢复会话。
- 还没在一台真正的公司 Windows 电脑上装过。Windows 上的单元测试在 CI 里跑；`doctor` 是为那台电脑准备的。
- 不支持的：绕开 `fetch` 的插件；图片走切片能过但慢。
- 服务端只认一种令牌，没有限流；它应该只开给你自己。

## 文档

- [docs/SETUP.md](docs/SETUP.md)：从零配置，桌面版和命令行版，公司代理和证书，后台常驻。
- [docs/WORK-PC.md](docs/WORK-PC.md)：在工作电脑上用顺：自检、工作区的坑、PowerShell、AGENTS.md 模板、linux.do 上的经验。
- [docs/USING-DSH.md](docs/USING-DSH.md)：把 DSH 用好：预设、AGENTS.md、技能、子 agent、插件。
- [docs/PLUGINS.md](docs/PLUGINS.md)：和其他插件一起用。
- [docs/IM.md](docs/IM.md)：在微信、企业微信、飞书里派任务。
- [templates/AGENTS.md](templates/AGENTS.md)：管住模型的手的规矩模板。
