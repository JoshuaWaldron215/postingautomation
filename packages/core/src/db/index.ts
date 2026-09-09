import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

let _db: Db | undefined;
let _client: ReturnType<typeof postgres> | undefined;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and point it at a Postgres database.");
  return url;
}

export function createDb(url = databaseUrl(), max = 10): { db: Db; client: ReturnType<typeof postgres> } {
  const client = postgres(url, { max, onnotice: () => {}, transform: undefined });
  const db = drizzle(client, { schema });
  return { db, client };
}

export function getDb(): Db {
  if (!_db) {
    const created = createDb();
    _db = created.db;
    _client = created.client;
  }
  return _db;
}

/** Replace the process-wide database (tests). */
export function setDb(db: Db, client?: ReturnType<typeof postgres>) {
  _db = db;
  _client = client;
}

export async function closeDb() {
  await _client?.end({ timeout: 5 });
  _db = undefined;
  _client = undefined;
}

export { schema };
