// The real `@supabase/supabase-js` (and `tus-js-client`) against `@denext/backend` storage on a
// REAL S3-compatible store (MinIO) with its metadata in a REAL Postgres (Supabase's `storage`
// schema) and SQL-RLS authorization: the per-user rules are Supabase-style policies on
// `storage.objects` using `storage.foldername(name)` and `auth.uid()`, evaluated in Postgres
// under the request's role. The same suite runs on the fs driver with TypeScript rules in
// tests/backend-storage-supabase.test.ts. Also checked here: the `storage` schema's helper
// functions and grants, and TUS resumable uploads assembled from S3 multipart parts.
//
// Opt-in, on denext's Deno runtime (`Deno.SQL`), with a superuser Postgres URL and a MinIO:
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   docker run --rm -d --name dnx-minio -p 127.0.0.1:9100:9000 \
//     -e MINIO_ROOT_USER=dnxtest -e MINIO_ROOT_PASSWORD=dnxtest-secret minio/minio server /data
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//   DENEXT_TEST_S3_ENDPOINT=http://127.0.0.1:9100 DENEXT_TEST_S3_ACCESS_KEY=dnxtest \
//   DENEXT_TEST_S3_SECRET_KEY=dnxtest-secret \
//     deno test -A tests/backend-storage-supabase-integration.test.ts

import { assertEquals } from "@std/assert";
import { builtinSql } from "../src/server/postgres.ts";
import { backend, s3 } from "../packages/backend/mod.ts";
import { db, storage } from "../packages/backend/server.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { sha256Hex, signRequest } from "../packages/backend/src/sigv4.ts";
import { postgresEnvironment as environment } from "./helpers/postgres-env.ts";
import {
  runSupabaseStorageSuite,
  storageHarness,
  supabaseKeys,
} from "./helpers/supabase-storage-suite.ts";

const env = (name: string) => Deno.env.get(name) || undefined;
const PG_URL = env("DENEXT_TEST_POSTGRES_URL");
const ENDPOINT = env("DENEXT_TEST_S3_ENDPOINT");
const REGION = env("DENEXT_TEST_S3_REGION") ?? "us-east-1";
const BUCKET = env("DENEXT_TEST_S3_BUCKET") ?? "denext-test";
const CREDENTIALS = {
  accessKeyId: env("DENEXT_TEST_S3_ACCESS_KEY") ?? "",
  secretAccessKey: env("DENEXT_TEST_S3_SECRET_KEY") ?? "",
};
const reason = !PG_URL
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !builtinSql()
  ? "needs denext's Deno runtime (Deno.SQL)"
  : !ENDPOINT
  ? "set DENEXT_TEST_S3_ENDPOINT"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";

/** Create the S3 bucket when it does not exist yet (MinIO starts empty). */
async function ensureBucket(): Promise<void> {
  const origin = new URL(ENDPOINT!).origin;
  const scope = { region: REGION, service: "s3", credentials: CREDENTIALS };
  const head = await signRequest(
    { method: "HEAD", origin, path: `/${BUCKET}` },
    scope,
    await sha256Hex(""),
  );
  delete head.headers.host;
  const exists = await fetch(head.url, { method: "HEAD", headers: head.headers });
  await exists.body?.cancel();
  if (exists.ok) return;
  const put = await signRequest(
    { method: "PUT", origin, path: `/${BUCKET}` },
    scope,
    await sha256Hex(""),
  );
  delete put.headers.host;
  const created = await fetch(put.url, { method: "PUT", headers: put.headers });
  if (!created.ok) throw new Error(`create bucket: ${created.status} ${await created.text()}`);
  await created.body?.cancel();
}

/** Supabase-style policies: a user owns `private/<their id>/…`. */
const POLICIES = `
  create policy "own folder: read" on storage.objects for select to authenticated
    using (bucket_id = 'private' and (storage.foldername(name))[1] = auth.uid()::text);
  create policy "own folder: write" on storage.objects for insert to authenticated
    with check (bucket_id = 'private' and (storage.foldername(name))[1] = auth.uid()::text);
  create policy "own folder: update" on storage.objects for update to authenticated
    using (bucket_id = 'private' and (storage.foldername(name))[1] = auth.uid()::text)
    with check (bucket_id = 'private' and (storage.foldername(name))[1] = auth.uid()::text);
  create policy "own folder: delete" on storage.objects for delete to authenticated
    using (bucket_id = 'private' and (storage.foldername(name))[1] = auth.uid()::text);
`;

Deno.test({
  name: `supabase-js storage on MinIO + Postgres with SQL-RLS policies${label}`,
  ignore: reason !== undefined,
  async fn(t) {
    const pg = await environment();
    await ensureBucket();
    installPostgres(undefined);
    const h = await storageHarness(backend({
      supabase: await supabaseKeys(),
      postgres: { sql: pg.app },
      storage: {
        secret: "storage-secret-at-least-32-characters",
        driver: s3({
          endpoint: ENDPOINT,
          region: REGION,
          bucket: BUCKET,
          credentials: CREDENTIALS,
        }),
        rls: true,
        partSize: 5 * 1024 * 1024,
        buckets: {
          private: {},
          images: { public: true, mime: ["image/png"], maxBytes: 64 * 1024 },
        },
      },
    }));
    try {
      // The schema is created on first use; then the app's own policies go on it.
      await storage.listBuckets({ service: true });
      await db.service().unsafe(POLICIES).simple!();
      await t.step("the storage schema: helpers, grants, declared buckets seeded", async () => {
        const [helpers] = await db.service()`select
          storage.foldername('a/b/c.png') as folders, storage.filename('a/b/c.png') as file,
          storage.extension('a/b/c.png') as ext`;
        assertEquals([helpers.folders, helpers.file, helpers.ext], [["a", "b"], "c.png", "png"]);
        const seeded = await db.service()`select id, public, file_size_limit::int as limit,
          allowed_mime_types as types from storage.buckets where id in ('private', 'images') order by id`;
        assertEquals(seeded.map((r) => [r.id, r.public, r.limit, r.types]), [
          ["images", true, 65536, ["image/png"]],
          ["private", false, null, null],
        ]);
        const [grants] = await db.service()`select
          has_table_privilege('authenticated', 'storage.objects', 'insert') as objects,
          has_table_privilege('anon', 'storage.denext_resumable_uploads', 'select') as tus`;
        assertEquals([grants.objects, grants.tus], [true, false]);
      });
      await runSupabaseStorageSuite(t, h);
    } finally {
      await h.close();
      installPostgres(undefined);
      await pg.drop();
    }
  },
});
