/**
 * `@denext/backend` — your app's backend services as one opt-in plugin, self-hosted inside the
 * app. This release ships **storage**: buckets with per-bucket rules, signed upload and
 * download URLs, multipart uploads, image transforms on download, and session-aware access
 * checks — on S3 (AWS, Cloudflare R2, MinIO) or the local filesystem, with zero npm.
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
 * Server code uses `storage` from `@denext/backend/server`; the browser uses `uploadFile` and
 * `getFileUrl` from `@denext/backend/client`.
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

/**
 * Create the backend plugin. Place it in your `denext.config.ts` `plugins`.
 *
 * @param options The services to enable (`storage`).
 * @returns The plugin.
 */
export function backend(options: BackendOptions = {}): DenextPlugin {
  const storageOptions = options.storage;
  if (storageOptions && !storageOptions.driver) {
    throw new TypeError("backend(): storage.driver is required (s3({ … }) or fs({ dir }))");
  }
  const buckets = storageOptions ? resolveBuckets(storageOptions.buckets) : undefined;
  return {
    name: "@denext/backend",
    async setup(ctx: PluginContext) {
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
