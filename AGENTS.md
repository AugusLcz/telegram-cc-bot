# AGENTS.md

Guide for coding agents (and humans) working on this repository. Read this first; it is written so that a
fresh session can pick up the work without any earlier conversation.

**tg-cc-bot** is a Telegram front end for real, unmodified Claude Code, driven by the Claude Agent SDK
and signed in with the owner's Claude subscription. With Telegram's Threaded Mode, every chat with the
bot is one Claude Code session in a project directory; bot commands are mechanical and work in every
chat; idle sessions hibernate and resume transparently. It runs as a systemd service on Linux under
Bun, installed by `deploy/deploy.sh`.

| Read | For |
|---|---|
| [README.md](README.md) | What users see: commands, configuration, deployment, troubleshooting (keep [README-zh.md](README-zh.md) in sync) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Concepts, lifecycle, layers, module map, data model, flows, extension points |
| [docs/decisions/](docs/decisions/README.md) | Why things are the way they are. Read the matching record before changing covered behaviour |
| [docs/TESTING.md](docs/TESTING.md) | Test layers, the bot harness, fakes, deploy tests, live probes |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is open, limited, or still to verify |
| [CHANGELOG.md](CHANGELOG.md) | What changed, per version; `Unreleased` collects work since the last tag |

## Commands

```bash
npm ci                     # install (or: bun install)
npm run check              # THE gate: typecheck + all tests + shell syntax. Run before every commit
npm test                   # tests only (node:test, no network, no Claude login needed)
sudo npm run test:deploy   # deploy.sh tests; Linux only (Windows: wsl -u root -- bash deploy/test/run.sh)
npm run probe [dir]        # live: what the real Claude Code offers there (no message sent, no tokens)
npm run start:node         # run the bot locally under Node 24 with .env (or: bun src/index.ts)
```

Do not start the bot with a token that a deployed instance uses: Telegram allows one poller per token
([0005](docs/decisions/0005-one-poller-per-token.md)).

## Repository map

```
src/index.ts      composition root (startup order matters: getMe → instance lock → state → app → menu → polling)
src/core/         config, logger, mutex, queue, exec, instance lock, shared types — no project imports
src/store/        Store interface, JSON file store (atomic, debounced)
src/claude/       everything that talks to Claude Code: processes, pool, sessions, command catalog/names, config files, CLI path
src/telegram/     everything that talks to Telegram: polling, send/format/render, topics, permission prompts
src/domain/       chats ↔ sessions ↔ projects rules (ThreadService, ProjectService, ChatService, access)
src/app/          command registry, handlers (control, thread, inspect, skills), wiring (bot.ts)
test/             node:test suites; helpers/harness.ts (whole bot, fake Telegram + Claude), helpers/fake-process.ts
deploy/           deploy.sh (install/update/check…) and test/ (bash tests that source it)
scripts/          probe-claude.ts, topics-spike.ts (live checks), check-shell.ts
docs/             architecture, decisions, testing, roadmap
```

