#!/usr/bin/env bash
# Apply and validate the Chat database boundary against the explicitly approved
# local runtime database. This wrapper never stores or prints database secrets.

if [[ "$-" == *x* ]]; then
  set +x
  echo "FAIL: do not run this script with shell xtrace enabled" >&2
  exit 64
fi
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHAT_ENV="$ROOT/packages/chat/.env"
APPLY_SCRIPT="$ROOT/db/sql/apply-validate.sh"

for command_name in node psql; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "FAIL: required command is missing: $command_name" >&2
    exit 69
  fi
done
if [[ ! -f "$CHAT_ENV" ]]; then
  echo "FAIL: missing Chat environment file: $CHAT_ENV" >&2
  exit 66
fi
if [[ ! -f "$APPLY_SCRIPT" ]]; then
  echo "FAIL: missing database boundary script: $APPLY_SCRIPT" >&2
  exit 66
fi

# shellcheck disable=SC1090 -- this is the repository-owned local Chat env.
source "$CHAT_ENV"

# Keep the database target independent from the runtime URL. Load the env first,
# then replace every ambient route so it cannot override the approved target.
unset PGDATABASE PGUSER PGOPTIONS PGHOSTADDR PGSERVICE PGSERVICEFILE PGPASSWORD
export PGHOST="localhost"
export PGPORT="5433"
export DB="idream_runtime_20260812"
readonly PGHOST PGPORT DB

read_url_password() {
  IDREAM_DATABASE_URL="$1" IDREAM_DATABASE_URL_LABEL="$2" node -e '
    const label = process.env.IDREAM_DATABASE_URL_LABEL;
    try {
      const raw = process.env.IDREAM_DATABASE_URL;
      if (!raw) throw new Error("missing");
      const password = decodeURIComponent(new URL(raw).password);
      if (!password) throw new Error("empty");
      process.stdout.write(password);
    } catch {
      console.error(`FAIL: ${label} must contain a database password`);
      process.exit(65);
    }
  '
}

CHAT_SERVICE_PASSWORD="$(read_url_password "$CHAT_DATABASE_URL" CHAT_DATABASE_URL)"
CHAT_PROJECTOR_PASSWORD="$(read_url_password "$CHAT_PROJECTOR_DATABASE_URL" CHAT_PROJECTOR_DATABASE_URL)"
# Local bootstrap authority is postgres/postgres in docker-compose.yml and the
# checked-in local env examples. An explicit POSTGRES_PASSWORD may override it.
SUPER="postgres"
SUPER_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
export CHAT_DATABASE_URL CHAT_SERVICE_PASSWORD CHAT_PROJECTOR_PASSWORD SUPER SUPER_PASSWORD
readonly SUPER

cleanup() {
  unset SUPER_PASSWORD CHAT_SERVICE_PASSWORD CHAT_PROJECTOR_PASSWORD
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Target: ${SUPER}@${PGHOST}:${PGPORT}/${DB}"
echo "Chat must remain stopped until validation succeeds."
bash "$APPLY_SCRIPT"
