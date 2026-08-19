// Drizzle schema — a single `notes` table. Plain drizzle-orm/sqlite-core; nothing
// denext-specific. The column types drive both the generated SQL and the inferred
// TypeScript row types used across the app.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type Note = typeof notes.$inferSelect;
