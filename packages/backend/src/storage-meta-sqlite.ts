// The storage metadata store on Deno's built-in `node:sqlite`, for an app without Postgres: the
// same bucket, object (and object version) and resumable-upload rows as the Postgres store, in
// one file (default `.denext-storage.db` in the project root). It serves one server process;
// several replicas sharing storage need the Postgres store (`backend({ postgres })`).

import { DatabaseSync } from "node:sqlite";
import { dirname } from "@std/path";
import { StorageError } from "./errors.ts";
import {
  type BucketQuery,
  type BucketRow,
  commitKeeps,
  commitRefusal,
  type FlatQuery,
  likeEscape,
  type ListEntry,
  type ListQuery,
  matchesSearch,
  type MetaStore,
  type ObjectCommit,
  type ObjectMetadata,
  type ObjectRow,
  type ObjectWrite,
  type ResumableRow,
  shapeListing,
  type VersionFilter,
  type VersioningStatus,
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
  updated_at text not null,
  versioning_status text not null default 'DISABLED',
  lifecycle text
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
  archived_at text,
  is_delete_marker integer not null default 0,
  is_versioned integer not null default 0
);
create unique index if not exists objects_current on objects (bucket_id, name)
  where archived_at is null;
create index if not exists objects_names on objects (bucket_id, name);
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

/** A file from before versioning: rebuild `objects` (its `unique (bucket_id, name)` must go). */
const UPGRADE_V1 = `
alter table objects rename to objects_v1;
alter table buckets add column versioning_status text not null default 'DISABLED';
alter table buckets add column lifecycle text;
${SCHEMA}
insert into objects (id, bucket_id, name, owner, owner_id, version, metadata, user_metadata,
  created_at, updated_at, last_accessed_at)
  select id, bucket_id, name, owner, owner_id, version, metadata, user_metadata, created_at,
    updated_at, last_accessed_at from objects_v1;
drop table objects_v1;
`;

/** The current version of an object that exists. */
const LIVE = "archived_at is null and is_delete_marker = 0";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

function bucketRow(r: Row): BucketRow {
  return {
    id: r.id as string,
    name: r.name as string,
    owner: (r.owner as string | null) ?? null,
    owner_id: (r.owner_id as string | null) ?? null,
    public: Number(r.public) === 1,
    file_size_limit: r.file_size_limit === null ? null : Number(r.file_size_limit),
    allowed_mime_types: r.allowed_mime_types === null
      ? null
      : JSON.parse(r.allowed_mime_types as string),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    versioning_status: (r.versioning_status as VersioningStatus) ?? "DISABLED",
    lifecycle: r.lifecycle ? JSON.parse(r.lifecycle as string) : null,
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
    archived_at: (r.archived_at as string | null) ?? null,
    is_delete_marker: Number(r.is_delete_marker) === 1,
    is_versioned: Number(r.is_versioned) === 1,
  };
}

/** A UUID for `owner` when the user id is one (Supabase's `owner uuid` column), else `null`. */
export function ownerUuid(id: string | null): string | null {
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase()
    : null;
}

/** Whether a row is in a listing, by its version filters. */
function inListing(
  row: ObjectRow,
  versions: VersionFilter = "exclude",
  markers: VersionFilter = "exclude",
): boolean {
  if (row.is_delete_marker) return markers !== "exclude";
  if (row.archived_at !== null) return versions !== "exclude";
  return versions !== "only" && markers !== "only" && row.metadata !== null;
}

const BUCKET_COLUMNS = new Set(["id", "name", "created_at", "updated_at"]);

