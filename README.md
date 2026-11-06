# dsh-llm-ferry

DeepSeek Harness（DSH）的模型插件，加一个配套的服务端。装上以后，DSH 的模型请求先发到你自己的服务端，再由服务端调 DeepSeek（或别的模型）。请求按 Ferry 的办法发：每轮只上传新增的消息，压缩后拆成小块，模型请求本身只有几百字节。适合公司网关会拦大请求的电脑。

服务端有两个选择：用本仓库自带的（下面"自带服务端"），或者用原来的 Ferry 服务端。插件两个都能连。

## 自带服务端

只要 DeepSeek 的 API Key 和一个令牌（自己编，至少 16 个字符）：

```sh
DEEPSEEK_API_KEY=sk-... DSH_FERRY_TOKEN=<令牌> npx -y github:wvans123/dsh-ferry serve
```

默认监听 `127.0.0.1:8790`，给出 DeepSeek V4.1 Flash、DeepSeek V4 Pro，外加 `auto`（默认指向 Flash）。放在家里的电脑上，用 Cloudflare Tunnel 之类开到外网，工作电脑连那个地址。只用 Node 自带的模块，不装别的依赖。

要多个用户、换默认模型、指定摘要模型、加别的兼容 OpenAI 接口的服务商，写一个 `dsh-ferry-server.json`（`serve --config <文件>`），格式见 `server/config.js` 开头的注释。

对话放在内存里。服务端重启后，插件发现对不上会自动重传一遍，不用管。日志只记路径、大小、状态和用时，不记对话内容。

自带服务端为 DSH 多做的几件事：

- DeepSeek 的思考档位在 DSH 里能选（关、低、高、最高，Pro 没有低档），上一轮的思考内容按 DeepSeek 的要求带回去。
- 上传先压缩再切块。普通文字一般压到几分之一，300 KB 的对话在 100 KB 的网关下一次就过。
- DeepSeek 报的缓存命中原样传给 DSH，DSH 的用量里能看到 `cacheReadTokens`。
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

装上以后，模型请求只能经服务端发出：插件关掉 DSH 自带的直连模型插件（`llm-pi-ai`、`llm-deepseek`、`llm-deepseek-account`），默认模型设成 `ferry/auto`。哪个插件要用别的路线，会报 `NO_ADAPTER`，不会从这台电脑直连模型。

想恢复某条直连路线，在 profile 自己的 `cordis.patch.yml` 里写：

```yaml
- id: llm-deepseek
  disabled: false
```

网页搜索同样只走服务端：插件把 DSH 的搜索换成 `ferry-search`，并关掉 DSH 自带的两个 DeepSeek 搜索插件（它们会用本机的 Key 直连 DeepSeek）。服务端不支持搜索时（比如原来的 Ferry 服务端），DSH 就不提供 `web_search`。

管不到的是插件自己直接发的网络请求（不走 DSH 的模型接口），比如看图插件把图片发到自己的云端。这类插件别装，见 [docs/PLUGINS.md](docs/PLUGINS.md)。

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

用真的 DSH、不用 API Key 试自带服务端：`scripts/fake-deepseek.mjs` 是一个假的 DeepSeek（会思考、会调读文件工具），把服务端配置里 deepseek 的 `baseUrl` 指向它即可。

对着原来的 Ferry 服务端测（服务端接 ferry 仓库里 `selftest/fake_llm.py` 的 basic 模式）。脚本在中间放一个拦 100 KB 以上请求的假网关，先测上限，再用默认块大小发 300 KB 的对话跑两轮：

```sh
FERRY_SERVER=http://127.0.0.1:8799 FERRY_TOKEN=... node scripts/e2e-real-server.mjs
```
