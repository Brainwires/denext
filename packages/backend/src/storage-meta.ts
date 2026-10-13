// Storage metadata: the bucket table and the object table, Supabase-shaped (`storage.buckets`,
// `storage.objects`), plus the state of resumable (TUS) uploads. Two stores implement it: Postgres
// (`storage-meta-pg.ts`, the `storage` schema — and the only one the SQL-RLS mode runs on) and
// `node:sqlite` (`storage-meta-sqlite.ts`, a file, when the app has no Postgres).
//
// The listing logic Supabase's `storage.search()` runs in SQL (folders first, then the objects
// at the prefix's level, `search` matching the start of the remaining name) is shared here so
// both stores answer the same way.

import type { RlsScope } from "./rls.ts";

/** A bucket row (`storage.buckets`). */
export interface BucketRow {
  id: string;
  name: string;
  owner: string | null;
  owner_id: string | null;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
  created_at: string;
  updated_at: string;
  /** Object versioning: `DISABLED` (never on), `ENABLED`, or `SUSPENDED`. */
  versioning_status: VersioningStatus;
  /** The lifecycle policy (noncurrent-version expiration), or `null`. */
  lifecycle: LifecycleConfiguration | null;
}

/** A bucket's object versioning status, as Supabase Storage reports it. */
export type VersioningStatus = "DISABLED" | "ENABLED" | "SUSPENDED";

/** One lifecycle rule: expire noncurrent versions (Supabase's only action). */
export interface LifecycleRule {
  id: string;
  status: "Enabled" | "Disabled";
  filter: Record<string, never>;
  noncurrentVersionExpiration: { noncurrentDays: number; newerNoncurrentVersions?: number };
}

/** A bucket's lifecycle policy. */
export interface LifecycleConfiguration {
  rules: LifecycleRule[];
}

/** The `metadata` an object row carries — the shape supabase-js reads. */
export interface ObjectMetadata {
  eTag: string;
  size: number;
  mimetype: string;
  cacheControl: string;
  lastModified: string;
  contentLength: number;
  httpStatusCode: number;
}

/** An object row (`storage.objects`). `metadata` is `null` while its upload is in flight. */
export interface ObjectRow {
  id: string;
  bucket_id: string;
  name: string;
  owner: string | null;
  owner_id: string | null;
  version: string;
  metadata: ObjectMetadata | null;
  user_metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  /** When this version stopped being current (`null`: it is the current one). */
  archived_at: string | null;
  /** A delete marker (a versioned bucket's delete): no bytes, the object reads as absent. */
  is_delete_marker: boolean;
  /** Written while the bucket's versioning was `ENABLED` (kept when overwritten). */
  is_versioned: boolean;
}

/** What a new or replaced object row is written with. */
export interface ObjectWrite {
  bucket_id: string;
  name: string;
  owner_id: string | null;
  version: string;
  metadata: ObjectMetadata | null;
  user_metadata: Record<string, unknown> | null;
  is_versioned?: boolean;
  is_delete_marker?: boolean;
}

/** One entry of a Supabase listing: a folder (no `id`) or an object. */
export interface ListEntry {
  name: string;
  id: string | null;
  updated_at: string | null;
  created_at: string | null;
  last_accessed_at: string | null;
  metadata: ObjectMetadata | null;
  /** Version facts (objects only; with versions or delete markers asked for). */
  version?: string | null;
  archived_at?: string | null;
  is_delete_marker?: boolean | null;
  is_versioned?: boolean | null;
}

/** Which versions a listing includes: the current ones, also the others, or only the others. */
export type VersionFilter = "exclude" | "include" | "only";

/** The sortable columns of a listing. */
export type SortColumn = "name" | "updated_at" | "created_at" | "last_accessed_at";

/** A Supabase listing (`POST /object/list/<bucket>`), validated. */
export interface ListQuery {
  /** The folder, `""` or ending in `/`. */
  prefix: string;
  /** Matches the start of the name below the prefix (case-insensitive), `""` for all. */
  search: string;
  limit: number;
  offset: number;
  column: SortColumn;
  order: "asc" | "desc";
  /** Noncurrent versions (default `exclude`). */
  versions?: VersionFilter;
  /** Delete markers (default `exclude`). */
  markers?: VersionFilter;
  /** Only the object named exactly `prefix` (its versions). */
  exact?: boolean;
}

/** A flat (`listV2` without a delimiter) listing: every object under `prefix`, in order. */
export interface FlatQuery {
  prefix: string;
  limit: number;
  offset: number;
  column: "name" | "updated_at" | "created_at";
  order: "asc" | "desc";
  versions?: VersionFilter;
  markers?: VersionFilter;
  exact?: boolean;
}

/** A bucket listing (`GET /bucket`). */
export interface BucketQuery {
  limit?: number;
  offset?: number;
  search?: string;
  column: "id" | "name" | "created_at" | "updated_at";
  order: "asc" | "desc";
}

