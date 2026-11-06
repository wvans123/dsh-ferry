# dsh-llm-ferry

DeepSeek Harness（DSH）的模型插件。装上以后，DSH 用的是 Ferry 服务端上的模型，请求按 Ferry 的办法发：每轮只上传新增的消息，大的拆成小块，模型请求本身只有几百字节。适合公司网关会拦大请求的电脑。

模型列表来自 Ferry 服务端，每 5 分钟刷新一次。在服务端管理页改了模型，DSH 里跟着变，不用改 DSH 的配置。

## 安装

需要 DSH 0.2.2 以上、Node 24.9 以上，还要装 pnpm（DSH 用它装插件）。

```sh
dsh plugin --profile <profile> add github:wvans123/dsh-ferry
```

装完重启 DSH，模型选择框里会出现 Ferry 的模型。

## 只从 Ferry 出去

装上以后，模型请求只能经 Ferry 发出：插件关掉 DSH 自带的直连模型插件（`llm-pi-ai`、`llm-deepseek`、`llm-deepseek-account`），默认模型设成 `ferry/auto`。哪个插件要用别的路线，会报 `NO_ADAPTER`，不会从这台电脑直连模型。

想恢复某条直连路线，在 profile 自己的 `cordis.patch.yml` 里写：

```yaml
- id: llm-deepseek
  disabled: false
```

管不到的是插件自己直接发的网络请求（不走 DSH 的模型接口），比如看图插件把图片发到自己的云端。这类插件别装，见 [docs/PLUGINS.md](docs/PLUGINS.md)。DSH 自带的网页搜索用的是 DeepSeek 搜索 API，只在设了 `DEEPSEEK_API_KEY` 时才会连。

## 服务端地址和令牌

这台电脑用过 `ferry login` 就不用填，插件读 `~/.ferry/config.json`。也认环境变量 `FERRY_SERVER`、`FERRY_TOKEN`。

想单独给 DSH 填，在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: llm-ferry
  config:
    server: https://ferry.example.com
    token: <你的令牌>
```

其他可选项：`project`（服务端按它找 `rules/<项目名>.md`）、`refreshMinutes`（模型列表刷新间隔）。

## 每块多大

公司网关大约拦 100 KB 以上的请求，所以默认每块 80 KB，留点余量。被网关拦了（HTTP 403）会自动减半重发。

不同网络的上限不一样，可以实测：

```sh
npx -y github:wvans123/dsh-ferry probe          # 测上限，给出建议大小
npx -y github:wvans123/dsh-ferry probe --save   # 测完存进 ~/.ferry/config.json
```

它向服务端发 16 KB、64 KB、128 KB……的测试数据（服务端读完就扔），找到能过的最大值，建议用它的八成。`--save` 存的是 `chunkBytes`，ferry 客户端也读这个值；`ferry doctor --upload` 测的是同一件事。

块大小按这个顺序取：插件设置里的 `chunkBytes` → 环境变量 `FERRY_CHUNK_BYTES` → `~/.ferry/config.json` 的 `chunkBytes` → 默认 81920（80 KB）。单位是字节，最小 8192。

## 和其他插件一起用

本插件只做最后一步的协议转换，其他插件照常用。要注意的几种情况和推荐的插件见 [docs/PLUGINS.md](docs/PLUGINS.md)。

## 怎么做的

DSH 自带的模型插件 llm-pi-ai 负责 DSH 这一侧的全部转换（消息、图片、思考档位、回复）。本插件给它一条叫 `ferry` 的路线：模型来自服务端，发送换成 Ferry 协议（`lib/sync.js`、`lib/upload.js`，从 ferry 客户端的 `client/lib/sync.mjs`、`upload.mjs` 移植，两边要一起改）。

服务端不用改。上下文压缩的请求会标成 summary，服务端配了摘要模型就交给它。

## 测试

```sh
npm install
npm test
```

对着真的 Ferry 服务端测（服务端接 ferry 仓库里 `selftest/fake_llm.py` 的 basic 模式）。脚本在中间放一个拦 100 KB 以上请求的假网关，先测上限，再用默认块大小发 300 KB 的对话跑两轮：

```sh
FERRY_SERVER=http://127.0.0.1:8799 FERRY_TOKEN=... node scripts/e2e-real-server.mjs
```
