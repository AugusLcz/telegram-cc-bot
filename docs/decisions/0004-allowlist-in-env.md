# 0004. The allowlist lives in `.env`

Status: accepted (0.1.0)

## Context
The bot gives whoever talks to it Claude Code with the service account's permissions on a server.
Pairing flows (codes, approval buttons) add attack surface for little gain on a personal server.

## Decision
- `ALLOWED_USER_IDS` in `.env` is the only allowlist; all listed users are trusted equally.
- Anyone else, in a private chat, gets one reply (rate-limited to once per 10 minutes) with their
  numeric user ID and a note to ask the owner. Nothing else. Groups and channels are ignored.
- `deploy.sh` can detect the owner's ID from a message during install.

## Consequences
- Adding a user means editing `.env` and restarting (`deploy.sh update` or `install --reconfigure`).
- Allowed users share projects and the process limit, each with their own chats and defaults.
- Code: `src/domain/access.ts`, `accessGate` in `src/app/bot.ts`.