/** What a bucket is created or updated with. */
export interface BucketWrite {
  id: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
  owner_id?: string | null;
  versioning_status?: VersioningStatus;
}

/** A resumable upload in progress. */
export interface ResumableRow {
  id: string;
  bucket_id: string;
  name: string;
  upload_length: number;
  upload_offset: number;
  content_type: string;
  cache_control: string;
  user_metadata: Record<string, unknown> | null;
  owner_id: string | null;
  upsert: boolean;
  /** The driver's multipart upload id (s3), or `null` (chunk objects). */
  upload_id: string | null;
  /** The parts uploaded so far (s3), in order. */
  parts: { partNumber: number; etag: string }[];
  /** Bytes held back as a tail chunk, not yet a part (s3). */
  tail_size: number;
  /** The chunk objects received so far (a driver without multipart), in order. */
  chunks: { offset: number; size: number }[];
  /** The object version the upload will write. */
  version: string;
  expires_at: number;
  lease: string | null;
  lease_until: number | null;
}

/**
 * Who a statement runs as: the store's own connection (`service`), or — SQL-RLS mode on
 * Postgres — a role and its claims, so the `storage` tables' policies decide.
 */
export type Actor = { kind: "service" } | { kind: "scoped"; scope: RlsScope };

/** The service actor. */
export const SERVICE: Actor = Object.freeze({ kind: "service" });

/** The metadata store. Every method that takes an `as` runs scoped under SQL-RLS. */
export interface MetaStore {
  /** `"postgres"` or `"sqlite"`. */
  readonly kind: "postgres" | "sqlite";
  /** Create the tables (once; a failure is retried by the next call). */
  ready(): Promise<void>;
  /** Insert or update the config-declared buckets (config wins). */
  syncBuckets(rows: BucketWrite[]): Promise<void>;
  listBuckets(query: BucketQuery, as: Actor): Promise<BucketRow[]>;
  getBucket(id: string, as: Actor): Promise<BucketRow | null>;
  /** @throws {StorageError} `duplicate` when it exists; `forbidden` under a policy. */
  createBucket(row: BucketWrite, as: Actor): Promise<void>;
  /** @returns Whether a row was updated (`false`: absent, or hidden by a policy). */
  updateBucket(row: BucketWrite, as: Actor): Promise<boolean>;
  /** @returns Whether a row was deleted. @throws {StorageError} `not_empty`. */
  deleteBucket(id: string, as: Actor): Promise<boolean>;
  getObject(bucket: string, name: string, as: Actor): Promise<ObjectRow | null>;
  /**
   * Insert an object row; with `upsert`, replace an existing one.
   * @throws {StorageError} `duplicate` (no upsert, the name exists); `forbidden` under a policy.
   */
  writeObject(row: ObjectWrite, upsert: boolean, as: Actor): Promise<ObjectRow>;
  /** Check, under `as`, that {@link writeObject} would be allowed — then roll it back. */
  checkWrite(row: ObjectWrite, upsert: boolean, as: Actor): Promise<void>;
  /** Fill in a row's metadata once its bytes are stored — only while it is at `version`. */
  finishObject(
    bucket: string,
    name: string,
    version: string,
    metadata: ObjectMetadata,
  ): Promise<ObjectRow | null>;
  /** Delete rows (the ones `as` may delete); returns what was deleted. */
  deleteObjects(bucket: string, names: string[], as: Actor, version?: string): Promise<ObjectRow[]>;
  /**
   * Rename a row (move), checked under `as` (`update` on the source, the new row's `with check`).
   * @returns The moved row, or `null` when the source is absent or hidden.
   * @throws {StorageError} `duplicate` when the destination exists.
   */
  moveObject(
    from: { bucket: string; name: string },
    to: { bucket: string; name: string },
    as: Actor,
    dryRun: boolean,
  ): Promise<ObjectRow | null>;
  listObjects(bucket: string, query: ListQuery, as: Actor): Promise<ListEntry[]>;
  /** Up to `limit` names in `bucket` after `after` (emptying a bucket), as the service. */
  names(bucket: string, after: string, limit: number): Promise<string[]>;
  // ── versions (versioned buckets) ──
  /** A row by its version id — current or archived, an object or a delete marker. */
  getVersion(bucket: string, name: string, version: string, as: Actor): Promise<ObjectRow | null>;
  /** The current row (an object or a delete marker), as the service. */
  currentRow(bucket: string, name: string): Promise<ObjectRow | null>;
  /**
   * Make `row` the current version, in one transaction: the current row is archived (`keep`) or
   * deleted first. As the service (the caller has already been authorized).
   */
  replaceCurrent(row: ObjectWrite, keep: boolean): Promise<ObjectRow>;
  /**
   * The row a delete would remove — the current object, or the exact `version` — checked under
   * `as` (`select` + `delete`, rolled back), or `null` when absent or hidden.
   */
  checkDelete(
    bucket: string,
    name: string,
    version: string | undefined,
    as: Actor,
  ): Promise<ObjectRow | null>;
  /** Permanently delete one version row (as the service); returns it. */
  deleteVersion(bucket: string, name: string, version: string): Promise<ObjectRow | null>;
  /** With no current row left, make the newest archived row current; returns it. */
  promoteLatest(bucket: string, name: string): Promise<ObjectRow | null>;
  /** Store (or clear, `null`) a bucket's lifecycle policy. */
  setLifecycle(id: string, config: LifecycleConfiguration | null, as: Actor): Promise<boolean>;
  /** Every row under a prefix (no folders), in order — `listV2` without a delimiter. */
  listFlat(bucket: string, query: FlatQuery, as: Actor): Promise<ObjectRow[]>;
  /** Delete up to `limit` archived rows and delete markers (emptying a bucket); returns them. */
  purgeVersions(bucket: string, limit: number): Promise<ObjectRow[]>;
  /**
   * Delete up to `limit` noncurrent versions older than `days` beyond each name's newest
   * `keepNewer` (a lifecycle rule); returns them.
   */
  expireNoncurrent(
    bucket: string,
    days: number,
    keepNewer: number,
    limit: number,
  ): Promise<ObjectRow[]>;
  // ── resumable uploads (service) ──
  createResumable(row: ResumableRow): Promise<void>;
  getResumable(id: string): Promise<ResumableRow | null>;
  /** Take the lease when it is free (or stale) and the offset is `offset`; `null` when not. */
  leaseResumable(id: string, offset: number, lease: string, until: number): Promise<boolean>;
  /** Save progress and release the lease. */
  saveResumable(row: ResumableRow): Promise<void>;
  deleteResumable(id: string): Promise<void>;
  /** Uploads whose `expires_at` has passed, at most `limit`. */
  expiredResumables(now: number, limit: number): Promise<ResumableRow[]>;
  /** Release resources (the sqlite handle). */
  close?(): void;
}

