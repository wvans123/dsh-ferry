# dsh-llm-ferry

DeepSeek Harness（DSH）的模型插件，加一个配套的服务端。装上以后，DSH 的模型请求先发到你自己的服务端，再由服务端调 DeepSeek（或别的模型）。请求按 Ferry 的办法发：每轮只上传新增的消息，压缩后拆成小块，模型请求本身只有几百字节。适合公司网关会拦大请求的电脑。

服务端有两个选择：用本仓库自带的（下面"自带服务端"），或者用原来的 Ferry 服务端。插件两个都能连。

从零开始配（家里电脑当服务端、工作电脑用 DSH，包括公司代理和证书）：见 [docs/SETUP.md](docs/SETUP.md)。怎么把 DSH 用好（预设、AGENTS.md、技能、写 prompt、子 agent、好用的插件和玩法）：见 [docs/USING-DSH.md](docs/USING-DSH.md)。在微信、企业微信、飞书里给 agent 派任务：见 [docs/IM.md](docs/IM.md)。

## 自带服务端

只要 DeepSeek 的 API Key 和一个令牌（自己编，至少 16 个字符）：

```sh
DEEPSEEK_API_KEY=sk-... DSH_FERRY_TOKEN=<令牌> npx -y github:wvans123/dsh-ferry serve
```

默认监听 `127.0.0.1:8790`，给出 DeepSeek V4.1 Flash、DeepSeek V4 Pro，外加 `auto`（默认指向 Flash）。放在家里的电脑上，用 Cloudflare Tunnel 之类开到外网，工作电脑连那个地址。只用 Node 自带的模块，不装别的依赖。

要多个用户、换默认模型、指定摘要模型、接别家的模型，写一个 `dsh-ferry-server.json`（`serve --config <文件>`），格式见 `server/config.js` 开头的注释。

接别家的模型：

- 兼容 OpenAI 接口的（Kimi、GLM、通义等）：服务商写地址和 Key，模型写一行 `catalog`，指向 pi-ai 模型目录里的条目，比如 `"catalog": "moonshotai/kimi-k2.6"`。上下文多大、能不能看图、思考档位、这家接口的特殊要求，插件都从目录里取，不用自己填。
- Claude 等 Anthropic 接口的：服务商写 `"api": "anthropic"`（名字叫 `anthropic` 的不用写地址），模型同样写 `catalog`，比如 `"anthropic/claude-haiku-4-5"`。DeepSeek 自己的 Anthropic 兼容接口也能这样接。

```json
{
  "providers": {
    "deepseek": {},
    "kimi": { "baseUrl": "https://api.moonshot.cn/v1", "apiKeyEnv": "MOONSHOT_API_KEY" },
    "anthropic": {}
  },
  "models": [
    { "id": "deepseek-flash" }, { "id": "deepseek-v4-pro" },
    { "id": "kimi", "provider": "kimi", "model": "kimi-k2.6", "catalog": "moonshotai/kimi-k2.6" },
    { "id": "claude", "provider": "anthropic", "model": "claude-haiku-4-5", "catalog": "anthropic/claude-haiku-4-5" }
  ]
}
```

对话放在内存里。服务端重启后，插件发现对不上会自动重传一遍，不用管。日志只记路径、大小、状态和用时，不记对话内容。

自带服务端为 DSH 多做的几件事：

- 调 DeepSeek 的方式和 DSH 自带的 DeepSeek 插件一样：走 DeepSeek 的 Anthropic 兼容接口，思考用 `thinking: enabled` 加 `output_config.effort`，Flash 的系统提示改了放在对话中间（前缀不变，缓存照样命中），上一轮的思考连同签名原样带回。DSH 自带插件额外发的几个统计字段（匿名用户 id、会话日志上传）不发。想改用 OpenAI 格式的接口，在配置里给 deepseek 写 `"api": "openai"`。
- DeepSeek 的思考档位在 DSH 里能选（关、低、高、最高，Pro 没有低档），不选时默认"高"，和 DSH 直连 DeepSeek 一样。模型配置里的 `defaultEffort` 可以改默认档位。
- DeepSeek 忙（429、503 等）时，服务端在开始回复前自动等一下再问，最多两次，DSH 那边只是慢一点，不会报错。
- 上传先压缩再切块。普通文字一般压到几分之一，300 KB 的对话在 100 KB 的网关下一次就过。
- DeepSeek 报的缓存命中原样传给 DSH，DSH 的用量里能看到 `cacheReadTokens`。
- 手机通知（Bark）：任务跑了一分钟以上、结束时（完成、出错或被停止），或者有操作等你批准一分钟没人点，推一条到手机。服务端设 `BARK_URL=https://api.day.app/<你的 key>`（或配置里的 `barkUrl`）就开了；工作电脑只把通知交给服务端，不直连 Bark。插件设置里 `notifyAfterSeconds`、`approvalNotifySeconds` 改时长，设 0 关掉。原来的 Ferry 服务端在管理页设了 Bark 也能用。
- DSH 的网页搜索（`web_search`）也经服务端：服务端用自己的 Key 调 DeepSeek 搜索 API，工作电脑上不用放 DeepSeek 的 Key，只把搜索词发给服务端。读网页默认还在本机（内网页面也能读）；想让公网页面由服务端读，在 DSH 的网页设置里把抓取选成 "Ferry server"（`ferry-fetch`）。

## 安装插件

需要 DSH 0.2.2 以上、Node 24.9 以上，还要装 pnpm（DSH 用它装插件）。

```sh
dsh plugin --profile <profile> add github:wvans123/dsh-ferry
```

在 profile 的 `cordis.patch.yml` 里填服务端地址和令牌：

