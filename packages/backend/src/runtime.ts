// The configured storage, shared through a process-global slot: the plugin installs it at
// setup (from `denext.config.ts`), and `storage` from `@denext/backend/server` reads it from
// the app's own modules — which a production build may have bundled into a separate copy of
// this package, so a module-level variable would not be seen there.

import type { ImagesConfig } from "@denext/denext/server";
import { StorageError } from "./errors.ts";
import type {
  BucketRow,
  LifecycleConfiguration,
  MetaStore,
  VersioningStatus,
} from "./storage-meta.ts";
import type { BucketConfig, StorageAuthorizeContext, StorageDriver } from "./types.ts";

/** Default per-bucket size cap: 50 MiB. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** Default multipart threshold: 64 MiB. */
export const DEFAULT_MULTIPART_THRESHOLD = 64 * 1024 * 1024;
/** Default multipart part size: 16 MiB. */
export const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
/** S3's smallest part (all but the last). */
export const MIN_PART_SIZE = 5 * 1024 * 1024;
/** The longest a signed URL may live: 7 days (S3's own limit). */
const MAX_EXPIRES = 7 * 24 * 3600;

/** A bucket's resolved rules. */
export interface ResolvedBucket extends BucketConfig {
  /** The bucket name. */
  name: string;
  /** The size cap (default applied). */
  maxBytes: number;
  /** Object versioning (the bucket row's; `DISABLED` before the row is read). */
  versioning?: VersioningStatus;
  /** The lifecycle policy (noncurrent-version expiration), or `null`. */
  lifecycle?: LifecycleConfiguration | null;
}

/** The installed storage. */
export interface StorageRuntime {
  driver: StorageDriver;
  buckets: Map<string, ResolvedBucket>;
  /** Signing secrets, current first; `null` when none is configured (outside dev). */
  secrets: string[] | null;
  /** The app's `basePath` (no trailing slash). */
  basePath: string;
  /** The app's `images` config (transform allowlists). */
  images?: ImagesConfig;
  multipartThreshold: number;
  partSize: number;
  /** The metadata store (buckets, objects, resumable uploads). */
  meta: MetaStore;
  /** SQL-RLS mode: the `storage` tables' policies decide (Postgres only). */
  rls: boolean;
  /** The rule for a bucket created at runtime (or declared without its own `authorize`). */
  authorize?: (context: StorageAuthorizeContext) => boolean | Promise<boolean>;
  /** Where the Supabase-compatible API is served (`/storage/v1`), or `null` when it is off. */
  apiBase: string | null;
  /** The largest width or height the API's render routes produce. */
  maxTransformDimension: number;
  /**
   * Operations for `denext ui`'s Database → Storage page (it reaches the runtime through the
   * process-global slot, so it uses the same rules and metadata rows as the app).
   */
  admin?: StorageAdmin;
}

/** What `denext ui` uses: every bucket (declared and runtime), and removal through the ops. */
export interface StorageAdmin {
  /** Every bucket: declared ones first, then the runtime ones. */
  buckets(): Promise<{ name: string; public: boolean; maxBytes: number; mime: string[] | null }[]>;
  /** Whether a bucket exists (declared or runtime). */
  hasBucket(name: string): Promise<boolean>;
  /** Remove one object as the service (its metadata row with it). */
  remove(bucket: string, key: string): Promise<void>;
}

const SLOT = Symbol.for("denext.backend.storage");
type Slot = { [SLOT]?: StorageRuntime };

/**
 * Install the storage runtime (plugin setup), or clear it with `undefined` (tests).
 *
 * @param runtime The runtime.
 */
export function installRuntime(runtime: StorageRuntime | undefined): void {
  (globalThis as Slot)[SLOT] = runtime;
}

/**
 * The installed runtime.
 *
 * @returns The runtime.
 * @throws {StorageError} `not_configured` when the plugin has not set storage up.
 */
export function runtime(): StorageRuntime {
  const rt = (globalThis as Slot)[SLOT];
  if (!rt) {
    throw new StorageError(
      "not_configured",
      "storage is not configured: add backend({ storage }) to denext.config.ts plugins",
    );
  }
  return rt;
}