/** `\`, `%` and `_` escaped for a `LIKE … ESCAPE '\'` pattern. */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Turn the rows under a prefix into a Supabase listing: the first path segment below the prefix
 * names a folder (when deeper) or an object; folders come first, sorted by name, then objects by
 * the column; then `offset` and `limit`. Used by the sqlite store (Postgres does it in SQL).
 *
 * @param rows The rows whose name starts with the prefix (and matches the search).
 * @param query The listing.
 * @returns The page.
 */
export function shapeListing(rows: ObjectRow[], query: ListQuery): ListEntry[] {
  const withVersions = (query.versions ?? "exclude") !== "exclude" ||
    (query.markers ?? "exclude") !== "exclude";
  const folders = new Set<string>();
  const objects: ListEntry[] = [];
  for (const row of rows) {
    const rest = query.exact
      ? row.name.slice(row.name.lastIndexOf("/") + 1)
      : row.name.slice(query.prefix.length);
    const slash = query.exact ? -1 : rest.indexOf("/");
    if (slash >= 0) {
      folders.add(rest.slice(0, slash));
      continue;
    }
    objects.push({
      name: rest,
      id: row.id,
      updated_at: row.updated_at,
      created_at: row.created_at,
      last_accessed_at: row.last_accessed_at,
      metadata: row.metadata,
      ...(withVersions
        ? {
          version: row.version,
          archived_at: row.archived_at,
          is_delete_marker: row.is_delete_marker,
          is_versioned: row.is_versioned,
        }
        : {}),
    });
  }
  const dir = query.order === "desc" ? -1 : 1;
  const cmp = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? "") < (b ?? "") ? -dir : (a ?? "") > (b ?? "") ? dir : 0;
  const age = (a: ListEntry, b: ListEntry) =>
    (a.archived_at ?? "") === (b.archived_at ?? "")
      ? 0
      : !a.archived_at
      ? -1
      : !b.archived_at
      ? 1
      : a.archived_at < b.archived_at
      ? 1
      : -1;
  const folderEntries: ListEntry[] = [...folders].sort((a, b) => cmp(a, b)).map((name) => ({
    name,
    id: null,
    updated_at: null,
    created_at: null,
    last_accessed_at: null,
    metadata: null,
    ...(withVersions
      ? { version: null, archived_at: null, is_delete_marker: null, is_versioned: null }
      : {}),
  }));
  objects.sort((a, b) => cmp(a[query.column], b[query.column]) || cmp(a.name, b.name) || age(a, b));
  return [...folderEntries, ...objects].slice(query.offset, query.offset + query.limit);
}

/** Whether `name`'s remainder below `prefix` starts with `search`, case-insensitively. */
export function matchesSearch(name: string, prefix: string, search: string): boolean {
  if (!name.startsWith(prefix)) return false;
  return name.slice(prefix.length).toLowerCase().startsWith(search.toLowerCase());
}
