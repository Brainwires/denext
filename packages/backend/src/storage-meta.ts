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
}

/** What a new or replaced object row is written with. */
export interface ObjectWrite {
  bucket_id: string;
  name: string;
  owner_id: string | null;
  version: string;
  metadata: ObjectMetadata | null;
  user_metadata: Record<string, unknown> | null;
}

/** One entry of a Supabase listing: a folder (no `id`) or an object. */
export interface ListEntry {
  name: string;
  id: string | null;
  updated_at: string | null;
  created_at: string | null;
  last_accessed_at: string | null;
  metadata: ObjectMetadata | null;
}

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
  const folders = new Set<string>();
  const objects: ListEntry[] = [];
  for (const row of rows) {
    const rest = row.name.slice(query.prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) folders.add(rest.slice(0, slash));
    else {
      objects.push({
        name: rest,
        id: row.id,
        updated_at: row.updated_at,
        created_at: row.created_at,
        last_accessed_at: row.last_accessed_at,
        metadata: row.metadata,
      });
    }
  }
  const dir = query.order === "desc" ? -1 : 1;
  const cmp = (a: string | null, b: string | null) =>
    (a ?? "") < (b ?? "") ? -dir : (a ?? "") > (b ?? "") ? dir : 0;
  const folderEntries: ListEntry[] = [...folders].sort((a, b) => cmp(a, b)).map((name) => ({
    name,
    id: null,
    updated_at: null,
    created_at: null,
    last_accessed_at: null,
    metadata: null,
  }));
  objects.sort((a, b) => cmp(a[query.column], b[query.column]) || cmp(a.name, b.name));
  return [...folderEntries, ...objects].slice(query.offset, query.offset + query.limit);
}

/** Whether `name`'s remainder below `prefix` starts with `search`, case-insensitively. */
export function matchesSearch(name: string, prefix: string, search: string): boolean {
  if (!name.startsWith(prefix)) return false;
  return name.slice(prefix.length).toLowerCase().startsWith(search.toLowerCase());
}
