// The storage metadata store on Deno's built-in `node:sqlite`, for an app without Postgres: the
// same bucket, object and resumable-upload rows as the Postgres store, in one file (default
// `.denext-storage.db` in the project root). It serves one server process; several replicas
// sharing storage need the Postgres store (`backend({ postgres })`).

import { DatabaseSync } from "node:sqlite";
import { dirname } from "@std/path";
import { StorageError } from "./errors.ts";
import {
  type BucketQuery,
  type BucketRow,
  likeEscape,
  type ListEntry,
  type ListQuery,
  matchesSearch,
  type MetaStore,
  type ObjectMetadata,
  type ObjectRow,
  type ResumableRow,
  shapeListing,
} from "./storage-meta.ts";

const SCHEMA = `
create table if not exists buckets (
  id text primary key,
  name text not null unique,
  owner text,
  owner_id text,
  public integer not null default 0,
  file_size_limit integer,
  allowed_mime_types text,
  created_at text not null,
  updated_at text not null
);
create table if not exists objects (
  id text primary key,
  bucket_id text not null references buckets(id),
  name text not null,
  owner text,
  owner_id text,
  version text not null,
  metadata text,
  user_metadata text,
  created_at text not null,
  updated_at text not null,
  last_accessed_at text not null,
  unique (bucket_id, name)
);
create table if not exists resumable_uploads (
  id text primary key,
  bucket_id text not null,
  name text not null,
  state text not null,
  expires_at integer not null,
  lease text,
  lease_until integer
);
`;

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

