#!/usr/bin/env bash
# deploy.sh: where settings come from (the service's .env, the checkout's .env,
# the environment), which one wins, and that tokens are shown only by bot ID.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

OLD=111111111:AAoldoldoldoldoldoldoldoldoldoldold1
NEW=222222222:AAnewnewnewnewnewnewnewnewnewnewnew2
w=$(mktemp -d)
SRC_DIR=$w/checkout
mkdir -p "$SRC_DIR"
ENV_FILE=$w/install.env
printf 'TELEGRAM_BOT_TOKEN=%s\nALLOWED_USER_IDS=42\nDEFAULT_CWD=/srv\n' "$OLD" >"$ENV_FILE"
printf '# comment\nTELEGRAM_BOT_TOKEN="%s"\nALLOWED_USER_IDS=42\nMAX_LIVE_SESSIONS=5\n#DEFAULT_CWD=/x\n' "$NEW" >"$SRC_DIR/.env"

check "a token is shown by its bot ID" '[[ $(show_value TELEGRAM_BOT_TOKEN "$NEW") == "bot 222222222" ]]'
check "other secrets are masked" '[[ $(show_value CLAUDE_CODE_OAUTH_TOKEN sk-ant-abcdef1234) == "…1234" ]]'
check "env_get reads another file" '[[ $(env_get TELEGRAM_BOT_TOKEN "$SRC_DIR/.env") == "$NEW" ]]'

p=$(pending_settings)
check "a different token in the checkout is pending" '[[ $p == *"TELEGRAM_BOT_TOKEN	$SRC_DIR/.env	$NEW"* ]]'
check "a new key in the checkout is pending" '[[ $p == *"MAX_LIVE_SESSIONS	$SRC_DIR/.env	5"* ]]'
check "equal and commented-out keys are not" '[[ $p != *ALLOWED_USER_IDS* && $p != *DEFAULT_CWD* ]]'

ASSUME_YES=1
out=$(apply_overrides 2>&1)
check "non-interactive runs don't copy from the checkout" '[[ $(env_get TELEGRAM_BOT_TOKEN) == "$OLD" ]]'
check "the difference is shown by bot IDs" '[[ $out == *"bot 111111111 → bot 222222222"* ]]'
check "no token is printed" '[[ $out != *"$NEW"* && $out != *"$OLD"* ]]'

touch -d '2026-01-01' "$SRC_DIR/.env"
touch -d '2026-02-01' "$ENV_FILE"
out=$(apply_overrides 2>&1)
check "an older checkout .env suggests keeping the service's" '[[ $out == *"changed more recently"* ]]'
touch -d '2026-03-01' "$SRC_DIR/.env"
out=$(apply_overrides 2>&1)
check "a newer checkout .env suggests copying" '[[ $out != *"changed more recently"* ]]'

FROM_ENV[TELEGRAM_BOT_TOKEN]=$NEW
out=$(apply_overrides 2>&1)
check "the environment is applied without asking" '[[ $(env_get TELEGRAM_BOT_TOKEN) == "$NEW" ]]'
check "and reported by bot ID" '[[ $out == *"TELEGRAM_BOT_TOKEN set from the environment (bot 222222222)"* ]]'
p=$(pending_settings)
check "then nothing is pending for it" '[[ $p != *TELEGRAM_BOT_TOKEN* ]]'
unset 'FROM_ENV[TELEGRAM_BOT_TOKEN]'

cp "$SRC_DIR/.env" "$ENV_FILE"
ENV_FILE=$SRC_DIR/.env
p=$(pending_settings)
check "running from the install directory compares nothing" '[[ -z $p ]]'

TG_TOKEN=$NEW
tg_api() { printf '{"ok":true,"result":{"id":222222222,"username":"new_bot","has_topics_enabled":true}}'; }
out=$(verify_token)
check "verify_token names the bot and the file" '[[ $out == *"@new_bot (bot 222222222, saved in $ENV_FILE)"* ]]'
tg_api() { printf '{"ok":false,"error_code":401,"description":"Unauthorized"}'; }
out=$( (verify_token) 2>&1)
rc=$?
check "a rejected token stops the script without printing it" '((rc == 1)) && [[ $out == *"rejected the bot token (bot 222222222)"* && $out != *"$NEW"* ]]'

rm -rf "$w"
finish
