// The storage half of the Database section: the app's buckets — declared in `backend({ storage })`
// or created at runtime — and the objects in them, through the very driver the app uses; a
// removal goes through the plugin's own storage operations (its `admin` hooks), so the object's
// metadata row goes with its bytes. The plugin installs its storage in a
// process-global slot at setup (`Symbol.for("denext.backend.storage")`, the slot the app's own
// `storage` reads), so after the child has set the project's plugins up the driver and buckets
// are there — described structurally here, since denext does not depend on the package.

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import {
  DB_DOWNLOAD_MAX_BYTES,
  DB_OBJECTS_PAGE,
  DB_UPLOAD_MAX_BYTES,
  type DbReplies,
} from "../../ui/database/protocol.ts";
import { AdminRefusal, assertWritable } from "./tables.ts";

/** The parts of an object's info the admin reads. */
interface ObjectInfo {
  key: string;
  size: number;
  contentType?: string;
  lastModified?: Date;
}

/** The parts of a `@denext/backend` storage driver the admin uses. */
interface Driver {
  readonly name: string;
  head(bucket: string, key: string): Promise<ObjectInfo | null>;
  get(
    bucket: string,
    key: string,
  ): Promise<(ObjectInfo & { body: ReadableStream<Uint8Array> }) | null>;
  remove(bucket: string, key: string): Promise<void>;
  list(
    bucket: string,
    prefix: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ objects: ObjectInfo[]; cursor?: string }>;
}

/** A bucket's rules, as the plugin resolved them. */
interface Bucket {
  name: string;
  public?: boolean;
  maxBytes: number;
  mime?: string[];
}

/** How an upload is stored: its type, and whether it may replace an object. */
type UploadOptions = { contentType?: string; upsert: boolean };

/** Stores one object as the service (`@denext/backend` 0.5.0 on). */
type Upload = (
  bucket: string,
  key: string,
  bytes: Uint8Array,
  options: UploadOptions,
) => Promise<{ key: string; size: number }>;

/** The plugin's operations for this page (`@denext/backend` ≥ the release that added them). */
interface StorageAdmin {
  buckets(): Promise<{ name: string; public: boolean; maxBytes: number; mime: string[] | null }[]>;
  hasBucket(name: string): Promise<boolean>;
  remove(bucket: string, key: string): Promise<void>;
  upload?: Upload;
}

/** The installed storage. */
interface StorageRuntime {
  driver: Driver;
  buckets: Map<string, Bucket>;
  admin?: StorageAdmin;
}

const SLOT = Symbol.for("denext.backend.storage");

/** The installed storage, or `null` when the project declares none. */
function runtime(): StorageRuntime | null {
  return (globalThis as { [SLOT]?: StorageRuntime })[SLOT] ?? null;
}

/** Whether the project declares storage. */
export function hasStorage(): boolean {
  return runtime() !== null;
}

/** The runtime and one bucket — declared, or created at runtime (an unknown name is refused). */
async function bucketOf(name: string): Promise<{ rt: StorageRuntime; bucket: { name: string } }> {
  const rt = runtime();
  if (!rt) throw new AdminRefusal("not_found", "this project declares no storage");
  const declared = typeof name === "string" ? rt.buckets.get(name) : undefined;
  if (declared) return { rt, bucket: declared };
  if (typeof name === "string" && await rt.admin?.hasBucket(name)) return { rt, bucket: { name } };
  throw new AdminRefusal("not_found", `no bucket ${JSON.stringify(name)}`);
}

/** An object key the admin will pass to the driver. */
function checkKey(key: string): string {
  if (typeof key !== "string" || key === "" || key.length > 1024 || key.includes("\0")) {
    throw new AdminRefusal("bad_request", "bad object key");
  }
  return key;
}

/** A declared bucket and an object in it that exists. */
async function existing(
  name: string,
  key: string,
): Promise<{ rt: StorageRuntime; bucket: { name: string }; info: ObjectInfo }> {
  const { rt, bucket } = await bucketOf(name);
  const info = await rt.driver.head(bucket.name, checkKey(key));
  if (!info) throw new AdminRefusal("not_found", `no object ${JSON.stringify(key)}`);
  return { rt, bucket, info };
}

/**
 * The buckets: declared and created at runtime.
 *
 * @returns The driver's name and each bucket's rules.
 */
export async function listBuckets(): Promise<DbReplies["buckets"]> {
  const rt = runtime();
  if (!rt) return { driver: null, buckets: [] };
  if (rt.admin) return { driver: rt.driver.name, buckets: await rt.admin.buckets() };
  return {
    driver: rt.driver.name,
    buckets: [...rt.buckets.values()].map((b) => ({
      name: b.name,
      public: b.public === true,
      maxBytes: b.maxBytes,
      mime: b.mime ?? null,
    })),
  };
}

