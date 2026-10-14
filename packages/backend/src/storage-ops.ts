// The storage operations both the server API (`storage.bucket(n)…`) and the Supabase-compatible
// `/storage/v1` routes run: who is asking (a `Caller`), whether they may (the bucket's TypeScript
// `authorize`, and — in the SQL-RLS mode — the `storage` tables' policies, through a scoped
// client), and the writes that keep the bytes (the driver) and the rows (the metadata store) in
// step: an upload reserves its row first (so a duplicate or a refused policy stores nothing),
// stores the bytes through the size cap, allow-list and sniffing, then fills the row in. Under
// SQL-RLS a request's user writes through a staging place instead: the row is written under its
// role against the object as it is then, and only that write moves the bytes to the key.

import { StorageError } from "./errors.ts";
import { checkBucketName, normalizeKey } from "./keys.ts";
import { checkSniffed, essence, mimeAllowed, SNIFF_BYTES, sniffMime } from "./mime.ts";
import { resolveScope } from "./postgres.ts";
import { identityScope } from "./identity.ts";
import {
  DEFAULT_MAX_BYTES,
  forgetBucket,
  resolveBucket,
  type ResolvedBucket,
  type StorageAdmin,
  type StorageRuntime,
} from "./runtime.ts";
import { SERVICE_IDENTITY, type StorageIdentity, storageIdentity } from "./storage-identity.ts";
import {
  type Actor,
  type BucketQuery,
  type BucketRow,
  type BucketWrite,
  type FlatQuery,
  type LifecycleConfiguration,
  type ListEntry,
  type ListQuery,
  type ObjectMetadata,
  type ObjectRow,
  type ObjectWrite,
  SERVICE,
  type VersioningStatus,
} from "./storage-meta.ts";
import { limit, peek } from "./streams.ts";
import {
  commitStaged,
  deleteCurrent,
  deleteVersion,
  dropVersionBytes,
  isVersioned,
  type Location,
  locationOf,
  parseLifecycle,
  prepareOverwrite,
  replaceVersioned,
  stagesWrite,
  stagingLocation,
} from "./storage-versions.ts";
import type { BucketSettings, ObjectInfo, StorageOp } from "./types.ts";

type ContextBridge = { __denextCurrentRequestContext?: () => { request?: Request } | undefined };

/**
 * The request being served, or `null` outside any request (a job, a script, module load).
 *
 * @returns The current request.
 */
function currentRequest(): Request | null {
  return (globalThis as ContextBridge).__denextCurrentRequestContext?.()?.request ?? null;
}

const identities = new WeakMap<Request, Promise<StorageIdentity>>();

/** Who a storage operation is done for: the server itself (`service`), or a request's caller. */
export class Caller {
  /** Whether this is the server acting for itself (no `authorize`, no policies). */
  readonly service: boolean;
  /** The request, or `null` outside one. */
  readonly request: Request | null;

  /**
   * @param service The server acting for itself.
   * @param request The request being served.
   */
  constructor(service: boolean, request: Request | null) {
    this.service = service;
    this.request = request;
  }

  /** The caller's identity, resolved once per request. */
  identity(): Promise<StorageIdentity> {
    if (this.service || !this.request) return Promise.resolve(SERVICE_IDENTITY);
    let pending = identities.get(this.request);
    if (!pending) {
      pending = storageIdentity(this.request);
      identities.set(this.request, pending);
      pending.catch(() => identities.delete(this.request!));
    }
    return pending;
  }

  /** Whether the caller holds the service role (the server, or the secret key). */
  async isService(): Promise<boolean> {
    if (this.service) return true;
    if (!this.request) return false;
    return (await this.identity()).role === "service_role";
  }
}

/** The server API's caller: the current request's, or the service. */
export function serverCaller(service: boolean): Caller {
  return new Caller(service, currentRequest());
}

/** The service caller (a signed token already authorized this; the server acting for itself). */
export const SERVICE_CALLER: Caller = new Caller(true, null);

/**
 * Enforce one operation's TypeScript rule. A service caller is never checked; a public bucket's
 * downloads are open; otherwise the bucket's `authorize` must return `true` (absent → denied) —
 * except in the SQL-RLS mode, where an absent `authorize` defers to the policies (checked by the
 * statement that follows). Outside any request there is no one to authorize, so it is refused.
 *
 * @param rt The runtime.
 * @param bucket The bucket.
 * @param op The operation.
 * @param key The key (or prefix).
 * @param caller Who is asking.
 * @throws {StorageError} `forbidden`.
 */
