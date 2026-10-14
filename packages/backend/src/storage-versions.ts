// Object versioning, as Supabase Storage has it: a bucket's `versioning_status` is `DISABLED`
// (never on), `ENABLED` or `SUSPENDED`. While `ENABLED`, overwriting an object keeps the old one
// as a noncurrent version (`archived_at` set, its row still in `storage.objects`) and deleting it
// leaves a delete marker as the current version; while `SUSPENDED`, new writes replace the current
// object unless that one was written while versioning was on. A version is addressed by its
// `version` id: read, signed, copied (restored) or permanently deleted, and deleting the current
// version brings the newest noncurrent one back. A lifecycle rule expires noncurrent versions.
//
// The current version's bytes live at the object's key, as for any object; a noncurrent
// version's bytes are copied to the internal `.denext-versions` namespace (which no bucket name
// can reach) under `<bucket>/<version>` before they would be overwritten or removed.

import { StorageError } from "./errors.ts";
import type { ResolvedBucket, StorageRuntime } from "./runtime.ts";
import type {
  Actor,
  LifecycleConfiguration,
  LifecycleRule,
  ObjectMetadata,
  ObjectRow,
  ObjectWrite,
} from "./storage-meta.ts";

/** Where noncurrent versions' bytes are kept. */
const VERSION_NAMESPACE = ".denext-versions";

/**
 * Where an upload's bytes wait (`<bucket>/<version>`) until its row is written: no bucket name
 * reaches it, and nothing at the object's key changes before the write is allowed.
 */
const STAGING_NAMESPACE = ".denext-staging";

/** A place in the driver: a bucket (or internal namespace) and a key. */
export interface Location {
  bucket: string;
  key: string;
}

/** Where a noncurrent version's bytes are kept. */
function versionLocation(bucket: string, version: string): Location {
  return { bucket: VERSION_NAMESPACE, key: `${bucket}/${version}` };
}

/** Where a row's bytes are: the object's key (current), or the version store (noncurrent). */
export function locationOf(bucket: string, key: string, row: ObjectRow | null): Location {
  return row && row.archived_at !== null ? versionLocation(bucket, row.version) : { bucket, key };
}

/** Where an upload's bytes are staged until its row is written. */
export function stagingLocation(bucket: string, version: string): Location {
  return { bucket: STAGING_NAMESPACE, key: `${bucket}/${version}` };
}

/**
 * Whether a write stages its bytes and lands them with its row ({@linkcode commitStaged}): when a
 * request's user writes under SQL-RLS (the policies must judge the row that is there when the
 * write lands, not when it was checked), or when a signed upload is pinned to the object's state.
 */
export function stagesWrite(actor: Actor, expect: string | null | undefined): boolean {
  return actor.kind === "scoped" || expect !== undefined;
}

/**
 * Write an object whose bytes were staged: its row and its bytes land together, the row's write
 * run as `actor` against the current row as it is at that moment ({@linkcode MetaStore.commitObject}),
 * the bytes moved from `staged` to the key only once that write is allowed. The staged copy is
 * removed either way.
 *
 * @returns The written row.
 */
export async function commitStaged(
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
  metadata: ObjectMetadata,
  actor: Actor,
  staged: Location,
): Promise<ObjectRow> {
  const versioned = isVersioned(bucket);
  let kept: Location | undefined;
  try {
    const row = await rt.meta.commitObject(
      {
        row: {
          bucket_id: bucket.name,
          name: key,
          owner_id: options.owner,
          version,
          metadata,
          user_metadata: options.userMetadata ?? null,
          ...(versioned ? { is_versioned: bucket.versioning === "ENABLED" } : {}),
        },
        upsert: options.upsert,
        reserved: !versioned && !options.upsert,
        keep: versioned ? (current) => keepsCurrent(bucket, current) : null,
        ...(options.expect !== undefined ? { expect: options.expect } : {}),
      },
      actor,
      async (current, keep) => {
        if (keep && current && !current.is_delete_marker && current.metadata) {
          kept = versionLocation(bucket.name, current.version);
          await rawCopy(rt, { bucket: bucket.name, key }, kept);
        }
        await rawCopy(rt, staged, { bucket: bucket.name, key });
      },
    );
    kept = undefined;
    if (versioned) sweepLifecycle(rt, bucket);
    return row;
  } finally {
    if (kept) await rt.driver.remove(kept.bucket, kept.key).catch(() => {});
    await rt.driver.remove(staged.bucket, staged.key).catch(() => {});
  }
}

/** Whether a bucket keeps versions at all (`ENABLED`, or `SUSPENDED` with its history). */
export function isVersioned(bucket: ResolvedBucket): boolean {
  return (bucket.versioning ?? "DISABLED") !== "DISABLED";
}

