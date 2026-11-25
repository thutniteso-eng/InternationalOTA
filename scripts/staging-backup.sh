#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_DIR="${ROOT_DIR}/deploy/staging"
COMPOSE_FILE="${STAGING_DIR}/compose.yml"
ENV_FILE="${STAGING_DIR}/.env.staging"
BACKUP_DIR="${BACKUP_DIR:-${HOME}/ota-backups}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: ${ENV_FILE} not found. Run scripts/staging-up.sh first." >&2
  exit 1
fi

get_env_var() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | head -n 1 | cut -d'=' -f2-
}

PG_SUPERUSER="$(get_env_var POSTGRES_USER)"
DB_NAME="$(get_env_var STAGING_DB_NAME)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET_FILE="${BACKUP_DIR}/ota_staging_${TS}.dump"
TMP_FILE="${TARGET_FILE}.tmp"

echo "Creating custom-format pg_dump of ${DB_NAME} -> ${TARGET_FILE}..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$PG_SUPERUSER" -d "$DB_NAME" --format=custom >"$TMP_FILE"
chmod 600 "$TMP_FILE"
mv "$TMP_FILE" "$TARGET_FILE"

# Retain only the 7 most recent backups
mapfile -t backups < <(ls -1t "${BACKUP_DIR}"/ota_staging_*.dump 2>/dev/null || true)
if (( ${#backups[@]} > 7 )); then
  for old in "${backups[@]:7}"; do
    rm -f "$old"
    echo "Pruned old backup: ${old}"
  done
fi

ls -lh "$TARGET_FILE"
