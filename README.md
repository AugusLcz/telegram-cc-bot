# tg-cc-bot

**Drive Claude Code on your server from Telegram, signed in with your Claude subscription. Every new chat with the bot is its own Claude Code session.**

[中文说明](README-zh.md) · [Architecture](docs/ARCHITECTURE.md)

tg-cc-bot is a thin Telegram front end for real, unmodified Claude Code processes. The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) runs Claude Code. The system prompt, agent loop, tools, skills, `CLAUDE.md`, MCP servers, hooks and permission system are all Claude Code's own; the bot adds no prompt of its own. One exception: Claude Code's Telegram channel plugin is turned off in the bot's sessions, since each session would otherwise poll this bot as well. The bot relays messages, renders output, turns prompts into buttons and manages which sessions have a running process.

---

## Contents

- [The model: chats are sessions](#the-model-chats-are-sessions)
- [Why this design](#why-this-design)
- [Features](#features)
- [Commands](#commands)
- [Sessions and processes](#sessions-and-processes)
- [Permissions and safety](#permissions-and-safety)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Deploying on a Linux server](#deploying-on-a-linux-server)
- [Configuration](#configuration)
- [Authentication and billing](#authentication-and-billing)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Limitations](#limitations)

---

## The model: chats are sessions

With **Threaded Mode** enabled in @BotFather, Telegram splits your conversation with the bot into separate **chats**. Typing on the bot's main screen opens a new chat, and each one appears in the bot's chat list. tg-cc-bot maps them like this:

- **Each chat is one Claude Code session.** Its first message to Claude starts the session in the **active project**; later messages continue it. Leave a chat and come back any time: the session picks up where it was.
- **Bot commands are mechanical.** `/projects`, `/status`, `/settings`, `/model` and the rest never involve Claude, work in any chat, and a chat used only for them doesn't become a session.
- **Everything else goes to Claude**, including Claude Code's own slash commands and your skills.

To work in another directory, switch the project first (`/project use api`, in any chat), then start a new chat. If you switch inside a chat that hasn't talked to Claude yet, that chat moves too. `/resume` continues an old session, including one started from the terminal on the server, in the chat you send it from, like Claude Code's own `/resume`; the chat's previous session stays in the list.

## Why this design

| Approach | Problem |
|---|---|
| **Own agent loop calling the API with a subscription OAuth token** (e.g. OpenClaw) | Weaker harness than Claude Code, and [not permitted](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use): subscription credentials may only be used by Claude Code itself |
| **Official Telegram channel** (`claude --channels plugin:telegram@…`) | One running session receives messages as events. No separate chats per session, no `/resume` from Telegram |
| **Driving the interactive TUI through tmux** | Every command works, but menus and prompts have to be scraped from the screen. Brittle, and output formatting is poor |
| **Agent SDK (this project)** | Structured event stream, permission callbacks, session APIs (`resume`, `listSessions`, `forkSession`), and Claude Code's own command dispatch |

## Features

- **Parallel sessions.** Several chats can work at the same time, each in its own project directory, with its own model, permission mode and effort.
- **Answers, not noise.** A chat shows Claude's answers. Its notes between steps, its thinking and its tool calls stay out, so a long task ends in one reply that notifies you. Replies are Markdown converted to Telegram HTML: code blocks, tables, lists, quotes and links. Long replies are split safely (code fences stay balanced); very long ones arrive as a `.md` file.
- **A working message while Claude works.** `⏳ Working… 1m 20s` (sent silently, with a ⏹ Stop button) stays at the bottom of the chat until the answer replaces it, and steps aside while a prompt waits for you. The typing indicator runs too.
- **Thinking on demand.** `/thinking` shows Claude's notes between steps, its thinking summaries and timings in that chat, with a live preview of the text as it is written (`STREAM_MODE`). Tool calls are never shown.
- **Interactive prompts as buttons.** Permission requests (Allow / Always allow / Deny), `AskUserQuestion` (single- and multi-select), and plan approval, in the chat that asked. While a prompt is open, replying with text denies the request and tells Claude what to do instead, or answers the question in your own words.
- **Claude Code's full command set.** Built-ins, bundled skills, your personal and project skills, plugin commands and `.claude/commands` work in every chat and appear in the Telegram command menu.
- **Chat titles.** A chat without a name of yours is titled after its first prompt; names you give are never overwritten. `/rename` renames both the chat and the session.
- **Photos and files.** Photos are sent to Claude as images. Documents are saved under `<project>/.tg-uploads/` and the path is passed to Claude.
- **Status.** Notices for context compaction, API retries and usage-limit warnings (permission denials too, with `/thinking`). `/status` shows this chat's session (with context usage) and the bot's process pool.

## Commands

All bot commands work in every chat and don't involve Claude.

### This chat's session

| Command | Description |
|---|---|
| `/stop` | Interrupt the running turn, cancel open prompts and a message still waiting for a slot |
| `/model [name]` · `/mode [mode]` · `/effort [level]` | Show (buttons) or change this chat's model, permission mode or effort; also before the first message |
| `/thinking` | Show Claude's notes, thinking summaries and timings in this chat, or only its answers (the default). `/verbose` still works |
| `/rename <title>` | Rename this chat and its session |
| `/fork` (`/branch`) | Copy this session into a new chat |
| `/close` | Stop this chat's process now; your next message resumes it |
| `/delete` | Delete the chat and its messages after confirmation (the session stays resumable) |
| `/plan [task]` | Switch this chat to plan mode; with a task, send it right away |
| `/skills [filter]` | Browse the skills you can run here in one message: tabs for yours (user, project, plugins) and Claude Code's, 8 per page; tap one for its description and a button that copies `/name ` for adding arguments; `/skills stock` filters |
| `/agents` | Subagents Claude can use here |
| `/mcp [reconnect\|enable\|disable <server\|all>]` | This session's MCP servers and their state, with Reconnect / Enable / Disable buttons |
| `/tasks` (`/bashes`) | Background tasks of this session (shells, subagents…), with Stop buttons |
| `/diff` | `git status` and diff summary of the chat's directory; the full diff arrives as a `.patch` file |
| `/export` | This conversation as a Markdown file |
| `/memory [n]` | The CLAUDE.md / AGENTS.md files a session here loads; `/memory n` sends one |
| `/permissions` · `/hooks` | Permission rules and hooks from the managed, user, project and local settings files |

### Bot

| Command | Description |
|---|---|
| `/help` | How the bot works and the command list |
| `/status` | This chat's session plus live processes, waiting messages, memory, Claude Code version |
| `/sessions` | Chats with a session and their state (🟢 busy, 🟡 idle, ⚪ hibernated); tap one to jump there |
| `/resume [all\|id]` | Continue a past session (active project, all projects, or by ID) in this chat |
| `/projects` | List projects, buttons to switch the active one |
| `/project add <name> <path>` | Register a project directory (must exist and be inside `ALLOWED_ROOTS` if set) and make it active |
| `/project use <name>` · `/project rm <name>` | Switch the active project (also moves this chat if it hasn't talked to Claude yet) · remove one |
| `/settings` | Defaults for new chats: model, permission mode, effort, thinking |
| `/plugin [list\|install\|uninstall\|enable\|disable\|update\|marketplace …]` | Manage Claude Code plugins with the `claude plugin` CLI; the chat's session reloads them |

There is no `/new`: go back to the bot's main screen and type to start a new chat.

Every other slash command goes to Claude Code unchanged: `/compact`, `/context`, `/usage`, `/clear`, `/init`, `/config key=value`, `/output-style`, `/reload-skills`, `/code-review`, and all your skills and plugin commands, with arguments. Claude Code's terminal-only screens (`/theme`, `/login`, `/ide`…) do nothing over Telegram; the commands above replace the useful ones.

The `/` menu lists commands only: the bot's, then Claude Code's useful ones (`/compact`, `/context`, `/usage`, `/clear`…). Skills stay out of it; `/skills` lists them and typing one runs it. Telegram names must match `[a-z0-9_]`, so `code-review` is `/code_review` and `plugin:skill` is `/plugin_skill`; either spelling works.

## Sessions and processes

A session is not a process. A Claude Code session lives in its transcript on disk. A running Claude Code process is only needed while the session is working.

- A chat's process starts on its first message, or resumes when the session already exists.
- After `SESSION_IDLE_MINUTES` (15) without activity, the process is closed. Your next message in that chat resumes the session; a resume takes about a second.
- At most `MAX_LIVE_SESSIONS` (3) processes run at once. When a new one is needed, the least recently used idle process is closed. If every process is busy, the message waits ("⏳ waiting for a free slot"), and `/stop` cancels the wait.
- A process is never closed while it is working, waiting for your answer to a prompt, or running background tasks (background tasks are capped at `BACKGROUND_MAX_MINUTES`).
- Settings that live inside the process (model, permission mode, effort) are stored per chat and restored on every resume.
- After a bot restart every chat is hibernated and resumes on its next message.

The full design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Permissions and safety

- **Who can talk to it.** Only the Telegram user IDs in `ALLOWED_USER_IDS`, and only in private chats. Anyone else gets a single reply with their user ID, so you can add it if you want to. Groups are ignored. The bot refuses to start without an allowlist.
- **Default mode: `auto`.** Claude Code's classifier approves routine actions; anything it escalates arrives as buttons. If auto mode isn't available for your account or model, the chat switches to `acceptEdits` and tells you.
- **Unanswered prompts** are denied after `PERMISSION_TIMEOUT_MS` (default 10 minutes).
- **`bypassPermissions`** (via `/mode` or `/settings`) lets Claude run anything without asking. Use it only on a machine you're willing to let Claude change freely.
- **Projects** can be restricted to directories under `ALLOWED_ROOTS`.
- Claude Code runs as the bot's account, with that account's file access. Don't use root; for isolation use a dedicated account (see [Prerequisites](#prerequisites)).

## Prerequisites

Do these once, **as the account that will run the bot** (usually your own; see the note below), before running it locally or deploying it.

1. **A Claude Pro or Max subscription.**
2. **Claude Code installed and signed in.**
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash   # Linux, macOS, WSL; other platforms: see the Claude Code docs
   claude                                           # then type /login
   ```
   Over SSH there is no browser: open the link Claude Code prints on any device, sign in, and paste the code back into the terminal. Confirm it worked:
   ```bash
   claude auth status    # shows "loggedIn": true
   ```
   Headless alternative: run `claude setup-token` on any machine with a browser and give the bot the token as `CLAUDE_CODE_OAUTH_TOKEN` (in `.env`, or `sudo CLAUDE_CODE_OAUTH_TOKEN=<token> bash deploy/deploy.sh`). The token is valid for a year.
3. **A Telegram bot with Threaded Mode.** Create it with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token. In BotFather, open the bot → **Bot Settings → Threaded Mode**, enable it, and allow users to create topics (that is how you open new chats). Get your numeric user ID from [@userinfobot](https://t.me/userinfobot).
4. **Runtime.** For a server deployment: Linux x64/arm64 with systemd and `sudo` (the deploy script installs Bun). To run it locally: [Bun](https://bun.sh) or Node.js 24.

The bot runs as the account from step 2 and shares that account's Claude login, skills, settings and session history. To keep it apart from your own account, create a dedicated account, do step 2 as that account (`sudo -iu <name>`), and deploy with `--user <name>`.

## Quick start

To try it on your own machine, in a terminal (with the [prerequisites](#prerequisites) done). On a server, [deploy](#deploying-on-a-linux-server) instead; don't do both with one bot token, or the two copies split its messages.

1. Install and configure:
   ```bash
   bun install
   cp .env.example .env    # set TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, DEFAULT_CWD (first project)
   ```
2. Optional: check that chats (topics) work for your bot: `CHAT_ID=<your id> bun scripts/topics-spike.ts`.
3. Run it, then send `/help` to your bot:
   ```bash
   bun src/index.ts
   ```

## Deploying on a Linux server

Complete the [prerequisites](#prerequisites) first. Then, from the account that will run the bot, one command configures, starts and verifies everything:

```bash
git clone https://github.com/AugusLcz/telegram-cc-bot.git tg-cc-bot && cd tg-cc-bot
sudo bash deploy/deploy.sh
```

It runs these steps, and is safe to re-run at any time:

1. **Preflight.** Linux x64/arm64 with systemd. Installs `curl`, `unzip` and `git` if missing, and checks that Telegram, Anthropic, bun.sh and npm are reachable.
2. **Prerequisites.** Checks that Claude Code is installed and signed in for the account (see [Prerequisites](#prerequisites)). If not, it stops right away and prints the exact commands to run; it never creates accounts or runs a login itself.
3. **Bun.** Installs Bun for that account, or keeps an existing one that is recent enough.
4. **Application.** Copies the code to `/opt/tg-cc-bot` and installs dependencies. The Agent SDK brings a Claude Code binary matching its version, which uses the account's existing login.
5. **Configuration.** The service reads only `/opt/tg-cc-bot/.env` (mode 600). Values exported in your environment are written into it (run the script without `sudo` and it re-runs itself with `sudo -E`; a plain `sudo` drops them). Values in this checkout's `.env` that differ from it are listed (the bot token by its bot ID) and copied once you confirm. Then it asks for whatever is still missing:
   - the bot token, which it validates with Telegram (it also warns if Threaded Mode is off);
   - your user ID: type it, or leave it empty, message the bot, and the script detects it;
   - the first project's directory.
6. **Service.** Generates and enables the systemd unit, starts it, and waits until the bot reports it is polling and Claude Code is ready.
7. **Self-check.** Runs the full health check below, including a live Claude request, and prints a summary.

Day-2 commands:

| Command | What it does |
|---|---|
| `sudo bash deploy/deploy.sh check` | Read-only health check of the whole deployment (see below) |
| `sudo bash deploy/deploy.sh update` | After `git pull` or a settings change: copy the new code, apply newer settings (as in step 5), reinstall dependencies, restart, verify |
| `sudo bash deploy/deploy.sh claude …` | Run Claude Code as the service user, e.g. `claude mcp add …`, `claude plugin install …`, or `claude` to open the TUI |
| `sudo bash deploy/deploy.sh status` / `logs` | Service status and recent logs, or follow logs |
| `sudo bash deploy/deploy.sh uninstall [--purge]` | Remove the service (`--purge` also deletes `/opt/tg-cc-bot`) |

Options: `--user` (default: the account that ran `sudo`, or the one an existing install uses), `--dir` (`/opt/tg-cc-bot`), `--service` (`tg-cc-bot`); `--reconfigure` to re-enter settings; `--no-live` to skip the live Claude test. For an unattended install, export `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS` and `CLAUDE_CODE_OAUTH_TOKEN`, then run `sudo -E bash deploy/deploy.sh install --yes`.

**What `check` verifies:**
- **System:** OS, architecture, libc, systemd, memory, disk and required tools.
- **Network:** Telegram, Anthropic and claude.ai are reachable.
- **Service user** and its **Bun** version.
- **Application:**
  - code ownership and dependency versions
  - modules actually load under Bun
  - the Claude Code binary runs
- **Configuration:**
  - `.env` permissions
  - bot token and user ID format
  - first project directory writable by the service user
  - modes, effort, log level, state directory
  - process limits, and whether they fit the machine's RAM
- **Telegram:** token accepted by `getMe`, Threaded Mode on, whether users may open new chats, webhook state.
- **Claude sign-in:**
  - `claude auth status`
  - a live round-trip with one tiny Haiku request, since `auth status` alone can't tell whether a token is valid
- **Service:**
  - unit file, enabled, running, and restart count
  - the current run's logs show polling and Claude Code ready
  - known failures are explained, e.g. 401 for a bad token, 409 for a second instance polling the same bot, missing settings, or permission errors

The bot uses long polling, so the server needs no inbound ports or HTTPS endpoint.

## Configuration

Set these in `.env`. Bun loads it automatically; systemd loads it through `EnvironmentFile`. See [.env.example](.env.example) for comments.

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *required* | Token from @BotFather |
| `ALLOWED_USER_IDS` | *required* | Comma-separated Telegram user IDs allowed to use the bot |
| `DEFAULT_CWD` | home directory | Directory of the first project (`home`); add more with `/project add` |
| `ALLOWED_ROOTS` | unrestricted | Comma-separated directories that projects must live in |
| `DEFAULT_MODEL` | Claude Code default | Model for new chats (`opus`, `sonnet`, a full ID…) |
| `DEFAULT_PERMISSION_MODE` | `auto` | Permission mode for new chats |
| `DEFAULT_EFFORT` | model default | `low`, `medium`, `high`, `xhigh` or `max` for new chats |
| `MAX_LIVE_SESSIONS` | `3` | Claude Code processes running at the same time |
| `SESSION_IDLE_MINUTES` | `15` | Close a process after this long idle |
| `BACKGROUND_MAX_MINUTES` | `120` | Close a process kept alive only by background tasks after this long |
| `CLAUDE_PATH` | bundled with the SDK | Path to a system-installed `claude` binary |
| `STATE_FILE` | `./data/state.json` | Projects, chat ↔ session mapping and settings |
| `STREAM_MODE` | `draft` | Live preview in chats with `/thinking` on: `draft`, `edit`, or `off` |
| `PERMISSION_TIMEOUT_MS` | `600000` | Auto-deny prompts after this long |
| `LOG_LEVEL` | `info` | `debug` also logs Claude Code's stderr |
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | Optional long-lived token from `claude setup-token` |

Defaults for new chats can also be changed in Telegram with `/settings`; those per-chat defaults take precedence over the `DEFAULT_*` values. Claude Code's own configuration applies as usual: `~/.claude/settings.json`, `~/.claude/skills`, each project's `.claude/` folder, `CLAUDE.md` and `.mcp.json`.

## Authentication and billing

Claude Code signs in and makes every API request itself. The bot never reads or handles your credentials. Anthropic's terms explicitly allow signing in to the unmodified Claude Code binary with your own subscription. They don't allow lifting the OAuth token into another client.

Two ways to sign in the service user:

- **Interactive, once:** as the account that runs the bot, run `claude`, then `/login`. Credentials are stored in `~/.claude/` and refresh automatically. The SDK's bundled binary reads the same location.
- **Long-lived token:** run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.

Usage counts against your plan's normal limits; parallel chats use it faster. Anthropic announced, then [paused](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), a change that would bill Agent SDK usage from a separate monthly credit. If that change resumes, this bot's usage will come from that credit.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Changed the bot token, but the script still shows the old bot | The service reads only `/opt/tg-cc-bot/.env`. Run `sudo bash deploy/deploy.sh update` (or `install`): it applies a token exported in your environment (not through a plain `sudo`, which drops it) and offers to copy one from this checkout's `.env`. After a switch to another bot, the old bot's chat bindings are put aside (and come back if you switch back); its sessions stay available with `/resume` |
| Anything unclear | Run `sudo bash deploy/deploy.sh check` first; every ✗ comes with a hint |
| The bot says Threaded Mode is off | Enable **Threaded Mode** in @BotFather → your bot → Bot Settings, then restart the bot |
| Typing on the main screen doesn't open a new chat | In @BotFather's Threaded Mode settings, allow users to create topics |
| `Failed to authenticate: OAuth session expired` | The bot account's login expired. As that account run `claude`, then `/login` (no restart needed) |
| The deploy stops at "Prerequisites" | Claude Code isn't installed or signed in for the account; run the commands it prints, then re-run the script |
| "⏳ waiting for a free slot" | All `MAX_LIVE_SESSIONS` processes are busy. Wait, `/stop` another chat, or raise the limit |
| "Auto mode isn't available…" | Expected on some accounts or models. The chat switched to `acceptEdits`; use `/mode` to choose another |
| I deleted a chat by mistake | Its session is kept on disk; reopen it with `/resume` |
| Live preview doesn't update | It shows only with `/thinking` on (otherwise the answer arrives whole). Set `STREAM_MODE=edit` (the bot also falls back automatically if drafts fail) |
| Bot doesn't respond at all | Check your ID is in `ALLOWED_USER_IDS`, you're in a private chat, and `journalctl -u tg-cc-bot` shows `polling` |
| `409: Conflict` in the logs | Telegram serves one poller per bot token, and another client asked for this bot's updates at the same time. The bot itself polls from one loop only, however many chats and Claude sessions run. Common causes: Claude Code's Telegram plugin configured with this bot's token (a `claude` you run yourself loads it; the bot's own sessions don't), a second copy of the bot, or a copy on another machine. `sudo bash deploy/deploy.sh check` lists local processes and config files using the token, with how each was started. The bot keeps retrying meanwhile instead of crashing |
| No commands after typing `/` | The bot sets the menu at start and again once Claude Code's commands are known (`menu: N commands` in the log; `deploy.sh check` shows the count). Reopen the chat if Telegram still shows an old menu |
| Replies arrive while `deploy.sh` is still running | Expected once the "systemd service" step has started the bot: it answers messages sent while it was offline, while the script finishes its checks. Before that step nothing of tg-cc-bot runs (the script stops a running bot first) |

## Development

Start with [AGENTS.md](AGENTS.md): commands, repository map, the rules that must hold, recipes, definition of done and release steps. It is written so that a coding agent (or a person) in a fresh session can pick up the work.

```bash
npm ci                     # or: bun install
npm run check              # typecheck + all tests + shell syntax: run before every commit
sudo npm run test:deploy   # deploy.sh tests (Linux; WSL on Windows)
npm run probe              # what the real Claude Code offers here (no message sent)
npm run start:node         # run under Node.js 24 with .env
```

| Doc | For |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Concepts, lifecycle, layers, module map, data model, extension points |
| [docs/decisions/](docs/decisions/README.md) | Why the design is what it is |
| [docs/TESTING.md](docs/TESTING.md) | Test layers, the bot harness and fakes, live probes |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Open items and known limitations |

Tests use a fake Claude process factory and a recording Telegram API, so the whole bot runs without network access. Source files use `.ts` import extensions and only erasable TypeScript, so the same code runs under Bun and Node.js type stripping without a build step.

## Limitations

- **Private chats only.** Groups are ignored. Several allowed users each get their own chats and defaults, but share projects and the process limit.
- **One poller per token.** Don't run a second copy of the bot (for example a dev copy) with the same token.
- **Media.** Text, photos and documents only (no voice or video). Telegram limits bot downloads to 20 MB.
- **Terminal-only commands** (`/theme`, `/login`, `/terminal-setup`, interactive `/config` menus) aren't available in SDK sessions.
- **Scheduled wake-ups** inside a session (`/loop`, cron tools) don't survive hibernation.