/** Whether replacing (or deleting) `current` keeps it as a noncurrent version. */
function keepsCurrent(bucket: ResolvedBucket, current: ObjectRow): boolean {
  if (bucket.versioning === "ENABLED") return true;
  return bucket.versioning === "SUSPENDED" && current.is_versioned;
}

/** Copy bytes inside the store, with no checks (they were checked when first written). */
async function rawCopy(rt: StorageRuntime, from: Location, to: Location): Promise<void> {
  if (rt.driver.copy) {
    await rt.driver.copy(from.bucket, from.key, to.bucket, to.key);
    return;
  }
  const object = await rt.driver.get(from.bucket, from.key);
  if (!object) throw new StorageError("not_found", "Object not found");
  await rt.driver.put(to.bucket, to.key, object.body, {
    contentType: object.contentType,
    size: object.size,
  });
}

/**
 * Before an object's bytes are overwritten in a versioned bucket: keep a copy of the current
 * version's bytes when it will become noncurrent. Returns what undoes it (a failed write).
 *
 * @param rt The runtime.
 * @param bucket The bucket.
 * @param key The object.
 * @returns The undo.
 */
export async function prepareOverwrite(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
): Promise<() => Promise<void>> {
  const none = () => Promise.resolve();
  if (!isVersioned(bucket)) return none;
  const current = await rt.meta.currentRow(bucket.name, key);
  if (!current || current.is_delete_marker || !current.metadata) return none;
  if (!keepsCurrent(bucket, current)) return none;
  const copy = versionLocation(bucket.name, current.version);
  await rawCopy(rt, { bucket: bucket.name, key }, copy);
  return () => rt.driver.remove(copy.bucket, copy.key).catch(() => {});
}

/**
 * Make `write` the current version of a versioned bucket's object: the current one becomes
 * noncurrent (or goes, when it is not kept).
 *
 * @returns The new current row.
 */
export async function replaceVersioned(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  write: ObjectWrite,
): Promise<ObjectRow> {
  const current = await rt.meta.currentRow(bucket.name, write.name);
  const keep = current !== null && keepsCurrent(bucket, current);
  const row = await rt.meta.replaceCurrent({
    ...write,
    is_versioned: bucket.versioning === "ENABLED",
  }, keep);
  sweepLifecycle(rt, bucket);
  return row;
}

/**
 * Delete a versioned bucket's object (by its path): its current version becomes noncurrent (or
 * goes) and a delete marker becomes current.
 *
 * @returns The deleted (now noncurrent) row.
 */
export async function deleteCurrent(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  row: ObjectRow,
): Promise<ObjectRow> {
  const keep = keepsCurrent(bucket, row);
  if (keep) {
    await rawCopy(
      rt,
      { bucket: bucket.name, key: row.name },
      versionLocation(bucket.name, row.version),
    );
  }
  await rt.meta.replaceCurrent({
    bucket_id: bucket.name,
    name: row.name,
    owner_id: row.owner_id,
    version: crypto.randomUUID(),
    metadata: null,
    user_metadata: null,
    is_delete_marker: true,
    is_versioned: bucket.versioning === "ENABLED",
  }, keep);
  await rt.driver.remove(bucket.name, row.name);
  sweepLifecycle(rt, bucket);
  return row;
}

/**
 * Permanently delete one version. When it was the current one, the newest noncurrent version
 * (or delete marker) becomes current again, its bytes moved back to the object's key.
 *
 * @returns The deleted row.
 */
export async function deleteVersion(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  row: ObjectRow,
): Promise<ObjectRow> {
  await rt.meta.deleteVersion(bucket.name, row.name, row.version);
  if (!row.is_delete_marker) {
    const at = locationOf(bucket.name, row.name, row);
    await rt.driver.remove(at.bucket, at.key);
  }
  if (row.archived_at === null) {
    const promoted = await rt.meta.promoteLatest(bucket.name, row.name);
    if (promoted && !promoted.is_delete_marker) {
      const from = versionLocation(bucket.name, promoted.version);
      await rawCopy(rt, from, { bucket: bucket.name, key: row.name });
      await rt.driver.remove(from.bucket, from.key);
    }
  }
  return row;
}

/** Remove the bytes of rows taken out of the version store (emptying, expiry). */
export async function dropVersionBytes(
  rt: StorageRuntime,
  bucket: string,
  rows: ObjectRow[],
): Promise<void> {
  for (const row of rows) {
    if (row.is_delete_marker) continue;
    const at = locationOf(bucket, row.name, row);
    await rt.driver.remove(at.bucket, at.key).catch(() => {});
  }
}

