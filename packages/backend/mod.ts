/**
 * `@denext/backend` — your app's backend services as one opt-in plugin, self-hosted inside the
 * app: **storage** — buckets with per-bucket rules, signed upload and download URLs, multipart
 * uploads, image transforms on download, and session-aware access checks — on S3 (AWS,
 * Cloudflare R2, MinIO) or the local filesystem, with zero npm; and **Postgres** — `db()` for the
 * server, scoped by Supabase-compatible row-level security (`auth.uid()` in your policies), and
 * `backendAuthAdapter()` for denext auth, on the Postgres client built into denext's Deno runtime
 * (`Deno.SQL`), or any client you pass (`sql`); and **realtime** — `realtime({ tables })` sends
 * each table's inserts, updates and deletes to `useTableChanges` subscribers, every row re-read
 * under that subscriber's row-level security; and **auto-REST** — `rest: {}` serves the schema's
 * tables PostgREST-style under `/rest/v1/<table>`, every statement scoped by the same row-level
 * security, with row types generated into `.denext/rest.ts` for `from("table")`.
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
import { handleGoTrueRequest, installGoTrue, registerHealthCheck } from "@denext/denext/server";
import { installSupabaseAuthHooks } from "./src/identity.ts";
import { checkBucketName } from "./src/keys.ts";
import { handleStorageRequest } from "./src/handler.ts";
import { handleStorageApi } from "./src/storage-api.ts";
import {
  postgresMetaStore,
  STORAGE_MIGRATIONS_TABLE,
  storageMigrations,
} from "./src/storage-meta-pg.ts";
import { sqliteMetaStore } from "./src/storage-meta-sqlite.ts";
import type { BucketWrite, MetaStore } from "./src/storage-meta.ts";
import { declaredBucketRows, storageAdmin } from "./src/storage-ops.ts";
import { resolve as resolvePath } from "@std/path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MULTIPART_THRESHOLD,
  DEFAULT_PART_SIZE,
  installRuntime,
  MIN_PART_SIZE,
  type ResolvedBucket,
  type StorageRuntime,
} from "./src/runtime.ts";
import { resolveSecrets, SECRET_ENV } from "./src/signing.ts";
import type { StorageOptions } from "./src/types.ts";
import { db, installPostgres, openPostgres, type PostgresOptions } from "./src/postgres.ts";
import { createRealtimeChannel, installRealtime, RealtimeEngine } from "./src/realtime.ts";
import { createHub, handleRealtimeRequest, installRealtimeHub } from "./src/realtime-socket.ts";
import { postgresBus } from "./src/realtime-bus.ts";
import { channelPermissions } from "./src/realtime-authz.ts";
import {
  type RealtimeOptions,
  realtimeSchemaMigrations,
  resolveRealtime,
} from "./src/realtime-sql.ts";
import { resolveRest, type RestOptions, setupRest } from "./src/rest.ts";
import { deadlineHandler, surfaceDeadlines } from "./src/timeouts.ts";
import { type FunctionsOptions, resolveFunctions, setupFunctions } from "./src/functions.ts";
import { createFunctionsCommand } from "./src/functions-command.ts";
import {
  createBackendCommand,
  jwksResponse,
  setupSupabaseKeys,
  type SupabaseOptions,
} from "./src/supabase.ts";
import { installVault, vaultKeyedClient, vaultMigrations, type VaultOptions } from "./src/vault.ts";
import { vaultSqlMigrations } from "./src/vault-sql.ts";
import { ensureQueuesMigrated, installQueues, type QueuesOptions } from "./src/queues.ts";
import { queuesMigrations } from "./src/queues-sql.ts";
import {
  ensureWebhooksMigrated,
  installWebhooks,
  resolveWebhooks,
  startWebhookDelivery,
  webhooksMigrations,
  type WebhooksOptions,
} from "./src/webhooks.ts";
import { backendMigrationsOf, createDbHooks, installDbHooks } from "./src/db-command.ts";
import { seedBuckets } from "./src/storage-seed.ts";
import { createStorageCommand } from "./src/storage-command.ts";

export { backendAuthAdapter } from "./src/postgres.ts";
export type { BackendAuthAdapterOptions, PostgresOptions } from "./src/postgres.ts";
export { rlsMigrations, rlsSetupSql } from "./src/rls.ts";
export { storageMigrations } from "./src/storage-meta-pg.ts";
export type { StorageIdentity, StorageRole } from "./src/storage-identity.ts";
export { realtime, realtimeMigrations, realtimeSetupSql } from "./src/realtime-sql.ts";
export type {
  RealtimeLogicalOptions,
  RealtimeOptions,
  RealtimeRevalidateOptions,
  RealtimeSocketOptions,
  RealtimeTableOptions,
} from "./src/realtime-sql.ts";
export type { FilterOp, TableEvent } from "./src/realtime-shared.ts";
export type { RlsOptions } from "./src/rls.ts";
export type { RestOptions } from "./src/rest.ts";
export type { RestRateLimitOptions } from "./src/rest-limit.ts";
export type { FunctionConfig, FunctionsOptions } from "./src/functions.ts";
export type { SupabaseOptions } from "./src/supabase.ts";
export type { VaultOptions } from "./src/vault.ts";
export { vaultMigrations } from "./src/vault.ts";
export { vaultSqlMigrations } from "./src/vault-sql.ts";
export type { QueuesOptions } from "./src/queues.ts";
export { queuesMigrations, queuesSetupSql } from "./src/queues-sql.ts";
export type { WebhooksOptions, WebhookTarget } from "./src/webhooks.ts";
export { webhooksMigrations } from "./src/webhooks.ts";
export { vectorSearchSql } from "./src/vector.ts";
export type { VectorSearchSqlOptions } from "./src/vector.ts";
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
  BucketSettings,
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
  /**
   * Auto-REST: the schema's tables (those the `anon` / `authenticated` roles hold a privilege
   * on) served PostgREST-style under `/rest/v1/<table>` — filters, ordering, paging, inserts,
   * filtered updates and deletes — each statement run through `db()`, so row-level security
   * scopes it to the request's user. Row types are generated into `.denext/rest.ts`. Needs
   * `postgres`.
   */
  rest?: RestOptions;
  /**
   * The Supabase-compatible surface: `true` (keys from the environment) or the keys and the
   * `/auth/v1` options (`auth`). Installs the API keys (publishable / secret, and the legacy JWT
   * keys) and the JWT signing keys that `resolveIdentity()`, `db()` and `auth()` recognize,
   * serves GoTrue's `/auth/v1` over the `denextAuth()` users (with the JWKS at
   * `/auth/v1/.well-known/jwks.json`), and adds `denext backend keys`.
   */
  supabase?: boolean | SupabaseOptions;
  /**
   * Edge Functions: `functions/<name>.ts` (or `functions/<name>/index.ts`) served at
   * `/functions/v1/<name>` — what supabase-js's `functions.invoke` calls — each in a Deno Worker
   * of its own. A module that calls `Deno.serve(handler)` or default-exports a handler runs
   * unchanged. Callers need a valid identity unless `verifyJwt: false`. `{}` serves the
   * directory with the defaults.
   */
  functions?: FunctionsOptions;
  /**
   * Vault: secrets encrypted with AES-256-GCM in the app (key: `DENEXT_VAULT_KEY`) and stored in
   * `vault.secrets`, Supabase Vault's table shape — `vault` from `@denext/backend/server`. Needs
   * `postgres`.
   */
  vault?: VaultOptions;
  /**
   * Queues with pgmq's SQL API (no extension) and Supabase's `pgmq_public` wrappers — `queue()`,
   * `queues` and `queueConsumer()` from `@denext/backend/server`. Needs `postgres`.
   */
  queues?: QueuesOptions;
  /**
   * Database webhooks: `supabase_functions.http_request` triggers record changes, and the app
   * delivers them to the configured hooks, signed and retried. Needs `postgres`.
   */
  webhooks?: WebhooksOptions;
}

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/** Validate the bucket map and apply the defaults. */
function resolveBuckets(
  buckets: StorageOptions["buckets"],
  fallback: StorageOptions["authorize"],
): Map<string, ResolvedBucket> {
  const out = new Map<string, ResolvedBucket>();
  for (const [name, config] of Object.entries(buckets ?? {})) {
    checkBucketName(name);
    const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError(`backend(): bucket ${name}: maxBytes must be a positive integer`);
    }
    out.set(name, { ...config, name, maxBytes, authorize: config.authorize ?? fallback });
  }
  return out;
}

