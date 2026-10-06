# 0011. `deploy.sh` design

Status: accepted (0.2.0, refined through 0.2.2)

## Context
One script installs, upgrades and checks the bot on a Linux server with systemd. Field problems that
shaped it:
- A running (or auto-restarting) old service answered messages in the middle of an install, which
  looked like the script starting a second bot.
- A changed bot token "didn't apply": the service reads only the install directory's `.env`; the
  checkout's `.env` was ignored and plain `sudo` drops exported variables.
- A 40-second Telegram probe for other pollers made every run slow; the user had it removed.

## Decision
- Order of `install`: preflight → **stop the running service** (with its PID and start time) →
  prerequisites ([0006](0006-claude-code-is-a-prerequisite.md)) → Bun → code (`rsync`, never `.env`
  or `data/`) → configuration → local poller check → service → self-check. `update` skips the
  setup questions and only asks about differing checkout settings. If the script stops early, it says
  the bot is still stopped and how to start it.
- Settings: the service reads only `<install dir>/.env`. Exported variables (the script re-runs itself
  with `sudo -E`) are written into it; differing values in the checkout's `.env` are listed (tokens
  by bot ID only) and copied after confirmation, suggested when that file is newer.
- Secrets: the bot token never appears on a command line (`curl -K -` from stdin, `grep -f` from a
  process substitution) and is masked in all output; `.env` is mode 600.
- Local poller check: processes whose environment, command line or working-directory `.env` holds
  the token, with how each was started (cgroup: login session, systemd unit, Docker). No network
  probing of Telegram.
- `check` is read-only and safe while the bot runs.

## Consequences
- Bash logic is unit-tested on Linux by sourcing the script (it runs nothing when sourced):
  `deploy/test/*.test.sh`, `npm run test:deploy`.
- Any new step must keep the stop-first rule and the token rules; add a test next to the existing ones.