/** When each bucket's lifecycle last ran in this process. */
const swept = new Map<string, number>();
/** At most one lifecycle pass per bucket and minute. */
const SWEEP_EVERY = 60_000;

/**
 * Apply a bucket's lifecycle rules (noncurrent-version expiration), at most once a minute, in the
 * background of a write.
 *
 * @param rt The runtime.
 * @param bucket The bucket.
 */
function sweepLifecycle(rt: StorageRuntime, bucket: ResolvedBucket): void {
  const rules = bucket.lifecycle?.rules.filter((r) => r.status === "Enabled") ?? [];
  if (!rules.length) return;
  const last = swept.get(bucket.name) ?? 0;
  if (Date.now() - last < SWEEP_EVERY) return;
  swept.set(bucket.name, Date.now());
  (async () => {
    for (const rule of rules) {
      const { noncurrentDays, newerNoncurrentVersions } = rule.noncurrentVersionExpiration;
      const rows = await rt.meta.expireNoncurrent(
        bucket.name,
        noncurrentDays,
        newerNoncurrentVersions ?? 0,
        1000,
      );
      await dropVersionBytes(rt, bucket.name, rows);
    }
  })().catch((err) => console.error("[@denext/backend] lifecycle sweep failed", err));
}

/**
 * Validate a lifecycle configuration as Supabase Storage does: 1–1000 rules, each `Enabled` or
 * `Disabled`, `filter: {}` only, and only `noncurrentVersionExpiration` (`noncurrentDays` ≥ 1,
 * `newerNoncurrentVersions` 1–100); rule ids unique (generated when omitted).
 *
 * @param value The request body.
 * @returns The configuration.
 * @throws {StorageError} `bad_request`.
 */
export function parseLifecycle(value: unknown): LifecycleConfiguration {
  const rules = (value as { rules?: unknown })?.rules;
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 1000) {
    lifecycleError("rules must be a list of 1 to 1000 rules");
  }
  const ids = new Set<string>();
  return {
    rules: (rules as unknown[]).map((raw, i) => {
      const rule = parseRule(raw, i);
      if (ids.has(rule.id)) lifecycleError("rule ids must be unique");
      ids.add(rule.id);
      return rule;
    }),
  };
}

function lifecycleError(why: string): never {
  throw new StorageError("bad_request", `invalid lifecycle configuration: ${why}`);
}

const RULE_FIELDS = new Set(["id", "status", "filter", "noncurrentVersionExpiration"]);

/** One rule, checked; its id generated (`rule-<n>`) when omitted. */
function parseRule(raw: unknown, i: number): LifecycleRule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    lifecycleError(`rule ${i} is not an object`);
  }
  const rule = raw as Record<string, unknown>;
  const extra = Object.keys(rule).find((k) => !RULE_FIELDS.has(k));
  if (extra) lifecycleError(`unsupported field ${extra}`);
  const id = rule.id === undefined ? `rule-${i + 1}` : rule.id;
  if (typeof id !== "string" || !/^[\w.-]{1,255}$/.test(id)) lifecycleError("invalid rule id");
  if (rule.status !== "Enabled" && rule.status !== "Disabled") {
    lifecycleError("status must be Enabled or Disabled");
  }
  checkFilter(rule.filter);
  return {
    id: id as string,
    status: rule.status as "Enabled",
    filter: {},
    noncurrentVersionExpiration: parseExpiration(rule.noncurrentVersionExpiration),
  };
}

/** `filter` must be `{}` (prefix and tag filters are refused, as on Supabase). */
function checkFilter(filter: unknown): void {
  const ok = filter !== null && typeof filter === "object" && !Array.isArray(filter) &&
    Object.keys(filter).length === 0;
  if (!ok) lifecycleError("filter must be {}");
}

/** `noncurrentDays` ≥ 1; `newerNoncurrentVersions` 1–100 when given. */
function parseExpiration(value: unknown): LifecycleRule["noncurrentVersionExpiration"] {
  const exp = (value ?? {}) as Record<string, unknown>;
  const days = exp.noncurrentDays;
  const newer = exp.newerNoncurrentVersions;
  if (!Number.isSafeInteger(days) || (days as number) < 1) {
    lifecycleError("noncurrentVersionExpiration.noncurrentDays must be a positive integer");
  }
  const newerOk = newer === undefined ||
    (Number.isSafeInteger(newer) && (newer as number) >= 1 && (newer as number) <= 100);
  if (!newerOk) {
    lifecycleError("noncurrentVersionExpiration.newerNoncurrentVersions must be 1 to 100");
  }
  return {
    noncurrentDays: days as number,
    ...(newer === undefined ? {} : { newerNoncurrentVersions: newer as number }),
  };
}
