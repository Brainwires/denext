// The storage metadata store on Postgres: Supabase's `storage` schema — `storage.buckets`,
// `storage.objects` (with the same columns and unique index, row-level security enabled, and
// `anon` / `authenticated` granted access, so policies written for Supabase apply unchanged) and
// its `storage.foldername()` / `filename()` / `extension()` helpers — plus denext's own
// `storage.denext_resumable_uploads` for TUS state (never granted to the API roles).
//
// Statements run as the app's connection (the service actor) or, in the SQL-RLS mode, through a
// client scoped to the request's role and claims, so the tables' policies decide. A scoped write
// carries no RETURNING (an INSERT policy alone allows an upload, as on Supabase); the row is read
// back as the service.

import { migratePostgres, type Migration, type SqlClient } from "@denext/denext/server";
import { StorageError } from "./errors.ts";
import { db, rlsReady, scopedFor } from "./postgres.ts";
import { ownerUuid } from "./storage-meta-sqlite.ts";
import {
  type Actor,
  type BucketQuery,
  type BucketRow,
  likeEscape,
  type ListEntry,
  type ListQuery,
  type MetaStore,
  type ObjectRow,
  type ObjectWrite,
  type ResumableRow,
} from "./storage-meta.ts";

/** Where the storage migrations are recorded. */
const MIGRATIONS_TABLE = "backend_storage_migrations";

/** Supabase's helper functions, created only when missing (a restored Supabase dump keeps its own). */
const HELPERS: [string, string][] = [
  [
    "storage.foldername(text)",
    `create function storage.foldername(name text) returns text[] language plpgsql as $f$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $f$`,
  ],
  [
    "storage.filename(text)",
    `create function storage.filename(name text) returns text language plpgsql as $f$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end $f$`,
  ],
  [
    "storage.extension(text)",
    `create function storage.extension(name text) returns text language plpgsql as $f$
declare _parts text[]; _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end $f$`,
  ],
];

/**
 * The storage migration, `backend_storage_0001`: the `storage` schema and its tables (created
 * when missing; a database restored from Supabase keeps its own and gains any missing column),
 * row-level security enabled on both, grants to `anon` / `authenticated`, the helper functions,
 * and the resumable-upload table.
 *
 * @returns The migrations, in order.
 */
export function storageMigrations(): Migration[] {
  const helpers = HELPERS.map(([signature, body]) =>
    `  IF to_regprocedure('${signature}') IS NULL THEN
    EXECUTE $fn$${body}$fn$;
  END IF;`
  ).join("\n");
  return [{
    name: "backend_storage_0001",
    sql: `CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  public boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text
);
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS file_size_limit bigint;
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS allowed_mime_types text[];
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS owner_id text;
CREATE UNIQUE INDEX IF NOT EXISTS bname ON storage.buckets (name);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata jsonb,
  path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  version text,
  owner_id text,
  user_metadata jsonb
);
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS version text;
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS user_metadata jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS bucketid_objname ON storage.objects (bucket_id, name);
CREATE INDEX IF NOT EXISTS name_prefix_search ON storage.objects (name text_pattern_ops);
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;
DO $do$
BEGIN
${helpers}
END $do$;
GRANT EXECUTE ON FUNCTION storage.foldername(text), storage.filename(text), storage.extension(text)
  TO anon, authenticated;
CREATE TABLE IF NOT EXISTS storage.denext_resumable_uploads (
  id text PRIMARY KEY,
  bucket_id text NOT NULL,
  name text NOT NULL,
  state jsonb NOT NULL,
  expires_at bigint NOT NULL,
  lease text,
  lease_until bigint
);
REVOKE ALL ON storage.denext_resumable_uploads FROM anon, authenticated;`,
  }];
}

type JsonRow = { j: string };

const OBJECT_COLUMNS =
  "id, bucket_id, name, owner, owner_id, version, metadata, user_metadata, created_at, updated_at, last_accessed_at";
const BUCKET_COLUMNS_SQL =
  "id, name, owner, owner_id, public, file_size_limit, allowed_mime_types, created_at, updated_at";

/** Rows as JSON text, so every driver hands back the same shapes (timestamps as ISO strings). */
function asJson(select: string): string {
  return `select to_jsonb(r)::text as j from (${select}) r`;
}

