#!/usr/bin/env bash
# tg-cc-bot: one-step deployment with built-in self-checks (Linux + systemd).
#
#   sudo ./deploy/deploy.sh [command] [options]
#
# Commands
#   install     (default) Install or upgrade, configure, sign in, start, then verify
#   check       Read-only health check of an existing deployment
#   update      Copy code from this checkout, reinstall dependencies, restart, verify
#   login       Sign the service user in to Claude (browser login or long-lived token)
#   claude ...  Run the bundled Claude Code as the service user (e.g. `claude mcp list`)
#   status      Service status and recent logs
#   logs        Follow the service logs
#   uninstall   Stop and remove the service (--purge also deletes the install directory)
#
# Options
#   --user NAME      Service user                  (default: claude)
#   --dir PATH       Install directory             (default: /opt/tg-cc-bot)
#   --service NAME   systemd unit name             (default: tg-cc-bot)
#   -y, --yes        Never prompt; take settings from the environment
#   --reconfigure    Ask for the main settings again even if .env exists
#   --no-live        Skip the live Claude round-trip test (it uses a few tokens of your plan)
#   --purge          With `uninstall`: also delete the install directory
#   -h, --help       Show this help
#
# Unattended install: export TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS (optionally
# DEFAULT_CWD, DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, ALLOWED_ROOTS,
# CLAUDE_CODE_OAUTH_TOKEN) and run: sudo -E ./deploy/deploy.sh install --yes

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Defaults and output helpers
# ---------------------------------------------------------------------------

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

CMD=install
SVC_USER=claude
INSTALL_DIR=/opt/tg-cc-bot
SERVICE=tg-cc-bot
ASSUME_YES=0
RECONFIGURE=0
LIVE=1
PURGE=0
PASSTHROUGH=()
DISCOVERED_IDS=()
declare -A FROM_ENV=()

# Settings an unattended install may pass through the environment.
ENV_KEYS=(TELEGRAM_BOT_TOKEN ALLOWED_USER_IDS DEFAULT_CWD DEFAULT_MODEL DEFAULT_PERMISSION_MODE ALLOWED_ROOTS CLAUDE_CODE_OAUTH_TOKEN)

MIN_BUN=1.1.0
MIN_MEM_MB=3800
MIN_DISK_MB=1500
PERMISSION_MODES="auto default acceptEdits plan dontAsk bypassPermissions"

