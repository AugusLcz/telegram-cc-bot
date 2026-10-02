#!/usr/bin/env bash
# tg-cc-bot: one-step deployment with built-in self-checks (Linux + systemd).
#
#   sudo ./deploy/deploy.sh [command] [options]
#
# Prerequisites (once, as the account that will run the bot; usually your own):
#   1. Claude Code installed:   curl -fsSL https://claude.ai/install.sh | bash
#   2. Signed in:               claude   (then /login; over SSH open the link anywhere, paste the code back)
#      or headless:             claude setup-token, then pass CLAUDE_CODE_OAUTH_TOKEN=<token> to this script
#   3. A Telegram bot token with Threaded Mode enabled in @BotFather
# The script checks these first and stops with instructions if one is missing.
#
# Commands
#   install     (default) Check prerequisites, install or upgrade, configure, start, then verify
#   check       Read-only health check of an existing deployment
#   update      Copy code from this checkout, reinstall dependencies, restart, verify
#   claude ...  Run Claude Code as the service user (e.g. `claude mcp list`)
#   status      Service status and recent logs
#   logs        Follow the service logs
#   uninstall   Stop and remove the service (--purge also deletes the install directory)
#
# Options
#   --user NAME      Account that runs the bot     (default: the account that ran sudo,
#                                                  or the one an existing install uses)
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
SVC_USER=''
CLAUDE_CLI=''
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
die()     { printf '\n%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; stopped_note; exit 1; }

# The install stops a running bot first; say so whenever it ends early.
STOPPED_SERVICE=0
stopped_note() {
  if ((STOPPED_SERVICE)); then
    printf '  %s was running before and is still stopped. Start it again: sudo systemctl start %s\n' "$SERVICE" "$SERVICE" >&2
  fi
}

on_error() {
  printf '\n%s✗ Unexpected error at line %s: %s%s\n' "$RED" "$1" "$2" "$RESET" >&2
  printf '  Run "sudo %s check" to diagnose, or "bash -x %s" to trace.\n' "$0" "$0" >&2
  stopped_note
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
#   AS_USER_TIMEOUT  seconds before the command is stopped (killed 5 s later if needed)
#   AS_USER_QUIET    set: Claude Code skips auto-update and other background traffic
as_user() {
  local path="$SVC_HOME/.bun/bin:$SVC_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  local -a vars=(HOME="$SVC_HOME" USER="$SVC_USER" LOGNAME="$SVC_USER" SHELL=/bin/bash PATH="$path"
    LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}")
  local v
  for v in CLAUDE_CODE_OAUTH_TOKEN HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
    if [[ -n ${!v:-} ]]; then vars+=("$v=${!v}"); fi
  done
  if [[ -n ${AS_USER_QUIET:-} ]]; then vars+=(DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1); fi
  local -a pre=()
  if [[ -n ${AS_USER_TIMEOUT:-} ]]; then pre=(timeout -k 5 "$AS_USER_TIMEOUT"); fi
  (
    cd "${AS_USER_CWD:-$SVC_HOME}" 2>/dev/null || cd /
    exec env -i "${vars[@]}" ${pre[@]+"${pre[@]}"} runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" PATH="$path" "$@"
  )
}

# user_run [-q] SECS CMD...: run CMD as the service user, non-interactively, with a hard
# time limit, and print its output (-q: stdout only). Returns CMD's status (124: timed out).
# Output goes through a temp file and only the direct child is awaited, so helper
# processes a command leaves behind (an auto-updater, say) can never block the script.
user_run() {
  local quiet_err=0 secs out rc=0
  if [[ $1 == -q ]]; then quiet_err=1; shift; fi
  secs=$1
  shift
  out=$(mktemp)
  if ((quiet_err)); then
    AS_USER_QUIET=1 AS_USER_TIMEOUT=$secs as_user "$@" </dev/null >"$out" 2>/dev/null &
  else
    AS_USER_QUIET=1 AS_USER_TIMEOUT=$secs as_user "$@" </dev/null >"$out" 2>&1 &
  fi
  wait $! || rc=$?
  cat "$out"
  rm -f "$out"
  return "$rc"
}

# Telegram Bot API call. The token travels via curl's stdin config, not argv.
tg_api() { # METHOD [query-string] [max-seconds]
  printf 'url = "https://api.telegram.org/bot%s/%s%s"\n' "$TG_TOKEN" "$1" "${2:+?$2}" |
    curl -sS --max-time "${3:-20}" -K - 2>&1 || true
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
  v=$(user_run -q 30 "$BUN" --version | head -n1 || true)
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
    if AS_USER_CWD=$INSTALL_DIR user_run 60 "$BUN" -e "$probe" >/dev/null; then
      ok "Modules load under Bun"
    else
      bad "Modules fail to load under Bun"
      # Never suggest `bun src/index.ts` here: that starts a second bot next to the service (409 Conflict).
      hint "See the error with: cd $INSTALL_DIR && sudo -u $SVC_USER $BUN -e 'await import(\"./src/app/bot.ts\")'"
    fi
  fi

  if [[ -z $CLAUDE_BIN ]]; then
    bad "Claude Code binary not found (the Agent SDK's platform package is missing)"
    hint "Reinstall dependencies: sudo $0 update"
    return 0
  fi
  local v
  v=$(user_run -q 30 "$CLAUDE_BIN" --version | head -n1 || true)
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
      ok "Users may open new chats (each new chat is a Claude session)"
    else
      warn "Users cannot open new chats themselves, so they cannot start new sessions"
      hint "@BotFather → your bot → Bot Settings → Threaded Mode: allow users to create topics"
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
  report_local_pollers bad || true

  # Only when the bot is down: a test poll next to a running bot would itself cause a 409 there.
  local state rc=0
  state=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
  case $state in
    active | activating | reloading | deactivating) ;;
    *)
      info "$SERVICE is ${state:-not installed}: asking Telegram whether anything polls @$BOT_USERNAME (up to ${POLL_PROBE_SECS}s)…"
      probe_pollers || rc=$?
      case $rc in
        0) ok "Nothing polls @$BOT_USERNAME" ;;
        1) bad "Another client polls @$BOT_USERNAME: $PROBE_EVIDENCE" ;;
        *) warn "Could not check: $PROBE_EVIDENCE" ;;
      esac
      ;;
  esac
}