/** A data-modifying statement's RETURNING rows as JSON text (a DML CTE must be top-level). */
function dml(statement: string, columns: string): string {
  return `with w as (${statement} returning ${columns}) select to_jsonb(w)::text as j from w`;
}

function parse<T>(rows: JsonRow[]): T[] {
  return rows.map((r) => {
    const value = JSON.parse(r.j) as Record<string, unknown>;
    if ("file_size_limit" in value && value.file_size_limit !== null) {
      value.file_size_limit = Number(value.file_size_limit);
    }
    return value as T;
  });
}

/** Map Postgres failures to storage errors: a policy refusal, a duplicate, a missing bucket. */
function mapError(err: unknown): never {
  const code = (err as { code?: unknown })?.code;
  if (code === "42501") {
    throw new StorageError("forbidden", "new row violates row-level security policy", {
      cause: err,
    });
  }
  if (code === "23505") throw new StorageError("duplicate", "The resource already exists");
  if (code === "23503") throw new StorageError("unknown_bucket", "Bucket not found");
  throw err;
}

/** Thrown inside a dry-run transaction to roll it back. */
const DRY_RUN = Symbol("dry-run");

const BUCKET_SORT = new Set(["id", "name", "created_at", "updated_at"]);
const OBJECT_SORT = new Set(["name", "updated_at", "created_at", "last_accessed_at"]);

/**
 * The Postgres metadata store, on `backend({ postgres })`'s pool.
 *
 * @returns The store.
 */
