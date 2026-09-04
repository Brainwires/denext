// A server-only module: the Prisma client, wired to denext's node:sqlite compat
// through the better-sqlite3 driver adapter. `generated/client` is produced by
// `deno task setup` (`prisma generate`); the adapter reaches the compat because
// deno.json `links` substitutes it for the adapter's `better-sqlite3` dependency.
// No native addon, no Rust query engine.

import { PrismaBetterSQLite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/client/client.ts";

const url = `file:${Deno.env.get("DB_PATH") ?? "./prisma/dev.db"}`;
const prisma = new PrismaClient({
  adapter: new PrismaBetterSQLite3({ url }),
});

// Seed a couple of rows on first boot so a fresh database isn't empty (idempotent).
if ((await prisma.note.count()) === 0) {
  await prisma.note.create({ data: { title: "Prisma runs on denext" } });
  await prisma.note.create({ data: { title: "…Rust-free over node:sqlite" } });
}

/** All notes, newest first. */
export function listNotes() {
  return prisma.note.findMany({ orderBy: { id: "desc" } });
}

/** Insert a note (used by the Server Action). */
export function addNote(title: string) {
  return prisma.note.create({ data: { title } });
}
