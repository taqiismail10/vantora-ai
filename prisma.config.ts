import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 takes the connection URL from here rather than from the datasource
// block in schema.prisma. `process.env` is read directly instead of Prisma's
// `env()` helper because that helper throws when the variable is absent, and
// absent is the normal case here: with no DATABASE_URL the app falls back to the
// in-memory dataset in src/lib/sandbox/seed-data.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
