#!/usr/bin/env bash
# Shared by deploy/test/*.test.sh: loads deploy.sh's functions (sourcing runs nothing)
# and provides check / finish. Linux only: the tests read /proc.

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../deploy.sh
source "$TEST_DIR/../deploy.sh"
set +e # deploy.sh turns on errexit; a failing check must not end the run

PASS_COUNT=0
FAIL_COUNT=0

# check NAME EXPRESSION: evaluate EXPRESSION, record the result under NAME.
check() {
  if eval "$2"; then
    echo "PASS $1"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL $1"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# finish: print the totals; the exit status says whether everything passed.
finish() {
  echo "passed $PASS_COUNT, failed $FAIL_COUNT"
  ((FAIL_COUNT == 0))
}
