import { loadDotEnv } from "../lib/env";
loadDotEnv();
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
if (/supabase\.co|prod/i.test(url) && process.env.ALLOW_RESET !== "yes") {
  console.error("Refusing to reset what looks like a hosted/production database. Set ALLOW_RESET=yes to override.");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;");
await sql.end();
console.log("Database schema reset.");