export async function authorizeOp(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  op: StorageOp,
  key: string,
  caller: Caller,
): Promise<void> {
  if (caller.service) return;
  if (op === "download" && bucket.public) return;
  const request = caller.request;
  if (!request) {
    throw new StorageError(
      "forbidden",
      `${op} on ${bucket.name}/${key} outside a request has no session to authorize: ` +
        `use storage.bucket(${JSON.stringify(bucket.name)}, { service: true }) in a job or script`,
    );
  }
  const identity = await caller.identity();
  if (identity.role === "service_role") return;
  if (rt.rls && !bucket.authorize) return;
  const allowed = bucket.authorize
    ? await bucket.authorize({
      session: identity.session,
      identity,
      op,
      key,
      bucket: bucket.name,
      request,
    })
    : false;
  if (allowed !== true) {
    throw new StorageError("forbidden", `${op} is not allowed on ${bucket.name}/${key}`);
  }
}

/**
 * Who the metadata statements run as: the service, unless the SQL-RLS mode is on and the caller
 * is a request's `anon` or `authenticated` user.
 *
 * @param rt The runtime.
 * @param caller Who is asking.
 * @returns The actor.
 */
export async function actorFor(rt: StorageRuntime, caller: Caller): Promise<Actor> {
  if (!rt.rls || caller.service || !caller.request) return SERVICE;
  const identity = await caller.identity();
  if (identity.role === "service_role") return SERVICE;
  // A denext session's scope carries the app's own extra claims (`rls.claims`).
  const scope = identity.session
    ? await resolveScope(identity.session)
    : identityScope({ ...identity, session: undefined });
  return { kind: "scoped", scope };
}

/** The owner recorded on what the caller writes: its user id, or `null`. */
async function ownerOf(caller: Caller): Promise<string | null> {
  if (caller.service || !caller.request) return null;
  return (await caller.identity()).userId ?? null;
}

/**
 * Check a declared content type against a bucket's allow-list.
 *
 * @param bucket The bucket.
 * @param contentType The declared type.
 * @returns The type's essence.
 */
export function checkContentType(bucket: ResolvedBucket, contentType: string): string {
  const type = typeof contentType === "string" ? essence(contentType) : "";
  if (!type) throw new StorageError("bad_request", "a valid content type is required");
  if (!mimeAllowed(type, bucket.mime)) {
    throw new StorageError(
      "mime_not_allowed",
      `mime type ${type} is not allowed in ${bucket.name}`,
    );
  }
  return type;
}

/**
 * Store a body after checking its content: sniff the head against the declared type, then
 * stream it through the size cap (and the exact size, when declared) into the driver.
 *
 * @param rt The runtime.
 * @param bucket The bucket.
 * @param key The normalized key.
 * @param stream The body.
 * @param contentType The declared type (essence), or `undefined` to sniff one.
 * @param max The size cap.
 * @param size The exact size, if declared.
 * @param at Where to write the bytes instead of the object's key (a staged upload's place).
 * @returns The stored object's info.
 */
export async function storeChecked(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  contentType: string | undefined,
  max: number,
  size?: number,
  at?: Location,
): Promise<ObjectInfo> {
  const peeked = await peek(stream, SNIFF_BYTES);
  const type = contentType ??
    checkContentType(bucket, sniffMime(peeked.head) ?? "application/octet-stream");
  checkSniffed(type, peeked.head, bucket.mime);
  const target = at ?? { bucket: bucket.name, key };
  return await rt.driver.put(target.bucket, target.key, limit(peeked.stream, max, size), {
    contentType: type,
    size,
  });
}

/**
 * The `metadata` an object row carries for what the driver stored.
 *
 * @param info The stored object.
 * @param cacheControl Its `Cache-Control`.
 * @returns The metadata.
 */
export function metadataOf(info: ObjectInfo, cacheControl: string): ObjectMetadata {
  return {
    eTag: `"${info.etag ?? ""}"`,
    size: info.size,
    mimetype: info.contentType,
    cacheControl,
    lastModified: (info.lastModified ?? new Date()).toISOString(),
    contentLength: info.size,
    httpStatusCode: 200,
  };
}

/** The default `Cache-Control` of an uploaded object (Supabase's). */
const DEFAULT_CACHE_CONTROL = "max-age=3600";

/**
 * A `Cache-Control` value as uploads give it: `3600` (supabase-js's form field) or a directive
 * list (`max-age=3600, public`).
 *
 * @param value The value, or `null` for the default.
 * @returns The directive list.
 */
export function cacheControlOf(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return DEFAULT_CACHE_CONTROL;
  if (/^\d{1,10}$/.test(value)) return `max-age=${value}`;
  if (!/^[A-Za-z0-9=,\- ]{1,256}$/.test(value)) {
    throw new StorageError("bad_request", "invalid cache-control");
  }
  return value;
}

