// Prisma 7's CLI configuration: the schema, and the datasource URL `prisma db push` writes
// to (Prisma 7 reads it from here, not from schema.prisma). The app itself opens the same
// file through the driver adapter in `lib/db.ts`.
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: "file:./prisma/dev.db" },
});
