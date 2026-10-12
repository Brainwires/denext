/**
 * `@denext/backend` — your app's backend services as one opt-in plugin, self-hosted inside the
 * app: **storage** — buckets with per-bucket rules, signed upload and download URLs, multipart
 * uploads, image transforms on download, and session-aware access checks — on S3 (AWS,
 * Cloudflare R2, MinIO) or the local filesystem, with zero npm; and **Postgres** — `db()` for the
 * server, scoped by Supabase-compatible row-level security (`auth.uid()` in your policies), and
 * `backendAuthAdapter()` for denext auth, on the Postgres client built into denext's Deno runtime
 * (`Deno.SQL`), or any client you pass (`sql`); and **realtime** — `realtime({ tables })` sends
 * each table's inserts, updates and deletes to `useTableChanges` subscribers, every row re-read
 * under that subscriber's row-level security.
 *
 * ```ts
 * // denext.config.ts
 * import { backend, fs, s3 } from "@denext/backend";
 *
 * export default {
 *   plugins: [
 *     backend({
 *       storage: {
 *         driver: Deno.env.get("S3_BUCKET")
 *           ? s3({ region: "auto", bucket: Deno.env.get("S3_BUCKET")!, endpoint: Deno.env.get("S3_ENDPOINT") })
 *           : fs({ dir: ".storage" }),
 *         buckets: {
 *           avatars: {
 *             public: true,
 *             maxBytes: 2 * 1024 * 1024,
 *             mime: ["image/png", "image/jpeg", "image/webp"],
 *             authorize: ({ session, op, key }) => !!session && key.startsWith(`${session.user.id}/`),
 *           },
 *         },
 *       },
 *     }),
 *   ],
 * };
 * ```
 *
 * Server code uses `storage` and `db` from `@denext/backend/server`; the browser uses
 * `uploadFile` and `getFileUrl` from `@denext/backend/client`. Postgres:
 *
 * ```ts
 * // denext.config.ts
 * import { denextAuth, github } from "denext/server";
 * import { backend, backendAuthAdapter } from "@denext/backend";
 *
 * export default {
 *   plugins: [
 *     backend({ postgres: { url: Deno.env.get("DATABASE_URL") } }),
 *     denextAuth({ providers: [github()], adapter: backendAuthAdapter() }),
 *   ],
 * };
 * ```
 *
 * @module
 */

import type { DenextPlugin, PluginContext } from "@denext/denext/server";
import { checkBucketName } from "./src/keys.ts";
import { handleStorageRequest } from "./src/handler.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MULTIPART_THRESHOLD,
  DEFAULT_PART_SIZE,
  installRuntime,
  MIN_PART_SIZE,
  type ResolvedBucket,
} from "./src/runtime.ts";
import { resolveSecrets, SECRET_ENV } from "./src/signing.ts";
import type { StorageOptions } from "./src/types.ts";
import { db, installPostgres, openPostgres, type PostgresOptions } from "./src/postgres.ts";
import { createRealtimeChannel, installRealtime, RealtimeEngine } from "./src/realtime.ts";
import { type RealtimeOptions, resolveRealtime } from "./src/realtime-sql.ts";

export { backendAuthAdapter } from "./src/postgres.ts";
export type { BackendAuthAdapterOptions, PostgresOptions } from "./src/postgres.ts";
export { rlsMigrations, rlsSetupSql } from "./src/rls.ts";
export { realtime, realtimeMigrations, realtimeSetupSql } from "./src/realtime-sql.ts";
export type { RealtimeOptions, RealtimeTableOptions } from "./src/realtime-sql.ts";
export type { TableEvent } from "./src/realtime-shared.ts";
export type { RlsOptions } from "./src/rls.ts";
export { fs } from "./src/fs-driver.ts";
export type { FsDriverOptions } from "./src/fs-driver.ts";
export { s3 } from "./src/s3-driver.ts";
export type { S3DriverOptions } from "./src/s3-driver.ts";
export type { AwsCredentials } from "./src/sigv4.ts";
export { isStorageError, StorageError } from "./src/errors.ts";
export type { StorageErrorCode } from "./src/errors.ts";
export type { StorageTransform } from "./src/shared.ts";
export type {
  BucketConfig,
  ByteRange,
  DirectAccess,
  ListedObject,
  ListResult,
  ObjectInfo,
  PutInfo,
  StorageAuthorizeContext,
  StorageDriver,
  StorageOp,
  StorageOptions,
  StoredObject,
} from "./src/types.ts";

