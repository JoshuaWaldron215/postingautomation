import { sql } from "drizzle-orm";
/** Postgres array literal for uuid lists, safe for `= ANY(...)` with the postgres-js driver. */
export const uuidArray = (ids: string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;
