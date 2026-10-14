// What `denext db <action>` hands each Postgres action `@denext/backend` implements (structurally
// denext's `BackendActionInput`), shared by db-command.ts and the actions' own modules.

import type { CommandContext } from "@denext/denext/cli/command";
import type { SqlClient } from "@denext/denext/server";
import type { CommandIo } from "./command-io.ts";

/** What `denext db <action>` hands an action (structurally denext's `BackendActionInput`). */
export interface DbActionInput {
  /** The parsed invocation. */
  ctx: CommandContext;
  /** The project. */
  projectDir: string;
  /** The target database's client. */
  sql: SqlClient;
  /** Its URL, when known. Never print it. */
  url?: string;
  /** The project's migrations directory. */
  migrationsDir: string;
  /** Apply the backend's and the project's migrations to another database. */
  applyAll(sql: SqlClient): Promise<string[]>;
  /** Record a local migration (by file name) as applied on the target. */
  recordApplied(name: string): Promise<void>;
  /** Where to print. */
  io: Pick<CommandIo, "log" | "error">;
}

/**
 * The `--schema` list (default `public`), each a plain identifier.
 *
 * @param ctx The invocation.
 * @returns The schemas.
 */
export function schemasOf(ctx: CommandContext): string[] {
  const value = ctx.flags.schema;
  const list = typeof value === "string" && value !== "" ? value.split(",") : ["public"];
  for (const schema of list) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
      throw new TypeError(`--schema ${JSON.stringify(schema)} is not a plain identifier`);
    }
  }
  return list;
}
