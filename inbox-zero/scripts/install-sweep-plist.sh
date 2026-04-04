#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

TEMPLATE_PATH="${PROJECT_DIR}/com.house-keeping.inbox-zero-sweep.example.plist"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-${HOME}/Library/LaunchAgents}"
LOG_DIR_DEFAULT="${HOME}/Library/Logs/house-keeping/inbox-zero"
SHARED_LOG_PATH="${INBOX_ZERO_SWEEP_LOG_PATH:-}"
STDOUT_LOG_PATH="${INBOX_ZERO_SWEEP_STDOUT_LOG_PATH:-${SHARED_LOG_PATH:-${LOG_DIR_DEFAULT}/sweep.out.log}}"
STDERR_LOG_PATH="${INBOX_ZERO_SWEEP_STDERR_LOG_PATH:-${SHARED_LOG_PATH:-${LOG_DIR_DEFAULT}/sweep.err.log}}"
PLIST_DEST="${LAUNCH_AGENTS_DIR}/com.house-keeping.inbox-zero-sweep.plist"
SERVICE_ACCOUNT_KEY_PATH="${GOOGLE_SERVICE_ACCOUNT_KEY:-.secrets/service-account.json}"
GMAIL_USER_VALUE="${GMAIL_USER:-}"

resolve_path() {
  local input_path="$1"
  if [[ "${input_path}" == /* ]]; then
    printf '%s\n' "${input_path}"
  else
    printf '%s/%s\n' "${PROJECT_DIR}" "${input_path}"
  fi
}

usage() {
  cat <<'EOF'
Usage:
  GMAIL_USER=you@example.com bash scripts/install-sweep-plist.sh

Optional environment variables:
  GOOGLE_SERVICE_ACCOUNT_KEY   Defaults to .secrets/service-account.json
  LAUNCH_AGENTS_DIR            Defaults to ~/Library/LaunchAgents
  INBOX_ZERO_SWEEP_LOG_PATH    Sets a shared stdout/stderr log file
  INBOX_ZERO_SWEEP_STDOUT_LOG_PATH
                               Defaults to ~/Library/Logs/house-keeping/inbox-zero/sweep.out.log
  INBOX_ZERO_SWEEP_STDERR_LOG_PATH
                               Defaults to ~/Library/Logs/house-keeping/inbox-zero/sweep.err.log
EOF
}

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${GMAIL_USER_VALUE}" ]]; then
  echo "GMAIL_USER is required." >&2
  usage >&2
  exit 1
fi

if [[ ! -f "${TEMPLATE_PATH}" ]]; then
  echo "Missing plist template: ${TEMPLATE_PATH}" >&2
  exit 1
fi

SERVICE_ACCOUNT_KEY_PATH="$(resolve_path "${SERVICE_ACCOUNT_KEY_PATH}")"
STDOUT_LOG_PATH="$(resolve_path "${STDOUT_LOG_PATH}")"
STDERR_LOG_PATH="$(resolve_path "${STDERR_LOG_PATH}")"

if [[ ! -f "${SERVICE_ACCOUNT_KEY_PATH}" || ! -r "${SERVICE_ACCOUNT_KEY_PATH}" ]]; then
  echo "Missing or unreadable service account key: ${SERVICE_ACCOUNT_KEY_PATH}" >&2
  exit 1
fi

mkdir -p "${LAUNCH_AGENTS_DIR}"
for log_dir in "$(dirname -- "${STDOUT_LOG_PATH}")" "$(dirname -- "${STDERR_LOG_PATH}")"; do
  mkdir -p "${log_dir}"
  chmod 700 "${log_dir}"
done

touch "${STDOUT_LOG_PATH}" "${STDERR_LOG_PATH}"
chmod 600 "${STDOUT_LOG_PATH}" "${STDERR_LOG_PATH}"

escaped_project_dir="${PROJECT_DIR//\//\\/}"
escaped_gmail_user="${GMAIL_USER_VALUE//\//\\/}"
escaped_service_account_key="${SERVICE_ACCOUNT_KEY_PATH//\//\\/}"
escaped_stdout_log_path="${STDOUT_LOG_PATH//\//\\/}"
escaped_stderr_log_path="${STDERR_LOG_PATH//\//\\/}"

sed \
  -e "s/__PROJECT_DIR__/${escaped_project_dir}/g" \
  -e "s/__GMAIL_USER__/${escaped_gmail_user}/g" \
  -e "s/__GOOGLE_SERVICE_ACCOUNT_KEY__/${escaped_service_account_key}/g" \
  -e "s/__STDOUT_LOG_PATH__/${escaped_stdout_log_path}/g" \
  -e "s/__STDERR_LOG_PATH__/${escaped_stderr_log_path}/g" \
  "${TEMPLATE_PATH}" > "${PLIST_DEST}"

cat <<EOF
Wrote ${PLIST_DEST}

Next steps:
  launchctl unload ${PLIST_DEST} 2>/dev/null || true
  launchctl load ${PLIST_DEST}
  tail -f ${STDOUT_LOG_PATH}
EOF