/** What {@linkcode putObject} stores besides the bytes. */
export interface PutOptions {
  /** The declared type (checked against the allow-list), or `undefined` to sniff one. */
  contentType?: string;
  /** `Cache-Control` the object is served with. */
  cacheControl?: string;
  /** Free-form metadata (`user_metadata`). */
  userMetadata?: Record<string, unknown> | null;
  /** Replace an existing object (else a duplicate is refused). */
  upsert: boolean;
  /** The exact size, when known. */
  size?: number;
  /** A tighter cap than the bucket's. */
  maxBytes?: number;
  /** The owner to record instead of the caller's (a signed upload's). */
  owner?: string | null;
  /**
   * The version the object must still have when the write lands (`null`: none) — a signed
   * upload pinned to what its signer was allowed to write. Absent: any.
   */
  expect?: string | null;
}

/** The size cap for one upload: the bucket's, tightened by the caller's. */
export function capFor(bucket: ResolvedBucket, maxBytes?: number, size?: number): number {
  const cap = Math.min(bucket.maxBytes, maxBytes ?? Infinity);
  if (size !== undefined) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new StorageError("bad_request", "size must be a non-negative integer");
    }
    if (size > cap) {
      throw new StorageError("too_large", "The object exceeded the maximum allowed size");
    }
  }
  return cap;
}

/**
 * Reserve an object's row before its bytes are written: a plain insert (a duplicate or a refused
 * policy fails here, before anything is stored), or — for an upsert — a dry run of the upsert
 * under the caller's policies.
 *
 * @returns The version the write will carry.
 */
export async function reserveObject(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  options: { upsert: boolean; owner: string | null; userMetadata?: Record<string, unknown> | null },
  actor: Actor,
): Promise<string> {
  const version = crypto.randomUUID();
  const write: ObjectWrite = {
    bucket_id: bucket.name,
    name: key,
    owner_id: options.owner,
    version,
    metadata: null,
    user_metadata: options.userMetadata ?? null,
  };
  if (isVersioned(bucket)) {
    // No reserved row (a delete marker may hold the name): a duplicate is a live object.
    if (!options.upsert && await rt.meta.getObject(bucket.name, key, SERVICE)) {
      throw new StorageError("duplicate", "The resource already exists");
    }
    await rt.meta.checkWrite(write, true, actor);
  } else if (options.upsert) await rt.meta.checkWrite(write, true, actor);
  else await rt.meta.writeObject(write, false, actor);
  return version;
}

/**
 * Check, as a dry run under the caller's policies, an upload a signed token lets someone finish
 * later — pinned (a scoped caller, `pin`) to the object's version as it was checked, so the
 * upload lands only while the object still has it.
 *
 * @returns The pin to put in the token (`{}` when none).
 */
export async function checkSignedWrite(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  owner: string | null,
  upsert: boolean,
  actor: Actor,
): Promise<{ cv?: string | null }> {
  // Read before the check: a change after the read only makes the pin stricter.
  const pinned = actor.kind === "scoped" && upsert
    ? { cv: (await rt.meta.currentRow(bucket.name, key))?.version ?? null }
    : {};
  await rt.meta.checkWrite(
    {
      bucket_id: bucket.name,
      name: key,
      owner_id: owner,
      version: crypto.randomUUID(),
      metadata: null,
      user_metadata: null,
    },
    upsert,
    actor,
  );
  return pinned;
}

/**
 * Record a stored object's row (after {@linkcode reserveObject}).
 *
 * @returns The row.
 */
export async function recordObject(
  rt: StorageRuntime,
  bucket: string,
  key: string,
  version: string,
  options: { upsert: boolean; owner: string | null; userMetadata?: Record<string, unknown> | null },
  metadata: ObjectMetadata,
): Promise<ObjectRow> {
  const write = {
    bucket_id: bucket,
    name: key,
    owner_id: options.owner,
    version,
    metadata,
    user_metadata: options.userMetadata ?? null,
  };
  const resolved = await resolveBucket(rt, bucket);
  if (isVersioned(resolved)) return await replaceVersioned(rt, resolved, write);
  if (!options.upsert) {
    const row = await rt.meta.finishObject(bucket, key, version, metadata);
    if (row) return row;
  }
  return await rt.meta.writeObject(write, true, SERVICE);
}

/** Drop a reserved row whose bytes never arrived (only while it is still at `version`). */
export async function releaseObject(
  rt: StorageRuntime,
  bucket: string,
  key: string,
  version: string,
): Promise<void> {
  await rt.meta.deleteObjects(bucket, [key], SERVICE, version).catch(() => {});
}

/**
 * Store an object: authorize, reserve its row, store the bytes (size cap, allow-list, sniffing),
 * record the row.
 *
 * @param rt The runtime.
 * @param bucket The bucket.
 * @param key The normalized key.
 * @param body The bytes.
 * @param options Type, cache control, metadata, upsert.
 * @param caller Who is asking.
 * @returns The object's row.
 */
