#!/bin/sh
set -u

cd /workspace

STATE_FILE="${UPDATER_STATE_FILE:-/updater-data/state.json}"
LOG_FILE="${UPDATER_LOG_FILE:-/updater-data/deploy.log}"
BRANCH="${GIT_BRANCH:-master}"
HANDLED=0

REPO_UID="$(stat -c '%u' /workspace 2>/dev/null || echo 0)"
REPO_GID="$(stat -c '%g' /workspace 2>/dev/null || echo 0)"

restore_repo_ownership() {
  chown -R "$REPO_UID:$REPO_GID" /workspace 2>/dev/null || true
}

notify() {
  MESSAGE="$1"
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || return 0
  [ -n "${TELEGRAM_ALLOWED_USER_IDS:-}" ] || return 0

  OLD_IFS="$IFS"
  IFS=','
  for CHAT_ID in $TELEGRAM_ALLOWED_USER_IDS; do
    IFS="$OLD_IFS"
    CHAT_ID="$(printf '%s' "$CHAT_ID" | tr -d ' ')"
    [ -n "$CHAT_ID" ] || continue
    curl -fsS -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
      --data-urlencode "chat_id=$CHAT_ID" \
      --data-urlencode "text=$MESSAGE" >/dev/null 2>&1 || true
    IFS=','
  done
  IFS="$OLD_IFS"
}

bootstrap_failure() {
  CODE="$1"
  export TARGET_SHA="${TARGET_SHA:-}"
  printf '%s\n' "Bootstrap failed with exit code $CODE" >>"$LOG_FILE" 2>/dev/null || true
  /update-state.mjs failed 2>/dev/null || true
  notify "❌ Aggiornamento AdBlock fallito durante il bootstrap. Exit code: $CODE"
}

on_exit() {
  CODE="$?"
  restore_repo_ownership
  if [ "$CODE" -ne 0 ] && [ "$HANDLED" -eq 0 ]; then
    bootstrap_failure "$CODE"
  fi
}
trap on_exit EXIT INT TERM

mkdir -p "$(dirname "$STATE_FILE")"
: >"$LOG_FILE"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN is not configured" >>"$LOG_FILE"
  exit 2
fi

PREVIOUS_SHA="$(git -c safe.directory=/workspace rev-parse HEAD)" || exit 3
AUTH="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"

git -c safe.directory=/workspace \
  -c http.extraHeader="Authorization: Basic $AUTH" \
  -c credential.helper= \
  fetch origin "$BRANCH" >>"$LOG_FILE" 2>&1 || exit 4

TARGET_SHA="$(git -c safe.directory=/workspace rev-parse "origin/$BRANCH")" || exit 5
export PREVIOUS_SHA TARGET_SHA

git -c safe.directory=/workspace reset --hard "origin/$BRANCH" >>"$LOG_FILE" 2>&1 || exit 6

if [ ! -x /workspace/ops/deploy.sh ]; then
  echo "Fresh checkout does not contain executable ops/deploy.sh" >>"$LOG_FILE"
  exit 7
fi

set +e
/workspace/ops/deploy.sh
CODE="$?"
set -e
HANDLED=1
exit "$CODE"