Full module list: [ARCHITECTURE §5.2](docs/ARCHITECTURE.md#52-modules).

## Rules that must hold

- **Layering.** Imports point down only: `core` ← `store` / `claude` / `telegram` ← `domain` ← `app` ←
  `index.ts`. `claude/` never imports grammY; `telegram/` never starts Claude Code; outside `claude/` the
  Agent SDK is imported with `import type` only.
- **One poller.** `Poller` (`src/telegram/polling.ts`) is the only `getUpdates` loop; Claude sessions
  never talk to Telegram.
- **Session ≠ process.** A chat's session lives on disk; processes are a bounded, disposable cache
  (`SessionPool`). Never keep state only in a process ([0003](docs/decisions/0003-sessions-are-not-processes.md)).
- **Chat ↔ session.** A chat has one current session; a session is bound to at most one chat; a chat's
  directory is fixed once its session starts; per-chat changes go through `ThreadService` under its
  per-chat mutex.
- **Persist, then apply.** Per-chat settings are written to the record before they are applied to a live
  process, so a resume restores them.
- **Secrets.** `TELEGRAM_BOT_TOKEN` never reaches Claude Code (`claudeEnv`), logs, command lines or
  output. `deploy.sh` passes it on stdin and masks it.
- **What every session gets** is decided in one place, `SdkProcess.start`: Claude Code's system prompt
  preset, the flag settings that turn the Telegram channel plugin off, the cleaned environment
  ([0007](docs/decisions/0007-session-settings-the-bot-imposes.md)).
- **What a chat shows.** Claude's answers, notices and prompts; never tool calls or tool output. Notes
  between steps, thinking and timings only with the chat's `thinking` on. Anything sent during a turn goes
  through `TurnRenderer` so the working message stays last
  ([0012](docs/decisions/0012-chats-show-answers-not-work.md)).
- **Telegram limits.** 4096 characters per message; callback data ≤ 64 bytes (`callbackData` throws);
  command names `[a-z0-9_]{1,32}`; at most 100 menu commands; all text is sent with `parse_mode: HTML`.

## Conventions

- **TypeScript** strict, ES2023, NodeNext; import local files with their `.ts` extension; erasable syntax
  only (no enums, namespaces or parameter properties); `import type` for types. No build step: Bun runs
  it in production, Node type stripping in tests.
- **Style** (no formatter is enforced, so match the code): 2 spaces, double quotes, semicolons, trailing
  commas in multi-line literals, lines up to ~120 characters, named exports only, small modules.
- **Comments** say why, not what. Each module starts with a short comment on its role; exported
  functions get a doc comment when behaviour isn't obvious from the name.
- **Errors.** Throw `UserError` (`src/domain/errors.ts`) for expected failures; its message is shown to
  the user as is (HTML). Anything else is logged and shown as a short `❌` line.
- **User-facing text** is English, short, plain; escape every interpolated value with `escapeHtml`.
- **Logging** through `app.log` / `log.child(scope)`; one line per event; no secrets.
- **Dependencies.** Runtime deps are grammY (+ runner, auto-retry), the Agent SDK and marked. Add one only
  when the platform can't do it.
- **Docs move with code.** User-visible change → both READMEs and `CHANGELOG.md` (`Unreleased`). Design
  change → `docs/ARCHITECTURE.md`. A decision made or reversed → a new record in `docs/decisions/`
  (supersede, don't rewrite). New gap or limitation → `docs/ROADMAP.md`.

## Recipes

**Add a bot command.** Write it next to its kind (`src/app/control.ts` bot-wide, `thread.ts` session,
`inspect.ts` Claude Code screens) and register it in that file's `register*` function. Use
`chatCommand` when it needs a chat. `/help` and the `/` menu pick it up.

```ts
const ping = chatCommand({ name: "ping", description: "Check that the bot answers", run: async (app, { ctx }) => {
  await reply(app, ctx, "pong");
} });
// in registerInspect(app):  app.commands.register(ping)

test("/ping answers", async () => {          // test/inspect.test.ts
  const h = harness();
  await h.send("/ping", { thread: 500 });
  assert.match(h.texts(h.inThread(500)).at(-1)!, /pong/);
});
```

A bot command shadows any Claude Code command of the same name; check with `npm run probe`. Add the
command to the README tables (en + zh).

**Add inline buttons.** `app.callbacks.on(prefix, handler)` once; build data with
`callbackData(prefix, payload)`. Never put names in payloads: keep a snapshot keyed by
`chatId:messageId` (`src/app/skills.ts`) or by chat key (`/mcp`, `/tasks` in `inspect.ts`) and send
indexes. Always `answerCallbackQuery`; update the message with `editHtml`.

**Expose an SDK capability.** Add it to `ProcessHandle`, implement it in `SdkProcess` via
`this.running()`, and script it in `FakeProcess` (record calls in `controls`). Reach a process with
`app.pool.get(key)` (live only), `app.pool.ensure(key, () => app.threads.specFor(key))` after
`ensureRecord` (the chat's own session), or `inspect()` in `inspect.ts` (live, else a throwaway probe).

**Add a configuration key.** `src/core/config.ts` (parse, validate, `Config`), `.env.example` (with a
comment), `deploy/deploy.sh` (`check_config`; `ENV_KEYS` if unattended installs may pass it), both
READMEs, ARCHITECTURE §10, a test in `test/config.test.ts`.

**Change `deploy.sh`.** Read [0011](docs/decisions/0011-deploy-script-design.md) first. Run things as
the service user with `as_user` / `user_run SECS cmd` (never plain `sudo -u`); call Telegram with
`tg_api`; keep "stop the running bot first"; every check prints `ok` / `warn` / `bad` plus a `hint`.
Test functions in `deploy/test/*.test.sh` (they source the script).

**Change what every session gets.** Only in `SdkProcess.start` (`SESSION_FLAG_SETTINGS`, `claudeEnv`,
query options), with a test. Recorded system prompts mean existing sessions keep theirs until `/compact`.

## Definition of done

- `npm run check` passes (and `npm run test:deploy` on Linux if `deploy/` changed).
- New behaviour has tests through the harness or the unit under change; no test depends on the
  developer's machine (temp dirs only; never assert on the real `~/.claude`).
- Docs updated as listed under Conventions; `CHANGELOG.md` `Unreleased` describes the user-visible change.
- No secrets, tokens or personal paths in code, tests, docs or commit messages.

## Commits and releases

Commit and push only when the maintainer asks. Subject in the imperative, ≤ 72 characters; the body says
why. Releases are also on request:

1. `npm run check` passes; the tree contains exactly what ships.
2. Version (semver, 0.x): minor for features or behaviour/deployment changes, patch for fixes.
3. `CHANGELOG.md`: move `Unreleased` entries under `## [X.Y.Z] - YYYY-MM-DD`, keep an empty
   `## [Unreleased]`, update the compare links at the bottom.
4. `package.json` `version` and `package-lock.json` (top-level `version` and `packages[""].version`).
5. Commit `Release vX.Y.Z: <summary>`; annotated tag `git tag -a vX.Y.Z -m "vX.Y.Z: <summary>"`.
6. `git push origin main && git push origin vX.Y.Z`.

## Pitfalls (each cost a release)

- **SDK defaults are not CLI defaults.** `query()` without `systemPrompt` sends an empty prompt
  ([0007](docs/decisions/0007-session-settings-the-bot-imposes.md)).
- **Sessions load the account's plugins.** Claude Code's Telegram channel plugin polled the bot from
  every session (the 409s). Don't add anything that lets a session poll Telegram.
- **409 Conflict** means another `getUpdates` client on the token: a second copy of the bot, a plugin,
  `scripts/topics-spike.ts` while the bot runs. Bun loads `.env` from its working directory, so
  `bun src/index.ts` inside the install directory is a second bot (the instance lock refuses it).
- **Threaded Mode has no main view.** Every user message belongs to a chat; General (thread 1) counts as
  "no chat" ([0002](docs/decisions/0002-chats-are-sessions.md)).
- **Bindings belong to a bot.** Changing the token puts the old bot's chats aside
  ([0008](docs/decisions/0008-bindings-belong-to-a-bot.md)). State changes must stay additive (optional
  fields) or bump `state.version` with a migration in `JsonFileStore`.
- **Menus are per chat, not per topic**, and a scope set by another program wins over `default`; that is
  why `syncMenu` sets three scopes.
- **Claude Code built-ins change between versions.** Unknown ones show as skills until classified in
  `src/claude/cmdnames.ts` ([0010](docs/decisions/0010-commands-in-the-menu-skills-in-a-browser.md)).
- **If you run inside the bot** (a Claude Code session started from Telegram), restarting the service
  (`deploy.sh update`, `systemctl restart tg-cc-bot`) ends your own process mid-turn. Ask the user to
  run it, or expect the next message to resume you.

## Environment

- **Production:** Linux with systemd, Bun, the account that is signed in to Claude Code; installed to
  `/opt/tg-cc-bot` (state in `data/state.json`, settings in `.env`, mode 600).
- **Development:** any OS with Node 24 (or Bun). Windows works for everything except the deploy tests
  (use WSL); `npm run lint:sh` skips when `bash` is missing.
- Line endings are LF everywhere (`.gitattributes`, `.editorconfig`).
