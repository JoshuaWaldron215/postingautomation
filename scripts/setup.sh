#!/usr/bin/env bash
# One-time local setup: env file, databases, migrations, demo seed.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v pnpm >/dev/null || { echo "Install pnpm first: npm i -g pnpm"; exit 1; }
command -v psql >/dev/null || { echo "Postgres (psql) is required. On a Mac: brew install postgresql@16 && brew services start postgresql@16"; exit 1; }
[ -f .env ] || { cp .env.example .env; sed -i.bak "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -hex 32)|" .env && rm -f .env.bak; echo "Created .env"; }
DB_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
ADMIN_URL=${DB_URL%/*}/postgres
for db in synthos_dev synthos_test; do
  psql "$ADMIN_URL" -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 || psql "$ADMIN_URL" -c "create database $db"
done
pnpm install
pnpm db:migrate
pnpm db:seed
echo
echo "Done. Start everything with: pnpm dev:all   then open http://localhost:3000"
