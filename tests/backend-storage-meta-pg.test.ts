// The Postgres storage metadata store, unit level, over a scripted `SqlClient`: which statements
// run as the service and which through the RLS-scoped client, that a scoped write carries no
// RETURNING (an INSERT policy alone allows an upload), dry runs roll back, SQLSTATEs map to
// storage errors, and rows come back in the shapes the store promises. The statements themselves
// run against a real Postgres in tests/backend-storage-supabase-integration.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { SqlClient } from "../src/server/postgres.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import {
  postgresMetaStore,
  storageMigrations,
  versionPredicate,
} from "../packages/backend/src/storage-meta-pg.ts";
import { StorageError } from "../packages/backend/src/errors.ts";
import type { Actor, ResumableRow } from "../packages/backend/src/storage-meta.ts";

type Responder = (text: string, params: unknown[]) => unknown[] | Error;

function scripted(responder: Responder) {
  const log: { text: string; params: unknown[] }[] = [];
  const query = (text: string, params: unknown[] = []) => {
    log.push({ text, params });
    const out = responder(text, params);
    const settled = out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    settled.catch(() => {});
    const thenable = {
      then: (a?: (v: unknown) => unknown, b?: (e: unknown) => unknown) => settled.then(a, b),
      simple: () => thenable,
    };
    return thenable;
  };
  const client =
    ((strings: TemplateStringsArray, ...values: unknown[]) =>
      query(strings.join("$?"), values)) as unknown as SqlClient;
  client.unsafe =
    ((text: string, params?: unknown[]) => query(text, params)) as SqlClient["unsafe"];
  client.begin = (async (fn: (tx: SqlClient) => unknown) => {
    const result = fn(client);
    return Array.isArray(result) ? await Promise.all(result) : await result;
  }) as SqlClient["begin"];
  client.savepoint = client.begin as SqlClient["savepoint"];
  client.close = () => Promise.resolve();
  return { client, log };
}

const json = (value: unknown) => [{ j: JSON.stringify(value) }];
const err = (code: string) => Object.assign(new Error(`sqlstate ${code}`), { code });
const SCOPED: Actor = {
  kind: "scoped",
  scope: { role: "authenticated", claims: JSON.stringify({ sub: "u1", role: "authenticated" }) },
};
const SERVICE: Actor = { kind: "service" };
const OBJECT = {
  id: "00000000-0000-0000-0000-000000000001",
  bucket_id: "b",
  name: "k.txt",
  owner: null,
  owner_id: "u1",
  version: "v1",
  metadata: null,
  user_metadata: null,
  created_at: "t",
  updated_at: "t",
  last_accessed_at: "t",
};

