#!/usr/bin/env bash
# deploy.sh: finding other processes on this machine that use the bot token
# (local_pollers), naming how they were started, refusing to kill managed
# ones, and noticing Claude Code's Telegram plugin.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

TOK=123456789:AAtesttokentesttokentesttokentest12
TG_TOKEN=$TOK
SERVICE=tg-cc-bot

work=$(mktemp -d)
mkdir -p "$work/botdir" "$work/plain"
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOK" >"$work/botdir/.env"
started=()

# start NAME CMD…: run CMD in its own session (as a separately started program would be)
start() {
  local dir=$1
  shift
  (cd "$dir" && exec setsid env -u TELEGRAM_BOT_TOKEN "$@") &
  started+=($!)
}

start "$work" env BOT_TOKEN="$TOK" sleep 300               # a) token in the environment
start "$work/botdir" sleep 301                              # b) reads .env from its directory, like `bun src/index.ts`
start "$work/botdir" bash -c 'sleep 302; exit 0'            # c) a shell in that directory: never a poller
start "$work/plain" sleep 303                               # d) unrelated
env BOT_TOKEN="$TOK" sleep 304 &                            # e) this script's own helper (same process group)
own=$!
sleep 0.5
pid_of() { pgrep -f "$1" | head -n1; }
pa=$(pid_of '^sleep 300$') pb=$(pid_of '^sleep 301$') pc=$(pid_of '^bash -c sleep 302; exit 0$') pd=$(pid_of '^sleep 303$')

out=$(local_pollers)
check "token in the environment found" '[[ $out == *"pid $pa "* ]]'
check "working-directory .env found" '[[ $out == *"pid $pb "* && $out == *"in $work/botdir:"* ]]'
check "a shell in that directory is ignored" '[[ $out != *"pid $pc "* ]]'
check "an unrelated process is ignored" '[[ $out != *"pid $pd "* ]]'
check "this script's own helpers are ignored" '[[ $out != *"pid $own "* ]]'
check "the token is never printed" '[[ $out != *"$TOK"* ]]'

start "$work" perl -e 'sleep 305' -- "--token=$TOK"
sleep 0.5
out=$(local_pollers)
check "token on a command line found and masked" '[[ $out == *"<bot token>"* && $out != *"$TOK"* ]]'

check "login session" '[[ $(describe_cgroup /user.slice/user-1000.slice/session-5.scope) == "started from login session 5 (a terminal or SSH shell)" ]]'
check "system unit" '[[ $(describe_cgroup /system.slice/other-bot.service) == "systemd unit other-bot.service" ]]'
check "user unit" '[[ $(describe_cgroup /user.slice/user-1000.slice/user@1000.service/app.slice/bot.service) == "user systemd unit bot.service" ]]'
check "docker" '[[ $(describe_cgroup /system.slice/docker-0123456789abcdef0123.scope) == "Docker container 0123456789ab" ]]'
check "unknown parent" '[[ $(describe_cgroup "") == "started by an unknown parent" ]]'

ASSUME_YES=1
stop_local_pollers "pid $pa (root, since x), started from login session 3 (a terminal or SSH shell), in /: sleep" >/dev/null
rc=$?
check "never kills without a terminal to confirm" '((rc == 1)) && kill -0 $pa'
stop_local_pollers "pid 1 (root, since x), systemd unit x.service, in /: y" >/dev/null
rc=$?
check "refuses processes run by systemd" '((rc == 1))'
stop_local_pollers "config file with this token: /x" >/dev/null
rc=$?
check "config files alone need no stopping" '((rc == 0))'

SVC_HOME=$work/home SVC_USER=cz
mkdir -p "$SVC_HOME/.claude"
echo '{"enabledPlugins": {"telegram@claude-plugins-official": true}}' >"$SVC_HOME/.claude/settings.json"
out=$(report_telegram_plugin)
check "an enabled Telegram plugin is reported" '[[ $out == *"Telegram plugin is enabled for cz"* ]]'
echo '{"enabledPlugins": {"telegram@claude-plugins-official": false}}' >"$SVC_HOME/.claude/settings.json"
out=$(report_telegram_plugin)
check "a disabled plugin is not" '[[ -z $out ]]'

for p in "${started[@]}" "$own" "$pa" "$pb" "$pc" "$pd"; do kill "$p" 2>/dev/null; done
pkill -f "^perl -e sleep 305" 2>/dev/null
pkill -f "^sleep 30[0-4]$" 2>/dev/null
rm -rf "$work"
finish
