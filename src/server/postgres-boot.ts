/**
 * Boot-time DDL: the tables, roles, functions and triggers denext's Postgres features create for
 * themselves on first use (the auth adapter, the session, rate-limit, cache and job-history
 * stores, and `@denext/backend`'s services), each through {@linkcode migratePostgres} with a
 * tracking table of its own.
 *
 * Where migrations are applied out of band (a release step with a privileged role, a DBA), set
 * `DENEXT_BOOT_DDL=off`: no feature runs DDL at startup or on first use. Each one checks instead
 * that its migrations are recorded, and `denext dev` / `denext start` check every feature the
 * config built before they serve, failing with a {@linkcode BootSchemaError} that names what is
 * missing.
 *
 * With boot DDL on (the default), a run that applies migrations prints one line for it, and the
 * server's `NOTICE`s (`… already exists, skipping`) are silenced inside those transactions.
 *
 * @module
 */

import { migratePostgres, postgresMigrationStatus, trackingTable } from "./postgres-migrate.ts";
import type { PostgresMigrateOptions } from "./postgres-migrate.ts";
import type { SqlClient } from "./postgres.ts";

/** The environment variable that turns boot-time DDL off (`off`, `0`, `false` or `no`). */
export const BOOT_DDL_ENV = "DENEXT_BOOT_DDL";

/** The `code` a {@linkcode BootSchemaError} carries. */
export const BOOT_SCHEMA_MISSING = "boot_schema_missing";

/**
 * Whether denext's Postgres features may create their own schema (`DENEXT_BOOT_DDL` is not
 * `off` / `0` / `false` / `no`). Read on every call.
 *
 * @returns `true` unless boot-time DDL is turned off.
 */
export function bootDdlEnabled(): boolean {
  let value: string | undefined;
  try {
    value = Deno.env.get(BOOT_DDL_ENV);
  } catch {
    return true; // no env permission: the default
  }
  return !/^(?:off|0|false|no)$/i.test(value?.trim() ?? "");
}

/** Why a feature can't start with boot-time DDL off: its schema is not (all) there. */
export class BootSchemaError extends Error {
  /** Always {@linkcode BOOT_SCHEMA_MISSING}. */
  readonly code: typeof BOOT_SCHEMA_MISSING = BOOT_SCHEMA_MISSING;

  /**
   * Build the error.
   *
   * @param message What is missing, and how to apply it.
   * @param missing Each missing migration as `<tracking table>:<name>`.
   */
  constructor(message: string, readonly missing: string[] = []) {
    super(message);
    this.name = "BootSchemaError";
  }
}

/** Options for {@linkcode bootMigrate}: the migrations and their tracking table, and who asks. */
export interface BootMigrateOptions extends Omit<PostgresMigrateOptions, "dryRun" | "quiet"> {
  /** The feature, named in the log line and the error (`postgresAuthAdapter`). */
  feature: string;
}

/** `a, b, c` for a few names, `first … last (n)` for many. */
function summarize(names: string[]): string {
  return names.length <= 3 ? names.join(", ") : `${names[0]} … ${names[names.length - 1]}`;
}

/** The table as the log line and the error name it (unquoted). */
function tableLabel(options: BootMigrateOptions): string {
  return trackingTable(options).replaceAll('"', "");
}

/**
 * Bring a feature's schema up at startup or first use. With boot-time DDL on, apply the pending
 * migrations (the server's `NOTICE`s silenced) and print one line when any were applied. With it
 * off, apply nothing: throw a {@linkcode BootSchemaError} unless every migration is recorded.
 *
 * @param sql The client.
 * @param options The migrations, their tracking table, and the feature.
 * @throws {BootSchemaError} With boot-time DDL off, when a migration is not recorded.
 */
export async function bootMigrate(sql: SqlClient, options: BootMigrateOptions): Promise<void> {
  const { feature, ...migrate } = options;
  const table = tableLabel(options);
  if (!bootDdlEnabled()) {
    const { pending } = await postgresMigrationStatus(sql, migrate);
    if (pending.length === 0) return;
    throw new BootSchemaError(
      `${feature}: ${BOOT_DDL_ENV}=off and its schema is not in place — ${pending.length} ` +
        `migration${pending.length === 1 ? " is" : "s are"} not recorded in ${table} ` +
        `(${pending.join(", ")}). Apply them out of band before starting (denext db push applies ` +
        `@denext/backend's), or run once with ${BOOT_DDL_ENV} unset, as a role that may create them.`,
      pending.map((name) => `${table}:${name}`),
    );
  }
  const { applied } = await migratePostgres(sql, { ...migrate, quiet: true });
  if (applied.length === 0) return;
  console.info(
    `[denext] ${feature}: applied ${applied.length} migration${applied.length === 1 ? "" : "s"} ` +
      `to ${table} (${summarize(applied)})`,
  );
}

/** The checks {@linkcode verifyBootSchemas} runs next. */
const checks = new Set<() => Promise<void>>();

/**
 * With boot-time DDL off, register a feature's schema check for the server's startup
 * ({@linkcode verifyBootSchemas}); a no-op with it on. Each check runs once.
 *
 * @param check Resolves when the schema is in place; rejects (a {@linkcode BootSchemaError})
 *   when it is not.
 */
export function registerBootCheck(check: () => Promise<void>): void {
  if (bootDdlEnabled()) return;
  checks.add(check);
}

/**
 * Run every registered schema check (each once), as `denext dev` / `denext start` do after the
 * config's plugins are set up. Resolves at once with boot-time DDL on.
 *
 * @throws {BootSchemaError} Naming every feature whose schema is missing.
 */
export async function verifyBootSchemas(): Promise<void> {
  const pending = [...checks];
  checks.clear();
  if (pending.length === 0 || bootDdlEnabled()) return;
  const failures = (await Promise.allSettled(pending.map((check) => check())))
    .flatMap((r) => r.status === "rejected" ? [r.reason as unknown] : []);
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  const messages = failures.map((e) => `- ${e instanceof Error ? e.message : String(e)}`);
  throw new BootSchemaError(
    `${failures.length} features can't start with ${BOOT_DDL_ENV}=off:\n${messages.join("\n")}`,
    failures.flatMap((e) => e instanceof BootSchemaError ? e.missing : []),
  );
}
