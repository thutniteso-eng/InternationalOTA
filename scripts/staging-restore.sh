#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_DIR="${ROOT_DIR}/deploy/staging"
COMPOSE_FILE="${STAGING_DIR}/compose.yml"
ENV_FILE="${STAGING_DIR}/.env.staging"

usage() {
  echo "Usage: $0 <backup-file.dump> [--replace]" >&2
  exit 1
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
fi

BACKUP_FILE="$1"
REPLACE_LIVE="0"
if [[ "${2:-}" == "--replace" ]]; then
  REPLACE_LIVE="1"
elif [[ -n "${2:-}" ]]; then
  usage
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "ERROR: Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: ${ENV_FILE} not found." >&2
  exit 1
fi

get_env_var() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | head -n 1 | cut -d'=' -f2-
}

PG_SUPERUSER="$(get_env_var POSTGRES_USER)"
OWNER_USER="$(get_env_var OTA_OWNER_USER)"
LIVE_DB="$(get_env_var STAGING_DB_NAME)"

print_row_counts() {
  local db_name="$1"
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U "$PG_SUPERUSER" -d "$db_name" -X -A -F $'\t' <<'EOSQL'
SELECT 'identity.user' AS table_name, COUNT(*) AS row_count FROM identity."user"
UNION ALL
SELECT 'reference.currencies', COUNT(*) FROM reference.currencies
UNION ALL
SELECT 'reference.languages', COUNT(*) FROM reference.languages
UNION ALL
SELECT 'finance.accounts', COUNT(*) FROM finance.accounts
UNION ALL
SELECT 'finance.journal_entries', COUNT(*) FROM finance.journal_entries
ORDER BY table_name;
EOSQL
}

if [[ "$REPLACE_LIVE" == "1" ]]; then
  echo "WARNING: --replace specified; replacing live database '${LIVE_DB}' from ${BACKUP_FILE}..."
  docker compose -f "$COMPOSE_FILE" stop api web caddy || true
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U "$PG_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 <<EOSQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${LIVE_DB}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "${LIVE_DB}";
CREATE DATABASE "${LIVE_DB}" OWNER "${OWNER_USER}";
EOSQL
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_restore -U "$PG_SUPERUSER" -d "$LIVE_DB" --no-privileges <"$BACKUP_FILE"
  docker compose -f "$COMPOSE_FILE" run --rm migrate
  docker compose -f "$COMPOSE_FILE" up -d --no-deps --wait api web caddy
  echo "Row counts in restored live database (${LIVE_DB}):"
  print_row_counts "$LIVE_DB"
else
  RESTORE_DB="ota_restore_$(date -u +%Y%m%d_%H%M%S)"
  echo "Restoring ${BACKUP_FILE} into new verification database '${RESTORE_DB}' (live DB '${LIVE_DB}' untouched)..."
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U "$PG_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 <<EOSQL
CREATE DATABASE "${RESTORE_DB}" OWNER "${OWNER_USER}";
EOSQL
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_restore -U "$PG_SUPERUSER" -d "$RESTORE_DB" <"$BACKUP_FILE"

  echo ""
  echo "=== Live database (${LIVE_DB}) row counts ==="
  print_row_counts "$LIVE_DB"
  echo ""
  echo "=== Restored database (${RESTORE_DB}) row counts ==="
  print_row_counts "$RESTORE_DB"
fi
