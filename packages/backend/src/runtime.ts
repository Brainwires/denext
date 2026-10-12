// The configured storage, shared through a process-global slot: the plugin installs it at
// setup (from `denext.config.ts`), and `storage` from `@denext/backend/server` reads it from
// the app's own modules — which a production build may have bundled into a separate copy of
// this package, so a module-level variable would not be seen there.

import type { ImagesConfig } from "@denext/denext/server";
import { StorageError } from "./errors.ts";
import type { BucketConfig, StorageDriver } from "./types.ts";

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
