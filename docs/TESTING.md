# Testing

Everything below runs without network access or a Claude login, except the live probes at the end.

| Command | What |
|---|---|
| `npm run check` | The gate before every commit: typecheck, all unit/controller tests, `bash -n` (and shellcheck if installed) on the shell scripts |
| `npm test` | `node --test "test/*.test.ts"` only |
| `node --test --test-name-pattern="resume" test/bot.test.ts` | One file, tests matching a name |
| `sudo npm run test:deploy` | `deploy.sh` tests; Linux only (WSL on Windows): `wsl -u root -- bash deploy/test/run.sh` |
| `npm run probe [dir]` | Live: what the real Claude Code offers in a directory (no message sent, no tokens) |

Tests use `node:test` and `node:assert/strict`, run TypeScript directly (Node type stripping), and
must not depend on the machine: create temp dirs with `fs.mkdtempSync`, never read the developer's
`~/.claude` for assertions (filter by your temp paths when a function also scans the real home).

## Layers

| File | Covers |
|---|---|
| `test/pool.test.ts` | `SessionPool` lifecycle: LRU, idle TTL, BUSY protection, admission queue, crash and resume |
| `test/threads.test.ts` | `ThreadService` invariants, `/resume` in place, bindings per bot |
| `test/bot.test.ts` | Controllers through `bot.handleUpdate`: routing, access, menu, `/resume`, polling with the real runner |
| `test/inspect.test.ts` | `/agents /mcp /tasks /diff /export /plan /memory /permissions /hooks /plugin`, command classification, `runProgram` |
| `test/skills.test.ts` | The `/skills` browser: views, paging, callbacks, filter |
| `test/polling.test.ts` | `Poller` (409 / 401 / webhook), `claudeEnv`, session flag settings |
| others | config, format (Markdown → HTML), command names, queue, mutex, store, instance lock |

## The bot harness (`test/helpers/harness.ts`)

`harness(opts)` builds the whole app (`createApp`) with fake Telegram, fake Claude Code processes and an
in-memory store. The owner is user `42` (`OWNER`); `STRANGER` is `7`.

```ts
const h = harness();                       // opts: hasTopics, reject(method, payload), getUpdates, exec
await h.send("hello", { thread: 500 });    // a message in chat (topic) 500
await waitFor(() => h.texts(h.inThread(500)).some((t) => t.includes("reply: hello")), 1000, "reply");
await h.send("/mcp", { thread: 500 });     // commands are messages too
await h.press("mcp:d:0", 500, messageId);  // an inline button on message `messageId` (default 1)
```

| Field | Use |
|---|---|
| `calls` | Every Bot API call `{ method, payload }`, in order (`sendMessage`, `editMessageText`, `sendDocument`, `setMyCommands`…) |
| `messages` | Messages the bot sent with the IDs the fake API assigned (needed to press buttons on them) |
| `texts(filter)`, `inThread(t)` | Texts of `sendMessage` calls, optionally in one chat |
| `factory` | The `FakeFactory`: `created` processes, `last()`, `onSend`, `onCreate` |
| `app` | The real `App`: `threads`, `pool`, `catalog`, `cfg`… for assertions or to swap `app.sessions.*` |
| `home`, `other` | Temp project directories; `home` is the active project |
| `reject` | Make chosen API calls fail with a description, e.g. a menu Telegram rejects |
| `exec` | Replace the program runner used by `/diff` and `/plugin` |

By default every message gets a fake reply: the process emits `init`, then `reply: <text>`.

## Fake Claude Code (`test/helpers/fake-process.ts`)

`FakeProcess` implements `ProcessHandle`. Script it when it is created:

```ts
h.factory.onCreate = (p) => {
  p.commands = [{ name: "deploy-docs", description: "Publish", argumentHint: "<env>" }]; // no builtin: a user skill
  p.agents = [{ name: "Explore", description: "Search", model: "haiku" }];
  p.mcp = [{ name: "github", status: "connected" }];
};
```

Drive it from the test: `await p.emit({ type: "system", subtype: "background_tasks_changed", tasks: […] })`,
`await p.finishTurn("text")`, `p.crash()`. Read back `p.sent` (what the bot sent to Claude), `p.controls`
(`toggle:…`, `reconnect:…`, `stopTask:…`, `reloadPlugins`), `p.spec` (how it was started), `p.closed`.

## Writing a controller test

1. Arrange with `harness()` and `factory.onCreate`.
2. Act with `send` / `press`.
3. Assert on `calls` / `texts` / `messages` and on state (``h.app.threads.get(`${OWNER}:500`)``).
4. For a new SDK capability, add it to `ProcessHandle`, `SdkProcess` and `FakeProcess` together.

## `deploy.sh` tests (`deploy/test/`)

`lib.sh` sources `deploy.sh` (which runs nothing when sourced) and provides `check NAME EXPR` and
`finish`. Tests call the script's functions directly and stub `tg_api` when they need Telegram. They
read `/proc`, so they need Linux; run them as root like the script. Add a `*.test.sh` next to the
others; `run.sh` picks it up.

## Live checks (real services)

- `npm run probe [dir]` starts the real Claude Code (the SDK's binary, or `CLAUDE_PATH`) in a directory
  without sending a message, then lists its commands sorted by `commandKind`, subagents, MCP servers and
  models. Use it after an SDK update to see new built-ins (they show up as `skill` until classified in
  `src/claude/cmdnames.ts`).
- `CHAT_ID=<your user id> bun scripts/topics-spike.ts` checks private-chat topics against the real Bot
  API (needs the bot token in `.env`; stop the running bot first: one poller per token).
- On the server: `sudo bash deploy/deploy.sh check` is the read-only end-to-end check, including one tiny
  live Claude request.
