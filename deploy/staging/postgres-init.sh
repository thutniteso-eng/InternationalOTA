#!/usr/bin/env bash
set -euo pipefail

# Creates the schema-owner role (`ota_owner`) and least-privilege runtime role (`ota_app`)
# inside the PostGIS database initialized by the PostgreSQL entrypoint.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "postgres" \
  -v ota_owner="$OTA_OWNER_USER" \
  -v ota_owner_password="$OTA_OWNER_PASSWORD" \
  -v ota_app="$OTA_APP_USER" \
  -v ota_app_password="$OTA_APP_PASSWORD" \
  -v target_db="$STAGING_DB_NAME" <<'EOSQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'ota_owner',
  :'ota_owner_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'ota_owner')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'ota_app',
  :'ota_app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'ota_app')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'target_db', :'ota_owner')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_db')
\gexec
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$STAGING_DB_NAME" \
  -v ota_owner="$OTA_OWNER_USER" \
  -v ota_app="$OTA_APP_USER" \
  -v target_db="$STAGING_DB_NAME" <<'EOSQL'
CREATE EXTENSION IF NOT EXISTS postgis;
REVOKE CREATE ON DATABASE :"target_db" FROM PUBLIC, :"ota_app";
GRANT CONNECT ON DATABASE :"target_db" TO :"ota_owner", :"ota_app";
REVOKE CREATE ON SCHEMA public FROM PUBLIC, :"ota_app";
GRANT USAGE, CREATE ON SCHEMA public TO :"ota_owner";
GRANT USAGE ON SCHEMA public TO :"ota_app";
EOSQL

# Reject connections originating from the Docker bridge host gateway (172.29.10.1),
# allowing only container-to-container TCP on app_net and local socket inside postgres container.
{
  echo "host all all 172.29.10.1/32 reject"
  cat "${PGDATA}/pg_hba.conf"
} > "${PGDATA}/pg_hba.conf.tmp" && mv "${PGDATA}/pg_hba.conf.tmp" "${PGDATA}/pg_hba.conf"