/** denext's default `requestTimeout` (the deadline the backend's surfaces extend). */
const DEFAULT_APP_TIMEOUT_MS = 30_000;

/** The app's request deadline: the config's, else `DENEXT_REQUEST_TIMEOUT_MS`, else 30 s. */
function appTimeoutMs(configured: number | undefined): number {
  if (configured !== undefined) return configured;
  const fromEnv = Number(env("DENEXT_REQUEST_TIMEOUT_MS"));
  return Number.isFinite(fromEnv) && fromEnv >= 0 && env("DENEXT_REQUEST_TIMEOUT_MS")
    ? fromEnv
    : DEFAULT_APP_TIMEOUT_MS;
}

/** Give the backend's surfaces their own request deadlines (`denext dev` / `denext start`). */
function setupDeadlines(
  ctx: PluginContext,
  surfaces: Omit<Parameters<typeof surfaceDeadlines>[0], "appTimeoutMs">,
): void {
  if (ctx.mode !== "dev" && ctx.mode !== "prod") return;
  const deadlines = surfaceDeadlines({
    ...surfaces,
    appTimeoutMs: appTimeoutMs(ctx.config.requestTimeout),
  });
  if (deadlines.length > 0) {
    ctx.addRequestHandler(deadlineHandler(deadlines, ctx.config.basePath ?? ""));
  }
}