export async function putObject(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  options: PutOptions,
  caller: Caller,
): Promise<ObjectRow> {
  await authorizeOp(rt, bucket, "upload", key, caller);
  const type = options.contentType === undefined
    ? undefined
    : checkContentType(bucket, options.contentType);
  const max = capFor(bucket, options.maxBytes, options.size);
  const cacheControl = cacheControlOf(options.cacheControl);
  const owner = options.owner !== undefined ? options.owner : await ownerOf(caller);
  const row = { upsert: options.upsert, owner, userMetadata: options.userMetadata };
  const actor = await actorFor(rt, caller);
  const version = await reserveObject(rt, bucket, key, row, actor);
  if (stagesWrite(actor, options.expect)) {
    // Checked above only as a dry run: the row is written under the caller's role when the
    // bytes are in, against the object as it is then, and only then do the bytes reach the key.
    const staged = stagingLocation(bucket.name, version);
    const pinned = { ...row, expect: options.expect };
    return await landStaged(rt, bucket, key, version, pinned, actor, staged, async () =>
      metadataOf(
        await storeChecked(rt, bucket, key, body, type, max, options.size, staged),
        cacheControl,
      ));
  }
  const undo = await prepareOverwrite(rt, bucket, key);
  let info: ObjectInfo;
  try {
    info = await storeChecked(rt, bucket, key, body, type, max, options.size);
  } catch (err) {
    await undo();
    if (!options.upsert) await releaseObject(rt, bucket.name, key, version);
    throw err;
  }
  return await recordObject(rt, bucket.name, key, version, row, metadataOf(info, cacheControl));
}

/**
 * A staged write: store the bytes in their staging place (`store`), then land them with the
 * row ({@linkcode commitStaged}); a plain upload's reservation is released when either fails.
 *
 * @returns The written row.
 */
async function landStaged(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  version: string,
  options: {
    upsert: boolean;
    owner: string | null;
    userMetadata?: Record<string, unknown> | null;
    expect?: string | null;
  },
  actor: Actor,
  staged: Location,
  store: () => Promise<ObjectMetadata>,
): Promise<ObjectRow> {
  try {
    const metadata = await store();
    return await commitStaged(rt, bucket, key, version, options, metadata, actor, staged);
  } catch (err) {
    await rt.driver.remove(staged.bucket, staged.key).catch(() => {});
    if (!options.upsert) await releaseObject(rt, bucket.name, key, version);
    throw err;
  }
}

/**
 * The row of an object the caller may read: under SQL-RLS (a private bucket) the policies must
 * show it, else `not_found`; otherwise the service's view (which may be `null` for an object
 * stored before metadata was kept — the driver then answers for it).
 *
 * @returns The row, or `null`.
 */
export async function readableRow(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  caller: Caller,
  versionId?: string,
): Promise<ObjectRow | null> {
  await authorizeOp(rt, bucket, "download", key, caller);
  const actor = bucket.public ? SERVICE : await actorFor(rt, caller);
  if (versionId !== undefined) {
    const version = await rt.meta.getVersion(bucket.name, key, versionId, actor);
    if (!version || version.is_delete_marker || !version.metadata) {
      throw new StorageError("not_found", "Object not found");
    }
    return version;
  }
  const row = await rt.meta.getObject(bucket.name, key, actor);
  if (!row && actor.kind === "scoped") {
    throw new StorageError("not_found", "Object not found");
  }
  return row;
}

/**
 * Delete objects the caller may delete; returns the deleted rows. Under SQL-RLS only the rows the
 * policies let it delete are removed (bytes included); otherwise every listed key.
 *
 * @returns The deleted rows.
 */
export async function removeObjects(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  keys: (string | { key: string; versionId?: string })[],
  caller: Caller,
): Promise<ObjectRow[]> {
  const entries = keys.map((k) => typeof k === "string" ? { key: k } : k);
  for (const e of entries) await authorizeOp(rt, bucket, "delete", e.key, caller);
  const actor = await actorFor(rt, caller);
  if (isVersioned(bucket) || entries.some((e) => e.versionId !== undefined)) {
    return await removeVersioned(rt, bucket, entries, actor);
  }
  return await removeCurrent(rt, bucket, entries.map((e) => e.key), actor);
}

/** Delete current objects in a bucket without versioning. */
async function removeCurrent(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  keys: string[],
  actor: Actor,
): Promise<ObjectRow[]> {
  const rows = await rt.meta.deleteObjects(bucket.name, keys, actor);
  const doomed = actor.kind === "scoped" ? rows.map((r) => r.name) : keys;
  await eachLimited(doomed, 8, (k) => rt.driver.remove(bucket.name, k));
  return rows;
}

/**
 * Delete in a versioned bucket (or exact versions anywhere): a path leaves a delete marker, a
 * `versionId` deletes that version for good. Each row is checked under the caller's policies.
 */
async function removeVersioned(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  entries: { key: string; versionId?: string }[],
  actor: Actor,
): Promise<ObjectRow[]> {
  const out: ObjectRow[] = [];
  for (const { key, versionId } of entries) {
    const row = await rt.meta.checkDelete(bucket.name, key, versionId, actor);
    if (!row) continue;
    out.push(
      versionId === undefined && isVersioned(bucket)
        ? await deleteCurrent(rt, bucket, row)
        : await deleteVersion(rt, bucket, row),
    );
  }
  return out;
}