# Print local processes (as LEVEL: bad or warn) and config files using the bot token.
# Returns 1 when a running process was found.
report_local_pollers() {
  local level=$1 found line
  found=$(local_pollers)
  if grep -q '^pid ' <<<"$found"; then
    "$level" "Other processes on this machine use this bot token; Telegram lets only one client poll:"
    while IFS= read -r line; do hint "$line"; done <<<"$found"
    return 1
  elif [[ -n $found ]]; then
    warn "Not running, but these would compete for the bot's messages when started:"
    while IFS= read -r line; do hint "$line"; done <<<"$found"
  else
    ok "No other process on this machine uses this bot token (environment, command line, working-directory .env)"
  fi
}

check_claude_auth() {
  section "Claude sign-in"
  if [[ -z $CLAUDE_BIN ]]; then bad "Skipped: Claude Code binary not found"; return 0; fi
  local out rc=0
  out=$(user_run 30 "$CLAUDE_BIN" auth status) || rc=$?
  if ((rc == 124)); then
    bad "\`claude auth status\` did not answer within 30 s"
    hint "Run it yourself to see what it waits for: sudo -iu $SVC_USER claude auth status"
    return 0
  fi
  if ((rc == 0)); then
    local method email
    method=$(json_str "$out" authMethod)
    email=$(json_str "$out" email)
    ok "Signed in${method:+ ($method)}${email:+ as $email}"
    if [[ $method == oauth_token ]]; then info "Using CLAUDE_CODE_OAUTH_TOKEN from .env (only the live test proves it is valid)"; fi
  else
    local text
    text=$(user_run 30 "$CLAUDE_BIN" auth status --text || true)
    if grep -qi expired <<<"$text"; then bad "Claude login expired"; else bad "Not signed in to Claude"; fi
    hint "Sign in again as $SVC_USER: sudo -iu $SVC_USER claude, then /login (or set CLAUDE_CODE_OAUTH_TOKEN)"
    return 0
  fi

  if ((LIVE == 0)); then info "Live test skipped (--no-live)"; return 0; fi
  info "Live test: one tiny Haiku request…"
  live_probe
}