/** Options for {@linkcode backend}. */
export interface BackendOptions {
  /** File storage: a driver and the buckets it serves. */
  storage?: StorageOptions;
  /**
   * Postgres: the app's database, as `db()` from `@denext/backend/server` (and denext auth's,
   * with `adapter: backendAuthAdapter()`). `{}` reads `DATABASE_URL`.
   */
  postgres?: PostgresOptions;
  /**
   * Realtime from the database: tables whose inserts, updates and deletes reach
   * `useTableChanges` subscribers (each re-read under that subscriber's row-level security) and
   * `onTableChange` hooks. Needs `postgres`.
   */
  realtime?: RealtimeOptions;
}

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/** Validate the bucket map and apply the defaults. */
function resolveBuckets(buckets: StorageOptions["buckets"]): Map<string, ResolvedBucket> {
  const out = new Map<string, ResolvedBucket>();
  for (const [name, config] of Object.entries(buckets ?? {})) {
    checkBucketName(name);
    const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError(`backend(): bucket ${name}: maxBytes must be a positive integer`);
    }
    out.set(name, { ...config, name, maxBytes });
  }
  if (out.size === 0) throw new TypeError("backend(): storage.buckets declares no bucket");
  return out;
}

/** Install the realtime engine and its channel; teardown (LIFO) stops it before the pool closes. */
function setupRealtime(
  ctx: PluginContext,
  options: RealtimeOptions,
  slot: ReturnType<typeof openPostgres>["slot"],
): void {
  const channel = createRealtimeChannel();
  const engine = new RealtimeEngine(
    options,
    () => db.service(),
    (key, frame) => channel.publish(key, frame),
  );
  installRealtime(engine);
  ctx.addTeardown(() => engine.stop());
  if (ctx.mode !== "dev") return;
  const missing = "error" in slot
    ? slot.error.message
    : typeof slot.sql.listen !== "function"
    ? "this Postgres client has no listen() (LISTEN/NOTIFY)"
    : undefined;
  if (missing) console.warn(`[@denext/backend] realtime is unsupported here: ${missing}`);
}

/**
 * Create the backend plugin. Place it in your `denext.config.ts` `plugins`.
 *
 * @param options The services to enable (`storage`, `postgres`, `realtime`).
 * @returns The plugin.
 */
export function backend(options: BackendOptions = {}): DenextPlugin {
  const storageOptions = options.storage;
  if (storageOptions && !storageOptions.driver) {
    throw new TypeError("backend(): storage.driver is required (s3({ … }) or fs({ dir }))");
  }
  const buckets = storageOptions ? resolveBuckets(storageOptions.buckets) : undefined;
  if (options.realtime) {
    if (!options.postgres) throw new TypeError("backend(): realtime needs `postgres`");
    resolveRealtime(options.realtime);
  }
  return {
    name: "@denext/backend",
    async setup(ctx: PluginContext) {
      if (options.postgres) {
        const { slot, owned } = openPostgres(options.postgres, env);
        installPostgres(slot);
        if (owned && "sql" in slot) ctx.addTeardown(() => slot.sql.close());
        if (options.realtime) setupRealtime(ctx, options.realtime, slot);
      }
      if (!storageOptions || !buckets) return;
      const dev = ctx.mode === "dev";
      const secrets = resolveSecrets(storageOptions.secret, env, dev);
      if (dev && storageOptions.secret === undefined && !env(SECRET_ENV)) {
        console.warn(
          `[@denext/backend] no ${SECRET_ENV}: signed storage URLs use a random dev secret and stop working on restart`,
        );
      }
      await storageOptions.driver.init?.({ projectRoot: ctx.projectRoot });
      installRuntime({
        driver: storageOptions.driver,
        buckets,
        secrets,
        basePath: (ctx.config.basePath ?? "").replace(/\/$/, ""),
        images: ctx.config.images,
        multipartThreshold: storageOptions.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD,
        partSize: Math.max(storageOptions.partSize ?? DEFAULT_PART_SIZE, MIN_PART_SIZE),
      });
      ctx.addRequestHandler(handleStorageRequest);
    },
  };
}
