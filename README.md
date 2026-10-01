# tg-cc-bot

**Drive Claude Code on your server from Telegram, signed in with your Claude subscription. Every chat tab is its own Claude Code session.**

[中文说明](README-zh.md) · [Architecture](docs/ARCHITECTURE.md)

tg-cc-bot is a thin Telegram front end for real, unmodified Claude Code processes. The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) runs Claude Code. The agent loop, tools, skills, `CLAUDE.md`, MCP servers, hooks and permission system are all Claude Code's own. The bot relays messages, renders output, turns prompts into buttons and manages which sessions have a running process.

---

## Contents

- [The model: tabs are sessions](#the-model-tabs-are-sessions)
- [Why this design](#why-this-design)
- [Features](#features)
- [Commands](#commands)
- [Sessions and processes](#sessions-and-processes)
- [Permissions and safety](#permissions-and-safety)
- [Quick start](#quick-start)
- [Deploying on a Linux server](#deploying-on-a-linux-server)
- [Configuration](#configuration)
- [Authentication and billing](#authentication-and-billing)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Limitations](#limitations)

---

## The model: tabs are sessions

Telegram can split a private chat with a bot into **tabs** (topics, shown at the top of the chat). tg-cc-bot uses them like this:

| Where | What it is | What you do there |
|---|---|---|
| **Main view** (outside tabs) | Control panel | Commands only: choose or add the active **project**, open tabs, list sessions, change defaults, check status |
| **A tab** | One Claude Code session, working in the project that was active when the tab was opened | Talk to Claude, send photos and files, use Claude Code's slash commands and your skills |

Open a tab with `/new` or Telegram's **+** button. Both use the active project. To work in another directory, switch the active project in the main view (`/projects`), then open a tab. Old sessions, including ones started from the terminal on the server, can be reopened in a tab with `/resume`.

## Why this design

| Approach | Problem |
|---|---|
| **Own agent loop calling the API with a subscription OAuth token** (e.g. OpenClaw) | Weaker harness than Claude Code, and [not permitted](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use): subscription credentials may only be used by Claude Code itself |
| **Official Telegram channel** (`claude --channels plugin:telegram@…`) | One running session receives messages as events. No tabs, no `/new` or `/resume` from Telegram |
| **Driving the interactive TUI through tmux** | Every command works, but menus and prompts have to be scraped from the screen. Brittle, and output formatting is poor |
| **Agent SDK (this project)** | Structured event stream, permission callbacks, session APIs (`resume`, `listSessions`, `forkSession`), and Claude Code's own command dispatch |

## Features

- **Parallel sessions.** Several tabs can work at the same time, each in its own project directory, with its own model, permission mode and effort.
- **Streaming replies.** Live preview via Telegram's `sendMessageDraft`, falling back to editing a placeholder message if drafts aren't available. Final replies are Markdown converted to Telegram HTML: code blocks, tables, lists, quotes and links. Long replies are split safely (code fences stay balanced); very long ones arrive as a `.md` file.
- **Compact tool activity.** Tool calls collapse into a status message such as `💻 Bash ls -la` or `✏️ Edit src/app.ts`, with subagent calls indented. `/verbose` also shows tool output and timings.
- **Interactive prompts as buttons.** Permission requests (Allow / Always allow / Deny), `AskUserQuestion` (single- and multi-select), and plan approval, in the tab that asked. While a prompt is open, replying with text denies the request and tells Claude what to do instead, or answers the question in your own words.
- **Claude Code's full command set.** Built-ins, bundled skills, your personal and project skills, plugin commands and `.claude/commands` work inside tabs and appear in the Telegram command menu.
- **Tab titles.** A tab opened without a name is titled after its first prompt; your own names are never overwritten. `/rename` renames both the tab and the session.
- **Photos and files.** Photos are sent to Claude as images. Documents are saved under `<project>/.tg-uploads/` and the path is passed to Claude.
- **Status.** Notices for context compaction, API retries, usage-limit warnings and permission denials. `/status` in a tab shows that session's context usage; in the main view it shows the process pool.

## Commands

### Main view

| Command | Description |
|---|---|
| `/projects` | List projects, buttons to switch the active one |
| `/project add <name> <path>` | Register a project directory (must exist and be inside `ALLOWED_ROOTS` if set) and make it active |
| `/project use <name>` · `/project rm <name>` | Switch the active project · remove one (its tabs keep working) |
| `/new [title]` | Open a new tab in the active project |
| `/resume [all\|id]` | Open a past session (active project, all projects, or by ID) in a tab |
| `/sessions` | Your tabs with state: 🟢 busy, 🟡 idle, ⚪ hibernated |
| `/settings` | Defaults for new tabs: model, permission mode, effort, verbose |
| `/status` | Live processes, waiting messages, memory, Claude Code version |
| `/help` | Help for the current view |

Text in the main view is not sent to Claude; the bot answers with a hint.

### In a tab

| Command | Description |
|---|---|
| `/stop` | Interrupt the running turn, cancel open prompts and a message still waiting for a slot |
| `/model [name]` · `/mode [mode]` · `/effort [level]` | Show (buttons) or change this tab's model, permission mode or effort |
| `/verbose` | Toggle tool output and timings for this tab |
| `/status` | Session ID, project, settings, process state, context usage |
| `/rename <title>` | Rename this session and tab |
| `/fork` | Copy this session into a new tab |
| `/close` | Stop this tab's process now; your next message resumes it |
| `/delete` | Delete the tab and its messages after confirmation (the session stays resumable) |
| `/new`, `/resume`, `/help` | As in the main view |

Every other slash command goes to Claude Code unchanged: `/compact`, `/context`, `/usage`, `/clear`, `/init`, `/config key=value`, `/output-style`, `/code-review`, and all your skills and plugin commands, with arguments.

Telegram menu names must match `[a-z0-9_]`, so `code-review` appears as `/code_review` and `plugin:skill` as `/plugin_skill`. Either spelling works. Commands used in the wrong place get a one-line redirect.

## Sessions and processes

A session is not a process. A Claude Code session lives in its transcript on disk. A running Claude Code process is only needed while the session is working.

- A tab's process starts on its first message, or resumes when the session already exists.
- After `SESSION_IDLE_MINUTES` (15) without activity, the process is closed. Your next message in that tab resumes the session; a resume takes about a second.
- At most `MAX_LIVE_SESSIONS` (3) processes run at once. When a new one is needed, the least recently used idle process is closed. If every process is busy, the message waits ("⏳ waiting for a free slot"), and `/stop` cancels the wait.
- A process is never closed while it is working, waiting for your answer to a prompt, or running background tasks (background tasks are capped at `BACKGROUND_MAX_MINUTES`).
- Settings that live inside the process (model, permission mode, effort) are stored per tab and restored on every resume.
- After a bot restart every tab is hibernated and resumes on its next message.

The full design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Permissions and safety

- **Who can talk to it.** Only the Telegram user IDs in `ALLOWED_USER_IDS`, and only in private chats. Anyone else gets a single reply with their user ID, so you can add it if you want to. Groups are ignored. The bot refuses to start without an allowlist.
- **Default mode: `auto`.** Claude Code's classifier approves routine actions; anything it escalates arrives as buttons. If auto mode isn't available for your account or model, the tab switches to `acceptEdits` and tells you.
- **Unanswered prompts** are denied after `PERMISSION_TIMEOUT_MS` (default 10 minutes).
- **`bypassPermissions`** (via `/mode` or `/settings`) lets Claude run anything without asking. Use it only on a machine you're willing to let Claude change freely.
- **Projects** can be restricted to directories under `ALLOWED_ROOTS`.
- Claude Code runs as the service user with that user's filesystem access. Run it as a dedicated account, not root.

## Quick start

Requirements: [Bun](https://bun.sh) (or Node.js 24), a Telegram account, and a Claude Pro or Max subscription.

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token. In BotFather, open the bot → **Bot Settings → Threaded Mode** and enable it. Get your numeric user ID from [@userinfobot](https://t.me/userinfobot).
2. Install and configure:
   ```bash
   bun install
   cp .env.example .env    # set TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, DEFAULT_CWD (first project)
   ```
3. Sign in to Claude Code once as the same OS user: run `claude`, then `/login` (see [Authentication](#authentication-and-billing)).
4. Optional: check that tabs work for your bot: `CHAT_ID=<your id> bun scripts/topics-spike.ts`.
5. Run it, then send `/help` to your bot:
   ```bash
   bun src/index.ts
   ```

## Deploying on a Linux server

One command installs, configures, signs in, starts and verifies everything:

```bash
git clone <this repo> tg-cc-bot && cd tg-cc-bot
sudo bash deploy/deploy.sh
```

It runs these steps, and is safe to re-run at any time:

1. **Preflight.** Linux x64/arm64 with systemd. Installs `curl`, `unzip` and `git` if missing, and checks that Telegram, Anthropic, bun.sh and npm are reachable.
2. **Service user.** Creates the `claude` account if it doesn't exist.
3. **Bun.** Installs Bun for that user, or keeps an existing one that is recent enough.
4. **Application.** Copies the code to `/opt/tg-cc-bot` and installs dependencies. The Agent SDK brings a matching Claude Code binary.
5. **Configuration.** Creates `.env` (mode 600) and asks for:
   - the bot token, which it validates with Telegram (it also warns if Threaded Mode is off);
   - your user ID: type it, or leave it empty, message the bot, and the script detects it;
   - the first project's directory.
6. **Claude sign-in.** Offers browser login or a long-lived `setup-token`, and skips this if you're already signed in.
7. **Service.** Generates and enables the systemd unit, starts it, and waits until the bot reports it is polling and Claude Code is ready.
8. **Self-check.** Runs the full health check below and prints a summary.

Day-2 commands:

| Command | What it does |
|---|---|
| `sudo bash deploy/deploy.sh check` | Read-only health check of the whole deployment (see below) |
| `sudo bash deploy/deploy.sh update` | After `git pull`: copy the new code, reinstall dependencies, restart, verify |
| `sudo bash deploy/deploy.sh login` | Sign in again (expired login, switch account, or set a long-lived token) |
| `sudo bash deploy/deploy.sh claude …` | Run Claude Code as the service user, e.g. `claude mcp add …`, `claude plugin install …`, or `claude` to open the TUI |
| `sudo bash deploy/deploy.sh status` / `logs` | Service status and recent logs, or follow logs |
| `sudo bash deploy/deploy.sh uninstall [--purge]` | Remove the service (`--purge` also deletes `/opt/tg-cc-bot`) |

Options: `--user`, `--dir`, `--service` to change the defaults (`claude`, `/opt/tg-cc-bot`, `tg-cc-bot`); `--reconfigure` to re-enter settings; `--no-live` to skip the live Claude test. For an unattended install, export `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS` and `CLAUDE_CODE_OAUTH_TOKEN`, then run `sudo -E bash deploy/deploy.sh install --yes`.

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
- **Telegram:** token accepted by `getMe`, Threaded Mode on, whether users may open tabs, webhook state.
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
| `DEFAULT_MODEL` | Claude Code default | Model for new tabs (`opus`, `sonnet`, a full ID…) |
| `DEFAULT_PERMISSION_MODE` | `auto` | Permission mode for new tabs |
| `DEFAULT_EFFORT` | model default | `low`, `medium`, `high`, `xhigh` or `max` for new tabs |
| `MAX_LIVE_SESSIONS` | `3` | Claude Code processes running at the same time |
| `SESSION_IDLE_MINUTES` | `15` | Close a process after this long idle |
| `BACKGROUND_MAX_MINUTES` | `120` | Close a process kept alive only by background tasks after this long |
| `CLAUDE_PATH` | bundled with the SDK | Path to a system-installed `claude` binary |
| `STATE_FILE` | `./data/state.json` | Projects, tabs and settings |
| `STREAM_MODE` | `draft` | Live preview: `draft`, `edit`, or `off` |
| `PERMISSION_TIMEOUT_MS` | `600000` | Auto-deny prompts after this long |
| `LOG_LEVEL` | `info` | `debug` also logs Claude Code's stderr |
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | Optional long-lived token from `claude setup-token` |

Defaults for new tabs can also be changed in Telegram with `/settings`; those per-chat defaults take precedence over the `DEFAULT_*` values. Claude Code's own configuration applies as usual: `~/.claude/settings.json`, `~/.claude/skills`, each project's `.claude/` folder, `CLAUDE.md` and `.mcp.json`.

## Authentication and billing

Claude Code signs in and makes every API request itself. The bot never reads or handles your credentials. Anthropic's terms explicitly allow signing in to the unmodified Claude Code binary with your own subscription. They don't allow lifting the OAuth token into another client.

Two ways to sign in the service user:

- **Interactive, once:** run `claude`, then `/login`, or `sudo bash deploy/deploy.sh login`. Credentials are stored in `~/.claude/` and refresh automatically. The SDK's bundled binary reads the same location.
- **Long-lived token:** run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.

Usage counts against your plan's normal limits; parallel tabs use it faster. Anthropic announced, then [paused](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), a change that would bill Agent SDK usage from a separate monthly credit. If that change resumes, this bot's usage will come from that credit.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Anything unclear | Run `sudo bash deploy/deploy.sh check` first; every ✗ comes with a hint |
| `/new` says tabs are off | Enable **Threaded Mode** in @BotFather → your bot → Bot Settings, then restart the bot |
| `Failed to authenticate: OAuth session expired` | The service user's login expired. Run `sudo bash deploy/deploy.sh login` |
| "⏳ waiting for a free slot" | All `MAX_LIVE_SESSIONS` processes are busy. Wait, `/stop` another tab, or raise the limit |
| "Auto mode isn't available…" | Expected on some accounts or models. The tab switched to `acceptEdits`; use `/mode` to choose another |
| A tab I deleted is mentioned in the main view | Expected: its session is kept on disk; reopen it with `/resume` if needed |
| Live preview doesn't update | Set `STREAM_MODE=edit` (the bot also falls back automatically if drafts fail) |
| Bot doesn't respond at all | Check your ID is in `ALLOWED_USER_IDS`, you're in a private chat, and `journalctl -u tg-cc-bot` shows `polling` |

## Development

```bash
npm install            # or: bun install
npm run typecheck
npm test               # unit, pool, domain and controller tests (node:test)
npm run start:node     # run under Node.js 24 with .env
```

The code is layered (`core` → `store` / `claude` / `telegram` → `domain` → `app`); see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map, lifecycle state machine, data model and extension points. Tests use a fake Claude process factory and a recording Telegram API, so the whole bot runs without network access.

Source files use explicit `.ts` import extensions and only erasable TypeScript syntax, so the same code runs directly under Bun and under Node.js type stripping without a build step.

## Limitations

- **Private chats only.** Groups are ignored. Several allowed users each get their own chat, tabs and defaults, but share projects and the process limit.
- **One poller per token.** Don't run a second copy of the bot (for example a dev copy) with the same token.
- **Media.** Text, photos and documents only (no voice or video). Telegram limits bot downloads to 20 MB.
- **Terminal-only commands** (`/theme`, `/login`, `/terminal-setup`, interactive `/config` menus) aren't available in SDK sessions.
- **Scheduled wake-ups** inside a session (`/loop`, cron tools) don't survive hibernation.
