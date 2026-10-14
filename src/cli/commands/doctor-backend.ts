// `denext doctor`'s checks for an app on `@denext/backend`: its setup accepts the configuration
// (API keys, storage secret), the database answers, the backend's and the app's migrations are
// applied, and the storage driver answers. denext does not depend on the package: the plugin
// is set up the way `denext db` sets it up (`setUpProject`), and what it installs is read from
// its process-global slots, structurally.

import { join } from "@std/path";
import type { DenextConfig } from "../../server/config.ts";
import { installedSupabaseKeys } from "../../server/auth/gotrue/keys.ts";
import { projectMigrationsDir, readMigrationFiles } from "../../server/migration-files.ts";
import { listMigrations } from "../../server/migration-ops.ts";
import { postgresMigrationStatus } from "../../server/postgres-migrate.ts";
import { backendHooks, setUpProject } from "../db/project.ts";
import { runPluginTeardown } from "../../plugin/mod.ts";
import { type DbTarget, historyFor, openTarget } from "../db/target.ts";

/** One doctor line (the shape `doctor.ts` prints). */
export interface BackendCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly critical: boolean;
}

/** How long a probe of the database or the store may take. */
const PROBE_MS = 5000;

/** The structural slice of the storage runtime `@denext/backend` installs. */
interface StorageSlot {
  buckets: Map<string, unknown>;
  secrets: string[] | null;
  driver: { list(bucket: string, prefix: string, options: { limit: number }): Promise<unknown> };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not answer in ${PROBE_MS} ms`)),
      PROBE_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function usesBackend(config: DenextConfig | null): boolean {
  return (config?.plugins ?? []).some((p) => p?.name === "@denext/backend");
}

/** The Supabase keys the setup installed: present, or the reason a client is refused. */
function keysCheck(): BackendCheck | null {
  const keys = installedSupabaseKeys();
  if (!keys) return null;
  const signs = keys.ec.length > 0 || keys.hmac !== null;
  const ok = keys.publishable.length > 0 && signs;
  return {
    name: "backend keys",
    ok,
    detail: ok
      ? `${keys.publishable.length} publishable, ${keys.secret.length} secret, ${
        keys.ec.length > 0 ? "ES256" : "HS256"
      } signing`
      : "no publishable key or no signing key: supabase-js clients are refused — run " +
        "`denext backend keys` and set the variables it prints",
    critical: false,
  };
}

/** The database answers `select 1`. */
async function databaseCheck(target: DbTarget): Promise<BackendCheck> {
  try {
    await withTimeout(Promise.resolve(target.sql!`select 1`), "the database");
    return { name: "backend database", ok: true, detail: target.display, critical: true };
  } catch (error) {
    return {
      name: "backend database",
      ok: false,
      detail: `${target.display}: ${message(error)}`,
      critical: true,
    };
  }
}

/** The backend's own migrations and the app's, none pending. */
async function migrationsCheck(projectDir: string, target: DbTarget): Promise<BackendCheck> {
  const hooks = backendHooks();
  const backend = hooks
    ? (await postgresMigrationStatus(target.sql!, {
      migrations: hooks.migrations(),
      table: hooks.table || "backend_migrations",
    })).pending
    : [];
  const dir = await projectMigrationsDir(projectDir);
  const abs = join(projectDir, ...dir.split("/"));
  const files = await readMigrationFiles(abs).catch(() => []);
  const history = await historyFor(target, dir, files.length > 0);
  const app = (await listMigrations(history, files)).filter((r) => r.local && !r.remote);
  const pending = [...backend, ...app.map((r) => r.name ?? r.version)];
  return {
    name: "backend migrations",
    ok: pending.length === 0,
    detail: pending.length === 0
      ? "all applied"
      : `${pending.length} pending (${pending.slice(0, 3).join(", ")}${
        pending.length > 3 ? ", …" : ""
      }) — run \`denext migration up\``,
    critical: false,
  };
}

/** The store answers a one-object listing of the first bucket; signed URLs have a secret. */
async function storageCheck(): Promise<BackendCheck | null> {
  const rt = (globalThis as Record<symbol, unknown>)[Symbol.for("denext.backend.storage")] as
    | StorageSlot
    | undefined;
  if (!rt) return null;
  if (!rt.secrets) {
    return {
      name: "backend storage",
      ok: false,
      detail: "no DENEXT_STORAGE_SECRET: signed upload and download URLs are refused",
      critical: false,
    };
  }
  const [bucket] = rt.buckets.keys();
  if (bucket === undefined) {
    return { name: "backend storage", ok: true, detail: "no buckets declared", critical: false };
  }
  try {
    await withTimeout(rt.driver.list(bucket, "", { limit: 1 }), "the store");
    return {
      name: "backend storage",
      ok: true,
      detail: `reached (bucket ${bucket})`,
      critical: true,
    };
  } catch (error) {
    return { name: "backend storage", ok: false, detail: message(error), critical: true };
  }
}

/** The database's checks, when the backend has Postgres. */
async function postgresChecks(projectDir: string): Promise<BackendCheck[]> {
  if (!backendHooks()) return [];
  let target: DbTarget;
  try {
    target = openTarget(projectDir, { readOnly: true, postgresOnly: "@denext/backend" });
  } catch (error) {
    return [{ name: "backend database", ok: false, detail: message(error), critical: true }];
  }
  try {
    const reachable = await databaseCheck(target);
    if (!reachable.ok) return [reachable];
    return [reachable, await migrationsCheck(projectDir, target)];
  } finally {
    await target.close();
  }
}

/**
 * `denext doctor`'s backend checks: none for an app without `@denext/backend`.
 *
 * @param projectDir The project.
 * @param config Its loaded config.
 * @param setUp Sets the project's plugins up (`denext db`'s, by default).
 * @returns The checks, in print order.
 */
export async function backendChecks(
  projectDir: string,
  config: DenextConfig | null,
  setUp: (projectDir: string) => Promise<void> = setUpProject,
): Promise<BackendCheck[]> {
  if (!usesBackend(config)) return [];
  try {
    await setUp(projectDir);
  } catch (error) {
    return [{ name: "backend config", ok: false, detail: message(error), critical: true }];
  }
  try {
    const checks: BackendCheck[] = [];
    const keys = keysCheck();
    if (keys) checks.push(keys);
    checks.push(...await postgresChecks(projectDir));
    const storage = await storageCheck();
    if (storage) checks.push(storage);
    return checks;
  } finally {
    // Close the clients the setup opened, so the verb can exit.
    await runPluginTeardown();
  }
}
