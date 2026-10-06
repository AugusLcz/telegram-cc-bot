#!/usr/bin/env bash
# Run every deploy/test/*.test.sh. Linux only (they read /proc); run as root to
# match how deploy.sh runs: sudo bash deploy/test/run.sh
set -uo pipefail
cd "$(dirname "$0")"
if [[ $(uname -s) != Linux ]]; then
  echo "deploy tests need Linux (use WSL on Windows)" >&2
  exit 2
fi
failed=0
for t in ./*.test.sh; do
  echo "== ${t#./}"
  out=$(bash "$t" 2>&1)
  rc=$?
  grep -v '^PASS ' <<<"$out" || true # failures and totals only
  ((rc == 0)) || failed=1
done
exit "$failed"