live_probe() {
  local out rc=0
  local -a args=(-p "Reply with exactly the word OK" --model haiku --tools "" --output-format json --no-session-persistence)
  out=$(user_run 120 "$CLAUDE_BIN" --safe-mode "${args[@]}") || rc=$?
  if [[ $out == *"unknown option"* ]]; then
    rc=0
    out=$(user_run 120 "$CLAUDE_BIN" "${args[@]}") || rc=$?
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
      *xpired* | *uthenticat* | *login* | *401*) hint "Sign in again as $SVC_USER: sudo -iu $SVC_USER claude, then /login" ;;
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

# The service's log lines since this script (re)started it, so older runs can't
# mislead the diagnosis; without a restart, the last 200 lines.
RUN_SINCE=''
run_logs() {
  if [[ -n $RUN_SINCE ]]; then journalctl -q --no-pager -o cat -u "$SERVICE" --since "@$RUN_SINCE" 2>/dev/null || true
  else journalctl -q --no-pager -o cat -u "$SERVICE" -n 200 2>/dev/null || true; fi
}

# This script and the sudo/shell chain that started it: they may carry the token in
# their environment, but never poll. (Its own helpers share its process group.)
own_ancestors() {
  local pid=$$
  while [[ -n $pid ]] && ((pid > 1)); do
    echo "$pid"
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  done
}

# PID → its systemd cgroup ('' when unknown): tells how the process was started.
cgroup_of() { sed -n 's/^0:://p; s/^[0-9]*:name=systemd://p' "/proc/$1/cgroup" 2>/dev/null | head -n1 || true; }