/** Run `fn` over `items`, at most `width` at a time. */
async function eachLimited<T>(items: T[], width: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

/** A copy or move's source and destination. */
export interface Transfer {
  from: { bucket: string; key: string; versionId?: string };
  to: { bucket: string; key: string };
}

/** The source's type and size, checked against the destination bucket's rules. */
function checkDestination(to: ResolvedBucket, info: { size: number; contentType: string }) {
  if (info.size > to.maxBytes) {
    throw new StorageError("too_large", "The object exceeded the maximum allowed size");
  }
  checkContentType(to, info.contentType);
}

/**
 * Copy the bytes: the driver's own copy, else a read streamed back through the checks — to the
 * object's key, or to `at` (a staged copy's place).
 */
async function copyBytes(
  rt: StorageRuntime,
  from: Location,
  to: ResolvedBucket,
  key: string,
  at?: Location,
): Promise<ObjectInfo> {
  const target = at ?? { bucket: to.name, key };
  if (rt.driver.copy) {
    return await rt.driver.copy(from.bucket, from.key, target.bucket, target.key);
  }
  const object = await rt.driver.get(from.bucket, from.key);
  if (!object) throw new StorageError("not_found", "Object not found");
  return await storeChecked(
    rt,
    to,
    key,
    object.body,
    essence(object.contentType),
    to.maxBytes,
    object.size,
    at,
  );
}

/** Resolve and normalize both ends of a transfer. */
async function transferEnds(rt: StorageRuntime, t: Transfer) {
  const from = await resolveBucket(rt, t.from.bucket);
  const to = t.to.bucket === t.from.bucket ? from : await resolveBucket(rt, t.to.bucket);
  return { from, to, fromKey: normalizeKey(t.from.key), toKey: normalizeKey(t.to.key) };
}

/**
 * Copy an object (within a bucket or across buckets): `download` on the source, `upload` on the
 * destination (whose size cap and allow-list apply), its `user_metadata` and cache control
 * carried over.
 *
 * @returns The new row.
 */
export async function copyObject(
  rt: StorageRuntime,
  transfer: Transfer,
  upsert: boolean,
  caller: Caller,
): Promise<ObjectRow> {
  const { from, to, fromKey, toKey } = await transferEnds(rt, transfer);
  const source = await sourceOf(rt, from, fromKey, caller, transfer.from.versionId);
  await authorizeOp(rt, to, "upload", toKey, caller);
  checkDestination(to, source);
  const owner = await ownerOf(caller);
  const row = { upsert, owner, userMetadata: source.userMetadata };
  const actor = await actorFor(rt, caller);
  const version = await reserveObject(rt, to, toKey, row, actor);
  if (stagesWrite(actor, undefined)) {
    const staged = stagingLocation(to.name, version);
    return await landStaged(
      rt,
      to,
      toKey,
      version,
      row,
      actor,
      staged,
      async () =>
        metadataOf(await copyBytes(rt, source.location, to, toKey, staged), source.cacheControl),
    );
  }
  const undo = await prepareOverwrite(rt, to, toKey);
  let info: ObjectInfo;
  try {
    info = await copyBytes(rt, source.location, to, toKey);
  } catch (err) {
    await undo();
    if (!upsert) await releaseObject(rt, to.name, toKey, version);
    throw err;
  }
  return await recordObject(
    rt,
    to.name,
    toKey,
    version,
    row,
    metadataOf(info, source.cacheControl),
  );
}

/** A readable source object's facts (its row's, else the driver's). */
async function sourceOf(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  caller: Caller,
  versionId?: string,
) {
  const row = await readableRow(rt, bucket, key, caller, versionId);
  if (row?.metadata) {
    return {
      size: row.metadata.size,
      contentType: row.metadata.mimetype,
      cacheControl: row.metadata.cacheControl,
      userMetadata: row.user_metadata,
      location: locationOf(bucket.name, key, row),
    };
  }
  const info = await rt.driver.head(bucket.name, key);
  if (!info) throw new StorageError("not_found", "Object not found");
  return {
    size: info.size,
    contentType: info.contentType,
    cacheControl: DEFAULT_CACHE_CONTROL,
    userMetadata: null,
    location: { bucket: bucket.name, key } as Location,
  };
}

/**
 * Move (rename) an object, within a bucket or across buckets: `download` and `delete` on the
 * source, `upload` on the destination; under SQL-RLS the source row must be one the policies let
 * the caller update (and the moved row pass their `with check`). The destination must not exist.
 *
 * @returns The moved row.
 */
export async function moveObject(
  rt: StorageRuntime,
  transfer: Transfer,
  caller: Caller,
): Promise<ObjectRow> {
  const { from, to, fromKey, toKey } = await transferEnds(rt, transfer);
  const versionId = transfer.from.versionId;
  if (versionId !== undefined || isVersioned(from) || isVersioned(to)) {
    // Versioned: a copy, then the source deleted (a marker, or that version for good). Moving a
    // noncurrent version onto its own path restores it.
    const restore = from.name === to.name && fromKey === toKey && versionId !== undefined;
    await authorizeOp(rt, from, "delete", fromKey, caller);
    const copied = await copyObject(rt, transfer, restore, caller);
    await removeObjects(rt, from, [{ key: fromKey, versionId }], caller);
    return copied;
  }
  if (from.name === to.name && fromKey === toKey) {
    throw new StorageError("bad_request", "the source and destination are the same");
  }
  await authorizeOp(rt, from, "download", fromKey, caller);
  await authorizeOp(rt, from, "delete", fromKey, caller);
  await authorizeOp(rt, to, "upload", toKey, caller);
  const actor = await actorFor(rt, caller);
  const ends = { bucket: from.name, name: fromKey };
  const dest = { bucket: to.name, name: toKey };
  const source = await rt.meta.moveObject(ends, dest, actor, true);
  if (!source?.metadata) throw new StorageError("not_found", "Object not found");
  checkDestination(to, { size: source.metadata.size, contentType: source.metadata.mimetype });
  // The rename runs as the caller, the destination's name taken before any byte is copied there
  // (an object created there meanwhile is `duplicate`, its bytes untouched); the bytes are copied
  // inside that transaction, and the source's removed once it commits.
  const moved = await rt.meta.moveObject(ends, dest, actor, false, async () => {
    await copyBytes(rt, { bucket: from.name, key: fromKey }, to, toKey);
  });
  if (!moved) throw new StorageError("not_found", "Object not found");
  await rt.driver.remove(from.name, fromKey);
  return moved;
}

/**
 * A Supabase listing (folders first, then objects at the prefix's level).
 *
 * @returns The entries.
 */
export async function listEntries(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  query: ListQuery,
  caller: Caller,
): Promise<ListEntry[]> {
  await authorizeOp(rt, bucket, "list", query.prefix, caller);
  return await rt.meta.listObjects(bucket.name, query, await actorFor(rt, caller));
}

/**
 * Every object under a prefix (no folders), in order — `listV2` without a delimiter.
 *
 * @returns The rows.
 */
export async function listRows(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  query: FlatQuery,
  caller: Caller,
): Promise<ObjectRow[]> {
  await authorizeOp(rt, bucket, "list", query.prefix, caller);
  return await rt.meta.listFlat(bucket.name, query, await actorFor(rt, caller));
}

// ── Buckets ─────────────────────────────────────────────────────────────────

/** Names the `/storage/v1` routes use as path words: a bucket may not take them. */
const RESERVED_BUCKETS = new Set([
  "public",
  "authenticated",
  "sign",
  "upload",
  "list",
  "list-v2",
  "info",
  "move",
  "copy",
]);

/**
 * The actor for a bucket administration statement: the service role always; a request's user
 * only under SQL-RLS (the `storage.buckets` policies decide) — with TypeScript rules, bucket
 * administration is the service role's alone.
 *
 * @throws {StorageError} `forbidden`.
 */
async function bucketActor(rt: StorageRuntime, caller: Caller): Promise<Actor> {
  if (await caller.isService()) return SERVICE;
  if (!rt.rls) {
    throw new StorageError("forbidden", "bucket administration needs the service role");
  }
  return await actorFor(rt, caller);
}

/** A size limit as Supabase takes it: a byte count, or `"50MB"` / `"512KB"` / `"1GB"`. */
export function parseSizeLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new StorageError("bad_request", "file_size_limit must be a positive integer");
    }
    return value;
  }
  const m = typeof value === "string"
    ? value.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i)
    : null;
  if (!m) throw new StorageError("bad_request", "invalid file_size_limit");
  const unit = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[
    (m[2] ?? "B").toUpperCase() as "B"
  ];
  const bytes = Math.floor(Number(m[1]) * unit);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new StorageError("bad_request", "invalid file_size_limit");
  }
  return bytes;
}