if [[ -t 1 ]]; then
  RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' BLUE=$'\e[34m' BOLD=$'\e[1m' DIM=$'\e[2m' RESET=$'\e[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' BOLD='' DIM='' RESET=''
fi

PASS=0 WARN=0 FAIL=0
ok()      { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; PASS=$((PASS + 1)); }
warn()    { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; WARN=$((WARN + 1)); }
bad()     { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*"; FAIL=$((FAIL + 1)); }
info()    { printf '  %s·%s %s\n' "$DIM" "$RESET" "$*"; }
hint()    { printf '    %s↳ %s%s\n' "$DIM" "$*" "$RESET"; }
section() { printf '\n%s%s▸ %s%s\n' "$BOLD" "$BLUE" "$*" "$RESET"; }
banner()  { printf '\n%s%s════════ %s ════════%s\n' "$BOLD" "$BLUE" "$*" "$RESET"; }
die()     { printf '\n%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

on_error() {
  printf '\n%s✗ Unexpected error at line %s: %s%s\n' "$RED" "$1" "$2" "$RESET" >&2
  printf '  Run "sudo %s check" to diagnose, or "bash -x %s" to trace.\n' "$0" "$0" >&2
}

usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# ver_ge A B: true when version A >= version B
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

valid_token()    { [[ $1 =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]]; }
valid_user_ids() { [[ $1 =~ ^[0-9]+(,[0-9]+)*$ ]]; }
normalize_ids()  { tr -d '[:space:]' <<<"$1"; }
is_musl()        { { ldd --version 2>&1 || true; } | grep -qi musl; }

# json_str JSON KEY: first string value of KEY ('' when absent). Never fails.
json_str() { { grep -o "\"$2\":\"[^\"]*\"" <<<"$1" | head -n1 | cut -d'"' -f4; } 2>/dev/null || true; }

http_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || true; }

is_interactive() { ((ASSUME_YES == 0)) && (exec </dev/tty) 2>/dev/null; }

# ask VAR "Question" [default] [secret]. A secret's default is used but never shown.
ask() {
  local __var=$1 question=$2 default=${3:-} secret=${4:-} answer=''
  if [[ -n $default && $secret != secret ]]; then question="$question [$default]"; fi
  if [[ $secret == secret ]]; then
    read -r -s -p "  ? $question: " answer </dev/tty
    echo >/dev/tty
  else
    read -r -p "  ? $question: " answer </dev/tty
  fi
  printf -v "$__var" '%s' "${answer:-$default}"
}

# confirm "Question" [y|n]. Non-interactive runs take the default.
confirm() {
  local default=${2:-y} answer
  if ! is_interactive; then [[ $default == y ]]; return; fi
  read -r -p "  ? $1 [$([[ $default == y ]] && echo Y/n || echo y/N)]: " answer </dev/tty
  answer=${answer:-$default}
  [[ $answer =~ ^[Yy] ]]
}

# env_get KEY: value from the .env file ('' when missing)
env_get() {
  [[ -f $ENV_FILE ]] || return 0
  local line
  line=$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n1 || true)
  line=${line#*=}
  line=${line%$'\r'}
  if [[ $line =~ ^\"(.*)\"$ || $line =~ ^\'(.*)\'$ ]]; then line=${BASH_REMATCH[1]}; fi
  printf '%s' "$line"
}

# env_set KEY VALUE: replace active lines, else the first commented-out one, else append.
env_set() {
  local tmp
  tmp=$(mktemp)
  KEY=$1 VAL=$2 awk '
    BEGIN { key = ENVIRON["KEY"]; val = ENVIRON["VAL"]; active = "^[ \t]*" key "="; commented = "^[ \t]*#[ \t]*" key "=" }
    { line[NR] = $0; if ($0 ~ active) hit[++n] = NR; else if ($0 ~ commented && !c) c = NR }
    END {
      if (n) { for (i = 1; i <= n; i++) line[hit[i]] = key "=" val }
      else if (c) line[c] = key "=" val
      else line[++NR] = key "=" val
      for (i = 1; i <= NR; i++) print line[i]
    }' "$ENV_FILE" >"$tmp"
  cat "$tmp" >"$ENV_FILE" # keeps the file's owner and mode
  rm -f "$tmp"
}

# Run a command as the service user with a clean environment (root's variables
# never leak in). Secrets go through the environment, not the command line.
#   AS_USER_CWD      working directory (default: the user's home)
#   AS_USER_TIMEOUT  seconds before the command is killed
as_user() {
  local path="$SVC_HOME/.bun/bin:$SVC_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  local -a vars=(HOME="$SVC_HOME" USER="$SVC_USER" LOGNAME="$SVC_USER" SHELL=/bin/bash PATH="$path"
    LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}")
  local v
  for v in CLAUDE_CODE_OAUTH_TOKEN HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
    if [[ -n ${!v:-} ]]; then vars+=("$v=${!v}"); fi
  done
  local -a pre=()
  if [[ -n ${AS_USER_TIMEOUT:-} ]]; then pre=(timeout "$AS_USER_TIMEOUT"); fi
  (
    cd "${AS_USER_CWD:-$SVC_HOME}" 2>/dev/null || cd /
    exec env -i "${vars[@]}" ${pre[@]+"${pre[@]}"} runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" PATH="$path" "$@"
  )
}

# Telegram Bot API call. The token travels via curl's stdin config, not argv.
tg_api() { # METHOD [query-string]
  printf 'url = "https://api.telegram.org/bot%s/%s%s"\n' "$TG_TOKEN" "$1" "${2:+?$2}" |
    curl -sS --max-time 20 -K - 2>&1 || true
}

pkg_install() {
  if have apt-get; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif have dnf; then dnf install -y -q "$@"
  elif have yum; then yum install -y -q "$@"
  elif have zypper; then zypper --non-interactive install "$@"
  elif have pacman; then pacman -Sy --noconfirm --needed "$@"
  elif have apk; then apk add --no-cache "$@"
  else return 1
  fi
}

# Claude Code binary the bot will run: CLAUDE_PATH, else the SDK's platform
# package, probed in the same order the SDK uses (glibc first unless musl).
find_claude_bin() {
  local custom
  custom=$(env_get CLAUDE_PATH)
  if [[ -n $custom ]]; then printf '%s' "$custom"; return 0; fi
  local arch base=$INSTALL_DIR/node_modules/@anthropic-ai
  case $(uname -m) in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) return 0 ;; esac
  local -a order=("claude-agent-sdk-linux-$arch" "claude-agent-sdk-linux-$arch-musl")
  if is_musl; then order=("claude-agent-sdk-linux-$arch-musl" "claude-agent-sdk-linux-$arch"); fi
  local pkg
  for pkg in "${order[@]}"; do
    if [[ -x $base/$pkg/claude ]]; then printf '%s' "$base/$pkg/claude"; return 0; fi
  done
}

# ---------------------------------------------------------------------------
# Derived state
# ---------------------------------------------------------------------------

resolve_paths() {
  ENV_FILE=$INSTALL_DIR/.env
  UNIT_FILE=/etc/systemd/system/$SERVICE.service
  SVC_HOME=$(getent passwd "$SVC_USER" | cut -d: -f6 || true)
  SVC_GROUP=$(id -gn "$SVC_USER" 2>/dev/null || true)
  BUN=${SVC_HOME:+$SVC_HOME/.bun/bin/bun}
  TG_TOKEN=$(env_get TELEGRAM_BOT_TOKEN)
  CLAUDE_BIN=$(find_claude_bin)
  # Check exactly what the service will see: the token from .env, or none.
  local oauth
  oauth=$(env_get CLAUDE_CODE_OAUTH_TOKEN)
  if [[ -n $oauth ]]; then export CLAUDE_CODE_OAUTH_TOKEN=$oauth; else unset CLAUDE_CODE_OAUTH_TOKEN; fi
}
BOT_USERNAME=''

# ---------------------------------------------------------------------------
# Checks (read-only). Each prints ✓ / ! / ✗ lines and never aborts the script.
# ---------------------------------------------------------------------------

check_system() {
  section "System"
  local os
  os=$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-${ID:-}}") || true)
  if [[ $(uname -s) == Linux ]]; then ok "OS: ${os:-$(uname -sr)}"; else bad "OS: $(uname -s) (Linux required)"; fi

  local arch
  arch=$(uname -m)
  case $arch in
    x86_64 | amd64 | aarch64 | arm64) ok "Architecture: $arch" ;;
    *) bad "Architecture: $arch (Claude Code supports x64 and arm64)" ;;
  esac

  if is_musl; then
    warn "musl libc detected"
    hint "Claude Code on musl needs libgcc, libstdc++ and ripgrep, plus USE_BUILTIN_RIPGREP=0"
  fi

  if [[ -d /run/systemd/system ]] && have systemctl && have journalctl; then
    ok "systemd: $(systemctl --version | head -n1)"
  else
    bad "systemd is not running as init (required for the service)"
  fi

  if have runuser; then ok "runuser available"; else bad "runuser missing (install util-linux)"; fi

  local mem
  mem=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)
  if ((mem >= MIN_MEM_MB)); then
    ok "Memory: ${mem} MB"
  else
    warn "Memory: ${mem} MB (Claude Code recommends 4 GB+)"
    hint "Add swap if Claude Code gets killed under load"
  fi

  local target=$INSTALL_DIR disk
  while [[ ! -d $target ]]; do target=$(dirname "$target"); done
  disk=$(df -Pm "$target" | awk 'NR == 2 { print $4 }')
  if ((disk >= MIN_DISK_MB)); then ok "Free disk at $target: ${disk} MB"
  elif ((disk >= 600)); then warn "Free disk at $target: ${disk} MB (1.5 GB+ recommended)"
  else bad "Free disk at $target: ${disk} MB (need at least 600 MB)"; fi

  local cmd missing=()
  for cmd in curl unzip git; do have "$cmd" || missing+=("$cmd"); done
  if ((${#missing[@]} == 0)); then
    ok "Tools: curl, unzip, git"
  else
    bad "Missing tools: ${missing[*]}"
    hint "install adds them automatically"
  fi
}

check_network() {
  section "Network"
  local name code
  for name in api.telegram.org api.anthropic.com claude.ai; do
    code=$(http_code "https://$name")
    if [[ -n $code && $code != 000 ]]; then
      ok "$name reachable (HTTP $code)"
    else
      bad "$name unreachable"
      hint "Check DNS, firewall or proxy (HTTPS_PROXY is honoured by curl and Claude Code)"
    fi
  done
}

check_user() {
  section "Service user"
  if [[ -z $SVC_HOME ]]; then bad "User '$SVC_USER' does not exist"; return 0; fi
  ok "User '$SVC_USER' (home $SVC_HOME)"
  if [[ $SVC_USER == root ]]; then warn "Running Claude Code as root gives it full control of this machine"; fi
  if [[ -d $SVC_HOME/.claude ]]; then ok "Claude config dir: $SVC_HOME/.claude"
  else info "No ~/.claude yet (created at first sign-in)"; fi
}

check_bun() {
  section "Bun runtime"
  if [[ -z $BUN || ! -x $BUN ]]; then bad "Bun not installed for '$SVC_USER' (expected $BUN)"; return 0; fi
  local v
  v=$(as_user "$BUN" --version 2>/dev/null || true)
  if [[ -z $v ]]; then
    bad "Bun at $BUN does not run"
  elif ver_ge "$v" "$MIN_BUN"; then
    ok "Bun $v"
  else
    bad "Bun $v is too old (need $MIN_BUN+)"
    hint "Run: sudo $0 update"
  fi
}

pkg_version() { grep -o '"version": *"[^"]*"' "$1" 2>/dev/null | head -n1 | cut -d'"' -f4 || true; }

check_code() {
  section "Application"
  if [[ ! -f $INSTALL_DIR/package.json || ! -f $INSTALL_DIR/src/index.ts ]]; then
    bad "No application found in $INSTALL_DIR"
    return 0
  fi
  ok "Code in $INSTALL_DIR (v$(pkg_version "$INSTALL_DIR/package.json"))"

  local owner
  owner=$(stat -c %U "$INSTALL_DIR")
  if [[ $owner == "$SVC_USER" ]]; then ok "Owned by $SVC_USER"; else bad "Owned by $owner, expected $SVC_USER"; fi

  local pkg
  for pkg in grammy @grammyjs/runner @grammyjs/auto-retry @anthropic-ai/claude-agent-sdk marked; do
    if [[ -f $INSTALL_DIR/node_modules/$pkg/package.json ]]; then
      ok "Dependency $pkg $(pkg_version "$INSTALL_DIR/node_modules/$pkg/package.json")"
    else
      bad "Dependency $pkg missing"
      hint "Run: sudo $0 update"
    fi
  done

  if [[ -n $BUN && -x $BUN ]]; then
    local probe="for (const m of ['$INSTALL_DIR/src/core/config.ts', '$INSTALL_DIR/src/app/bot.ts', '@anthropic-ai/claude-agent-sdk', 'grammy', '@grammyjs/runner']) await import(m);"
    if AS_USER_CWD=$INSTALL_DIR AS_USER_TIMEOUT=60 as_user "$BUN" -e "$probe" >/dev/null 2>&1; then
      ok "Modules load under Bun"
    else
      bad "Modules fail to load under Bun"
      hint "See the error with: cd $INSTALL_DIR && sudo -u $SVC_USER $BUN src/index.ts"
    fi
  fi

  if [[ -z $CLAUDE_BIN ]]; then
    bad "Claude Code binary not found (the Agent SDK's platform package is missing)"
    hint "Reinstall dependencies: sudo $0 update"
    return 0
  fi
  local v
  v=$(AS_USER_TIMEOUT=30 as_user "$CLAUDE_BIN" --version 2>/dev/null | head -n1 || true)
  if [[ -n $v ]]; then ok "Claude Code $v"; info "$CLAUDE_BIN"; else bad "Claude Code binary does not run: $CLAUDE_BIN"; fi
}

check_config() {
  section "Configuration"
  if [[ ! -f $ENV_FILE ]]; then bad "$ENV_FILE missing"; return 0; fi

  local perm owner
  perm=$(stat -c %a "$ENV_FILE")
  owner=$(stat -c %U "$ENV_FILE")
  if [[ $perm == 600 && $owner == "$SVC_USER" ]]; then
    ok ".env is private (600, $owner)"
  else
    warn ".env permissions $perm, owner $owner (expected 600, $SVC_USER)"
    hint "chmod 600 $ENV_FILE && chown $SVC_USER $ENV_FILE"
  fi

  if valid_token "$TG_TOKEN"; then ok "TELEGRAM_BOT_TOKEN looks valid"; else bad "TELEGRAM_BOT_TOKEN missing or malformed"; fi

  local ids
  ids=$(normalize_ids "$(env_get ALLOWED_USER_IDS)")
  if valid_user_ids "$ids"; then ok "ALLOWED_USER_IDS: $ids"; else bad "ALLOWED_USER_IDS missing or not numeric"; fi

  local cwd
  cwd=$(env_get DEFAULT_CWD)
  cwd=${cwd:-$SVC_HOME}
  if [[ ! -d $cwd ]]; then
    bad "DEFAULT_CWD does not exist: $cwd"
  elif as_user test -r "$cwd" -a -w "$cwd" -a -x "$cwd"; then
    ok "DEFAULT_CWD: $cwd (writable by $SVC_USER)"
  else
    bad "DEFAULT_CWD not writable by $SVC_USER: $cwd"
  fi

  local roots root
  roots=$(env_get ALLOWED_ROOTS)
  if [[ -n $roots ]]; then
    local -a root_list
    IFS=',' read -r -a root_list <<<"$roots"
    for root in "${root_list[@]}"; do
      root=$(xargs <<<"$root")
      if [[ ! -d $root ]]; then warn "ALLOWED_ROOTS entry does not exist: $root"; fi
    done
    ok "ALLOWED_ROOTS: $roots"
  else
    info "ALLOWED_ROOTS not set: /cd may enter any directory $SVC_USER can access"
  fi

  local mode
  mode=$(env_get DEFAULT_PERMISSION_MODE)
  mode=${mode:-auto}
  if [[ " $PERMISSION_MODES " == *" $mode "* ]]; then
    ok "DEFAULT_PERMISSION_MODE: $mode"
    if [[ $mode == bypassPermissions ]]; then warn "bypassPermissions lets Claude run anything without asking"; fi
  else
    bad "DEFAULT_PERMISSION_MODE invalid: $mode"
  fi

  local stream
  stream=$(env_get STREAM_MODE)
  case ${stream:-draft} in
    draft | edit | off) ok "STREAM_MODE: ${stream:-draft}" ;;
    *) bad "STREAM_MODE invalid: $stream" ;;
  esac

  local effort level
  effort=$(env_get DEFAULT_EFFORT)
  case ${effort:-unset} in
    unset | low | medium | high | xhigh | max) ;;
    *) bad "DEFAULT_EFFORT invalid: $effort (low, medium, high, xhigh, max)" ;;
  esac
  level=$(env_get LOG_LEVEL)
  case ${level:-info} in
    debug | info | warn | error) ;;
    *) bad "LOG_LEVEL invalid: $level (debug, info, warn, error)" ;;
  esac

  # Process lifecycle: how many Claude Code processes may run, and for how long idle ones stay up.
  local key value
  for key in MAX_LIVE_SESSIONS SESSION_IDLE_MINUTES BACKGROUND_MAX_MINUTES; do
    value=$(env_get "$key")
    if [[ -n $value && ! $value =~ ^[0-9]+([.][0-9]+)?$ ]]; then bad "$key must be a positive number (got $value)"; fi
  done
  local live idle
  live=$(env_get MAX_LIVE_SESSIONS)
  idle=$(env_get SESSION_IDLE_MINUTES)
  ok "Lifecycle: up to ${live:-3} live Claude processes, idle ones close after ${idle:-15} min"
  local mem_mb
  mem_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)
  if ((mem_mb > 0 && ${live:-3} * 600 > mem_mb)); then
    warn "MAX_LIVE_SESSIONS=${live:-3} may be too many for ${mem_mb} MB RAM (plan ~600 MB per busy process)"
  fi

  local state state_dir
  state=$(env_get STATE_FILE)
  state=${state:-./data/state.json}
  [[ $state == /* ]] || state=$INSTALL_DIR/${state#./}
  state_dir=$(dirname "$state")
  if [[ -d $state_dir ]] && ! as_user test -w "$state_dir"; then
    bad "State directory not writable by $SVC_USER: $state_dir"
  else
    ok "State file: $state"
  fi
}

check_telegram() {
  section "Telegram"
  if ! valid_token "$TG_TOKEN"; then bad "Skipped: no valid bot token"; return 0; fi
  local body
  body=$(tg_api getMe)
  if [[ $body == *'"ok":true'* ]]; then
    BOT_USERNAME=$(json_str "$body" username)
    ok "Bot token accepted: @$BOT_USERNAME"
    # Tabs (topics in private chats) are what each Claude session lives in.
    if [[ $body == *'"has_topics_enabled":true'* ]]; then
      ok "Threaded Mode on: tabs available"
    else
      bad "Threaded Mode is off: tabs (one per Claude session) are unavailable"
      hint "@BotFather → your bot → Bot Settings → Threaded Mode → enable, then: sudo $0 update"
    fi
    if [[ $body == *'"allows_users_to_create_topics":true'* ]]; then
      ok "Users may open tabs with the + button"
    else
      info "The + button is disabled for users; /new still opens tabs"
    fi
  elif [[ $body == *'"error_code":401'* ]]; then
    bad "Bot token rejected by Telegram (401 Unauthorized)"
    hint "Get a fresh token from @BotFather"
    return 0
  else
    bad "Telegram getMe failed: ${body:0:200}"
    return 0
  fi
  local hook
  hook=$(json_str "$(tg_api getWebhookInfo)" url)
  if [[ -n $hook ]]; then warn "A webhook is set ($hook); the bot removes it on start because it uses long polling"
  else ok "No webhook set (long polling)"; fi
}

check_claude_auth() {
  section "Claude sign-in"
  if [[ -z $CLAUDE_BIN ]]; then bad "Skipped: Claude Code binary not found"; return 0; fi
  local out rc=0
  out=$(AS_USER_TIMEOUT=30 as_user "$CLAUDE_BIN" auth status 2>&1) || rc=$?
  if ((rc == 0)); then
    local method email
    method=$(json_str "$out" authMethod)
    email=$(json_str "$out" email)
    ok "Signed in${method:+ ($method)}${email:+ as $email}"
    if [[ $method == oauth_token ]]; then info "Using CLAUDE_CODE_OAUTH_TOKEN from .env (only the live test proves it is valid)"; fi
  else
    local text
    text=$(AS_USER_TIMEOUT=30 as_user "$CLAUDE_BIN" auth status --text 2>&1 || true)
    if grep -qi expired <<<"$text"; then bad "Claude login expired"; else bad "Not signed in to Claude"; fi
    hint "Run: sudo $0 login"
    return 0
  fi

  if ((LIVE == 0)); then info "Live test skipped (--no-live)"; return 0; fi
  info "Live test: one tiny Haiku request…"
  live_probe
}

live_probe() {
  local out rc=0
  local -a args=(-p "Reply with exactly the word OK" --model haiku --tools "" --output-format json --no-session-persistence)
  out=$(AS_USER_TIMEOUT=120 as_user "$CLAUDE_BIN" --safe-mode "${args[@]}" 2>&1) || rc=$?
  if [[ $out == *"unknown option"* ]]; then
    rc=0
    out=$(AS_USER_TIMEOUT=120 as_user "$CLAUDE_BIN" "${args[@]}" 2>&1) || rc=$?
  fi
  if [[ $out == *'"is_error":false'* ]]; then
    ok "Live round-trip to Claude succeeded (reply: $(json_str "$out" result))"
  elif ((rc == 124)); then
    bad "Live test timed out after 120s"
  else
    local msg
    msg=$(json_str "$out" result)
    bad "Live test failed: ${msg:-${out:0:300}}"
    case "$msg $out" in
      *xpired* | *uthenticat* | *login* | *401*) hint "Sign in again: sudo $0 login" ;;
      *limit* | *usage*) hint "Your plan's usage limit may be reached; try again later" ;;
      *) hint "Run it by hand: sudo $0 claude -p hello" ;;
    esac
  fi
}

service_logs() {
  local inv
  inv=$(systemctl show -p InvocationID --value "$SERVICE" 2>/dev/null || true)
  if [[ -n $inv ]]; then journalctl -q --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null || true
  else journalctl -q --no-pager -o cat -u "$SERVICE" -n 200 2>/dev/null || true; fi
}

# Print hints for known failure signatures in the bot's logs.
explain_logs() {
  local logs=$1
  if [[ $logs == *"401: Unauthorized"* ]]; then hint "Telegram rejected the bot token: update TELEGRAM_BOT_TOKEN"; fi
  if [[ $logs == *"409: Conflict"* ]]; then hint "Another process polls this bot token (e.g. a dev copy). Only one instance may run"; fi
  if [[ $logs == *"is required"* ]]; then hint "A required setting is missing in $ENV_FILE"; fi
  if [[ $logs == *"warm-up failed"* ]]; then hint "Claude Code could not start: see the Application and Claude sign-in checks"; fi
  if [[ $logs == *EACCES* ]]; then hint "Permission denied: check ownership of $INSTALL_DIR and DEFAULT_CWD"; fi
  return 0
}

check_service() {
  section "Service"
  if [[ ! -f $UNIT_FILE ]]; then bad "systemd unit not installed ($UNIT_FILE)"; return 0; fi
  ok "Unit file: $UNIT_FILE"

  local exec_bun
  exec_bun=$(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' "$UNIT_FILE")
  if [[ -x $exec_bun ]]; then ok "ExecStart runtime exists: $exec_bun"; else bad "ExecStart runtime missing: $exec_bun"; fi

  if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
    ok "Enabled at boot"
  else
    warn "Not enabled at boot"
    hint "systemctl enable $SERVICE"
  fi

  local state restarts since logs
  state=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
  restarts=$(systemctl show -p NRestarts --value "$SERVICE" 2>/dev/null || true)
  restarts=${restarts:-0}
  since=$(systemctl show -p ActiveEnterTimestamp --value "$SERVICE" 2>/dev/null || true)
  logs=$(service_logs)
  if [[ $state == active ]]; then
    ok "Running since ${since:-unknown}"
  else
    bad "Service is ${state:-unknown}"
    explain_logs "$(journalctl -q --no-pager -o cat -u "$SERVICE" -n 200 2>/dev/null || true)"
    hint "Logs: journalctl -u $SERVICE -n 50"
    return 0
  fi

  if ((restarts > 0)); then
    warn "Restarted $restarts time(s) since the unit was started"
    explain_logs "$(journalctl -q --no-pager -o cat -u "$SERVICE" -n 200 2>/dev/null || true)"
  fi

  if grep -q ' polling ' <<<"$logs"; then
    ok "Telegram: $(grep ' polling ' <<<"$logs" | tail -n1)"
  else
    warn "No 'polling' line in this run's logs (journal may have rotated)"
  fi

  if grep -q 'Claude Code ready' <<<"$logs"; then
    ok "$(grep 'Claude Code ready' <<<"$logs" | tail -n1)"
  elif grep -q 'warm-up failed' <<<"$logs"; then
    bad "Claude Code warm-up failed"
    explain_logs "$logs"
  else
    warn "Claude Code has not reported ready in this run's logs"
  fi

  local errors
  errors=$(grep -cE 'Claude Code exited|error handling update|failed:' <<<"$logs" || true)
  if ((errors > 0)); then
    warn "$errors error line(s) in this run's logs"
    hint "journalctl -u $SERVICE -n 100"
  fi
}

run_all_checks() {
  resolve_paths
  check_system
  check_network
  check_user
  if [[ -z $SVC_HOME ]]; then return 0; fi
  check_bun
  check_code
  check_config
  check_telegram
  check_claude_auth
  check_service
}

summary() {
  printf '\n%s──────────────── Summary ────────────────%s\n' "$BOLD" "$RESET"
  printf '  %s✓ %d passed%s   %s! %d warnings%s   %s✗ %d failed%s\n' \
    "$GREEN" "$PASS" "$RESET" "$YELLOW" "$WARN" "$RESET" "$RED" "$FAIL" "$RESET"
  if [[ -n $BOT_USERNAME ]]; then printf '  Bot       @%s  (https://t.me/%s)\n' "$BOT_USERNAME" "$BOT_USERNAME"; fi
  local state
  state=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
  printf '  Service   %s (%s)\n' "$SERVICE" "${state:-not installed}"
  printf '  Config    %s\n' "$ENV_FILE"
  printf '  Logs      journalctl -u %s -f\n' "$SERVICE"
  if ((FAIL == 0)); then
    printf '\n  %sAll good.%s Open Telegram and send /help to %s.\n' "$GREEN$BOLD" "$RESET" "${BOT_USERNAME:+@$BOT_USERNAME}"
  else
    printf '\n  %sFix the ✗ items above, then run: sudo %s check%s\n' "$RED" "$0" "$RESET"
  fi
}

# ---------------------------------------------------------------------------
# Install steps (these change the system)
# ---------------------------------------------------------------------------

step_preflight() {
  section "Preflight"
  [[ $(uname -s) == Linux ]] || die "Linux is required"
  case $(uname -m) in x86_64 | amd64 | aarch64 | arm64) ;; *) die "Unsupported architecture $(uname -m)" ;; esac
  [[ -d /run/systemd/system ]] || die "systemd is required (it is not running as init here)"
  have runuser || die "runuser is required (util-linux)"
  [[ -f $SRC_DIR/package.json && -f $SRC_DIR/src/index.ts ]] || die "Run this script from a tg-cc-bot checkout ($SRC_DIR/src/index.ts not found)"
  ok "Linux $(uname -m) with systemd"

  local missing=() cmd
  for cmd in curl unzip git; do have "$cmd" || missing+=("$cmd"); done
  if ((${#missing[@]})); then
    info "Installing: ${missing[*]}"
    pkg_install "${missing[@]}" ca-certificates >/dev/null || die "Could not install ${missing[*]}; install them manually"
    ok "Installed ${missing[*]}"
  else
    ok "curl, unzip and git present"
  fi

  local name code
  for name in api.telegram.org api.anthropic.com bun.sh registry.npmjs.org; do
    code=$(http_code "https://$name")
    [[ -n $code && $code != 000 ]] || die "Cannot reach https://$name (check network or proxy)"
  done
  ok "Network: Telegram, Anthropic, bun.sh and npm reachable"
}

step_user() {
  section "Service user"
  if getent passwd "$SVC_USER" >/dev/null; then
    ok "User '$SVC_USER' exists"
  else
    useradd --create-home --shell /bin/bash "$SVC_USER"
    ok "Created user '$SVC_USER'"
  fi
  resolve_paths
}

step_bun() {
  section "Bun runtime"
  local v=''
  if [[ -x $BUN ]]; then v=$(as_user "$BUN" --version 2>/dev/null || true); fi
  if [[ -n $v ]] && ver_ge "$v" "$MIN_BUN"; then
    ok "Bun $v already installed"
    return 0
  fi
  info "Installing Bun for $SVC_USER…"
  as_user bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null
  v=$(as_user "$BUN" --version 2>/dev/null || true)
  [[ -n $v ]] || die "Bun installation failed"
  ok "Bun $v installed at $BUN"
}

step_code() {
  section "Application"
  mkdir -p "$INSTALL_DIR"
  if [[ $SRC_DIR -ef $INSTALL_DIR ]]; then
    info "Running from the install directory; nothing to copy"
  else
    if have rsync; then
      rsync -a --delete --exclude node_modules --exclude .env --exclude data --exclude .git "$SRC_DIR/" "$INSTALL_DIR/"
    else
      rm -rf "$INSTALL_DIR/src" "$INSTALL_DIR/deploy" "$INSTALL_DIR/test"
      tar -C "$SRC_DIR" --exclude=./node_modules --exclude=./.env --exclude=./data --exclude=./.git -cf - . |
        tar -C "$INSTALL_DIR" -xf -
    fi
    ok "Copied code to $INSTALL_DIR"
  fi
  chown -R "$SVC_USER:$SVC_GROUP" "$INSTALL_DIR"

  info "Installing dependencies…"
  local out
  if ! out=$(AS_USER_CWD=$INSTALL_DIR as_user "$BUN" install --production 2>&1); then
    printf '%s\n' "$out" | tail -n 20
    die "bun install failed"
  fi
  ok "Dependencies installed"
  resolve_paths
  [[ -n $CLAUDE_BIN ]] || die "Claude Code binary missing after install (the SDK's platform package was not installed)"
  ok "Claude Code $(AS_USER_TIMEOUT=30 as_user "$CLAUDE_BIN" --version 2>/dev/null | head -n1 || true)"
}

discover_user_ids() {
  # Nothing else may poll the bot meanwhile; the service is stopped before this runs.
  tg_api deleteWebhook >/dev/null
  local attempt body lines line id name last
  for attempt in 1 2 3; do
    info "In Telegram, send any message to @$BOT_USERNAME, then press Enter here"
    read -r _ </dev/tty
    body=$(tg_api getUpdates "timeout=0")
    lines=$(grep -o '"from":{"id":[0-9]*,"is_bot":false,"first_name":"[^"]*"' <<<"$body" | sort -u || true)
    if [[ -z $lines ]]; then
      warn "No message received yet (attempt $attempt/3)"
      continue
    fi
    while IFS= read -r line; do
      id=$(grep -o '"id":[0-9]*' <<<"$line" | cut -d: -f2)
      name=$(cut -d'"' -f10 <<<"$line")
      if confirm "Allow $name (ID $id)?" y; then DISCOVERED_IDS+=("$id"); fi
    done <<<"$lines"
    # Acknowledge these updates so the bot does not answer them on its first start.
    last=$(grep -o '"update_id":[0-9]*' <<<"$body" | cut -d: -f2 | sort -n | tail -n1 || true)
    if [[ -n $last ]]; then tg_api getUpdates "offset=$((last + 1))&timeout=0" >/dev/null; fi
    if ((${#DISCOVERED_IDS[@]})); then return 0; fi
  done
  return 1
}

step_config() {
  section "Configuration"
  if [[ ! -f $ENV_FILE ]]; then
    cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
    ok "Created $ENV_FILE from .env.example"
  fi
  chown "$SVC_USER:$SVC_GROUP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  # Values passed through the environment win (unattended installs).
  local key
  if ((${#FROM_ENV[@]})); then
    for key in "${!FROM_ENV[@]}"; do
      if [[ ${FROM_ENV[$key]} != "$(env_get "$key")" ]]; then
        env_set "$key" "${FROM_ENV[$key]}"
        ok "$key set from the environment"
      fi
    done
  fi

  # Bot token
  TG_TOKEN=$(env_get TELEGRAM_BOT_TOKEN)
  if ! valid_token "$TG_TOKEN" || ((RECONFIGURE)); then
    is_interactive || die "TELEGRAM_BOT_TOKEN is missing: export it or put it in $ENV_FILE"
    local suffix=''
    if valid_token "$TG_TOKEN"; then suffix=' (Enter keeps the current one)'; fi
    info "Create a bot with @BotFather (/newbot) and paste its token"
    while :; do
      ask TG_TOKEN "Telegram bot token$suffix" "$TG_TOKEN" secret
      if valid_token "$TG_TOKEN"; then break; fi
      warn "That doesn't look like a bot token (format 123456789:AA…)"
    done
  fi
  local body
  body=$(tg_api getMe)
  [[ $body == *'"ok":true'* ]] || die "Telegram rejected the bot token: ${body:0:200}"
  BOT_USERNAME=$(json_str "$body" username)
  env_set TELEGRAM_BOT_TOKEN "$TG_TOKEN"
  ok "Bot token valid: @$BOT_USERNAME"
  if [[ $body != *'"has_topics_enabled":true'* ]]; then
    warn "Threaded Mode is off for @$BOT_USERNAME: every Claude session lives in a tab, so enable it now"
    hint "@BotFather → @$BOT_USERNAME → Bot Settings → Threaded Mode (the bot picks it up on restart)"
  fi

  # Allowed users
  local ids
  ids=$(normalize_ids "$(env_get ALLOWED_USER_IDS)")
  if ! valid_user_ids "$ids" || ((RECONFIGURE)); then
    is_interactive || die "ALLOWED_USER_IDS is missing: export it or put it in $ENV_FILE"
    local current=''
    if valid_user_ids "$ids"; then current=$ids; fi
    ask ids "Telegram user IDs allowed to use the bot (comma-separated; empty = detect)" "$current"
    ids=$(normalize_ids "$ids")
    if [[ -z $ids ]]; then
      DISCOVERED_IDS=()
      discover_user_ids || die "Could not detect your user ID; get it from @userinfobot and re-run"
      ids=$(IFS=,; echo "${DISCOVERED_IDS[*]}")
    fi
    valid_user_ids "$ids" || die "Invalid user ID list: $ids"
    env_set ALLOWED_USER_IDS "$ids"
  fi
  ok "Allowed users: $ids"

  # Working directory
  local cwd
  cwd=$(env_get DEFAULT_CWD)
  if [[ -z $cwd ]] || ((RECONFIGURE)); then
    if is_interactive; then ask cwd "First project directory (add more later in Telegram with /project add)" "${cwd:-$SVC_HOME}"; fi
    cwd=${cwd:-$SVC_HOME}
    env_set DEFAULT_CWD "$cwd"
  fi
  if [[ ! -d $cwd ]]; then
    mkdir -p "$cwd"
    chown "$SVC_USER:$SVC_GROUP" "$cwd"
    ok "Created $cwd"
  fi
  as_user test -w "$cwd" || die "$SVC_USER cannot write to DEFAULT_CWD $cwd (fix ownership or pick another directory)"
  ok "Working directory: $cwd"

  mkdir -p "$INSTALL_DIR/data"
  chown -R "$SVC_USER:$SVC_GROUP" "$INSTALL_DIR/data"
  chown "$SVC_USER:$SVC_GROUP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  resolve_paths
}

signed_in() { AS_USER_TIMEOUT=30 as_user "$CLAUDE_BIN" auth status >/dev/null 2>&1; }

step_login() {
  section "Claude sign-in"
  resolve_paths
  [[ -n $CLAUDE_BIN ]] || die "Claude Code binary not found; run install first"
  if [[ $CMD != login ]] && signed_in; then
    ok "Already signed in"
    return 0
  fi
  if ! is_interactive; then
    bad "Not signed in to Claude, and running non-interactively"
    hint "Export CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`) or run: sudo $0 login"
    return 0
  fi
  printf '\n  Sign %s in to your Claude subscription:\n' "$SVC_USER"
  printf '    1) Browser login (recommended): open the link on any device, paste the code back here\n'
  printf '    2) Long-lived token: run setup-token, paste the token (stored in .env, valid for 1 year)\n'
  printf '    3) Skip for now\n'
  local choice
  ask choice "Choice" 1
  case $choice in
    1)
      as_user "$CLAUDE_BIN" auth login </dev/tty >/dev/tty 2>&1 || true
      ;;
    2)
      as_user "$CLAUDE_BIN" setup-token </dev/tty >/dev/tty 2>&1 || true
      local token
      ask token "Paste the token printed above" "" secret
      [[ -n $token ]] || die "No token entered"
      if [[ $token != sk-ant-* ]]; then warn "Token does not start with sk-ant-; saving it anyway"; fi
      env_set CLAUDE_CODE_OAUTH_TOKEN "$token"
      export CLAUDE_CODE_OAUTH_TOKEN=$token
      ;;
    *)
      warn "Skipped. The bot will report authentication errors until you run: sudo $0 login"
      return 0
      ;;
  esac
  if signed_in; then ok "Signed in"; else bad "Still not signed in"; hint "Retry: sudo $0 login"; fi
}

step_service() {
  section "systemd service"
  local path="$SVC_HOME/.bun/bin:$SVC_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  local tmp
  tmp=$(mktemp)
  cat >"$tmp" <<EOF
# Generated by deploy/deploy.sh. Re-run the script instead of editing by hand.
[Unit]
Description=tg-cc-bot: Telegram remote control for Claude Code
Documentation=file://$INSTALL_DIR/README.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_GROUP
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
Environment=HOME=$SVC_HOME
Environment=PATH=$path
ExecStart=$BUN src/index.ts
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
  if [[ -f $UNIT_FILE ]] && cmp -s "$tmp" "$UNIT_FILE"; then
    ok "Unit file up to date"
  else
    install -m 644 "$tmp" "$UNIT_FILE"
    ok "Wrote $UNIT_FILE"
  fi
  rm -f "$tmp"
  systemctl daemon-reload
  systemctl enable --quiet "$SERVICE"
  systemctl reset-failed "$SERVICE" 2>/dev/null || true
  systemctl restart "$SERVICE"
  ok "Service (re)started"
  wait_ready 90
}

wait_ready() {
  info "Waiting for the bot to come up…"
  local deadline=$((SECONDS + $1)) logs restarts
  while ((SECONDS < deadline)); do
    sleep 2
    restarts=$(systemctl show -p NRestarts --value "$SERVICE" 2>/dev/null || true)
    if ! systemctl is-active --quiet "$SERVICE" || [[ ${restarts:-0} != 0 ]]; then
      bad "Service failed to start"
      journalctl -q --no-pager -o cat -u "$SERVICE" -n 15 2>/dev/null | sed 's/^/      /' || true
      explain_logs "$(journalctl -q --no-pager -o cat -u "$SERVICE" -n 200 2>/dev/null || true)"
      return 0
    fi
    logs=$(service_logs)
    if grep -q ' polling ' <<<"$logs" && grep -qE 'Claude Code ready|warm-up failed' <<<"$logs"; then
      ok "Bot is up"
      return 0
    fi
  done
  warn "Bot did not report ready within $1s (it may still be starting)"
}

stop_service_if_running() {
  if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    systemctl stop "$SERVICE"
    info "Stopped $SERVICE for the upgrade"
  fi
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

self_check() {
  banner "Self-check"
  PASS=0 WARN=0 FAIL=0
  run_all_checks
  summary
}

cmd_install() {
  printf '%sInstalling tg-cc-bot%s → %s (user %s, service %s)\n' "$BOLD" "$RESET" "$INSTALL_DIR" "$SVC_USER" "$SERVICE"
  resolve_paths
  step_preflight
  step_user
  stop_service_if_running
  step_bun
  step_code
  step_config
  step_login
  step_service
  self_check
}

cmd_update() {
  resolve_paths
  [[ -n $SVC_HOME && -f $ENV_FILE ]] || die "No deployment found in $INSTALL_DIR; run install first"
  printf '%sUpdating tg-cc-bot%s in %s\n' "$BOLD" "$RESET" "$INSTALL_DIR"
  stop_service_if_running
  step_bun
  step_code
  step_service
  self_check
}

cmd_check() {
  printf '%sChecking tg-cc-bot%s in %s (user %s, service %s)\n' "$BOLD" "$RESET" "$INSTALL_DIR" "$SVC_USER" "$SERVICE"
  run_all_checks
  summary
}

cmd_login() {
  resolve_paths
  [[ -n $SVC_HOME ]] || die "User $SVC_USER does not exist; run install first"
  step_login
  if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    systemctl restart "$SERVICE"
    info "Restarted $SERVICE to pick up the new credentials"
  fi
}

cmd_claude() {
  resolve_paths
  [[ -n $CLAUDE_BIN ]] || die "Claude Code binary not found; run install first"
  local cwd
  cwd=$(env_get DEFAULT_CWD)
  AS_USER_CWD=${cwd:-$SVC_HOME} as_user "$CLAUDE_BIN" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} || exit $?
}

cmd_status() {
  systemctl status "$SERVICE" --no-pager -n 0 || true
  printf '\n%sRecent logs%s\n' "$BOLD" "$RESET"
  journalctl -q --no-pager -o short-iso -u "$SERVICE" -n 30 || true
}

cmd_logs() { exec journalctl -u "$SERVICE" -f -o cat; }

cmd_uninstall() {
  resolve_paths
  confirm "Stop and remove the $SERVICE service?" y || exit 0
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
  ok "Removed $SERVICE"
  if ((PURGE)); then
    if confirm "Delete $INSTALL_DIR including .env and bot state?" n || ((ASSUME_YES)); then
      rm -rf "$INSTALL_DIR"
      ok "Deleted $INSTALL_DIR"
    fi
  else
    info "Kept $INSTALL_DIR (add --purge to delete it)"
  fi
  info "Kept user $SVC_USER and ~$SVC_USER/.claude (sign-in and sessions). Remove with: userdel -r $SVC_USER"
}

main() {
  local -a original=("$@")
  while (($#)); do
    case $1 in
      install | check | update | login | status | logs | uninstall) CMD=$1 ;;
      claude) CMD=claude; shift; PASSTHROUGH=("$@"); break ;;
      --user) SVC_USER=${2:?--user needs a value}; shift ;;
      --dir) INSTALL_DIR=${2:?--dir needs a value}; shift ;;
      --service) SERVICE=${2:?--service needs a value}; shift ;;
      -y | --yes) ASSUME_YES=1 ;;
      --reconfigure) RECONFIGURE=1 ;;
      --no-live) LIVE=0 ;;
      --purge) PURGE=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "Unknown argument: $1 (see --help)" ;;
    esac
    shift
  done
  INSTALL_DIR=${INSTALL_DIR%/}

  if ((EUID != 0)); then
    have sudo || die "Run as root"
    exec sudo -E bash "$0" "${original[@]}"
  fi

  # Remember settings handed in through the environment, then drop them so
  # checks see exactly what the service will see.
  local key
  for key in "${ENV_KEYS[@]}"; do
    if [[ -n ${!key:-} ]]; then FROM_ENV[$key]=${!key}; fi
    unset "$key"
  done

  trap 'on_error $LINENO "$BASH_COMMAND"' ERR
  ENV_FILE=$INSTALL_DIR/.env

  case $CMD in
    install) cmd_install ;;
    update) cmd_update ;;
    check) cmd_check ;;
    login) cmd_login ;;
    claude) cmd_claude ;;
    status) cmd_status ;;
    logs) cmd_logs ;;
    uninstall) cmd_uninstall ;;
  esac
  exit $((FAIL > 0 ? 1 : 0))
}

# Sourcing the script (for tests) defines the functions without running anything.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
