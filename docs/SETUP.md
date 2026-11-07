# 一步步配置：家里电脑当服务端，工作电脑用 DSH

整体是这样：

```
工作电脑：DSH + dsh-llm-ferry 插件 ──小块上传──▶ 家里电脑：dsh-ferry 服务端 ──▶ DeepSeek（或别的模型）
```

工作电脑上不放 DeepSeek 的 Key，Key 只在家里电脑上。

## 一、家里电脑（服务端）

1. 装 Node 24 或更新的版本。

2. 编一个令牌，至少 16 个字符，比如用 `openssl rand -hex 16` 生成。工作电脑连服务端时要用它。

3. 启动服务端。Mac：

   ```sh
   export DEEPSEEK_API_KEY=sk-...
   export DSH_FERRY_TOKEN=<令牌>
   npx -y github:wvans123/dsh-ferry serve
   ```

   Windows（PowerShell）：

   ```powershell
   $env:DEEPSEEK_API_KEY = "sk-..."
   $env:DSH_FERRY_TOKEN = "<令牌>"
   npx -y github:wvans123/dsh-ferry serve
   ```

   看到 `DSH Ferry server ... on http://127.0.0.1:8790` 就是起来了。窗口要一直开着。

   想要手机通知（任务做完、等你批准），装 Bark App，把它给的地址也设上再启动：`export BARK_URL=https://api.day.app/<你的 key>`（Windows：`$env:BARK_URL = "..."`）。

4. 开到外网。和 Ferry 一样用 Cloudflare Tunnel。临时试用：

   ```sh
   cloudflared tunnel --url http://127.0.0.1:8790
   ```

   它会给一个 `https://xxx.trycloudflare.com` 地址，每次启动都会变。长期用建一个固定的命名隧道，指向 `http://127.0.0.1:8790`。

5. 在家里先试一下：

   ```sh
   curl https://<你的地址>/health
   ```

   返回 `{"ok":true,"server":"dsh-ferry",...}` 就通了。

6. 长期用，让它在后台跑，开机自己起来，挂了自己重启。先把 `npx -y github:wvans123/dsh-ferry` 装成固定命令，免得每次启动去 GitHub 取：`npm install -g github:wvans123/dsh-ferry`，以后用 `dsh-llm-ferry serve`；升级再跑一次这条。

   Mac（launchd）。写 `~/Library/LaunchAgents/dsh-ferry.plist`，把 Key、令牌、路径换成自己的（`which dsh-llm-ferry` 看路径）：

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>dsh-ferry</string>
     <key>ProgramArguments</key><array>
       <string>/opt/homebrew/bin/dsh-llm-ferry</string><string>serve</string>
     </array>
     <key>EnvironmentVariables</key><dict>
       <key>DEEPSEEK_API_KEY</key><string>sk-...</string>
       <key>DSH_FERRY_TOKEN</key><string>你的令牌</string>
       <key>BARK_URL</key><string>https://api.day.app/你的key</string>
       <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>/tmp/dsh-ferry.log</string>
     <key>StandardErrorPath</key><string>/tmp/dsh-ferry.err</string>
   </dict></plist>
   ```

   然后 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dsh-ferry.plist`。停：`launchctl bootout gui/$(id -u)/dsh-ferry`。改了 plist 要先 bootout 再 bootstrap。这个文件里有 Key，`chmod 600` 它。Cloudflare Tunnel 自己的服务用 `cloudflared service install`。

   Windows（计划任务）。管理员 PowerShell：

   ```powershell
   $cmd = (Get-Command dsh-llm-ferry.cmd).Source
   [Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "sk-...", "User")
   [Environment]::SetEnvironmentVariable("DSH_FERRY_TOKEN", "你的令牌", "User")
   $action  = New-ScheduledTaskAction -Execute $cmd -Argument "serve" -WorkingDirectory "$env:USERPROFILE\.dsh-ferry"
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
   Register-ScheduledTask -TaskName dsh-ferry -Action $action -Trigger $trigger -Settings $settings
   Start-ScheduledTask -TaskName dsh-ferry
   ```

   日志在任务计划程序里看不到，想留日志就把 `-Argument` 写成 `serve --config D:\ferry\dsh-ferry-server.json` 并用 `cmd /c "... serve >> D:\ferry\dsh-ferry.log 2>&1"` 的形式。