```yaml
- id: llm-ferry
  config:
    server: https://ferry.example.com
    token: <令牌>
```

连原来的 Ferry 服务端、并且这台电脑用过 `ferry login` 的话，可以不填，插件读 `~/.ferry/config.json`。也认环境变量 `FERRY_SERVER`、`FERRY_TOKEN`。

装完重启 DSH。模型列表来自服务端，每 5 分钟刷新一次；服务端改了模型，DSH 里跟着变。

其他可选项：`chunkBytes`（每块上限，见下）、`compress`（压缩上传，默认开；网络拦压缩数据时设成 false）、`project`（Ferry 服务端按它找 `rules/<项目名>.md`）、`refreshMinutes`（模型列表刷新间隔）。

## 只从服务端出去

装上以后，DSH 里每一次模型调用都经本插件、到服务端、再发给模型。装别的插件、自己改配置都可以，最后一步不变：

- DSH 的每个模型请求发出前都要经过同一个关口（`llm/stream`），插件守在这里：请求的不是 Ferry 的路线，就交给 Ferry 发出，服务端有同名模型用同名的，没有就用 `auto`。所以别的插件自带的模型路线、重新打开的 DSH 自带 DeepSeek 插件、答案复查或按任务换模型的插件，照常能用，只是都经 Ferry 出去。
- 插件或 DSH 自己用 `fetch` 直连常见的模型接口（api.deepseek.com、api.openai.com、api.anthropic.com、Kimi、GLM、通义、OpenRouter 等）一律拒绝。确实要放行某个地址，在插件设置里写 `allowDirectHosts`。
- 默认关掉 DSH 自带的直连模型插件（`llm-pi-ai`、`llm-deepseek`、`llm-deepseek-account`），默认模型设成 `ferry/auto`。打开它们也不会绕过 Ferry，只是多一份没用的模型列表。

实测：装一个自带模型路线、启动时还直连 OpenAI 的测试插件，把默认模型设成它的路线，回答照常，请求全部经 Ferry 服务端，那条路线一次都没被真正调用；把 DSH 自带的 DeepSeek 插件打开并给它 Key，请求同样经 Ferry，它去 api.deepseek.com 拉模型列表也被拦下。

网页搜索同样只走服务端：插件把 DSH 的搜索换成 `ferry-search`，并关掉 DSH 自带的两个 DeepSeek 搜索插件（它们会用本机的 Key 直连 DeepSeek）。自带服务端用 DeepSeek 搜索 API；原来的 Ferry 服务端用它管理页里设的搜索引擎。服务端没有搜索时，DSH 就不提供 `web_search`。

管不到的是插件绕开 `fetch`（用 node:http 之类）直接发的网络请求，或者发到不在上面名单里的地址，比如看图插件把图片发到自己的云端。这类插件别装，见 [docs/PLUGINS.md](docs/PLUGINS.md)；公司网络是最后一道关。

## 每块多大

公司网关大约拦 100 KB 以上的请求，所以默认每块 80 KB，留点余量。被网关拦了（HTTP 403）会自动减半重发。

不同网络的上限不一样，可以实测：

```sh
npx -y github:wvans123/dsh-ferry probe          # 测上限，给出建议大小
npx -y github:wvans123/dsh-ferry probe --save   # 测完存进 ~/.ferry/config.json
```

它向服务端发 16 KB、64 KB、128 KB……的测试数据（服务端读完就扔），找到能过的最大值，建议用它的八成。两种服务端都支持。`--save` 存的是 `chunkBytes`，ferry 客户端也读这个值。

块大小按这个顺序取：插件设置里的 `chunkBytes` → 环境变量 `FERRY_CHUNK_BYTES` → `~/.ferry/config.json` 的 `chunkBytes` → 默认 81920（80 KB）。单位是字节，最小 8192。

## 和其他插件一起用

本插件只做最后一步的协议转换，其他插件照常用。要注意的几种情况和推荐的插件见 [docs/PLUGINS.md](docs/PLUGINS.md)。

## 怎么做的

DSH 自带的模型插件 llm-pi-ai 负责 DSH 这一侧的全部转换（消息、图片、思考档位、回复）。本插件给它一条叫 `ferry` 的路线：模型来自服务端，发送换成 Ferry 协议（`lib/sync.js`、`lib/upload.js`，从 ferry 客户端的 `client/lib/sync.mjs`、`upload.mjs` 移植，两边要一起改）。

服务端在模型列表里声明自己支持什么（`features`）：自带服务端声明 `gzip` 和 `reasoning`，并给出每个模型的思考设置；原来的 Ferry 服务端不声明，插件就按原来的方式发。上下文压缩的请求标成 summary，服务端配了摘要模型就交给它。

## 测试

```sh
npm install
npm test
```

对着接了真 DeepSeek 的自带服务端检查一遍（思考档位、思考内容回传、缓存命中、搜索；花几分钱）：

```sh
FERRY_SERVER=http://127.0.0.1:8790 FERRY_TOKEN=<令牌> node scripts/check-real-deepseek.mjs [deepseek-flash|deepseek-v4-pro]
```

用真的 DSH、不用 API Key 试自带服务端：`scripts/fake-deepseek.mjs` 是一个假的 DeepSeek（会思考、会调读文件工具），把服务端配置里 deepseek 的 `baseUrl` 指向它即可。

对着原来的 Ferry 服务端测（服务端接 ferry 仓库里 `selftest/fake_llm.py` 的 basic 模式）。脚本在中间放一个拦 100 KB 以上请求的假网关，先测上限，再用默认块大小发 300 KB 的对话跑两轮：

```sh
FERRY_SERVER=http://127.0.0.1:8799 FERRY_TOKEN=... node scripts/e2e-real-server.mjs
```