/** An allowed-types list as Supabase takes it: exact types or `type/*`. */
export function parseMimeList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > 256) {
    throw new StorageError("bad_request", "allowed_mime_types must be a list");
  }
  if (value.length === 0) return null;
  return value.map((t) => {
    const type = typeof t === "string" ? t.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/.test(type)) {
      throw new StorageError("bad_request", `invalid mime type ${JSON.stringify(t)}`);
    }
    return type;
  });
}

function bucketWrite(id: string, settings: BucketSettings): BucketWrite {
  const status = settings.versioningStatus;
  if (status !== undefined && status !== "DISABLED" && status !== "ENABLED") {
    throw new StorageError(
      "bad_request",
      "a new bucket's versioning_status is DISABLED or ENABLED",
    );
  }
  return {
    id,
    public: settings.public === true,
    file_size_limit: parseSizeLimit(settings.fileSizeLimit),
    allowed_mime_types: parseMimeList(settings.allowedMimeTypes),
    ...(status ? { versioning_status: status } : {}),
  };
}

/** A versioning change: `ENABLED` or `SUSPENDED` (there is no way back to `DISABLED`). */
function versioningUpdate(status: VersioningStatus | undefined): VersioningStatus | undefined {
  if (status === undefined || status === "ENABLED" || status === "SUSPENDED") return status;
  throw new StorageError(
    "bad_request",
    "versioning_status can only be set to ENABLED or SUSPENDED",
  );
}

