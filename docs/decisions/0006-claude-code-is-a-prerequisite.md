# 0006. Claude Code install and sign-in are prerequisites

Status: accepted (0.2.0)

## Context
The first `deploy.sh` created a dedicated account and ran an interactive login inside the script. Over
SSH it hung at the sign-in, and the user couldn't tell what it was waiting for. A later version hung
after `claude --version` because Claude Code's auto-updater kept the command substitution's pipe open.

## Decision
- The user installs Claude Code and signs in once, as the account that will run the bot (by default
  the one that ran `sudo`). `deploy.sh` checks this first (`claude --version`, `claude auth status`)
  and stops with the exact commands if it is missing. It never creates accounts or logs in.
- The bot shares that account's login, skills, settings and session history (`--user` picks another
  account).
- Commands run as that account go through `user_run`: stdin from `/dev/null`, a hard timeout, output
  through a temp file, and Claude Code's auto-update and non-essential traffic disabled.

## Consequences
- Installs are non-interactive apart from the bot token and user ID questions.
- A headless alternative exists: `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN`.
- Code: `step_prerequisites`, `as_user`, `user_run` in `deploy/deploy.sh`.
