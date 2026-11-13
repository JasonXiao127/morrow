/**
 * @morrow/db — Drizzle schema, migrations, and the SQLite client.
 *
 * The app-server skeleton imports `getDb`, `initSchema`, `closeDb`, and
 * `pingDb`; those remain available. New code can use `openDatabase()` for an
 * isolated connection or `getMorrowDb()` for the typed Drizzle singleton.
 */
export * from "./schema.js";
export * from "./client.js";
