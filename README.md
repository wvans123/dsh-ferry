# dsh-llm-ferry

DeepSeek Harness（DSH）的模型插件。装上以后，DSH 用的是 Ferry 服务端上的模型，请求按 Ferry 的办法发：每轮只上传新增的消息，大的拆成小块，模型请求本身只有几百字节。适合公司网关会拦大请求的电脑。

模型列表来自 Ferry 服务端，每 5 分钟刷新一次。在服务端管理页改了模型，DSH 里跟着变，不用改 DSH 的配置。

## 安装

需要 DSH 0.2.2 以上（Node 24.9 以上）。

```sh
dsh plugin --profile <profile> add github:wvans123/dsh-ferry
```

装完重启 DSH，模型选择框里会出现 Ferry 的模型。

## 服务端地址和令牌

这台电脑用过 `ferry login` 就不用填，插件读 `~/.ferry/config.json`。也认环境变量 `FERRY_SERVER`、`FERRY_TOKEN`。

想单独给 DSH 填，在 profile 的插件条目下加 config：

```yaml
- id: llm-ferry
  name: dsh-llm-ferry
  config:
    server: https://ferry.example.com
    token: <你的令牌>
```

其他可选项：`project`（服务端按它找 `rules/<项目名>.md`）、`chunkBytes`（每块上限，默认 512 KB，被网关拦了会自动减半）、`refreshMinutes`（模型列表刷新间隔）。

## 怎么做的

DSH 自带的模型插件 llm-pi-ai 负责 DSH 这一侧的全部转换（消息、图片、思考档位、回复）。本插件给它一条叫 `ferry` 的路线：模型来自服务端，发送换成 Ferry 协议（`lib/sync.js`、`lib/upload.js`，从 ferry 客户端的 `client/lib/sync.mjs`、`upload.mjs` 移植，两边要一起改）。

服务端不用改。上下文压缩的请求会标成 summary，服务端配了摘要模型就交给它。

## 测试

```sh
npm install
npm test
```

对着真的 Ferry 服务端跑两轮（服务端接 ferry 仓库里 `selftest/fake_llm.py` 的 basic 模式）：

```sh
FERRY_SERVER=http://127.0.0.1:8799 FERRY_TOKEN=... node scripts/e2e-real-server.mjs
```