function bucketRow(r: Row): BucketRow {
  return {
    id: r.id as string,
    name: r.name as string,
    owner: (r.owner as string | null) ?? null,
    owner_id: (r.owner_id as string | null) ?? null,
    public: r.public === 1 || r.public === 1n,
    file_size_limit: r.file_size_limit === null ? null : Number(r.file_size_limit),
    allowed_mime_types: r.allowed_mime_types === null
      ? null
      : JSON.parse(r.allowed_mime_types as string),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function objectRow(r: Row): ObjectRow {
  return {
    id: r.id as string,
    bucket_id: r.bucket_id as string,
    name: r.name as string,
    owner: (r.owner as string | null) ?? null,
    owner_id: (r.owner_id as string | null) ?? null,
    version: r.version as string,
    metadata: r.metadata ? JSON.parse(r.metadata as string) as ObjectMetadata : null,
    user_metadata: r.user_metadata ? JSON.parse(r.user_metadata as string) : null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    last_accessed_at: r.last_accessed_at as string,
  };
}

/** A UUID for `owner` when the user id is one (Supabase's `owner uuid` column), else `null`. */
export function ownerUuid(id: string | null): string | null {
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase()
    : null;
}

const BUCKET_COLUMNS = new Set(["id", "name", "created_at", "updated_at"]);

/**
 * Open the sqlite metadata store at `path` (created on first use).
 *
 * @param path The database file.
 * @returns The store.
 */
export function sqliteMetaStore(path: string): MetaStore {
  let handle: DatabaseSync | undefined;
  const open = (): DatabaseSync => {
    if (handle) return handle;
    if (path !== ":memory:") Deno.mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on;");
    db.exec(SCHEMA);
    handle = db;
    return db;
  };
  const all = (sql: string, ...params: unknown[]) =>
    open().prepare(sql).all(...(params as never[])) as Row[];
  const one = (sql: string, ...params: unknown[]) =>
    open().prepare(sql).get(...(params as never[])) as Row | undefined;
  const run = (sql: string, ...params: unknown[]) =>
    open().prepare(sql).run(...(params as never[]));
  const getObject = (bucket: string, name: string) => {
    const r = one("select * from objects where bucket_id = ? and name = ?", bucket, name);
    return r ? objectRow(r) : null;
  };
  const resumable = (r: Row | undefined): ResumableRow | null =>
    r
      ? {
        ...JSON.parse(r.state as string),
        lease: r.lease ?? null,
        lease_until: r.lease_until === null ? null : Number(r.lease_until),
      }
      : null;

  return {
    kind: "sqlite",
    ready() {
      return Promise.resolve().then(() => void open());
    },
    syncBuckets(rows) {
      return Promise.resolve().then(() => {
        for (const row of rows) {
          const t = now();
          run(
            `insert into buckets (id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?)
             on conflict (id) do update set public = excluded.public,
               file_size_limit = excluded.file_size_limit,
               allowed_mime_types = excluded.allowed_mime_types, updated_at = excluded.updated_at`,
            row.id,
            row.id,
            row.public ? 1 : 0,
            row.file_size_limit,
            row.allowed_mime_types ? JSON.stringify(row.allowed_mime_types) : null,
            t,
            t,
          );
        }
      });
    },
    listBuckets(query: BucketQuery) {
      return Promise.resolve().then(() => {
        const column = BUCKET_COLUMNS.has(query.column) ? query.column : "name";
        const order = query.order === "desc" ? "desc" : "asc";
        const rows = all(
          `select * from buckets where (? = '' or name like ? escape '\\')
           order by ${column} ${order} limit ? offset ?`,
          query.search ?? "",
          `%${likeEscape(query.search ?? "")}%`,
          query.limit ?? -1,
          query.offset ?? 0,
        );
        return rows.map(bucketRow);
      });
    },
    getBucket(id) {
      return Promise.resolve().then(() => {
        const r = one("select * from buckets where id = ?", id);
        return r ? bucketRow(r) : null;
      });
    },
    createBucket(row) {
      return Promise.resolve().then(() => {
        const t = now();
        try {
          run(
            `insert into buckets (id, name, owner, owner_id, public, file_size_limit, allowed_mime_types, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            row.id,
            row.id,
            ownerUuid(row.owner_id ?? null),
            row.owner_id ?? null,
            row.public ? 1 : 0,
            row.file_size_limit,
            row.allowed_mime_types ? JSON.stringify(row.allowed_mime_types) : null,
            t,
            t,
          );
        } catch (err) {
          if (/UNIQUE|PRIMARY KEY/i.test(String((err as Error).message))) {
            throw new StorageError("duplicate", "The resource already exists");
          }
          throw err;
        }
      });
    },
    updateBucket(row) {
      return Promise.resolve().then(() =>
        run(
          `update buckets set public = ?, file_size_limit = ?, allowed_mime_types = ?, updated_at = ?
           where id = ?`,
          row.public ? 1 : 0,
          row.file_size_limit,
          row.allowed_mime_types ? JSON.stringify(row.allowed_mime_types) : null,
          now(),
          row.id,
        ).changes > 0
      );
    },
    deleteBucket(id) {
      return Promise.resolve().then(() => {
        if (one("select 1 as x from objects where bucket_id = ? limit 1", id)) {
          throw new StorageError("not_empty", "The bucket you tried to delete is not empty");
        }
        return run("delete from buckets where id = ?", id).changes > 0;
      });
    },
    getObject(bucket, name) {
      return Promise.resolve().then(() => getObject(bucket, name));
    },
    writeObject(row, upsert) {
      return Promise.resolve().then(() => {
        const t = now();
        const existing = getObject(row.bucket_id, row.name);
        if (existing && !upsert) throw new StorageError("duplicate", "The resource already exists");
        const metadata = row.metadata ? JSON.stringify(row.metadata) : null;
        const user = row.user_metadata ? JSON.stringify(row.user_metadata) : null;
        try {
          if (existing) {
            run(
              `update objects set owner = ?, owner_id = ?, version = ?, metadata = ?, user_metadata = ?,
               updated_at = ?, last_accessed_at = ? where id = ?`,
              ownerUuid(row.owner_id),
              row.owner_id,
              row.version,
              metadata,
              user,
              t,
              t,
              existing.id,
            );
          } else {
            run(
              `insert into objects (id, bucket_id, name, owner, owner_id, version, metadata, user_metadata,
               created_at, updated_at, last_accessed_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              crypto.randomUUID(),
              row.bucket_id,
              row.name,
              ownerUuid(row.owner_id),
              row.owner_id,
              row.version,
              metadata,
              user,
              t,
              t,
              t,
            );
          }
        } catch (err) {
          if (/UNIQUE/i.test(String((err as Error).message))) {
            throw new StorageError("duplicate", "The resource already exists");
          }
          if (/FOREIGN KEY/i.test(String((err as Error).message))) {
            throw new StorageError("unknown_bucket", "Bucket not found");
          }
          throw err;
        }
        return getObject(row.bucket_id, row.name)!;
      });
    },
    checkWrite() {
      return Promise.resolve();
    },
    finishObject(bucket, name, version, metadata) {
      return Promise.resolve().then(() => {
        const changed = run(
          `update objects set metadata = ?, updated_at = ? where bucket_id = ? and name = ? and version = ?`,
          JSON.stringify(metadata),
          now(),
          bucket,
          name,
          version,
        ).changes;
        return changed ? getObject(bucket, name) : null;
      });
    },
    deleteObjects(bucket, names, _as, version) {
      return Promise.resolve().then(() => {
        const out: ObjectRow[] = [];
        for (const name of names) {
          const row = getObject(bucket, name);
          if (!row || (version !== undefined && row.version !== version)) continue;
          run("delete from objects where id = ?", row.id);
          out.push(row);
        }
        return out;
      });
    },
    moveObject(from, to, _as, dryRun) {
      return Promise.resolve().then(() => {
        const source = getObject(from.bucket, from.name);
        if (!source) return null;
        if (getObject(to.bucket, to.name)) {
          throw new StorageError("duplicate", "The resource already exists");
        }
        if (dryRun) return source;
        run(
          "update objects set bucket_id = ?, name = ?, updated_at = ? where id = ?",
          to.bucket,
          to.name,
          now(),
          source.id,
        );
        return getObject(to.bucket, to.name);
      });
    },
    listObjects(bucket, query: ListQuery): Promise<ListEntry[]> {
      return Promise.resolve().then(() => {
        const rows = all(
          `select * from objects where bucket_id = ? and name like ? escape '\\' and metadata is not null`,
          bucket,
          `${likeEscape(query.prefix)}%`,
        ).map(objectRow).filter((r) => matchesSearch(r.name, query.prefix, query.search));
        return shapeListing(rows, query);
      });
    },
    names(bucket, after, limit) {
      return Promise.resolve().then(() =>
        all(
          "select name from objects where bucket_id = ? and name > ? order by name limit ?",
          bucket,
          after,
          limit,
        ).map((r) => r.name as string)
      );
    },
    createResumable(row) {
      return Promise.resolve().then(() =>
        void run(
          `insert into resumable_uploads (id, bucket_id, name, state, expires_at) values (?, ?, ?, ?, ?)`,
          row.id,
          row.bucket_id,
          row.name,
          JSON.stringify(stateOf(row)),
          row.expires_at,
        )
      );
    },
    getResumable(id) {
      return Promise.resolve().then(() =>
        resumable(one("select * from resumable_uploads where id = ?", id))
      );
    },
    leaseResumable(id, offset, lease, until) {
      return Promise.resolve().then(() => {
        const current = resumable(one("select * from resumable_uploads where id = ?", id));
        if (!current || current.upload_offset !== offset) return false;
        return run(
          `update resumable_uploads set lease = ?, lease_until = ?
           where id = ? and (lease is null or lease_until < ?)`,
          lease,
          until,
          id,
          Date.now(),
        ).changes > 0;
      });
    },
    saveResumable(row) {
      return Promise.resolve().then(() =>
        void run(
          "update resumable_uploads set state = ?, lease = null, lease_until = null where id = ?",
          JSON.stringify(stateOf(row)),
          row.id,
        )
      );
    },
    deleteResumable(id) {
      return Promise.resolve().then(() =>
        void run("delete from resumable_uploads where id = ?", id)
      );
    },
    expiredResumables(at, limit) {
      return Promise.resolve().then(() =>
        all("select * from resumable_uploads where expires_at < ? limit ?", at, limit).map((r) =>
          resumable(r)!
        )
      );
    },
    close() {
      handle?.close();
      handle = undefined;
    },
  };
}

/** The row without its lease columns (they live in columns of their own). */
function stateOf(row: ResumableRow): Omit<ResumableRow, "lease" | "lease_until"> {
  const { lease: _l, lease_until: _u, ...state } = row;
  return state;
}