Deno.test("pg metadata store: statements, scoping, dry runs, errors and shapes", async () => {
  const failures: [RegExp, Error][] = [];
  const answers: [RegExp, unknown[]][] = [];
  const { client, log } = scripted((text, params) => {
    const failure = failures.findIndex(([re]) => re.test(text));
    if (failure >= 0) return failures.splice(failure, 1)[0][1];
    const answer = answers.findIndex(([re]) => re.test(text));
    if (answer >= 0) return answers.splice(answer, 1)[0][1];
    if (/count\(\*\)::int as n/.test(text)) return json({ n: params[0] === "full" ? 1 : 0 });
    return [];
  });
  installPostgres({ sql: client, rls: { migrate: false } });
  try {
    const store = postgresMetaStore();
    assertEquals(store.kind, "postgres");
    await store.ready();
    assert(log.some((s) => s.text.includes("CREATE TABLE IF NOT EXISTS storage.objects")));
    assert(storageMigrations()[0].sql.includes("storage.foldername"));

    answers.push([
      /from storage\.buckets where id = \$1/,
      json({ id: "b", name: "b", public: true, file_size_limit: "1024" }),
    ]);
    assertEquals((await store.getBucket("b", SERVICE))?.file_size_limit, 1024);
    assertEquals(await store.getBucket("zz", SERVICE), null);

    const bucket = { id: "b", public: false, file_size_limit: null, allowed_mime_types: null };
    failures.push([/insert into storage\.buckets/, err("23505")]);
    await assertRejects(() => store.createBucket(bucket, SERVICE), StorageError, "already exists");
    failures.push([/insert into storage\.buckets/, err("42501")]);
    await assertRejects(
      () => store.createBucket(bucket, SCOPED),
      StorageError,
      "row-level security",
    );
    failures.push([/insert into storage\.buckets/, err("XX000")]);
    await assertRejects(() => store.createBucket(bucket, SERVICE), Error, "XX000");
    await store.createBucket(bucket, SERVICE);
    await store.syncBuckets([bucket]);
    answers.push([/update storage\.buckets/, json({ id: "b" })]);
    assertEquals(await store.updateBucket(bucket, SERVICE), true);
    assertEquals(await store.updateBucket(bucket, SERVICE), false);
    await assertRejects(() => store.deleteBucket("full", SERVICE), StorageError, "not empty");
    answers.push([/delete from storage\.buckets/, json({ id: "b" })]);
    assertEquals(await store.deleteBucket("b", SERVICE), true);
    answers.push([/order by created_at desc limit \$3/, json(bucket)]);
    assertEquals(
      (await store.listBuckets({ column: "created_at", order: "desc", search: "b%" }, SERVICE))
        .length,
      1,
    );
    const listedBuckets = log.findLast((s) => s.text.includes("from storage.buckets"))!;
    assertEquals(listedBuckets.params.slice(0, 2), ["b%", "%b\\%%"]);

    // A scoped write: no RETURNING, then the row read back as the service.
    const write = {
      bucket_id: "b",
      name: "k.txt",
      owner_id: "u1",
      version: "v1",
      metadata: null,
      user_metadata: { a: 1 },
    };
    answers.push([/where bucket_id = \$1 and name = \$2/, json(OBJECT)]);
    const before = log.length;
    assertEquals((await store.writeObject(write, false, SCOPED)).id, OBJECT.id);
    const insert = log.slice(before).find((s) => s.text.includes("insert into storage.objects"))!;
    assert(!/returning/i.test(insert.text), "a scoped insert has no RETURNING");
    assert(log.slice(before).some((s) => s.params[0] === "authenticated"), "scoped by role");
    assertEquals(insert.params[2], null, "a non-uuid owner is not cast");
    answers.push([/insert into storage\.objects/, json(OBJECT)]);
    assertEquals(
      (await store.writeObject({ ...write, owner_id: OBJECT.id }, true, SERVICE)).name,
      "k.txt",
    );
    failures.push([/insert into storage\.objects/, err("23503")]);
    await assertRejects(
      () => store.writeObject(write, false, SERVICE),
      StorageError,
      "Bucket not found",
    );

    // Dry runs: nothing for the service; rolled back under a scope; a policy refusal surfaces.
    const quiet = log.length;
    await store.checkWrite(write, true, SERVICE);
    assertEquals(log.length, quiet);
    await store.checkWrite(write, true, SCOPED);
    assert(
      log.slice(quiet).some((s) =>
        s.text.includes("on conflict (bucket_id, name) where archived_at is null do update")
      ),
    );
    failures.push([/insert into storage\.objects/, err("42501")]);
    await assertRejects(
      () => store.checkWrite(write, false, SCOPED),
      StorageError,
      "row-level security",
    );

    answers.push([/update storage\.objects set metadata/, json(OBJECT)]);
    assertEquals((await store.finishObject("b", "k.txt", "v1", {} as never))?.id, OBJECT.id);
    assertEquals(await store.finishObject("b", "k.txt", "v2", {} as never), null);
    answers.push([/delete from storage\.objects/, json(OBJECT)]);
    assertEquals((await store.deleteObjects("b", ["k.txt"], SCOPED, "v1")).length, 1);

    // Moves: an absent source, a taken destination, a dry run, the real thing.
    const from = { bucket: "b", name: "k.txt" };
    const to = { bucket: "b", name: "m.txt" };
    assertEquals(await store.moveObject(from, to, SCOPED, true), null);
    answers.push([/where bucket_id = \$1 and name = \$2/, json(OBJECT)]);
    answers.push([/where bucket_id = \$1 and name = \$2/, json(OBJECT)]);
    await assertRejects(
      () => store.moveObject(from, to, SCOPED, true),
      StorageError,
      "already exists",
    );
    answers.push([/where bucket_id = \$1 and name = \$2/, json(OBJECT)]);
    assertEquals((await store.moveObject(from, to, SCOPED, true))?.id, OBJECT.id);
    answers.push([/update storage\.objects set bucket_id/, json({ ...OBJECT, name: "m.txt" })]);
    assertEquals((await store.moveObject(from, to, SERVICE, false))?.name, "m.txt");

    // Listings: a column off the list falls back to `name`; the search is escaped.
    await store.listObjects("b", {
      prefix: "a_b/",
      search: "50%",
      limit: 10,
      offset: 0,
      column: "owner; drop" as "name",
      order: "desc",
    }, SCOPED);
    const listing = log.findLast((s) => s.text.includes("split_part"))!;
    assert(listing.text.includes("order by entry desc"));
    assertEquals(listing.params.slice(1, 4), ["a\\_b/%", 5, "50\\%%"]);
    answers.push([/select name from storage\.objects/, json({ name: "x" })]);
    assertEquals(await store.names("b", "", 10), ["x"]);

    // Resumable uploads (always the service).
    const row = {
      id: "r1",
      bucket_id: "b",
      name: "k",
      upload_length: 1,
      upload_offset: 0,
      expires_at: 1,
      lease: null,
      lease_until: null,
    } as unknown as ResumableRow;
    await store.createResumable(row);
    const { lease: _l, lease_until: _u, ...state } = row;
    answers.push([
      /from storage\.denext_resumable_uploads where id/,
      json({ state, lease: "x", lease_until: "5" }),
    ]);
    assertEquals((await store.getResumable("r1"))?.lease_until, 5);
    assertEquals(await store.getResumable("r2"), null);
    answers.push([/update storage\.denext_resumable_uploads set lease/, json({ id: "r1" })]);
    assertEquals(await store.leaseResumable("r1", 0, "l", 9), true);
    assertEquals(await store.leaseResumable("r1", 0, "l", 9), false);
    await store.saveResumable(row);
    await store.deleteResumable("r1");
    answers.push([/where expires_at < \$1/, json({ state, lease: null, lease_until: null })]);
    assertEquals((await store.expiredResumables(10, 5))[0].lease_until, null);
  } finally {
    installPostgres(undefined);
  }
});