export function postgresMetaStore(): MetaStore {
  let migrated: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    migrated ??= rlsReady().then(() =>
      migratePostgres(db.service(), { migrations: storageMigrations(), table: MIGRATIONS_TABLE })
    ).then(() => undefined, (err) => {
      migrated = undefined;
      throw err;
    });
    return migrated;
  };
  const client = (as: Actor): SqlClient =>
    as.kind === "service" ? db.service() : scopedFor(as.scope);
  const query = async <T>(
    as: Actor,
    text: string,
    params: unknown[],
    wrap = true,
  ): Promise<T[]> => {
    await ready();
    try {
      const sql = wrap ? asJson(text) : text;
      return parse<T>(await client(as).unsafe<JsonRow>(sql, params) as JsonRow[]);
    } catch (err) {
      mapError(err);
    }
  };
  const exec = async (as: Actor, text: string, params: unknown[]): Promise<void> => {
    await ready();
    try {
      await client(as).unsafe(text, params);
    } catch (err) {
      mapError(err);
    }
  };
  const dryRun = async (as: Actor, text: string, params: unknown[]): Promise<void> => {
    if (as.kind === "service") return;
    await ready();
    try {
      await client(as).begin(async (tx) => {
        await tx.unsafe(text, params);
        throw DRY_RUN;
      });
    } catch (err) {
      if (err === DRY_RUN) return;
      mapError(err);
    }
  };
  const getObject = async (bucket: string, name: string, as: Actor) =>
    (await query<ObjectRow>(
      as,
      `select ${OBJECT_COLUMNS} from storage.objects where bucket_id = $1 and name = $2`,
      [bucket, name],
    ))[0] ?? null;
  const objectWriteSql = (upsert: boolean) =>
    `insert into storage.objects (bucket_id, name, owner, owner_id, version, metadata, user_metadata)
     values ($1, $2, $3::uuid, $4, $5, $6::jsonb, $7::jsonb)` +
    (upsert
      ? ` on conflict (bucket_id, name) do update set owner = excluded.owner,
          owner_id = excluded.owner_id, version = excluded.version, metadata = excluded.metadata,
          user_metadata = excluded.user_metadata, updated_at = now(), last_accessed_at = now()`
      : "");
  const objectParams = (row: ObjectWrite) => [
    row.bucket_id,
    row.name,
    ownerUuid(row.owner_id),
    row.owner_id,
    row.version,
    row.metadata ? JSON.stringify(row.metadata) : null,
    row.user_metadata ? JSON.stringify(row.user_metadata) : null,
  ];
  const resumableOf = (
    r: {
      state: Omit<ResumableRow, "lease" | "lease_until">;
      lease: string | null;
      lease_until: number | null;
    },
  ): ResumableRow => ({
    ...r.state,
    lease: r.lease,
    lease_until: r.lease_until === null ? null : Number(r.lease_until),
  });
  const stateJson = (row: ResumableRow) => {
    const { lease: _l, lease_until: _u, ...state } = row;
    return JSON.stringify(state);
  };

  return {
    kind: "postgres",
    ready,
    async syncBuckets(rows) {
      for (const row of rows) {
        await exec(
          { kind: "service" },
          `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
           values ($1, $1, $2, $3, $4::text[])
           on conflict (id) do update set public = excluded.public,
             file_size_limit = excluded.file_size_limit,
             allowed_mime_types = excluded.allowed_mime_types, updated_at = now()`,
          [row.id, row.public, row.file_size_limit, row.allowed_mime_types],
        );
      }
    },
    listBuckets(q: BucketQuery, as) {
      const column = BUCKET_SORT.has(q.column) ? q.column : "name";
      const order = q.order === "desc" ? "desc" : "asc";
      return query<BucketRow>(
        as,
        `select ${BUCKET_COLUMNS_SQL} from storage.buckets
         where ($1 = '' or name ilike $2 escape '\\')
         order by ${column} ${order} limit $3 offset $4`,
        [q.search ?? "", `%${likeEscape(q.search ?? "")}%`, q.limit ?? null, q.offset ?? 0],
      );
    },
    async getBucket(id, as) {
      return (await query<BucketRow>(
        as,
        `select ${BUCKET_COLUMNS_SQL} from storage.buckets where id = $1`,
        [id],
      ))[0] ?? null;
    },
    createBucket(row, as) {
      return exec(
        as,
        `insert into storage.buckets (id, name, owner, owner_id, public, file_size_limit, allowed_mime_types)
         values ($1, $1, $2::uuid, $3, $4, $5, $6::text[])`,
        [
          row.id,
          ownerUuid(row.owner_id ?? null),
          row.owner_id ?? null,
          row.public,
          row.file_size_limit,
          row.allowed_mime_types,
        ],
      );
    },
    async updateBucket(row, as) {
      const rows = await query<{ id: string }>(
        as,
        dml(
          `update storage.buckets set public = $2, file_size_limit = $3,
           allowed_mime_types = $4::text[], updated_at = now() where id = $1`,
          "id",
        ),
        [row.id, row.public, row.file_size_limit, row.allowed_mime_types],
        false,
      );
      return rows.length > 0;
    },
    async deleteBucket(id, as) {
      const [{ n }] = await query<{ n: number }>(
        { kind: "service" },
        "select count(*)::int as n from (select 1 from storage.objects where bucket_id = $1 limit 1) x",
        [id],
      );
      if (n > 0) {
        throw new StorageError("not_empty", "The bucket you tried to delete is not empty");
      }
      const rows = await query<{ id: string }>(
        as,
        dml("delete from storage.buckets where id = $1", "id"),
        [id],
        false,
      );
      return rows.length > 0;
    },
    getObject,
    async writeObject(row, upsert, as) {
      if (as.kind === "scoped") {
        await exec(as, objectWriteSql(upsert), objectParams(row));
        return (await getObject(row.bucket_id, row.name, { kind: "service" }))!;
      }
      const [written] = await query<ObjectRow>(
        as,
        dml(objectWriteSql(upsert), OBJECT_COLUMNS),
        objectParams(row),
        false,
      );
      return written;
    },
    checkWrite(row, upsert, as) {
      return dryRun(as, objectWriteSql(upsert), objectParams(row));
    },
    async finishObject(bucket, name, version, metadata) {
      const [row] = await query<ObjectRow>(
        { kind: "service" },
        dml(
          `update storage.objects set metadata = $4::jsonb, updated_at = now()
           where bucket_id = $1 and name = $2 and version = $3`,
          OBJECT_COLUMNS,
        ),
        [bucket, name, version, JSON.stringify(metadata)],
        false,
      );
      return row ?? null;
    },
    deleteObjects(bucket, names, as, version) {
      return query<ObjectRow>(
        as,
        dml(
          `delete from storage.objects where bucket_id = $1 and name = any($2::text[])
           and ($3::text is null or version = $3)`,
          OBJECT_COLUMNS,
        ),
        [bucket, names, version ?? null],
        false,
      );
    },
    async moveObject(from, to, as, isDryRun) {
      const text = `update storage.objects set bucket_id = $3, name = $4, updated_at = now()
        where bucket_id = $1 and name = $2`;
      const params = [from.bucket, from.name, to.bucket, to.name];
      if (isDryRun) {
        const source = await getObject(from.bucket, from.name, as);
        if (!source) return null;
        const taken = await getObject(to.bucket, to.name, { kind: "service" });
        if (taken) throw new StorageError("duplicate", "The resource already exists");
        await dryRun(as, text, params);
        return source;
      }
      const [row] = await query<ObjectRow>(
        as,
        dml(text, OBJECT_COLUMNS),
        params,
        false,
      );
      return row ?? null;
    },
    listObjects(bucket, q: ListQuery, as): Promise<ListEntry[]> {
      const column = OBJECT_SORT.has(q.column) ? q.column : "name";
      const order = q.order === "desc" ? "desc" : "asc";
      const sortKey = column === "name" ? "entry" : column;
      return query<ListEntry>(
        as,
        `with m as (
           select id, updated_at, created_at, last_accessed_at, metadata,
             split_part(substr(name, $3), '/', 1) as entry,
             strpos(substr(name, $3), '/') > 0 as is_folder
           from storage.objects
           where bucket_id = $1 and name like $2 escape '\\' and metadata is not null
             and substr(name, $3) ilike $4 escape '\\'
         ),
         f as (select entry, row_number() over (order by entry ${order}) as rn
               from m where is_folder group by entry),
         o as (select *, row_number() over (order by ${sortKey} ${order}, entry) as rn
               from m where not is_folder)
         select name, id, updated_at, created_at, last_accessed_at, metadata from (
           select entry as name, null::uuid as id, null::timestamptz as updated_at,
             null::timestamptz as created_at, null::timestamptz as last_accessed_at,
             null::jsonb as metadata, 0 as k, rn from f
           union all
           select entry, id, updated_at, created_at, last_accessed_at, metadata, 1, rn from o
         ) x order by k, rn limit $5 offset $6`,
        [
          bucket,
          `${likeEscape(q.prefix)}%`,
          q.prefix.length + 1,
          `${likeEscape(q.search)}%`,
          q.limit,
          q.offset,
        ],
      );
    },
    async names(bucket, after, limit) {
      const rows = await query<{ name: string }>(
        { kind: "service" },
        "select name from storage.objects where bucket_id = $1 and name > $2 order by name limit $3",
        [bucket, after, limit],
      );
      return rows.map((r) => r.name);
    },
    createResumable(row) {
      return exec(
        { kind: "service" },
        `insert into storage.denext_resumable_uploads (id, bucket_id, name, state, expires_at)
         values ($1, $2, $3, $4::jsonb, $5)`,
        [row.id, row.bucket_id, row.name, stateJson(row), row.expires_at],
      );
    },
    async getResumable(id) {
      const [row] = await query<Parameters<typeof resumableOf>[0]>(
        { kind: "service" },
        "select state, lease, lease_until from storage.denext_resumable_uploads where id = $1",
        [id],
      );
      return row ? resumableOf(row) : null;
    },
    async leaseResumable(id, offset, lease, until) {
      const rows = await query<{ id: string }>(
        { kind: "service" },
        dml(
          `update storage.denext_resumable_uploads set lease = $3, lease_until = $4
           where id = $1 and (state->>'upload_offset')::bigint = $2
             and (lease is null or lease_until < $5)`,
          "id",
        ),
        [id, offset, lease, until, Date.now()],
        false,
      );
      return rows.length > 0;
    },
    saveResumable(row) {
      return exec(
        { kind: "service" },
        `update storage.denext_resumable_uploads set state = $2::jsonb, lease = null,
           lease_until = null where id = $1`,
        [row.id, stateJson(row)],
      );
    },
    deleteResumable(id) {
      return exec(
        { kind: "service" },
        "delete from storage.denext_resumable_uploads where id = $1",
        [id],
      );
    },
    async expiredResumables(at, limit) {
      const rows = await query<Parameters<typeof resumableOf>[0]>(
        { kind: "service" },
        `select state, lease, lease_until from storage.denext_resumable_uploads
         where expires_at < $1 limit $2`,
        [at, limit],
      );
      return rows.map(resumableOf);
    },
  };
}