/** Refuse a change to a bucket `denext.config.ts` declares (the config is its source). */
function checkNotDeclared(rt: StorageRuntime, id: string): void {
  if (rt.buckets.has(id)) {
    throw new StorageError(
      "bad_request",
      `bucket ${id} is declared in denext.config.ts; change it there`,
    );
  }
}

/**
 * Create a bucket at runtime.
 *
 * @throws {StorageError} `duplicate`, `invalid_bucket`, `forbidden`.
 */
export async function createBucket(
  rt: StorageRuntime,
  id: string,
  settings: BucketSettings,
  caller: Caller,
): Promise<void> {
  checkBucketName(id);
  if (RESERVED_BUCKETS.has(id)) {
    throw new StorageError("invalid_bucket", `${id} is a reserved bucket name`);
  }
  const actor = await bucketActor(rt, caller);
  if (rt.buckets.has(id)) throw new StorageError("duplicate", "The resource already exists");
  const write = { ...bucketWrite(id, settings), owner_id: await ownerOf(caller) };
  await rt.meta.createBucket(write, actor);
  forgetBucket(rt, id);
}

/**
 * Update a runtime bucket's settings.
 *
 * @throws {StorageError} `unknown_bucket`, `forbidden`.
 */
export async function updateBucket(
  rt: StorageRuntime,
  id: string,
  settings: BucketSettings,
  caller: Caller,
): Promise<void> {
  const actor = await bucketActor(rt, caller);
  checkNotDeclared(rt, id);
  const current = await rt.meta.getBucket(id, actor);
  if (!current) throw new StorageError("unknown_bucket", "Bucket not found");
  // Only the settings given change (Storage's update is partial).
  const write: BucketWrite = {
    id,
    public: settings.public ?? current.public,
    file_size_limit: settings.fileSizeLimit === undefined
      ? current.file_size_limit
      : parseSizeLimit(settings.fileSizeLimit),
    allowed_mime_types: settings.allowedMimeTypes === undefined
      ? current.allowed_mime_types
      : parseMimeList(settings.allowedMimeTypes),
    versioning_status: versioningUpdate(settings.versioningStatus),
  };
  if (!(await rt.meta.updateBucket(write, actor))) {
    throw new StorageError("unknown_bucket", "Bucket not found");
  }
  forgetBucket(rt, id);
}

/**
 * Delete an empty runtime bucket.
 *
 * @throws {StorageError} `not_empty`, `unknown_bucket`, `forbidden`.
 */
export async function deleteBucket(rt: StorageRuntime, id: string, caller: Caller): Promise<void> {
  const actor = await bucketActor(rt, caller);
  checkNotDeclared(rt, id);
  if (!(await rt.meta.deleteBucket(id, actor))) {
    throw new StorageError("unknown_bucket", "Bucket not found");
  }
  forgetBucket(rt, id);
}

/**
 * Delete every object of a bucket the caller may delete.
 *
 * @throws {StorageError} `unknown_bucket`, `forbidden`.
 */
export async function emptyBucket(rt: StorageRuntime, id: string, caller: Caller): Promise<void> {
  const actor = await bucketActor(rt, caller);
  if (!(await rt.meta.getBucket(id, actor))) {
    throw new StorageError("unknown_bucket", "Bucket not found");
  }
  const bucket = await resolveBucket(rt, id);
  let after = "";
  for (;;) {
    const names = await rt.meta.names(id, after, 200);
    if (!names.length) break;
    after = names[names.length - 1];
    const rows = await rt.meta.deleteObjects(id, names, actor);
    await eachLimited(rows.map((r) => r.name), 8, (k) => rt.driver.remove(bucket.name, k));
  }
  // Noncurrent versions and delete markers go too — under SQL-RLS only the ones the caller's
  // policies let it delete, each as the caller (Supabase empties a bucket through the policies).
  if (actor.kind === "scoped") return await purgeScoped(rt, id, actor);
  for (;;) {
    const rows = await rt.meta.purgeVersions(id, 200);
    if (!rows.length) return;
    await dropVersionBytes(rt, id, rows);
  }
}