/** The default sqlite metadata file (no Postgres), relative to the project root. */
const METADATA_FILE = ".denext-storage.db";

/** Where the Storage API is served, or `null` when it is off. */
function storageApiBase(api: StorageOptions["api"]): string | null {
  if (api === false) return null;
  const base = (typeof api === "object" ? api.basePath : undefined) ?? "/storage/v1";
  if (!/^\/[A-Za-z0-9._~\/-]*[^/]$/.test(base)) {
    throw new TypeError("backend(): storage.api.basePath must be a path like /storage/v1");
  }
  return base;
}

/**
 * The store, with the config-declared buckets seeded into it before its first use (once; a
 * failure is retried by the next call).
 */
function seededStore(store: MetaStore, rows: BucketWrite[]): MetaStore {
  let seeded: Promise<void> | undefined;
  const seed = () =>
    seeded ??= store.ready().then(() => store.syncBuckets(rows)).catch((err) => {
      seeded = undefined;
      throw err;
    });
  return new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function" || key === "close" || key === "ready") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => seed().then(() => value.apply(target, args));
    },
  });
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
  const resolved = resolveRealtime(options);
  if (resolved.socket) {
    const hub = createHub({
      engine,
      limits: resolved.socket,
      permissions: (scope, topic) =>
        channelPermissions(db.service(), scope, topic, resolved.queryTimeoutMs),
      bus: (handlers) =>
        postgresBus({
          client: () => db.service(),
          instance: crypto.randomUUID(),
          ready: () => engine.start(),
          handlers,
        }),
    });
    installRealtimeHub(hub);
    ctx.addRequestHandler(handleRealtimeRequest);
    ctx.addTeardown(async () => {
      await hub.stop();
      installRealtimeHub(undefined);
    });
  }
  if (ctx.mode !== "dev") return;
  const missing = "error" in slot
    ? slot.error.message
    : typeof slot.sql.listen !== "function"
    ? "this Postgres client has no listen() (LISTEN/NOTIFY)"
    : undefined;
  if (missing) console.warn(`[@denext/backend] realtime is unsupported here: ${missing}`);
}

/** Install the Supabase keys, `/auth/v1` (with the JWKS) and `denext backend keys`. */
async function setupSupabase(ctx: PluginContext, option: true | SupabaseOptions): Promise<void> {
  const supabase = option === true ? {} : option;
  const keys = await setupSupabaseKeys(ctx, supabase, env);
  const auth = { options: supabase.auth ?? {}, keys };
  // The SAML metadata refresh timer is background work: serving (dev/prod) only, not build/export.
  installGoTrue(auth, ctx.mode === "dev" || ctx.mode === "prod");
  installSupabaseAuthHooks(supabase.auth?.hooks);
  ctx.addTeardown(() => {
    installGoTrue(undefined);
    installSupabaseAuthHooks(undefined);
  });
  ctx.addRequestHandler((request) =>
    jwksResponse(request, keys) ?? handleGoTrueRequest(request, auth)
  );
  ctx.addCommand(createBackendCommand());
}

