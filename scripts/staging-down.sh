#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/deploy/staging/compose.yml"

echo "Stopping staging containers (PostgreSQL volume and .env.staging are preserved)..."
docker compose -f "$COMPOSE_FILE" down --remove-orphans
echo "Staging stopped."
