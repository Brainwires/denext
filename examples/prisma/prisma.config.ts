// Prisma 7's CLI configuration: the schema, and the datasource URL `prisma db push` writes
// to (Prisma 7 reads it from here, not from schema.prisma). It reads `DB_PATH` as `lib/db.ts`
// does, so the CLI and the app open the same file.
import process from "node:process";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: `file:${process.env.DB_PATH ?? "./prisma/dev.db"}` },
});