/** Open (or adopt) the Postgres client, then the services that run on it. */
function setupPostgres(
  ctx: PluginContext,
  options: BackendOptions,
  rest: ReturnType<typeof resolveRest> | undefined,
  webhooks: ReturnType<typeof resolveWebhooks> | undefined,
): void {
  const { slot, owned } = openPostgres(options.postgres!, env);
  installPostgres(slot);
  if (owned && "sql" in slot) ctx.addTeardown(() => slot.sql.close());
  if (options.realtime) setupRealtime(ctx, options.realtime, slot);
  if (rest) setupRest(ctx, rest, "sql" in slot ? slot.sql : undefined);
  installVault(options.vault);
  installQueues(options.queues);
  installWebhooks(webhooks);
  if (ctx.mode === "dev" || ctx.mode === "prod") {
    startServices(ctx, options, webhooks);
    ctx.addTeardown(registerHealthCheck("database", () => databaseReachable(slot)));
  }
}

/**
 * `/_denext/health`'s `database` check: `select 1` on the backend's client. A client that could
 * not be opened (no `DATABASE_URL`) is down too — every backend endpoint would fail.
 */
async function databaseReachable(slot: ReturnType<typeof openPostgres>["slot"]): Promise<boolean> {
  if (!("sql" in slot)) return false;
  await slot.sql`select 1`;
  return true;
}

/**
 * The hooks `denext db` / `denext migration` read: the backend's own migrations (applied before
 * the app's), its service schemas, and the Postgres tooling (`diff`, `lint`, `inspect`, …).
 */
function installDbHooksFor(
  ctx: PluginContext,
  options: BackendOptions,
  webhooks: ReturnType<typeof resolveWebhooks> | undefined,
): void {
  const on = { vault: !!options.vault, queues: !!options.queues, webhooks: !!webhooks };
  const postgres = !!options.postgres;
  // The realtime schema and publication (not the per-table triggers, which need the app's
  // tables) when the server would migrate them.
  const realtimeOptions = options.realtime?.migrate !== false ? options.realtime : undefined;
  installDbHooks(createDbHooks(
    {
      backendMigrations: () =>
        postgres
          ? backendMigrationsOf([
            realtimeOptions ? () => realtimeSchemaMigrations(realtimeOptions) : () => [],
            on.vault ? vaultMigrations : () => [],
            options.vault?.sql ? vaultSqlMigrations : () => [],
            on.queues ? queuesMigrations : () => [],
            on.webhooks ? webhooksMigrations : () => [],
          ])
          : [],
      // Storage's metadata lives on the backend's Postgres: its schema, in its own table.
      migrationSets: () =>
        postgres && options.storage
          ? [{ table: STORAGE_MIGRATIONS_TABLE, migrations: storageMigrations() }]
          : [],
      serviceSchemas: [
        ...(on.vault ? ["vault"] : []),
        ...(on.queues ? ["pgmq", "pgmq_public"] : []),
        ...(on.webhooks ? ["supabase_functions"] : []),
      ],
      keyed: options.vault?.sql ? vaultKeyedClient : undefined,
      seedBuckets: options.storage ? seedBuckets : undefined,
    },
    undefined,
    postgres,
  ));
  ctx.addTeardown(() => installDbHooks(undefined));
}

/**
 * At server start: apply the queues and webhooks migrations (so a migration that creates a
 * webhook trigger finds `supabase_functions.http_request`), and start webhook delivery.
 */
function startServices(
  ctx: PluginContext,
  options: BackendOptions,
  webhooks: ReturnType<typeof resolveWebhooks> | undefined,
): void {
  const warn = (what: string) => (error: unknown) =>
    console.warn(
      `[@denext/backend] ${what}: ${(error as Error)?.message ?? error} (retried on first use)`,
    );
  if (options.queues && options.queues.migrate !== false) {
    Promise.resolve().then(() => ensureQueuesMigrated(db.service())).catch(warn("queues"));
  }
  if (!webhooks) return;
  if (webhooks.migrate) {
    Promise.resolve().then(() => ensureWebhooksMigrated(db.service())).catch(warn("webhooks"));
  }
  if (webhooks.delivery === "auto") ctx.addTeardown(startWebhookDelivery(webhooks));
}

