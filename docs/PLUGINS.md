# 和其他 DSH 插件一起用

2026-11-06 看的，DSH 0.2.2-rc.1。星数是当天 GitHub 上的数字。

## 一条原则

dsh-llm-ferry 是 DSH 发请求前的最后一步：别的插件改提示词、加工具、管上下文、做记忆、压缩历史，都在它前面做完，它只把最后的请求按 Ferry 协议发出去。所以这些插件照常用，不用为 Ferry 做任何设置。

实测：同一个 profile 里装 dsh-llm-ferry、dsh-context、@hytime/dsh-thinking-effort，跑一个读文件的任务，两轮都正常，所有请求都经 Ferry 服务端，分块照常。

dsh-llm-ferry 装上后会关掉 DSH 自带的直连模型插件，所以 DSH 里只有 Ferry 这一条模型路线，见 README 的"只从 Ferry 出去"。有三种情况要注意：

1. **自己另外调模型的插件**：答案复查、多模型投票、按任务换模型这类插件，会用它们自己设置里的模型。要在它们的设置里选 Ferry 的模型（`ferry/...`）；选了别的路线会报 `NO_ADAPTER`。看图插件不一样：它们自己直接连云端，不走 DSH 的模型接口，拦不住，工作电脑上别装。
2. **改 llm-pi-ai 设置的插件**：比如 dsh-thinking-effort、dsh-model-capabilities、dsh-plugin-modelsdev。llm-pi-ai 被关掉后，它们没东西可改，装着也不影响启动（实测 dsh-thinking-effort）。Ferry 模型的能力（上下文多大、能不能看图、思考档位）来自 Ferry 服务端。
3. **版本**：DSH 插件大多写死了支持的 DSH 版本，DSH 一升级就可能装不上。比如 dsh-ops 0.4.4 只认 DSH 0.2.2 以前的版本，在 0.2.2-rc.1 上被拒绝安装。dsh-llm-ferry 写的是 0.2.2-rc.1 到 0.3 之前。

## 值得装的

除了 dsh-context 实际装上测过，下面两张表都是按插件说明里的工作方式判断的，没有逐个安装。

| 插件 | 星 | 做什么 | 和 Ferry |
|---|---|---|---|
| [dsh-context](https://github.com/bowenliang123/dsh-context) | 4.4k | 看上下文由什么组成、占了多少，管理和压缩 | 实测可以一起用 |
| [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 4.9k | 侧边栏：文件预览编辑、终端、Git、子代理 | 只是界面，不碰请求 |
| [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | 7.1k | 终端界面 | 只是界面 |
| [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | 2.7k | 多个 agent 组队分工 | 成员的模型要选 Ferry 的 |
| [cc-safety-net](https://github.com/kenryu42/cc-safety-net) | 1.9k | 执行前拦掉危险命令、读密钥文件 | 工具层，不碰请求 |
| [dsh-im](https://github.com/xmanrui/dsh-im) | 3.3k | 飞书、企业微信、钉钉等机器人接入 DSH | 不碰请求；工作电脑上要看网络是否放行 |

## 工作电脑上不建议

| 插件 | 星 | 原因 |
|---|---|---|
| [modlens](https://github.com/liustack/modlens)、[dsh-vision-router](https://github.com/ysr666/dsh-vision-router) | 4.8k、1.2k | 给纯文本模型加看图能力，图片直接发给它们自己的云端模型，不经 Ferry。Ferry 的模型本来就能看图（服务端没设 `vision = false` 的都能） |
| [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)、[dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 等模型来源插件 | 63k、1.2k | 各自是一条独立路线，能和 Ferry 共存，但请求从工作电脑直连，不经 Ferry |
| [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)、[ds-harness-remote](https://github.com/liguobao/ds-harness-remote) | 2.8k、2.0k | 把 DSH 开放到手机或公网，工作电脑上多半不合规 |
| [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | 7.0k | 带一个运行时注入器，会改 DSH 内部；要用的话，路由到的模型都得是 Ferry 的 |
| [dsh-ops](https://github.com/T-Auto/dsh-ops) | 5.4k | 当前版本装不上 DSH 0.2.2 |
| dsh-purge 及其镜像 | 20k | 越狱提示词，不用 |

## 找插件的地方

- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：分类精选列表
- GitHub 话题 [dsh-plugin](https://github.com/topics/dsh-plugin)，按星排序
- DSH 里的插件市场（[dsh-market](https://github.com/dsh-market/dsh-market)）
