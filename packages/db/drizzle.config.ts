import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit is used to inspect/generate future migrations. The initial
 * migration is hand-written and lives at migrations/0001_init.sql so that
 * every CHECK, partial unique index, and FK is explicit and reviewable.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env["DATABASE_PATH"] ?? "./data/morrow.db",
  },
  strict: true,
  verbose: true,
});