/**
 * A configured bucket.
 *
 * @param rt The runtime.
 * @param name The bucket name.
 * @returns Its rules.
 * @throws {StorageError} `unknown_bucket`.
 */
export function bucketOf(rt: StorageRuntime, name: string): ResolvedBucket {
  const bucket = typeof name === "string" ? rt.buckets.get(name) : undefined;
  if (!bucket) throw new StorageError("unknown_bucket", `unknown bucket ${JSON.stringify(name)}`);
  return bucket;
}

/** How long a runtime bucket's row is reused before it is read again (ms). */
const BUCKET_TTL = 2000;
const bucketCache = new WeakMap<
  StorageRuntime,
  Map<string, { at: number; bucket: ResolvedBucket | null }>
>();

/**
 * A bucket's rules: a config-declared bucket, else a bucket created at runtime (its
 * `storage.buckets` row, cached for a moment).
 *
 * @param rt The runtime.
 * @param name The bucket name.
 * @returns Its rules.
 * @throws {StorageError} `unknown_bucket`.
 */
export async function resolveBucket(rt: StorageRuntime, name: string): Promise<ResolvedBucket> {
  const declared = typeof name === "string" ? rt.buckets.get(name) : undefined;
  if (!declared && (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name))) {
    throw new StorageError("unknown_bucket", `unknown bucket ${JSON.stringify(name)}`);
  }
  let cache = bucketCache.get(rt);
  if (!cache) bucketCache.set(rt, cache = new Map());
  const hit = cache.get(name);
  let bucket = hit && Date.now() - hit.at < BUCKET_TTL ? hit.bucket : undefined;
  if (bucket === undefined) {
    bucket = bucketFrom(rt, name, declared, await rt.meta.getBucket(name, { kind: "service" }));
    cache.set(name, { at: Date.now(), bucket });
  }
  if (!bucket) throw new StorageError("unknown_bucket", `unknown bucket ${JSON.stringify(name)}`);
  return bucket;
}

/** A bucket's rules from its declaration (when it has one) and its row. */
function bucketFrom(
  rt: StorageRuntime,
  name: string,
  declared: ResolvedBucket | undefined,
  row: BucketRow | null,
): ResolvedBucket | null {
  if (declared) {
    return {
      ...declared,
      versioning: row?.versioning_status ?? declaredVersioning(declared),
      lifecycle: row?.lifecycle ?? null,
    };
  }
  if (!row) return null;
  return {
    name,
    public: row.public,
    maxBytes: row.file_size_limit ?? DEFAULT_MAX_BYTES,
    mime: row.allowed_mime_types ?? undefined,
    authorize: rt.authorize,
    versioning: row.versioning_status,
    lifecycle: row.lifecycle,
  };
}

/** A declared bucket's versioning before its row says otherwise. */
function declaredVersioning(bucket: ResolvedBucket): VersioningStatus {
  return bucket.versioned === true ? "ENABLED" : "DISABLED";
}

/**
 * Forget a cached runtime bucket (after this process changed or deleted it).
 *
 * @param rt The runtime.
 * @param name The bucket name.
 */
export function forgetBucket(rt: StorageRuntime, name: string): void {
  bucketCache.get(rt)?.delete(name);
}

/**
 * The signing secrets.
 *
 * @param rt The runtime.
 * @returns The secrets.
 * @throws {StorageError} `not_configured` when none is set.
 */
export function secretsOf(rt: StorageRuntime): string[] {
  if (!rt.secrets) {
    throw new StorageError(
      "not_configured",
      "storage needs a signing secret: set DENEXT_STORAGE_SECRET (≥ 32 characters) or storage.secret",
    );
  }
  return rt.secrets;
}

/**
 * Clamp a requested lifetime to 1 s … 7 days.
 *
 * @param requested Seconds, or `undefined` for the default.
 * @param fallback The default.
 * @returns The lifetime.
 */
export function clampExpiry(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback;
  if (!Number.isFinite(value) || value < 1) {
    throw new StorageError("bad_request", "expiresIn must be a positive number of seconds");
  }
  return Math.min(Math.trunc(value), MAX_EXPIRES);
}
