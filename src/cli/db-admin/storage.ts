// The storage half of the Database section: the buckets `backend({ storage })` declares and the
// objects in them, through the very driver the app uses. The plugin installs its storage in a
// process-global slot at setup (`Symbol.for("denext.backend.storage")`, the slot the app's own
// `storage` reads), so after the child has set the project's plugins up the driver and buckets
// are there — described structurally here, since denext does not depend on the package.

import { encodeBase64 } from "@std/encoding/base64";
import {
  DB_DOWNLOAD_MAX_BYTES,
  DB_OBJECTS_PAGE,
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

/** The installed storage. */
interface StorageRuntime {
  driver: Driver;
  buckets: Map<string, Bucket>;
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

/** The runtime and one declared bucket (a name the config does not declare is refused). */
function bucketOf(name: string): { rt: StorageRuntime; bucket: Bucket } {
  const rt = runtime();
  if (!rt) throw new AdminRefusal("not_found", "this project declares no storage");
  const bucket = typeof name === "string" ? rt.buckets.get(name) : undefined;
  if (!bucket) throw new AdminRefusal("not_found", `no bucket ${JSON.stringify(name)}`);
  return { rt, bucket };
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
): Promise<{ rt: StorageRuntime; bucket: Bucket; info: ObjectInfo }> {
  const { rt, bucket } = bucketOf(name);
  const info = await rt.driver.head(bucket.name, checkKey(key));
  if (!info) throw new AdminRefusal("not_found", `no object ${JSON.stringify(key)}`);
  return { rt, bucket, info };
}

/**
 * The declared buckets.
 *
 * @returns The driver's name and each bucket's rules.
 */
export function listBuckets(): DbReplies["buckets"] {
  const rt = runtime();
  if (!rt) return { driver: null, buckets: [] };
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
  const { rt, bucket } = bucketOf(name);
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
  if (confirm) await rt.driver.remove(bucket.name, key);
  return { bucket: bucket.name, key, applied: confirm };
}
