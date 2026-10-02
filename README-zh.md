# tg-cc-bot

[English](README.md) · [架构文档（英文）](docs/ARCHITECTURE.md)

用 Telegram 遥控服务器上的 **Claude Code**，用你自己的 **Claude 订阅（Pro/Max）登录**。和 bot 的**每个新对话就是一个独立的 Claude Code 会话**。

底层是官方 [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 驱动的、未修改的 Claude Code 进程。系统提示词、Agent 循环、工具、skills、CLAUDE.md、MCP、hooks、权限系统都由 Claude Code 自己处理，bot 不额外加任何提示词。唯一的例外：bot 起的会话里会关掉 Claude Code 的 Telegram 频道插件，否则每个会话都会再去拉一遍这个 bot 的消息。bot 负责收发消息、渲染输出、把提示变成按钮，并管理哪些会话需要有进程在跑。

> 合规说明：Anthropic 不允许把订阅 OAuth token 拿出来自己调 API（OpenClaw 那种做法）。这里由 Claude Code 二进制自己完成登录和请求，属于"用户用自己的订阅登录未修改的 Claude Code"。用量计入你的订阅额度，多个对话并行时消耗更快。2026 年 6 月那次"SDK 单独额度池"的改动已暂停，如果将来恢复，SDK 用量会改走单独额度。

## 使用模型：对话就是会话

在 @BotFather 里开启 **Threaded Mode** 后，Telegram 会把你和 bot 的聊天拆成多个独立的**对话**：在 bot 的主屏幕上打字就会新建一个对话，所有对话都列在 bot 的对话列表里。tg-cc-bot 这样对应：

- **每个对话就是一个 Claude Code 会话**：对话里第一条发给 Claude 的消息会在**当前项目**里开始会话，之后的消息接着这个会话。离开对话、随时回来，会话都从原来的地方继续。
- **bot 命令是机械性的**：`/projects`、`/status`、`/settings`、`/model` 等命令不经过 Claude，在任何对话里都能用；只发过这类命令的对话不会变成会话。
- **其它内容都交给 Claude**，包括 Claude Code 自己的斜杠命令和你的 skills。

想换目录工作：先在任意对话里切换项目（比如 `/project use api`），再新建对话。如果是在一个还没和 Claude 说过话的对话里切换，这个对话也会一起换过去。`/resume` 可以在当前对话里接着之前的会话聊（包括在服务器终端里用 Claude Code 开的会话），和 Claude Code 自己的 `/resume` 一样；这个对话原来的会话仍然留在列表里。

## 功能

- **并行会话**：多个对话可以同时工作，各自有项目目录、模型、权限模式和 effort。
- **流式回复**：用 `sendMessageDraft` 实时预览，不可用时自动改成编辑消息。最终回复把 Markdown 转成 Telegram HTML；太长会安全切分（代码块不会被切断），特别长的转成 `.md` 文件发送。
- **工具调用压缩显示**：例如 `💻 Bash ls -la`，子代理的调用缩进显示。`/verbose` 额外显示工具输出和耗时。
- **提示变成按钮**：权限请求（允许 / 总是允许 / 拒绝）、`AskUserQuestion`（单选、多选）、计划审批，都显示在发起请求的那个对话里。有提示等待时直接回复文字，等于拒绝并告诉 Claude 该怎么做，或者用你自己的话回答问题。
- **完整的 Claude Code 命令**：内置命令、自带 skills、你的个人和项目 skills、插件命令、`.claude/commands` 在每个对话里都能用，也会出现在 Telegram 命令菜单里。
- **对话标题**：你没起名的对话会用第一句提问自动命名，你自己起的名字不会被覆盖。`/rename` 同时修改对话名和会话名。
- **图片和文件**：图片直接发给 Claude 看；文件存到 `<项目>/.tg-uploads/`，再把路径告诉 Claude。
- **状态提示**：上下文压缩、API 重试、用量预警、权限被拒都会提示。`/status` 同时显示当前对话的会话（含上下文占用）和 bot 的进程池状态。
- bot 自身的界面消息（按钮、提示、命令说明）是英文；Claude 的回复语言跟随你的提问。

## 命令

所有 bot 命令在任何对话里都能用，都不经过 Claude。

### 当前对话的会话

| 命令 | 作用 |
|---|---|
| `/stop` | 中断当前回合，取消待处理的提示，以及还在排队等进程的消息 |
| `/model [名称]` · `/mode [模式]` · `/effort [等级]` | 查看（按钮）或修改这个对话的模型、权限模式、effort；第一条消息之前也能设置 |
| `/verbose` | 开关这个对话的工具输出和耗时 |
| `/rename <标题>` | 重命名这个对话和它的会话 |
| `/fork` | 把这个会话复制到一个新对话 |
| `/close` | 立即关闭这个对话的进程；下一条消息会自动恢复 |
| `/delete` | 确认后删除对话及其消息（会话本身保留，仍可恢复） |

### bot

| 命令 | 作用 |
|---|---|
| `/help` | 使用说明和命令列表 |
| `/status` | 当前对话的会话，以及运行中的进程、排队的消息、内存、Claude Code 版本 |
| `/sessions` | 有会话的对话及其状态（🟢 运行中、🟡 空闲、⚪ 已休眠），点一下跳到那个对话 |
| `/resume [all\|id]` | 在当前对话里继续之前的会话（当前项目、全部项目，或按 ID） |
| `/projects` | 列出项目，按钮切换当前项目 |
| `/project add <名称> <路径>` | 登记一个项目目录（必须存在，设置了 `ALLOWED_ROOTS` 时必须在其范围内），并设为当前项目 |
| `/project use <名称>` · `/project rm <名称>` | 切换当前项目（当前对话还没和 Claude 说过话时也一起切换） · 删除项目 |
| `/settings` | 新对话的默认模型、权限模式、effort、verbose |

没有 `/new`：回到 bot 主屏幕打字就是新对话。

其它斜杠命令原样交给 Claude Code：`/compact`、`/context`、`/usage`、`/clear`、`/init`、`/config key=value`、`/output-style`、`/code-review`，以及你所有的 skills 和插件命令，可以带参数。

Telegram 菜单名只允许 `[a-z0-9_]`，所以 `code-review` 在菜单里显示为 `/code_review`，`plugin:skill` 显示为 `/plugin_skill`，两种写法都能用。

## 会话和进程

会话不等于进程。Claude Code 会话保存在磁盘上的记录里，只有会话正在工作时才需要一个运行中的 Claude Code 进程。

- 对话的进程在第一条消息时启动；会话已经存在时则是恢复。
- 空闲超过 `SESSION_IDLE_MINUTES`（15 分钟）后进程会被关闭。下一条消息自动恢复会话，大约需要 1 秒。
- 同时最多运行 `MAX_LIVE_SESSIONS`（3）个进程。需要新进程时，关掉最久没用的空闲进程；如果全都在忙，消息会排队（"⏳ waiting for a free slot"），`/stop` 可以取消排队。
- 进程在工作、等你回答提示、或有后台任务时，绝不会被关闭（后台任务最长 `BACKGROUND_MAX_MINUTES`）。
- 存在进程里的设置（模型、权限模式、effort）按对话保存，每次恢复都会带上。
- bot 重启后所有对话都处于休眠状态，下一条消息时自动恢复。

完整设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 权限和安全

- **谁能用**：只有 `ALLOWED_USER_IDS` 里的 Telegram 用户，而且只在私聊里。其他人只会收到一条包含其 user ID 的回复，方便你决定是否把他加进来。群聊一律忽略。没配置白名单时 bot 拒绝启动。
- **默认 `auto` 模式**：常规操作由 Claude Code 的分类器自动批准，需要升级的操作以按钮形式询问。账户或模型不支持 auto 时，该对话会自动改为 `acceptEdits` 并告诉你。
- **无人响应的提示**在 `PERMISSION_TIMEOUT_MS`（默认 10 分钟）后自动拒绝。
- **`bypassPermissions`**（通过 `/mode` 或 `/settings`）让 Claude 不经询问执行任何操作，只在你愿意让 Claude 随意改动的机器上用。
- **项目目录**可以用 `ALLOWED_ROOTS` 限制在指定目录下。
- Claude Code 以运行 bot 的那个账户身份运行，拥有该账户的文件权限。不要用 root；想隔离的话，用一个专用账户（见[前提条件](#前提条件)）。

## 前提条件

无论是本地运行还是部署到服务器，都请先**用将来运行 bot 的那个账户**（通常就是你自己的账户，见本节最后的说明）完成以下几项：

1. **Claude Pro 或 Max 订阅。**
2. **安装 Claude Code 并登录。**
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash   # 适用于 Linux、macOS、WSL；其它平台见 Claude Code 文档
   claude                                           # 然后输入 /login
   ```
   通过 SSH 登录服务器时没有浏览器：在任意设备上打开 Claude Code 给出的链接完成登录，再把验证码贴回终端。用下面的命令确认登录成功：
   ```bash
   claude auth status    # 输出里有 "loggedIn": true
   ```
   没有浏览器时的替代办法：在任意一台有浏览器的机器上运行 `claude setup-token`，把得到的 token 作为 `CLAUDE_CODE_OAUTH_TOKEN` 交给 bot（写进 `.env`，或者用 `sudo CLAUDE_CODE_OAUTH_TOKEN=<token> bash deploy/deploy.sh` 部署）。token 有效期一年。
3. **开启了话题模式的 Telegram bot。** 在 [@BotFather](https://t.me/BotFather) 用 `/newbot` 创建 bot 并复制 token。然后在 BotFather 里打开这个 bot → **Bot Settings → Threaded Mode**，开启话题模式，并允许用户创建话题（新建对话靠它）。用 [@userinfobot](https://t.me/userinfobot) 查到你自己的数字 user ID。
4. **运行环境。** 部署到服务器：需要带 systemd 的 Linux（x64/arm64）和 `sudo` 权限，Bun 由部署脚本自动安装。本地运行：需要 [Bun](https://bun.sh) 或 Node.js 24。

bot 会以完成第 2 步的那个账户运行，并共用它的 Claude 登录、skills、设置和会话记录。想和自己的账户分开的话，先建一个专用账户，用 `sudo -iu <账户名>` 切过去完成第 2 步，部署时加上 `--user <账户名>`。

## 部署（Linux）

先完成上面的[前提条件](#前提条件)。然后在将来运行 bot 的那个账户下，一条命令完成配置、启动和自查：

```bash
git clone https://github.com/AugusLcz/telegram-cc-bot.git tg-cc-bot && cd tg-cc-bot
sudo bash deploy/deploy.sh
```

脚本依次执行以下步骤，可以随时重复运行：

1. **预检**：确认是 Linux x64/arm64 且有 systemd；缺 `curl`、`unzip`、`git` 就自动安装；检查 Telegram、Anthropic、bun.sh 和 npm 能否连通。
2. **检查前提条件**：确认这个账户已经安装并登录了 Claude Code。没有的话立即停下，打印出需要执行的命令；脚本不会自己创建账户，也不会自己执行登录。
3. **Bun**：为这个账户安装；已有且版本够新就跳过。
4. **应用**：把代码复制到 `/opt/tg-cc-bot` 并安装依赖。Agent SDK 会带上与自身版本匹配的 Claude Code，直接使用这个账户已有的登录。
5. **配置**：
   - 服务只读 `/opt/tg-cc-bot/.env`（权限 600）。环境变量里导出的设置会写进去（直接运行脚本、不加 `sudo`，它会自己用 `sudo -E` 重新运行；普通的 `sudo` 会丢掉环境变量）。这个 checkout 里 `.env` 中与它不同的值会列出来（bot token 只显示 bot ID），确认后复制过去。
   - 询问 bot token，并用 Telegram 接口验证；话题模式没开会提醒你。
   - 询问 user ID：可以直接填；也可以留空，然后给 bot 发一条消息，脚本会自动识别。
   - 询问第一个项目的目录。
6. **服务**：生成并启用 systemd unit，启动后一直等到日志里出现 polling 和 "Claude Code ready"。
7. **自查**：完整跑一遍下面的健康检查（包括一次真实的 Claude 请求），并输出汇总。

日常命令：

| 命令 | 作用 |
|---|---|
| `sudo bash deploy/deploy.sh check` | 只读的全面自查 |
| `sudo bash deploy/deploy.sh update` | `git pull` 或改了设置之后用：复制新代码、应用新的设置（同第 5 步）、重装依赖、重启并自查 |
| `sudo bash deploy/deploy.sh claude …` | 以运行 bot 的账户身份运行 Claude Code，比如 `claude mcp add …`、`claude plugin install …`，或者直接 `claude` 打开终端界面 |
| `sudo bash deploy/deploy.sh status` / `logs` | 查看服务状态和最近日志 / 实时跟踪日志 |
| `sudo bash deploy/deploy.sh uninstall [--purge]` | 移除服务（`--purge` 同时删掉 `/opt/tg-cc-bot`） |

**参数：**
- `--user`：运行 bot 的账户（默认是执行 `sudo` 的账户，已安装过的话沿用原来的账户）；`--dir`、`--service`：修改目录和服务名（默认 `/opt/tg-cc-bot`、`tg-cc-bot`）。
- `--reconfigure`：重新填写配置。
- `--no-live`：跳过实际调用 Claude 的测试。
- 无人值守安装：先 export `TELEGRAM_BOT_TOKEN`、`ALLOWED_USER_IDS`、`CLAUDE_CODE_OAUTH_TOKEN`，再运行 `sudo -E bash deploy/deploy.sh install --yes`。

**`check` 检查的内容：**
- **系统**：系统版本、CPU 架构、libc、systemd、内存、磁盘、必需工具。
- **网络**：Telegram、Anthropic、claude.ai 能否连通。
- **运行 bot 的账户**和 **Bun** 版本。
- **应用**：
  - 代码目录的所有者、依赖版本
  - 模块能否在 Bun 下正常加载
  - Claude Code 二进制能否运行
- **配置**：
  - `.env` 的文件权限
  - bot token 和 user ID 的格式
  - 第一个项目目录对这个账户是否可写
  - 各项模式、effort、日志级别、状态文件目录
  - 进程数上限，以及它和机器内存是否匹配
- **Telegram**：`getMe` 是否接受 token，话题模式是否开启，用户能否自己新建对话，有没有设置 webhook。
- **Claude 登录**：
  - 先看 `claude auth status`。
  - 再用 Haiku 发一次很小的真实请求。`auth status` 无法判断 token 是否有效，所以必须实际调一次。
- **服务**：
  - unit 文件是否存在，是否开机自启、是否在运行，重启了几次
  - 本次运行的日志里有没有 polling 和 "Claude Code ready"
  - 常见故障会附上原因：401（token 错误）、409（同一个 bot 有别的实例在拉取消息）、缺少配置项、权限不足

用的是 long polling，服务器不需要公网 HTTPS 入口。

想在部署前单独确认话题功能在你的 bot 上可用，可以运行：`CHAT_ID=<你的 user ID> bun scripts/topics-spike.ts`（先停掉正在运行的 bot）。

## 配置项（`.env`）

完整注释见 [.env.example](.env.example)。

| 变量 | 默认 | 说明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 必填 | BotFather 给的 token |
| `ALLOWED_USER_IDS` | 必填 | 允许使用的 Telegram user ID，逗号分隔 |
| `DEFAULT_CWD` | 家目录 | 第一个项目（`home`）的目录；更多项目用 `/project add` 添加 |
| `ALLOWED_ROOTS` | 不限 | 项目必须位于的目录，逗号分隔 |
| `DEFAULT_MODEL` | Claude Code 默认 | 新对话的模型（`opus`、`sonnet`、完整 ID…） |
| `DEFAULT_PERMISSION_MODE` | `auto` | 新对话的权限模式 |
| `DEFAULT_EFFORT` | 模型默认 | 新对话的 effort：`low`、`medium`、`high`、`xhigh`、`max` |
| `MAX_LIVE_SESSIONS` | `3` | 同时运行的 Claude Code 进程数上限 |
| `SESSION_IDLE_MINUTES` | `15` | 空闲多久后关闭进程 |
| `BACKGROUND_MAX_MINUTES` | `120` | 只剩后台任务在跑的进程，多久后关闭 |
| `CLAUDE_PATH` | SDK 自带 | 改用系统安装的 `claude` |
| `STATE_FILE` | `./data/state.json` | 项目、对话与会话的对应关系、设置的存储位置 |
| `STREAM_MODE` | `draft` | 实时预览：`draft` / `edit` / `off` |
| `PERMISSION_TIMEOUT_MS` | `600000` | 提示无人响应时多久后自动拒绝 |
| `LOG_LEVEL` | `info` | 设为 `debug` 时也记录 Claude Code 的 stderr |
| `CLAUDE_CODE_OAUTH_TOKEN` | 不设置 | 可选，`claude setup-token` 生成的长期 token |

新对话的默认设置也可以在 Telegram 里用 `/settings` 修改，它优先于上面的 `DEFAULT_*`。Claude Code 自己的配置照常生效：`~/.claude/settings.json`、`~/.claude/skills`、每个项目的 `.claude/` 目录、`CLAUDE.md`、`.mcp.json`。

## 排错

| 现象 | 处理 |
|---|---|
| 换了 bot token，脚本显示的还是旧 bot | 服务只读 `/opt/tg-cc-bot/.env`。运行 `sudo bash deploy/deploy.sh update`（或 `install`）：它会应用环境变量里导出的 token（普通 `sudo` 会把环境变量丢掉），并询问是否复制这个 checkout 的 `.env` 里的 token。换成另一个 bot 后，旧 bot 的对话绑定会先存起来（换回去时自动恢复），那些会话仍然可以用 `/resume` 打开 |
| 不确定哪里有问题 | 先跑 `sudo bash deploy/deploy.sh check`，每个 ✗ 都附有修复提示 |
| bot 提示 Threaded Mode 没开 | 在 @BotFather → 你的 bot → Bot Settings 里开启 **Threaded Mode**，然后重启 bot |
| 在主屏幕打字不会新建对话 | 在 @BotFather 的 Threaded Mode 设置里允许用户创建话题 |
| 回复 `Failed to authenticate: OAuth session expired` | 运行 bot 的账户登录过期了。用这个账户运行 `claude` 再输入 `/login`（不需要重启 bot） |
| 部署停在 "Prerequisites" | 这个账户还没安装或没登录 Claude Code。按脚本打印的命令做完，再重新运行脚本 |
| 出现 "⏳ waiting for a free slot" | `MAX_LIVE_SESSIONS` 个进程都在忙。等一下、在别的对话里用 `/stop`，或调高上限 |
| 提示 "Auto mode isn't available…" | 部分账户或模型会这样。该对话已改为 `acceptEdits`，可以用 `/mode` 换成别的 |
| 误删了一个对话 | 会话还保存在磁盘上，用 `/resume` 重新打开 |
| 流式预览不动 | 设置 `STREAM_MODE=edit`（drafts 不可用时 bot 也会自动切换） |
| bot 完全没反应 | 确认你的 ID 在 `ALLOWED_USER_IDS` 里、用的是私聊，并且 `journalctl -u tg-cc-bot` 里有 `polling` |
| 日志里有 `409: Conflict` | Telegram 规定一个 bot token 同时只有一个拉取者，而有另一个客户端同时在拉这个 bot 的消息。bot 自己无论开多少个对话和 Claude 会话，都只有一个拉取循环。常见原因：Claude Code 的 Telegram 插件配置了这个 bot 的 token（你自己运行的 `claude` 会加载它；bot 自己的会话不会），bot 的第二个副本，或者另一台机器上的副本。`sudo bash deploy/deploy.sh check` 会列出本机用这个 token 的进程和配置文件，以及它们是怎么启动的。在此期间 bot 会按间隔重试，不会崩溃 |
| 输入 `/` 没有命令列表 | bot 启动时会设置菜单，拿到 Claude Code 的命令后再更新一次（日志里是 `menu: N commands`；`deploy.sh check` 会显示数量）。如果 Telegram 还显示旧菜单，重新打开对话 |
| `deploy.sh` 还没跑完就收到了回复 | 只要已经过了 “systemd service” 这一步就是正常的：bot 已经启动，正在回复它离线期间收到的消息，脚本还在做后续检查。在这一步之前 tg-cc-bot 不会运行（脚本一开始就会停掉正在运行的 bot） |

## 开发

```bash
npm install          # 或 bun install
npm run typecheck
npm test             # 单元、进程池、领域层和控制器测试（node:test）
npm run start:node   # 用 Node 24 运行（读取 .env）
```

代码分层为 `core` → `store` / `claude` / `telegram` → `domain` → `app`。模块划分、生命周期状态机、数据模型和扩展点见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。测试用假的 Claude 进程工厂和会记录调用的 Telegram API，整个 bot 不联网也能跑。

## 限制

- **只支持私聊**：群聊忽略。多个白名单用户各自有自己的对话和默认设置，但共享项目列表和进程上限。
- **一个 token 只能有一个实例在拉取消息**：不要用同一个 token 再跑一份（比如开发用的副本）。
- **媒体**：只支持文字、图片和文件（不支持语音和视频）。Telegram 限制 bot 只能下载 20 MB 以内的文件。
- **只能在终端里用的命令**（`/theme`、`/login`、`/terminal-setup`、交互式 `/config` 菜单）在 SDK 会话里不可用。
- 会话里的**定时唤醒**（`/loop`、cron 工具）在进程休眠后不会保留。