Deno.test("pg metadata store: a failed migration is retried by the next call", async () => {
  let fail = true;
  const { client } = scripted((text) => {
    if (fail && text.includes("CREATE SCHEMA IF NOT EXISTS storage")) {
      fail = false;
      return new Error("boom");
    }
    return [];
  });
  installPostgres({ sql: client, rls: { migrate: false } });
  try {
    const store = postgresMetaStore();
    await assertRejects(() => store.ready(), Error, "boom");
    await store.ready();
  } finally {
    installPostgres(undefined);
  }
});

Deno.test("pg metadata store: versions, delete markers, lifecycle, flat listings", async () => {
  const answers: [RegExp, unknown[]][] = [];
  const { client, log } = scripted((text) => {
    const answer = answers.findIndex(([re]) => re.test(text));
    if (answer >= 0) return answers.splice(answer, 1)[0][1];
    return [];
  });
  installPostgres({ sql: client, rls: { migrate: false } });
  try {
    const store = postgresMetaStore();
    await store.ready();
    assert(storageMigrations()[1].sql.includes("bucketid_objname_current"));
    assertEquals(
      versionPredicate(),
      "((archived_at is null and not is_delete_marker and metadata is not null))",
    );
    assert(versionPredicate("only", "include").includes("is_delete_marker"));
    assert(!versionPredicate("only").includes("metadata is not null"));
    answers.push([/version = \$3/, json({ ...OBJECT, archived_at: "t" })]);
    assertEquals((await store.getVersion("b", "k.txt", "v1", SERVICE))?.archived_at, "t");
    answers.push([/archived_at is null`?$|and archived_at is null\s*\)?\s*r?$/m, json(OBJECT)]);
    await store.currentRow("b", "k.txt");
    const write = {
      bucket_id: "b",
      name: "k.txt",
      owner_id: null,
      version: "v2",
      metadata: null,
      user_metadata: null,
    };
    answers.push([/insert into storage\.objects/, json({ ...OBJECT, version: "v2" })]);
    assertEquals((await store.replaceCurrent(write, true)).version, "v2");
    assert(log.some((l) => l.text.includes("set archived_at = now()")));
    answers.push([/insert into storage\.objects/, json({ ...OBJECT, version: "v3" })]);
    await store.replaceCurrent(write, false);
    assert(
      log.some((l) =>
        /delete from storage\.objects\s+where bucket_id = \$1 and name = \$2 and archived_at is null/
          .test(l.text)
      ),
    );
    answers.push([
      /select .* from storage\.objects where bucket_id = \$1 and name = \$2\s+and \(\$3/s,
      json(OBJECT),
    ]);
    assertEquals((await store.checkDelete("b", "k.txt", undefined, SERVICE))?.id, OBJECT.id);
    answers.push([
      /delete from storage\.objects where bucket_id = \$1 and name = \$2\s+and \(\$3/,
      json(OBJECT),
    ]);
    assertEquals((await store.checkDelete("b", "k.txt", "v1", SCOPED))?.id, OBJECT.id);
    answers.push([/and version = \$3/, json(OBJECT)]);
    assertEquals((await store.deleteVersion("b", "k.txt", "v1"))?.id, OBJECT.id);
    answers.push([/set archived_at = null/, json(OBJECT)]);
    assertEquals((await store.promoteLatest("b", "k.txt"))?.id, OBJECT.id);
    answers.push([/set lifecycle/, json({ id: "b" })]);
    assertEquals(await store.setLifecycle("b", { rules: [] }, SERVICE), true);
    answers.push([/order by created_at desc, name desc/, json(OBJECT)]);
    assertEquals(
      (await store.listFlat("b", {
        prefix: "a/",
        limit: 10,
        offset: 0,
        column: "created_at",
        order: "desc",
        versions: "include",
      }, SERVICE)).length,
      1,
    );
    answers.push([/archived_at is not null or is_delete_marker/, json(OBJECT)]);
    assertEquals((await store.purgeVersions("b", 10)).length, 1);
    answers.push([/make_interval/, json(OBJECT)]);
    assertEquals((await store.expireNoncurrent("b", 30, 2, 100)).length, 1);
    await store.listObjects("b", {
      prefix: "k.txt",
      search: "",
      limit: 10,
      offset: 0,
      column: "name",
      order: "asc",
      versions: "include",
      markers: "include",
      exact: true,
    }, SERVICE);
    const listing = log.findLast((l) => l.text.includes("split_part"))!;
    assert(listing.text.includes("split_part(name, '/', -1)"));
    assertEquals(listing.params[6], "k.txt");
  } finally {
    installPostgres(undefined);
  }
});