/** The services that run on Postgres refuse a config without it. */
function checkNeedsPostgres(options: BackendOptions): void {
  if (options.postgres) return;
  if (options.storage?.rls) throw new TypeError("backend(): storage.rls needs `postgres`");
  for (const service of ["realtime", "rest", "vault", "queues", "webhooks"] as const) {
    if (options[service]) throw new TypeError(`backend(): ${service} needs \`postgres\``);
  }
}

/** `denext functions`, and the functions themselves under `denext dev` / `denext start`. */
async function setupFunctionsService(
  ctx: PluginContext,
  functions: ReturnType<typeof resolveFunctions>,
): Promise<void> {
  ctx.addCommand(createFunctionsCommand(functions));
  if (ctx.mode === "dev" || ctx.mode === "prod") await setupFunctions(ctx, functions);
}

/**
 * Create the backend plugin. Place it in your `denext.config.ts` `plugins`.
 *
 * @param options The services to enable (`storage`, `postgres`, `realtime`, `rest`).
 * @returns The plugin.
 */
export function backend(options: BackendOptions = {}): DenextPlugin {
  const storageOptions = options.storage;
  if (storageOptions && !storageOptions.driver) {
    throw new TypeError("backend(): storage.driver is required (s3({ … }) or fs({ dir }))");
  }
  const buckets = storageOptions
    ? resolveBuckets(storageOptions.buckets, storageOptions.authorize)
    : undefined;
  checkNeedsPostgres(options);
  const apiBase = storageOptions ? storageApiBase(storageOptions.api) : null;
  if (options.realtime) resolveRealtime(options.realtime);
  const rest = options.rest ? resolveRest(options.rest) : undefined;
  const functions = options.functions ? resolveFunctions(options.functions) : undefined;
  const webhooks = options.webhooks ? resolveWebhooks(options.webhooks, env) : undefined;
  return {
    name: "@denext/backend",
    async setup(ctx: PluginContext) {
      // First, so it runs before the handler that answers the request.
      setupDeadlines(ctx, {
        functions,
        rest,
        storage: storageOptions !== undefined,
        storageApiBase: apiBase,
      });
      if (options.supabase) await setupSupabase(ctx, options.supabase);
      if (options.postgres) setupPostgres(ctx, options, rest, webhooks);
      if (options.postgres || options.storage) installDbHooksFor(ctx, options, webhooks);
      if (functions) await setupFunctionsService(ctx, functions);
      if (storageOptions && buckets) {
        await setupStorage(ctx, storageOptions, buckets, apiBase, options.postgres !== undefined);
      }
    },
  };
}

/** Install storage: the secret, the driver, the metadata store, the runtime and its handlers. */
async function setupStorage(
  ctx: PluginContext,
  storageOptions: StorageOptions,
  buckets: Map<string, ResolvedBucket>,
  apiBase: string | null,
  postgres: boolean,
): Promise<void> {
  const dev = ctx.mode === "dev";
  const secrets = resolveSecrets(storageOptions.secret, env, dev);
  if (dev && storageOptions.secret === undefined && !env(SECRET_ENV)) {
    console.warn(
      `[@denext/backend] no ${SECRET_ENV}: signed storage URLs use a random dev secret and stop working on restart`,
    );
  }
  await storageOptions.driver.init?.({ projectRoot: ctx.projectRoot });
  const meta = seededStore(
    postgres ? postgresMetaStore() : sqliteMetaStore(
      resolvePath(ctx.projectRoot, storageOptions.metadataPath ?? METADATA_FILE),
    ),
    declaredBucketRows(buckets),
  );
  ctx.addTeardown(() => meta.close?.());
  const rt: StorageRuntime = {
    driver: storageOptions.driver,
    buckets,
    secrets,
    basePath: (ctx.config.basePath ?? "").replace(/\/$/, ""),
    images: ctx.config.images,
    multipartThreshold: storageOptions.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD,
    partSize: Math.max(storageOptions.partSize ?? DEFAULT_PART_SIZE, MIN_PART_SIZE),
    meta,
    rls: storageOptions.rls === true,
    authorize: storageOptions.authorize,
    apiBase,
    maxTransformDimension: storageOptions.maxTransformDimension ?? 2500,
  };
  rt.admin = storageAdmin(rt);
  installRuntime(rt);
  ctx.addCommand(createStorageCommand());
  ctx.addRequestHandler(handleStorageRequest);
  if (apiBase) ctx.addRequestHandler((request) => handleStorageApi(rt, request));
}