describe_cgroup() {
  local cg=$1 x
  case $cg in
    */session-*.scope*) x=${cg##*/session-}; printf 'started from login session %s (a terminal or SSH shell)' "${x%%.scope*}" ;;
    */docker-*.scope* | */docker/*) x=${cg##*docker[-/]}; printf 'Docker container %s' "${x:0:12}" ;;
    */user@*.service/*) printf 'user systemd unit %s' "${cg##*/}" ;;
    /system.slice/*.service*) x=${cg#/system.slice/}; printf 'systemd unit %s' "${x%%/*}" ;;
    '') printf 'started by an unknown parent' ;;
    *) printf 'cgroup %s' "$cg" ;;
  esac
}

# Does /proc/PID hold the token: in its environment, its command line, or a .env in its
# working directory (how `bun src/index.ts` and most bots read it, invisible in environ)?
holds_token() {
  local d=$1 comm=''
  { IFS= read -r comm <"$d/comm"; } 2>/dev/null || true
  case $comm in # shells and terminals carry exported variables but never poll
    bash | sh | dash | zsh | fish | sudo | su | login | sshd | tmux* | screen | less | more | vi | vim | nano | '') return 1 ;;
  esac
  grep -qsaF -f <(printf '%s\n' "$TG_TOKEN") "$d/environ" "$d/cmdline" && return 0
  [[ -f $d/cwd/.env ]] && grep -qsF -f <(printf '%s\n' "$TG_TOKEN") "$d/cwd/.env"
}

# Every process on this machine except the service ($SERVICE and its Claude sessions)
# that uses this bot's token, one line each: pid, account, start time, how it was started,
# working directory and command. Then known config files holding the token.
# The token reaches grep through a file descriptor, never a command line.
local_pollers() {
  [[ -n $TG_TOKEN ]] || return 0
  local mine pgid g d pid cg user start cwd cmd
  mine=" $(own_ancestors | tr '\n' ' ') "
  pgid=$(ps -o pgid= -p $$ | tr -d ' ')
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [[ $mine == *" $pid "* ]] && continue
    holds_token "$d" || continue
    g=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    [[ -z $g || $g == "$pgid" ]] && continue # gone, or one of this script's own helpers
    cg=$(cgroup_of "$pid")
    [[ $cg == "/system.slice/$SERVICE.service" || $cg == "/system.slice/$SERVICE.service/"* ]] && continue
    user=$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    start=$(ps -o lstart= -p "$pid" 2>/dev/null || true)
    cwd=$(readlink "$d/cwd" 2>/dev/null || true)
    cmd=$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null || true)
    cmd=${cmd//"$TG_TOKEN"/<bot token>}
    printf 'pid %s (%s, since %s), %s, in %s: %s\n' "$pid" "${user:-?}" "${start:-?}" "$(describe_cgroup "$cg")" "${cwd:-?}" "${cmd:0:160}"
  done
  local dirs=()
  for d in /root/.openclaw /home/*/.openclaw /root/.claude/channels /home/*/.claude/channels; do
    if [[ -d $d ]]; then dirs+=("$d"); fi
  done
  if ((${#dirs[@]})); then
    grep -rlsF -f <(printf '%s\n' "$TG_TOKEN") "${dirs[@]}" 2>/dev/null | sed 's/^/config file with this token: /' || true
  fi
}

# With tg-cc-bot stopped, does anything still poll this bot? Telegram ends a waiting
# getUpdates with 409 as soon as another client asks for updates, and pollers ask again
# at least every ~30 s, so holding one open for POLL_PROBE_SECS either catches a second
# poller or rules one out. No offset is sent, so no message is consumed here.
# Returns 0 (nothing else polls), 1 (something does; PROBE_EVIDENCE says how we know)
# or 2 (Telegram did not answer).
POLL_PROBE_SECS=40
PROBE_EVIDENCE=''
probe_pollers() {
  local start=$SECONDS left body first='' now
  while :; do
    left=$((POLL_PROBE_SECS - (SECONDS - start)))
    ((left > 0)) || return 0
    body=$(tg_api getUpdates "timeout=$left&limit=1" $((left + 15)))
    case $body in
      *'"error_code":409'*webhook*)
        PROBE_EVIDENCE="a webhook is set for this bot, so Telegram sends its messages there instead"
        return 1
        ;;
      *'"error_code":409'*)
        PROBE_EVIDENCE="Telegram cut off a test request after $((SECONDS - start))s with 409 Conflict: another client asked for this bot's updates while $SERVICE was stopped"
        return 1
        ;;
      *'"ok":true,"result":[]'*) ;;
      *'"ok":true'*)
        # Messages are waiting. Another poller would take and confirm them within seconds.
        now=$(grep -o '"update_id":[0-9]*' <<<"$body" | head -n1 | cut -d: -f2)
        if [[ -z $first ]]; then
          first=$now
        elif [[ $now != "$first" ]]; then
          PROBE_EVIDENCE="another client received and confirmed update $first while $SERVICE was stopped"
          return 1
        fi
        sleep 2
        ;;
      *)
        PROBE_EVIDENCE="Telegram did not answer the test request: ${body:0:160}"
        return 2
        ;;
    esac
  done
}

# After a 409 in the bot's log: name local processes using the token, if any.
explain_conflict() {
  local found line
  found=$(local_pollers)
  if [[ -n $found ]]; then
    hint "These use the same bot token on this machine (only one client may poll):"
    while IFS= read -r line; do hint "  $line"; done <<<"$found"
  else
    hint "No other process here has the token in its environment, command line or working-directory .env"
    hint "Run \`sudo $0 install\` again: it stops $SERVICE first and asks Telegram whether anything else still polls"
  fi
}

# Print hints for known failure signatures in the bot's logs.
explain_logs() {
  local logs=$1
  if [[ $logs == *"401: Unauthorized"* ]]; then hint "Telegram rejected the bot token: update TELEGRAM_BOT_TOKEN"; fi
  if [[ $logs == *"409: Conflict"* || $logs == *"409 Conflict"* ]]; then
    hint "Telegram answered 409 Conflict: another client asked for this bot's updates at the same time"
    explain_conflict
  fi
  if [[ $logs == *"already polls this bot on this machine"* ]]; then
    hint "A second copy of tg-cc-bot runs on this machine (its pid is in the log line); stop it: only one may poll"
  fi
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
    ok "Running since ${since:-unknown} (pid $(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo ?))"
  else
    bad "Service is ${state:-unknown}"
    explain_logs "$(run_logs)"
    hint "Logs: journalctl -u $SERVICE -n 50"
    return 0
  fi

  if ((restarts > 0)); then
    warn "Restarted $restarts time(s) since the unit was started"
    explain_logs "$(run_logs)"
  fi

  if grep -qE '409:? Conflict' <<<"$logs"; then
    bad "Telegram answered 409 Conflict in this run: another client polls this bot token, so the two split its messages"
    explain_conflict
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

# The service user's own Claude Code install (any install method), if any.
find_user_claude() {
  local p
  for p in "$SVC_HOME/.local/bin/claude" "$SVC_HOME/.claude/local/claude" "$SVC_HOME/.npm-global/bin/claude"; do
    if [[ -x $p ]]; then printf '%s' "$p"; return 0; fi
  done
  p=$(user_run -q 15 bash -lc 'command -v claude' | tail -n1 || true)
  if [[ $p == /* && -x $p ]]; then printf '%s' "$p"; fi
}

# Is the service user signed in to Claude (with the given claude binary)?
# Returns 0 signed in, 1 not signed in, 2 Claude Code did not answer in time.
SIGNIN_METHOD=''
user_signed_in() {
  local out rc=0
  out=$(user_run 30 "$1" auth status) || rc=$?
  if ((rc == 124)); then return 2; fi
  if ((rc == 0)); then
    SIGNIN_METHOD=$(json_str "$out" authMethod)
    return 0
  fi
  # Older Claude Code without `auth status`: accept a stored login or a token; the live test decides.
  if grep -qiE "unknown (command|option)|did you mean" <<<"$out"; then
    if [[ -n ${CLAUDE_CODE_OAUTH_TOKEN:-} || -s $SVC_HOME/.claude/.credentials.json ]]; then
      SIGNIN_METHOD=stored
      return 0
    fi
  fi
  return 1
}

# Stop with the exact steps to satisfy the Claude prerequisite.
prereq_fail() {
  bad "$1"
  local as=""
  if [[ $SVC_USER != "${SUDO_USER:-}" ]]; then as="sudo -iu $SVC_USER    # switch to the account that runs the bot\n     "; fi
  printf '\n  %sDo this once, then run the script again:%s\n' "$BOLD" "$RESET"
  printf "     ${as}curl -fsSL https://claude.ai/install.sh | bash    # skip if claude is installed\n"
  printf '     claude          # sign in with /login (over SSH: open the link on any device, paste the code back)\n'
  printf '\n  %sHeadless alternative:%s run `claude setup-token` anywhere, then\n' "$BOLD" "$RESET"
  printf '     sudo CLAUDE_CODE_OAUTH_TOKEN=<token> bash %s\n\n' "$SCRIPT_DIR/deploy.sh"
  stopped_note
  exit 1
}

step_prerequisites() {
  section "Prerequisites"
  resolve_paths
  if [[ -z $SVC_HOME ]]; then
    die "Account '$SVC_USER' does not exist. Create it, install Claude Code and sign in as it, or run this script with sudo from your own account."
  fi
  ok "Bot runs as '$SVC_USER' (home $SVC_HOME)"
  if [[ $SVC_USER == root ]]; then warn "Running Claude Code as root gives it full control of this machine; prefer a normal account (--user)"; fi

  CLAUDE_CLI=$(find_user_claude)
  [[ -n $CLAUDE_CLI ]] || prereq_fail "Claude Code is not installed for '$SVC_USER'"
  local v
  info "Asking Claude Code for its version…"
  v=$(user_run -q 30 "$CLAUDE_CLI" --version | head -n1 || true)
  [[ -n $v ]] || prereq_fail "Claude Code at $CLAUDE_CLI does not run for '$SVC_USER'"
  ok "Claude Code $v ($CLAUDE_CLI)"

  # A token handed in through the environment counts as signed in (it is saved to .env later).
  if [[ -n ${FROM_ENV[CLAUDE_CODE_OAUTH_TOKEN]:-} ]]; then export CLAUDE_CODE_OAUTH_TOKEN=${FROM_ENV[CLAUDE_CODE_OAUTH_TOKEN]}; fi
  info "Checking the Claude sign-in (claude auth status)…"
  local signed=0
  user_signed_in "$CLAUDE_CLI" || signed=$?
  if ((signed == 0)); then
    ok "Signed in to Claude${SIGNIN_METHOD:+ ($SIGNIN_METHOD)}; the bot shares this login"
  elif ((signed == 2)); then
    die "\`claude auth status\` did not answer within 30 s for '$SVC_USER'. Run it yourself to see what it waits for: sudo -iu $SVC_USER claude auth status"
  else
    local text
    text=$(user_run 30 "$CLAUDE_CLI" auth status --text || true)
    if grep -qi expired <<<"$text"; then prereq_fail "The Claude login of '$SVC_USER' has expired"; fi
    prereq_fail "'$SVC_USER' is not signed in to Claude"
  fi
}

step_bun() {
  section "Bun runtime"
  local v=''
  if [[ -x $BUN ]]; then v=$(user_run -q 30 "$BUN" --version | head -n1 || true); fi
  if [[ -n $v ]] && ver_ge "$v" "$MIN_BUN"; then
    ok "Bun $v already installed"
    return 0
  fi
  info "Installing Bun for $SVC_USER…"
  user_run 300 bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null || die "Bun installation failed"
  v=$(user_run -q 30 "$BUN" --version | head -n1 || true)
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
  if ! out=$(AS_USER_CWD=$INSTALL_DIR user_run 900 "$BUN" install --production); then
    printf '%s\n' "$out" | tail -n 20
    die "bun install failed"
  fi
  ok "Dependencies installed"
  resolve_paths
  [[ -n $CLAUDE_BIN ]] || die "Claude Code binary missing after install (the SDK's platform package was not installed)"
  ok "Claude Code $(user_run -q 30 "$CLAUDE_BIN" --version | head -n1 || true)"
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
  RUN_SINCE=$(date +%s)
  systemctl restart "$SERVICE"
  STOPPED_SERVICE=0
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
      run_logs | tail -n 15 | sed 's/^/      /' || true
      explain_logs "$(run_logs)"
      return 0
    fi
    logs=$(service_logs)
    if grep -qE '409:? Conflict' <<<"$logs"; then
      bad "Telegram answered 409 Conflict right after the start: another client polls this bot"
      explain_conflict
      return 0
    fi
    if grep -q ' polling ' <<<"$logs" && grep -qE 'Claude Code ready|warm-up failed' <<<"$logs"; then
      ok "Bot is up: $(grep ' polling ' <<<"$logs" | tail -n1)"
      return 0
    fi
  done
  warn "Bot did not report ready within $1s (it may still be starting)"
}

# Stop the bot before anything else: until the new version starts, nothing of this
# install talks to Telegram, so a reply that arrives meanwhile cannot come from it.
# "activating" covers a unit waiting to auto-restart after a crash.
stop_service_if_running() {
  local state pid since
  state=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
  case $state in
    active | activating | reloading | deactivating)
      pid=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)
      since=$(systemctl show -p ActiveEnterTimestamp --value "$SERVICE" 2>/dev/null || true)
      systemctl stop "$SERVICE"
      STOPPED_SERVICE=1
      [[ $pid == 0 ]] && pid=''
      info "Stopped the running $SERVICE ($state${pid:+, pid $pid}${since:+, up since $since}); it starts again at the end"
      ;;
  esac
}

# Before the service starts: make sure it will be the only client polling the bot.
step_single_poller() {
  section "Telegram polling"
  [[ -n $TG_TOKEN ]] || return 0
  if [[ -z $BOT_USERNAME ]]; then BOT_USERNAME=$(json_str "$(tg_api getMe)" username); fi
  local bot="@${BOT_USERNAME:-bot}" hook
  hook=$(json_str "$(tg_api getWebhookInfo)" url)
  if [[ -n $hook ]]; then
    warn "A webhook is set for $bot ($hook): Telegram delivers its messages there, so polling gets none"
    confirm "Remove the webhook so $SERVICE receives the messages?" y || die "Remove the webhook or use another bot token, then re-run"
    tg_api deleteWebhook >/dev/null
    ok "Webhook removed"
  fi

  if ! report_local_pollers bad; then
    stop_local_pollers "$(local_pollers)" || die "Not started: stop the processes above (or give $SERVICE its own bot token), then re-run"
  fi

  info "Asking Telegram whether anything else polls $bot while $SERVICE is stopped (up to ${POLL_PROBE_SECS}s)…"
  local rc=0
  probe_pollers || rc=$?
  case $rc in
    0) ok "Nothing else polled $bot in ${POLL_PROBE_SECS}s" ;;
    1)
      bad "Another client polls $bot: $PROBE_EVIDENCE"
      hint "It is none of this machine's processes with the token in their environment, command line or working-directory .env"
      hint "Stop it wherever it runs, or create a separate bot for $SERVICE in @BotFather"
      confirm "Start $SERVICE anyway (the two will split $bot's messages)?" n || die "Not started: another client polls $bot"
      ;;
    *) warn "Could not check: $PROBE_EVIDENCE" ;;
  esac
}

# Offer to stop local processes that use the bot token (from local_pollers).
# Returns 1 when any remain.
stop_local_pollers() {
  local line pid pids=() managed=0
  while IFS= read -r line; do
    [[ $line == 'pid '* ]] || continue
    pid=${line#pid }
    pid=${pid%% *}
    case $line in
      *', systemd unit '* | *', user systemd unit '* | *', Docker container '*) managed=1 ;;
      *) pids+=("$pid") ;;
    esac
  done <<<"$1"
  if ((managed)); then
    hint "Stop the ones run by systemd or Docker with systemctl stop / docker stop, or they come back"
    return 1
  fi
  ((${#pids[@]})) || return 0
  if ! is_interactive || ! confirm "Stop pid ${pids[*]} now?" y; then return 1; fi
  kill -TERM "${pids[@]}" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "${pids[@]}" 2>/dev/null || break
    sleep 1
  done
  kill -KILL "${pids[@]}" 2>/dev/null || true
  ok "Stopped pid ${pids[*]}"
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
  stop_service_if_running
  step_prerequisites
  step_bun
  step_code
  step_config
  step_single_poller
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
  step_single_poller
  step_service
  self_check
}

cmd_check() {
  printf '%sChecking tg-cc-bot%s in %s (user %s, service %s)\n' "$BOLD" "$RESET" "$INSTALL_DIR" "$SVC_USER" "$SERVICE"
  run_all_checks
  summary
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
  info "Kept $SVC_USER's Claude Code install, sign-in and sessions (~$SVC_USER/.claude)"
}

main() {
  local -a original=("$@")
  while (($#)); do
    case $1 in
      install | check | update | status | logs | uninstall) CMD=$1 ;;
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

  # Which account runs the bot: --user, else the one an existing install uses, else whoever ran sudo.
  if [[ -z $SVC_USER && -f /etc/systemd/system/$SERVICE.service ]]; then
    SVC_USER=$(sed -n 's/^User=//p' "/etc/systemd/system/$SERVICE.service" | head -n1)
  fi
  SVC_USER=${SVC_USER:-${SUDO_USER:-}}
  [[ -n $SVC_USER ]] || die "Run this with sudo from the account that has Claude Code signed in, or pass --user NAME"

  case $CMD in
    install) cmd_install ;;
    update) cmd_update ;;
    check) cmd_check ;;
    claude) cmd_claude ;;
    status) cmd_status ;;
    logs) cmd_logs ;;
    uninstall) cmd_uninstall ;;
  esac
  exit $((FAIL > 0 ? 1 : 0))
}

# Sourcing the script (for tests) defines the functions without running anything.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
