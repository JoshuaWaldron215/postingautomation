import { loadDotEnv } from "../lib/env";
import { runMigrations } from "../db/migrate";
import postgres from "postgres";

export default async function setup() {
  loadDotEnv();
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/synthos_test";
  if (/prod/i.test(url)) throw new Error("Refusing to run tests against a production-looking database");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;");
  await sql.end();
  await runMigrations(url);
  process.env.DATABASE_URL = url;
}
