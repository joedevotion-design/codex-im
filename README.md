# codex-im

通过飞书、钉钉或企业微信，在手机上控制电脑中正在运行的 Codex CLI。

这是基于 [openai/codex](https://github.com/openai/codex) 的非官方 fork。新增 `/lark`、`/dingtalk`、`/wecom`，将 IM 消息接入**当前终端的同一段对话**，而不是另开独立机器人会话。

> npm/pnpm 安装的 `@openai/codex` 是官方版本，不包含本仓库的 IM 功能。请构建并运行本仓库的可执行文件。

## 功能与平台

- 手机提交任务，终端同步显示输入和执行结果，保留当前对话上下文。
- 沿用终端的项目目录、模型、沙箱和审批设置，不绕过权限控制。
- 接收已完成的助手回复、任务完成或错误状态。
- 查询状态、停止任务、处理支持的执行和文件修改审批、回答澄清问题。
- 使用短时配对码绑定发送者和聊天，断开后重新配对。

| 命令 | 接入方式 | 前置条件 |
| --- | --- | --- |
| `/lark` | 飞书/Lark CLI 机器人事件 | `lark-cli`、机器人消息权限、事件订阅 |
| `/dingtalk` | 通过 `dws` 获取配置，使用机器人 Stream 连接 | `dws`、已开启 Stream 的机器人、`unifiedAppId` |
| `/wecom` | **推荐：智能机器人 API 长连接** | 官方 SDK、Bot ID、Bot Secret |
| `/wecom` | 兼容：WeCom CLI 登录后轮询消息 | `wecom-cli`，企业允许会话及聊天记录接口 |

**电脑、Codex 终端和网络必须保持运行。** 这不是云端托管或后台常驻服务。扫码只完成相应 CLI 授权，不等于创建好机器人或开通消息权限；企业微信长连接使用机器人凭据，不需要扫码。

## 快速开始

1. 按[构建说明](#build)生成自建版本。
2. 安装 Node.js 22+，按[平台配置](#platform-setup)准备对应 CLI 或 SDK，确保启动 Codex 的终端能够找到它们。
3. 在目标项目中启动自建 Codex，完成 Codex 自身登录，进入要远程控制的对话。
4. 等当前任务结束，输入 `/lark`、`/dingtalk` 或 `/wecom`，按提示连接。
5. 五分钟内向对应机器人**私聊**发送终端显示的完整消息：`/pair <配对码>`。
6. 收到配对确认后发送任务。先询问终端对话中已提及的内容，确认上下文一致，再尝试实际操作。

每个终端只支持一条活动 IM 连接。连接期间再次执行任一 IM 命令会断开当前连接；切换平台时，断开后再执行目标平台命令。

<a id="build"></a>
## 从源码构建

构建需要 Git、[Rustup](https://rustup.rs/) 和目标平台的原生编译工具。IM 功能还需要 Node.js 22+ 及相应平台依赖。Rust 版本由 [rust-toolchain.toml](codex-rs/rust-toolchain.toml) 固定，由 Rustup 自动选择。

请克隆本仓库，而不是上游仓库：

```shell
git clone https://github.com/joedevotion-design/codex-im.git
cd codex-im
```

### macOS / Linux

环境准备见[上游构建说明](docs/install.md)。从本仓库根目录进入 Cargo 工作区，构建 CLI 和工具执行所需的辅助程序：

```shell
cd codex-rs
cargo build -p codex-cli -p codex-code-mode-host --bins --profile dev-small
./target/dev-small/codex --version
./target/dev-small/codex -C /path/to/project
```

将 `/path/to/project` 替换为实际项目路径。

<a id="windows-build"></a>
### Windows x64

安装 Visual Studio C++ 构建工具和 Windows SDK。以下 V8 依赖解析步骤还需要 Python 3.11+。从仓库根目录在 PowerShell 执行：

```powershell
$env:CODEX_REPO_ROOT = (Get-Location).Path
Set-Location codex-rs

# Resolve the repository-pinned V8 archive and bindings.
$v8 = python -c "import sys,json; sys.path.insert(0,'../scripts'); from codex_package.v8 import resolve_codex_v8_cargo_env; from codex_package.targets import TARGET_SPECS; print(json.dumps(resolve_codex_v8_cargo_env(TARGET_SPECS['x86_64-pc-windows-msvc'])))" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'V8 dependency setup failed' }
foreach ($item in $v8.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($item.Name, [string]$item.Value, 'Process')
}

cargo build -p codex-cli -p codex-code-mode-host -p codex-windows-sandbox --bins --profile dev-small
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

$codexIm = (Resolve-Path .\target\dev-small\codex.exe).Path
& $codexIm --version
```

上述示例使用仓库的 `dev-small` 开发构建配置。首次构建会下载依赖，耗时和资源用量取决于环境。

产物在 `codex-rs/target/dev-small/`。运行或迁移时，保留以下程序在同一目录，不要只复制 `codex.exe`：

```text
codex.exe
codex-code-mode-host.exe
codex-command-runner.exe
codex-windows-sandbox-setup.exe
```

独立的 code-mode host 是部分模型执行工具所需的程序。仅构建 TUI 或 CLI 不会自动生成全部辅助程序。

### 与官方 CLI 共存

建议保留官方版本，通过完整路径启动自建版。在上面的 PowerShell 会话中，可以输入目标项目路径后启动：

```powershell
$projectPath = Read-Host 'Project directory'
& $codexIm -C $projectPath
```

`$codexIm` 仅在当前 PowerShell 会话有效；新终端可直接使用构建产物的绝对路径。`Get-Command codex -All` 可以检查裸命令指向哪个安装。不要直接替换 npm/pnpm 管理的文件，包更新可能覆盖它。

更新构建产物前，先在运行中的自建 CLI 输入 `/exit`，否则 Windows 会锁定可执行文件。重新打开后可恢复原有会话，但 IM 需要重新连接和配对。

<a id="platform-setup"></a>
## 平台配置

### 飞书 / Lark

安装官方 [Lark CLI](https://github.com/larksuite/cli)：

```shell
npm install -g @larksuite/cli
```

在开发者后台配置应用机器人，开通消息权限、订阅 `im.message.receive_v1`，确保应用对目标用户可用。在自建 Codex 中执行 `/lark`，按提示初始化、扫码或浏览器授权，也可预先执行：

```shell
lark-cli config init
lark-cli auth login --recommend
```

适配器依赖 `event consume im.message.receive_v1 --as bot` 接收事件，以及 `im +messages-send --as bot` 回复消息。配对后收不到消息时，应检查权限和事件配置，而不只是重复登录。

### 钉钉

安装官方 [DingTalk Workspace CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)：

```shell
npm install -g dingtalk-workspace-cli
```

准备已开启 Stream 的机器人及其 `unifiedAppId`。在自建 Codex 中执行 `/dingtalk`，按提示登录并填写应用 ID，也可预先执行 `dws auth login --format json`。

回复使用临时 webhook。任务持续很久时，旧 webhook 可能过期，可从手机发送 `/status` 更新回复通道。企业应用创建及权限配置可能需要管理员协助。

### 企业微信：推荐 API 长连接

在企业微信管理端创建支持 **API 长连接**的智能机器人，取得 Bot ID 和 Secret。普通群机器人 webhook 不能代替此类机器人。

安装适配器使用的[官方 SDK](https://github.com/WecomTeam/aibot-node-sdk)：

```shell
npm install -g @wecom/aibot-node-sdk@1.0.7
```

在启动 Codex 的进程环境中设置 `CODEX_WECOM_BOT_ID` 和 `CODEX_WECOM_BOT_SECRET`。可通过系统环境变量或凭据管理工具注入，不要写入项目配置。PowerShell 的交互式设置示例：

```powershell
$env:CODEX_WECOM_BOT_ID = Read-Host 'Bot ID'
$secret = Read-Host 'Bot Secret' -AsSecureString
$env:CODEX_WECOM_BOT_SECRET = [System.Net.NetworkCredential]::new('', $secret).Password
```

随后启动自建 Codex 并输入 `/wecom`。该模式跳过扫码，在 WebSocket 认证成功后显示配对码；向机器人私聊发送配对消息。它不依赖读取聊天记录的接口权限，仅接受私聊文本。

两个环境变量必须同时提供。连接失败不会自动退回 CLI 轮询。SDK 需要安装在启动终端 `PATH` 对应的 npm 全局安装位置。建议使用专用机器人，另一客户端使用相同机器人连接可能挤掉当前连接。

**不要把 Secret 发到 Codex、IM 聊天或提交进仓库。** 凭据会以环境变量传给本地桥接进程，不写入连接文件。退出 Codex 后若继续共用终端，可清除变量：

```powershell
Remove-Item Env:CODEX_WECOM_BOT_ID, Env:CODEX_WECOM_BOT_SECRET -ErrorAction SilentlyContinue
```

### 企业微信：CLI 扫码与轮询

未设置上述机器人环境变量时，`/wecom` 使用兼容的 CLI 模式：

```shell
npm install -g @wecom/cli
```

向导可执行 `wecom-cli auth init --noninteractive`。该模式依赖企业开放机器人会话列表和 `chat messages list` 等接口，扫码成功不代表拥有这些能力。

若返回 **`853006`**，说明当前企业不能使用相关接口。重复扫码不是修复方式，应咨询管理员或改用 API 长连接机器人。旧模式每三秒轮询最近至多 20 个机器人会话，去重不是严格的 exactly-once；避免在同一秒内重复发送完全相同的操作。

## 手机端命令

| 消息 | 行为 |
| --- | --- |
| 普通文本 | 作为当前终端对话的用户消息提交 |
| `/status` | 查看绑定的会话及是否正在执行 |
| `/stop` | 请求中断当前任务 |
| `/approve ID` | 批准转发的受支持审批 |
| `/deny ID` | 拒绝相应审批 |
| `/answer ID {"question_id":{"answers":["answer"]}}` | 使用机器人给出的请求及问题 ID 回答澄清问题 |

将 `ID`、`question_id`、`answer` 替换成实际值。手机不提供完整终端斜杠命令集，`/model`、`/resume` 等仍在终端操作；未识别的斜杠命令会被拒绝。以 `!` 开头的文本仍是普通用户消息，不会直接作为 shell 命令执行。

## 边界与安全

- 连接绑定建立时显示的会话；切换到其他会话后，需要切回才能继续接受手机任务。
- 当前任务运行中、终端弹窗未关闭或会话不可写时，新任务会被拒绝，不会无限排队。
- 仅支持文本，每条输入上限 12,000 UTF-8 字节；不支持图片、附件和语音。
- 转发已完成的助手消息及状态，不镜像逐 token 输出、完整工具日志或历史记录。
- 部分工具专属授权、MCP 交互或无法远程表示的审批仍需在终端处理。
- 配对码五分钟有效，首条有效配对绑定发送者和聊天。请勿分享配对码或在公开群中配对。
- 配对者可在现有 Codex 权限范围内请求操作项目。只连接可信账号，按需设置沙箱和审批策略。
- 断开或重启后需重新连接和配对，不提供离线任务投递保证。

## 常见问题

**没有新增 IM 命令？** 检查是否运行本仓库生成的可执行文件，而不是 PATH 中的官方版本。更新官方 npm/pnpm 包不会安装本 fork。

**提示 `IM connection closed`？** 查看前面的具体错误：可能是 CLI/SDK 不可用、授权或权限问题、连接被关闭。企业微信 `853006` 按上文处理；长连接检查机器人凭据、SDK 安装，以及是否有其他客户端使用该机器人。

**手机消息没有进入终端？** 确认配对未过期、发送者和聊天与配对时一致、终端仍显示绑定会话，且没有正在运行的任务或未关闭的弹窗。

## 开发与测试

从仓库根目录运行桥接测试：

```shell
node --test codex-rs/tui/assets/im-bridge/runtime_tests.mjs codex-rs/tui/assets/im-bridge/process_tests.mjs codex-rs/tui/assets/im-bridge/wecom_ws_tests.mjs codex-rs/tui/assets/im-bridge/wecom_sdk_tests.mjs
just test -p codex-tui --cargo-profile dev-small
```

Rust 测试需安装仓库使用的 `just`、`cargo-nextest`，并准备构建依赖。未安装企业微信 SDK 时，对应集成测试会跳过，不能视为平台验证通过。实现和测试细节见 [IM bridge README](codex-rs/tui/assets/im-bridge/README.md)。

模拟测试不覆盖企业权限、机器人发布状态和真实消息链路。部署后应使用真实机器人完成配对、任务收发和审批测试，并确认手机输入与回复出现在同一段终端对话中。

## 上游与许可

- [OpenAI Codex 源码](https://github.com/openai/codex)
- [Codex 官方文档](https://developers.openai.com/codex)
- [上游构建说明](docs/install.md)与[贡献指南](docs/contributing.md)

本项目是社区 fork，非 OpenAI 官方 IM 产品，也不代表各 IM 平台的官方集成。代码沿用 [Apache-2.0 许可证](LICENSE)。
