# Roadmap and open items

What is unfinished, known to be limited, or worth watching. Done work is in [CHANGELOG.md](../CHANGELOG.md);
the reasons behind the design are in [decisions/](decisions/README.md). Keep this file current: remove an
item when it ships, add one when you find a gap.

## To verify

- The `/skills` browser and the 0.3.0 commands on a real phone after `deploy.sh update`: tabs, paging,
  copy button, `/mcp` buttons, `/tasks` stop, `/diff` patch file, `/plugin install`.

## Open

- **Wake-ups across hibernation.** `/loop`, `ScheduleWakeup` and cron tools need a living process;
  hibernation (idle TTL, LRU eviction) ends them. Option: treat a pending wake-up like a background task
  (BUSY) up to `BACKGROUND_MAX_MINUTES`. See [0003](decisions/0003-sessions-are-not-processes.md).
- **Cold-start latency.** A `ProcessFactory` backed by the SDK's `prewarm()` spare process would hide
  the 0.5–1.5 s start of a resumed session.
- **Per-project defaults.** Model, permission mode and effort are per user and per chat today;
  per-project defaults would extend `ProjectRecord` and `ThreadService.specFor`.
- **Browser state survives restarts.** `/skills`, `/mcp`, `/tasks` button snapshots are in memory;
  after a restart old buttons answer "outdated".
- **Voice and video.** Only text, photos and documents reach Claude.

## Known limitations

- Private chats only; groups and channels are ignored (non-goal).
- One poller per bot token ([0005](decisions/0005-one-poller-per-token.md)).
- MCP servers that need sign-in must be authorized on the server (`claude` → `/mcp`) or in claude.ai.
- `/hooks` lists hooks from settings files, not those plugins add; `/memory` lists the instruction
  files loaded at start, not nested ones Claude Code loads on demand.
- New Claude Code built-ins are shown as skills until classified; check with `npm run probe`
  ([0010](decisions/0010-commands-in-the-menu-skills-in-a-browser.md)).

## Risks

- Private-chat topics are new in the Bot API (9.3, December 2025); `scripts/topics-spike.ts` checks the
  real behaviour.
- Agent SDK billing for subscription users may change (a separate SDK credit was announced, then paused).