7. 服务端留下的东西都在 `~/.dsh-ferry`（Windows：`%USERPROFILE%\.dsh-ferry`）：`store/` 是工作电脑传上来的对话（服务端重启、DSH 重启、恢复旧会话都不用重传），`usage.jsonl` 是每次模型调用的 token、缓存命中、费用和首字时间（从请求到达服务端到模型吐出第一个字）。看一眼花了多少、快不快：

   ```sh
   dsh-llm-ferry stats            # 最近 30 天，按天、按模型；最后一列是首字时间的中位数
   dsh-llm-ferry stats --days 7
   ```

   首字时间长，钱又没省（cache 那列低），多半是对话开头每轮都在变，缓存没命中；正常应该在 80% 以上。

   每天花费超过多少就让 Bark 提醒一次：配置里写 `"dailyBudget": 5`（单位和模型价格一致）。

   不想落盘，配置里写 `"dataDir": false`，或者环境变量 `DSH_FERRY_DATA=`（空）。换个地方，`"dataDir": "D:\\ferry\\data"`。

## 二、工作电脑（Windows）

两种装法，任选其一：

- 桌面版（推荐）：DeepSeek Harness 的 Windows 安装包，自带 Node 和 pnpm，不用另装。往下看"二甲"。
- 命令行版：自己装 Node，用 npm 装 DSH，用浏览器打开网页版。往下看"二乙"。

### 二甲、桌面版