/** Delete, as `actor`, every noncurrent version and delete marker its policies let it delete. */
async function purgeScoped(rt: StorageRuntime, id: string, actor: Actor): Promise<void> {
  let after = "";
  for (;;) {
    const rows = await rt.meta.noncurrentVersions(id, after, 200);
    if (!rows.length) return;
    after = rows[rows.length - 1].id;
    for (const row of rows) {
      const gone = await rt.meta.deleteVersion(id, row.name, row.version, actor);
      if (gone) await dropVersionBytes(rt, id, [gone]);
    }
  }
}

/**
 * Who reads bucket rows: the service role; a request's user under SQL-RLS (the policies decide);
 * otherwise nobody — as on Supabase, where `storage.buckets` has row-level security and no
 * policy, so anon and users see no bucket at all (not an error).
 */
async function bucketReader(rt: StorageRuntime, caller: Caller): Promise<Actor | null> {
  if (await caller.isService()) return SERVICE;
  return rt.rls ? await actorFor(rt, caller) : null;
}

/** A bucket's row as the caller may see it (`Bucket not found` when it may not). */
export async function getBucket(
  rt: StorageRuntime,
  id: string,
  caller: Caller,
): Promise<BucketRow> {
  const actor = await bucketReader(rt, caller);
  const row = actor ? await rt.meta.getBucket(id, actor) : null;
  if (!row) throw new StorageError("unknown_bucket", "Bucket not found");
  return row;
}

/** The buckets the caller may see (none, for anon and users without SQL-RLS policies). */
export async function listBuckets(
  rt: StorageRuntime,
  query: BucketQuery,
  caller: Caller,
): Promise<BucketRow[]> {
  const actor = await bucketReader(rt, caller);
  return actor ? await rt.meta.listBuckets(query, actor) : [];
}

/**
 * A bucket's lifecycle policy.
 *
 * @throws {StorageError} `not_found` (`NoSuchLifecycleConfiguration`) when it has none.
 */
export async function getLifecycle(
  rt: StorageRuntime,
  id: string,
  caller: Caller,
): Promise<LifecycleConfiguration> {
  const row = await getBucket(rt, id, caller);
  if (!row.lifecycle) {
    throw new StorageError("not_found", "The bucket has no lifecycle configuration");
  }
  return row.lifecycle;
}

/**
 * Replace (or, with `null`, remove) a bucket's lifecycle policy.
 *
 * @returns The stored policy.
 */
export async function setLifecycle(
  rt: StorageRuntime,
  id: string,
  config: unknown,
  caller: Caller,
): Promise<LifecycleConfiguration | null> {
  const actor = await bucketActor(rt, caller);
  const parsed = config === null ? null : parseLifecycle(config);
  if (!(await rt.meta.setLifecycle(id, parsed, actor))) {
    throw new StorageError("unknown_bucket", "Bucket not found");
  }
  forgetBucket(rt, id);
  return parsed;
}

/** The config-declared buckets as rows to seed `storage.buckets` with. */
export function declaredBucketRows(buckets: Map<string, ResolvedBucket>): BucketWrite[] {
  return [...buckets.values()].map((b) => ({
    id: b.name,
    public: b.public === true,
    file_size_limit: b.maxBytes === DEFAULT_MAX_BYTES ? null : b.maxBytes,
    allowed_mime_types: b.mime?.length ? [...b.mime] : null,
    ...(b.versioned === undefined
      ? {}
      : { versioning_status: b.versioned ? "ENABLED" as const : "SUSPENDED" as const }),
  }));
}

/**
 * The operations `denext ui` uses through the runtime slot: every bucket (declared and runtime),
 * and removal as the service through the same ops (so the metadata rows go with the bytes).
 *
 * @param rt The runtime.
 * @returns The admin operations.
 */
export function storageAdmin(rt: StorageRuntime): StorageAdmin {
  return {
    async buckets() {
      const rows = await rt.meta.listBuckets({ column: "name", order: "asc" }, SERVICE);
      const declared = [...rt.buckets.values()];
      const runtimeOnly = rows.filter((r) => !rt.buckets.has(r.id));
      return [
        ...declared.map((b) => ({
          name: b.name,
          public: b.public === true,
          maxBytes: b.maxBytes,
          mime: b.mime ?? null,
        })),
        ...runtimeOnly.map((r) => ({
          name: r.id,
          public: r.public,
          maxBytes: r.file_size_limit ?? DEFAULT_MAX_BYTES,
          mime: r.allowed_mime_types,
        })),
      ];
    },
    async hasBucket(name) {
      try {
        await resolveBucket(rt, name);
        return true;
      } catch {
        return false;
      }
    },
    async remove(name, key) {
      const bucket = await resolveBucket(rt, name);
      const k = normalizeKey(key);
      await removeObjects(rt, bucket, [k], SERVICE_CALLER);
    },
  };
}
