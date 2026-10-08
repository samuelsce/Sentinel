#!/bin/sh
set -eu

# psql quotes values with %L instead of interpolating passwords into SQL code.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set api_password="$SENTINEL_API_DB_PASSWORD" \
  --set detector_password="$SENTINEL_DETECTOR_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE sentinel_api LOGIN PASSWORD %L', :'api_password') \gexec
SELECT format('CREATE ROLE sentinel_detector LOGIN PASSWORD %L', :'detector_password') \gexec
CREATE DATABASE sentinel_test;
SQL