1. 从 [deepseek.com/harness](https://www.deepseek.com/harness) 下载 Windows 安装包并安装。

2. 公司代理和证书（同下面"二乙"的第 2 步）。桌面版从 Windows 继承环境变量，用 `setx` 设好后重新打开桌面版即可。

3. 打开桌面版一次（它会建好自己的 profile），先不用填 DeepSeek Key。

4. 装插件：左侧"插件"→"添加插件"，在输入框里填下面任意一种，点安装，装完点"立即启用"：
   - `github:wvans123/dsh-ferry`（能上 GitHub 时）；
   - 下载好的压缩包的完整路径，比如 `C:\Users\你\Downloads\dsh-ferry.tgz`（下载地址见"二乙"第 4 步）。

5. 填服务端地址和令牌：完全退出桌面版（托盘图标右键"退出"），用记事本打开 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，写入：

   ```yaml
   - id: llm-ferry
     config:
       server: https://<你的地址>
       token: <令牌>
   ```

6. 重新打开桌面版。新会话的模型应当是 `auto (DeepSeek V4.1 Flash)`，推理等级 High。

测块大小（可选）：桌面版也自带 `dsh` 命令，插件在 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-llm-ferry`，probe 的用法同"二乙"第 6 步（把路径里的 `web` 换成 `desktop`）。

### 二乙、命令行版

下面的命令都在 PowerShell 里执行。`setx` 设的变量要新开一个窗口才生效。

1. 装 Node 24.9 或更新的版本（DSH 要求）。

2. 公司代理和证书。DSH、npm、pnpm 都要用：

   ```powershell
   setx HTTPS_PROXY "http://<公司代理>:<端口>"
   setx HTTP_PROXY  "http://<公司代理>:<端口>"
   ```

   公司会检查 HTTPS 的话，还要让 Node 认公司的证书。装过 ferry 的，直接用 ferry 的证书文件：

   ```powershell
   setx NODE_EXTRA_CA_CERTS "$env:USERPROFILE\.ferry\ca-bundle.pem"
   ```

   没装 ferry 的，让 Node 读 Windows 自己的证书库：

   ```powershell
   setx NODE_USE_SYSTEM_CA 1
   ```

3. 装 pnpm 和 DSH（新开一个窗口）：

   ```powershell
   npm install -g pnpm @deepseek-ai/dsh
   ```

4. 装插件。DSH 的网页版用 `web` 这个 profile，终端版用 `tui`，下面以 `web` 为例。

   能上 GitHub、装了 git 的：

   ```powershell
   dsh plugin --profile web add github:wvans123/dsh-ferry
   ```

   没有 git 或上不了 GitHub 的：在能上网的地方下载 `https://codeload.github.com/wvans123/dsh-ferry/tar.gz/main`，存成 `dsh-ferry.tgz`，拷到工作电脑上，然后：

   ```powershell
   dsh plugin --profile web add C:\路径\dsh-ferry.tgz
   ```

5. 填服务端地址和令牌。用记事本打开 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`（没有就新建），写入：

   ```yaml
   - id: llm-ferry
     config:
       server: https://<你的地址>
       token: <令牌>
   ```

   这台电脑装过 ferry、并且 `ferry login` 连的就是这个服务端的话，这一步可以不做，插件会读 `%USERPROFILE%\.ferry\config.json`。

6. 测一下这台电脑的网络能过多大的请求，并把结果存下来。插件装好后，它的命令在 profile 里：

   ```powershell
   node "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-llm-ferry\bin\dsh-llm-ferry.js" probe --server https://<你的地址> --token <令牌> --save
   ```

   输出类似 `The limit is about 100 KB. Parts of 80 KB fit.`，测出的块大小会存进 `%USERPROFILE%\.ferry\config.json`，插件启动时读。不测也行，默认就是 80 KB，被拦了会自动减半。

7. 启动 DSH：

   ```powershell
   dsh web
   ```

   浏览器会打开 `http://127.0.0.1:3080`。模型选择框里是服务端的模型（`auto (DeepSeek V4.1 Flash)`、`DeepSeek V4.1 Flash`、`DeepSeek V4 Pro`），默认就是 `ferry/auto`。

## 三、确认确实经过了插件和服务端

先跑自检：`node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-llm-ferry\bin\dsh-llm-ferry.js" doctor --workspace D:\dsh-work`（命令行版把 desktop 换成 web），它会逐项告诉你哪里不对。装好以后怎么用顺见 [WORK-PC.md](WORK-PC.md)。


- DSH 的模型列表里只有服务端给的模型。
- 家里电脑的服务端窗口里，每问一次都会出现一行 `/anthropic/v1/messages`（小的增量就在这一个请求里，`inline` 字段是这回带上来几条；大的先有 `/v1/ferry/commit`，更大的还有 `/v1/ferry/upload/...` 分块；恢复旧会话时前面多一行 `/v1/ferry/head`）。没有这些记录，说明请求没到服务端。
- 想看得更细：服务端日志里每行都有 `bytes`（请求大小）。分块和提交不超过你设的块大小，模型请求只有几百字节。

## 常见问题

- 模型列表是空的（"暂无可用模型"）：插件连不上服务端。先在工作电脑的浏览器里打开 `https://<你的地址>/health` 看看。公司网关要确认的话，先在浏览器里确认一下。服务端起来以后，插件 15 秒内会自己再试，不用重启 DSH。
- 报 `token rejected` 或 401：令牌和服务端的 `DSH_FERRY_TOKEN` 不一致。
- 报证书错误（`unable to get local issuer certificate` 之类）：第二步的证书没设好，或者设了之后没新开窗口。
- 请求被拦（HTTP 403）：插件会自动把块减半重发。总是被拦就跑一下第 6 步的 probe；还不行，在第 5 步的配置里加 `compress: false`（有的网关拦压缩过的数据）。
- 想换模型、加 Kimi 或 Claude：改家里电脑上的服务端配置，见 README 的"自带服务端"。工作电脑不用动，5 分钟内 DSH 里就会出现新模型。