/** Compare as strings (ISO timestamps and names sort that way). */
function cmp(a: unknown, b: unknown): number {
  const x = String(a ?? "");
  const y = String(b ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Order rows by `column`, then name, then current before archived (newest archived first). */
function sortRows(rows: ObjectRow[], column: keyof ObjectRow, desc: boolean): ObjectRow[] {
  const dir = desc ? -1 : 1;
  const age = (a: ObjectRow, b: ObjectRow) =>
    a.archived_at === b.archived_at
      ? 0
      : a.archived_at === null
      ? -1
      : b.archived_at === null
      ? 1
      : cmp(b.archived_at, a.archived_at);
  return rows.sort((a, b) =>
    dir * cmp(a[column], b[column]) || dir * cmp(a.name, b.name) || age(a, b)
  );
}

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
    const columns = db.prepare("pragma table_info(objects)").all() as Row[];
    const v1 = columns.length > 0 && !columns.some((c) => c.name === "archived_at");
    db.exec(v1 ? `begin; ${UPGRADE_V1} commit;` : SCHEMA);
    handle = db;
    return db;
  };
  const all = (sql: string, ...params: unknown[]) =>
    open().prepare(sql).all(...(params as never[])) as Row[];
  const one = (sql: string, ...params: unknown[]) =>
    open().prepare(sql).get(...(params as never[])) as Row | undefined;
  const run = (sql: string, ...params: unknown[]) =>
    open().prepare(sql).run(...(params as never[]));
  const transaction = <T>(fn: () => T): T => {
    open().exec("begin");
    try {
      const out = fn();
      open().exec("commit");
      return out;
    } catch (err) {
      open().exec("rollback");
      throw err;
    }
  };
  const getObject = (bucket: string, name: string) => {
    const r = one(
      `select * from objects where bucket_id = ? and name = ? and ${LIVE}`,
      bucket,
      name,
    );
    return r ? objectRow(r) : null;
  };
  const currentRow = (bucket: string, name: string) => {
    const r = one(
      "select * from objects where bucket_id = ? and name = ? and archived_at is null",
      bucket,
      name,
    );
    return r ? objectRow(r) : null;
  };
  const byVersion = (bucket: string, name: string, version: string) => {
    const r = one(
      "select * from objects where bucket_id = ? and name = ? and version = ?",
      bucket,
      name,
      version,
    );
    return r ? objectRow(r) : null;
  };
  // A key prefix matches case-sensitively, as Postgres's `like` does (SQLite's ignores ASCII case,
  // which would list `ALICE/…` to a caller scoped to `alice/`): a byte-wise compare of the head.
  const prefixed = (bucket: string, prefix: string, exact?: boolean) =>
    (exact ? all("select * from objects where bucket_id = ? and name = ?", bucket, prefix) : all(
      "select * from objects where bucket_id = ? and substr(name, 1, length(?)) = ?",
      bucket,
      prefix,
      prefix,
    )).map(objectRow).filter((r) => exact || r.name.startsWith(prefix));
  const insertObject = (row: ObjectWrite) => {
    const t = now();
    try {
      run(
        `insert into objects (id, bucket_id, name, owner, owner_id, version, metadata, user_metadata,
         created_at, updated_at, last_accessed_at, is_versioned, is_delete_marker)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        row.bucket_id,
        row.name,
        ownerUuid(row.owner_id),
        row.owner_id,
        row.version,
        row.metadata ? JSON.stringify(row.metadata) : null,
        row.user_metadata ? JSON.stringify(row.user_metadata) : null,
        t,
        t,
        t,
        row.is_versioned ? 1 : 0,
        row.is_delete_marker ? 1 : 0,
      );
    } catch (err) {
      const message = String((err as Error).message);
      if (/UNIQUE/i.test(message)) {
        throw new StorageError("duplicate", "The resource already exists");
      }
      if (/FOREIGN KEY/i.test(message)) {
        throw new StorageError("unknown_bucket", "Bucket not found");
      }
      throw err;
    }
    return currentRow(row.bucket_id, row.name)!;
  };
  const updateCurrent = (id: string, row: ObjectWrite) => {
    const t = now();
    run(
      `update objects set owner = ?, owner_id = ?, version = ?, metadata = ?, user_metadata = ?,
       is_versioned = ?, is_delete_marker = ?, updated_at = ?, last_accessed_at = ? where id = ?`,
      ownerUuid(row.owner_id),
      row.owner_id,
      row.version,
      row.metadata ? JSON.stringify(row.metadata) : null,
      row.user_metadata ? JSON.stringify(row.user_metadata) : null,
      row.is_versioned ? 1 : 0,
      row.is_delete_marker ? 1 : 0,
      t,
      t,
      id,
    );
    return currentRow(row.bucket_id, row.name)!;
  };
  /** A commit's row, once its bytes are in (no row-level security here). */
  const landRow = (c: ObjectCommit, keep: boolean): ObjectRow => {
    const { row } = c;
    const live = currentRow(row.bucket_id, row.name);
    if (c.reserved) {
      run(
        "update objects set metadata = ?, updated_at = ? where id = ?",
        row.metadata ? JSON.stringify(row.metadata) : null,
        now(),
        live!.id,
      );
      return currentRow(row.bucket_id, row.name)!;
    }
    if (live && c.keep !== null) {
      run(
        keep
          ? "update objects set archived_at = ? where id = ?"
          : "delete from objects where id = ?",
        ...(keep ? [now(), live.id] : [live.id]),
      );
      return insertObject(row);
    }
    return live ? updateCurrent(live.id, row) : insertObject(row);
  };
  const resumable = (r: Row | undefined): ResumableRow | null =>
    r
      ? {
        ...JSON.parse(r.state as string),
        lease: r.lease ?? null,
        lease_until: r.lease_until === null ? null : Number(r.lease_until),
      }
      : null;
  const later = <T>(fn: () => T): Promise<T> => Promise.resolve().then(fn);
  const deleteRows = (rows: ObjectRow[]) => {
    for (const row of rows) run("delete from objects where id = ?", row.id);
    return rows;
  };

  return {
    kind: "sqlite",
    ready() {
      return later(() => void open());
    },
    syncBuckets(rows) {
      return later(() => {
        for (const row of rows) {
          const t = now();
          const was = (one("select versioning_status from buckets where id = ?", row.id)
            ?.versioning_status as VersioningStatus | undefined) ?? "DISABLED";
          const status = row.versioning_status === undefined ||
              (row.versioning_status === "SUSPENDED" && was === "DISABLED")
            ? was
            : row.versioning_status;
          run(
            `insert into buckets (id, name, public, file_size_limit, allowed_mime_types, created_at,
               updated_at, versioning_status)
             values (?, ?, ?, ?, ?, ?, ?, ?)
             on conflict (id) do update set public = excluded.public,
               file_size_limit = excluded.file_size_limit,
               allowed_mime_types = excluded.allowed_mime_types, updated_at = excluded.updated_at,
               versioning_status = excluded.versioning_status`,
            row.id,
            row.id,
            row.public ? 1 : 0,
            row.file_size_limit,
            row.allowed_mime_types ? JSON.stringify(row.allowed_mime_types) : null,
            t,
            t,
            status,
          );
        }
      });
    },
    listBuckets(query: BucketQuery) {
      return later(() => {
        const column = BUCKET_COLUMNS.has(query.column) ? query.column : "name";
        const order = query.order === "desc" ? "desc" : "asc";
        return all(
          `select * from buckets where (? = '' or name like ? escape '\\')
           order by ${column} ${order} limit ? offset ?`,
          query.search ?? "",
          `%${likeEscape(query.search ?? "")}%`,
          query.limit ?? -1,
          query.offset ?? 0,
        ).map(bucketRow);
      });
    },
    getBucket(id) {
      return later(() => {
        const r = one("select * from buckets where id = ?", id);
        return r ? bucketRow(r) : null;
      });
    },
    createBucket(row) {
      return later(() => {
        const t = now();
        try {
          run(
            `insert into buckets (id, name, owner, owner_id, public, file_size_limit,
               allowed_mime_types, created_at, updated_at, versioning_status)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            row.id,
            row.id,
            ownerUuid(row.owner_id ?? null),
            row.owner_id ?? null,
            row.public ? 1 : 0,
            row.file_size_limit,
            row.allowed_mime_types ? JSON.stringify(row.allowed_mime_types) : null,
            t,
            t,
            row.versioning_status ?? "DISABLED",
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
      return later(() =>
        run(
          `update buckets set public = ?, file_size_limit = ?, allowed_mime_types = ?,
             updated_at = ?, versioning_status = coalesce(?, versioning_status)
           where id = ?`,
          row.public ? 1 : 0,
          row.file_size_limit,
          row.allowed_mime_types ? JSON.stringify(row.allowed_mime_types) : null,
          now(),
          row.versioning_status ?? null,
          row.id,
        ).changes > 0
      );
    },
    deleteBucket(id) {
      return later(() => {
        if (one("select 1 as x from objects where bucket_id = ? limit 1", id)) {
          throw new StorageError("not_empty", "The bucket you tried to delete is not empty");
        }
        return run("delete from buckets where id = ?", id).changes > 0;
      });
    },
    getObject(bucket, name) {
      return later(() => getObject(bucket, name));
    },
    writeObject(row, upsert) {
      return later(() => {
        const existing = currentRow(row.bucket_id, row.name);
        if (existing && !upsert) throw new StorageError("duplicate", "The resource already exists");
        return existing ? updateCurrent(existing.id, row) : insertObject(row);
      });
    },
    checkWrite() {
      return Promise.resolve();
    },
    // No row-level security here (the SQL-RLS mode needs Postgres): the same checks against the
    // current row, then the bytes, then the row.
    async commitObject(c, _as, during) {
      const { row } = c;
      const current = await later(() => currentRow(row.bucket_id, row.name));
      const refusal = commitRefusal(c, current);
      if (refusal) throw refusal;
      const keep = commitKeeps(c, current);
      await during(current, keep);
      return await later(() => transaction(() => landRow(c, keep)));
    },
    finishObject(bucket, name, version, metadata) {
      return later(() => {
        const changed = run(
          `update objects set metadata = ?, updated_at = ?
           where bucket_id = ? and name = ? and version = ? and archived_at is null`,
          JSON.stringify(metadata),
          now(),
          bucket,
          name,
          version,
        ).changes;
        return changed ? currentRow(bucket, name) : null;
      });
    },
    deleteObjects(bucket, names, _as, version) {
      return later(() =>
        deleteRows(
          names.map((name) => getObject(bucket, name))
            .filter((row): row is ObjectRow =>
              row !== null && (version === undefined || row.version === version)
            ),
        )
      );
    },
    async moveObject(from, to, _as, dryRun, during) {
      const rename = (id: string, at: { bucket: string; name: string }) =>
        run(
          "update objects set bucket_id = ?, name = ?, updated_at = ? where id = ?",
          at.bucket,
          at.name,
          now(),
          id,
        );
      const source = await later(() => {
        const source = getObject(from.bucket, from.name);
        if (!source) return null;
        if (currentRow(to.bucket, to.name)) {
          throw new StorageError("duplicate", "The resource already exists");
        }
        if (!dryRun) rename(source.id, to);
        return source;
      });
      if (!source || dryRun) return source;
      // The destination's name is taken first, then the bytes copied; a failed copy undoes it.
      try {
        await during?.();
      } catch (err) {
        await later(() => rename(source.id, from));
        throw err;
      }
      return await later(() => getObject(to.bucket, to.name));
    },
    listObjects(bucket, query: ListQuery): Promise<ListEntry[]> {
      return later(() => {
        const rows = prefixed(bucket, query.prefix, query.exact)
          .filter((r) => inListing(r, query.versions, query.markers))
          .filter((r) => query.exact || matchesSearch(r.name, query.prefix, query.search));
        return shapeListing(rows, query);
      });
    },
    names(bucket, after, limit) {
      return later(() =>
        all(
          `select name from objects where bucket_id = ? and name > ? and ${LIVE}
           order by name limit ?`,
          bucket,
          after,
          limit,
        ).map((r) => r.name as string)
      );
    },
    getVersion(bucket, name, version) {
      return later(() => byVersion(bucket, name, version));
    },
    currentRow(bucket, name) {
      return later(() => currentRow(bucket, name));
    },
    replaceCurrent(row, keep) {
      return later(() =>
        transaction(() => {
          const current = currentRow(row.bucket_id, row.name);
          if (current && keep) {
            run("update objects set archived_at = ? where id = ?", now(), current.id);
          } else if (current) run("delete from objects where id = ?", current.id);
          return insertObject(row);
        })
      );
    },
    checkDelete(bucket, name, version) {
      return later(() =>
        version === undefined ? getObject(bucket, name) : byVersion(bucket, name, version)
      );
    },
    deleteVersion(bucket, name, version) {
      return later(() => {
        const row = byVersion(bucket, name, version);
        if (row) deleteRows([row]);
        return row;
      });
    },
    promoteLatest(bucket, name) {
      return later(() => {
        if (currentRow(bucket, name)) return null;
        const r = one(
          `select * from objects where bucket_id = ? and name = ? and archived_at is not null
           order by archived_at desc limit 1`,
          bucket,
          name,
        );
        if (!r) return null;
        run("update objects set archived_at = null where id = ?", r.id);
        return currentRow(bucket, name);
      });
    },
    setLifecycle(id, config) {
      return later(() =>
        run(
          "update buckets set lifecycle = ? where id = ?",
          config ? JSON.stringify(config) : null,
          id,
        ).changes > 0
      );
    },
    listFlat(bucket, q: FlatQuery) {
      return later(() => {
        const rows = prefixed(bucket, q.prefix, q.exact)
          .filter((r) => inListing(r, q.versions, q.markers));
        const column = ["name", "updated_at", "created_at"].includes(q.column) ? q.column : "name";
        return sortRows(rows, column as keyof ObjectRow, q.order === "desc")
          .slice(q.offset, q.offset + q.limit);
      });
    },
    noncurrentVersions(bucket, after, limit) {
      return later(() =>
        all(
          `select * from objects where bucket_id = ? and id > ?
           and (archived_at is not null or is_delete_marker = 1) order by id limit ?`,
          bucket,
          after,
          limit,
        ).map(objectRow)
      );
    },
    purgeVersions(bucket, limit) {
      return later(() =>
        deleteRows(
          all(
            `select * from objects where bucket_id = ?
             and (archived_at is not null or is_delete_marker = 1) limit ?`,
            bucket,
            limit,
          ).map(objectRow),
        )
      );
    },
    expireNoncurrent(bucket, days, keepNewer, limit) {
      return later(() => {
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        const rows = all(
          `select * from objects where bucket_id = ? and archived_at is not null
           and is_delete_marker = 0 order by name, archived_at desc`,
          bucket,
        ).map(objectRow);
        const doomed: ObjectRow[] = [];
        let name = "";
        let rank = 0;
        for (const row of rows) {
          rank = row.name === name ? rank + 1 : 1;
          name = row.name;
          if (rank > keepNewer && row.archived_at! < cutoff && doomed.length < limit) {
            doomed.push(row);
          }
        }
        return deleteRows(doomed);
      });
    },
    createResumable(row) {
      return later(() =>
        void run(
          `insert into resumable_uploads (id, bucket_id, name, state, expires_at)
           values (?, ?, ?, ?, ?)`,
          row.id,
          row.bucket_id,
          row.name,
          JSON.stringify(stateOf(row)),
          row.expires_at,
        )
      );
    },
    getResumable(id) {
      return later(() => resumable(one("select * from resumable_uploads where id = ?", id)));
    },
    leaseResumable(id, offset, lease, until) {
      return later(() => {
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
      return later(() =>
        void run(
          "update resumable_uploads set state = ?, lease = null, lease_until = null where id = ?",
          JSON.stringify(stateOf(row)),
          row.id,
        )
      );
    },
    deleteResumable(id) {
      return later(() => void run("delete from resumable_uploads where id = ?", id));
    },
    expiredResumables(at, limit) {
      return later(() =>
        all("select * from resumable_uploads where expires_at < ? limit ?", at, limit)
          .map((r) => resumable(r)!)
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