/**
 * One page of a bucket's objects.
 *
 * @param name The bucket.
 * @param prefix Only keys starting with this.
 * @param cursor The previous page's cursor.
 * @returns The objects and the next cursor.
 */
export async function listObjects(
  name: string,
  prefix = "",
  cursor?: string,
): Promise<DbReplies["objects"]> {
  const { rt, bucket } = await bucketOf(name);
  const page = await rt.driver.list(bucket.name, String(prefix), {
    limit: DB_OBJECTS_PAGE,
    ...(cursor ? { cursor: String(cursor) } : {}),
  });
  return {
    bucket: bucket.name,
    objects: page.objects.map((o) => ({
      key: o.key,
      size: o.size,
      ...(o.contentType ? { contentType: o.contentType } : {}),
      ...(o.lastModified ? { lastModified: new Date(o.lastModified).toISOString() } : {}),
    })),
    ...(page.cursor ? { cursor: page.cursor } : {}),
  };
}

/** Read a stream whole, refusing past `max` bytes. */
async function readAll(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > max) {
      await body.cancel().catch(() => {});
      throw new AdminRefusal("bad_request", "the object is larger than the UI downloads");
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * One object's bytes, base64 — up to {@linkcode DB_DOWNLOAD_MAX_BYTES}.
 *
 * @param name The bucket.
 * @param key The object's key.
 * @returns The object.
 */
export async function downloadObject(name: string, key: string): Promise<DbReplies["download"]> {
  const { rt, bucket, info } = await existing(name, key);
  if (info.size > DB_DOWNLOAD_MAX_BYTES) {
    throw new AdminRefusal(
      "bad_request",
      `the object is ${info.size} bytes; the UI downloads at most ${DB_DOWNLOAD_MAX_BYTES}`,
    );
  }
  const object = await rt.driver.get(bucket.name, key);
  if (!object) throw new AdminRefusal("not_found", `no object ${JSON.stringify(key)}`);
  const bytes = await readAll(object.body, DB_DOWNLOAD_MAX_BYTES);
  return {
    key,
    contentType: object.contentType || "application/octet-stream",
    size: bytes.length,
    base64: encodeBase64(bytes),
  };
}

/**
 * Preview or delete one object.
 *
 * @param name The bucket.
 * @param key The object's key.
 * @param confirm Delete (otherwise only check it exists).
 * @param readOnly `--read-only`: refused.
 * @returns What was (or would be) deleted.
 */
export async function removeObject(
  name: string,
  key: string,
  confirm: boolean,
  readOnly: boolean,
): Promise<DbReplies["removeObject"]> {
  assertWritable(readOnly);
  const { rt, bucket } = await existing(name, key);
  if (confirm) {
    if (rt.admin) await rt.admin.remove(bucket.name, key);
    else await rt.driver.remove(bucket.name, key);
  }
  return { bucket: bucket.name, key, applied: confirm };
}

/** The longest content type an upload may name. */
const MAX_CONTENT_TYPE = 255;

/**
 * Upload one object through the plugin's own operations (as the service), so the bucket's size
 * cap and type allow-list apply and the metadata row is written with the bytes.
 *
 * @param name The bucket.
 * @param key The object's key.
 * @param base64 Its bytes, base64.
 * @param options Its content type, and whether an existing object may be replaced.
 * @param readOnly `--read-only`: refused.
 * @returns The stored object.
 */
export async function uploadObject(
  name: string,
  key: string,
  base64: string,
  options: UploadOptions,
  readOnly: boolean,
): Promise<DbReplies["upload"]> {
  assertWritable(readOnly);
  const { rt, bucket } = await bucketOf(name);
  checkKey(key);
  if (!rt.admin?.upload) {
    throw new AdminRefusal(
      "unsupported",
      "uploading needs a newer @denext/backend (its storage admin has no upload)",
    );
  }
  if (typeof base64 !== "string" || base64.length > Math.ceil(DB_UPLOAD_MAX_BYTES / 3) * 4) {
    throw new AdminRefusal("bad_request", `the UI uploads at most ${DB_UPLOAD_MAX_BYTES} bytes`);
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64);
  } catch {
    throw new AdminRefusal("bad_request", "the upload is not valid base64");
  }
  const type = typeof options.contentType === "string" && options.contentType !== ""
    ? options.contentType.slice(0, MAX_CONTENT_TYPE)
    : undefined;
  const stored = await rt.admin.upload(bucket.name, key, bytes, {
    ...(type ? { contentType: type } : {}),
    upsert: options.upsert === true,
  });
  return { bucket: bucket.name, key: stored.key, size: stored.size };
}
