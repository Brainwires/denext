// `@denext/backend` storage under SQL-RLS on a REAL Postgres: a write is judged by the policies
// against the object as it is when the write lands, not when it was checked. An upsert, a TUS
// upload or a signed upload authorized while a path was free cannot replace an object someone
// else creates there in the meantime (their `update` policy refuses it, and the bytes at the key
// stay theirs); emptying a bucket deletes only the versions the caller's policies let it delete.
//
// Opt-in, on denext's Deno runtime (`Deno.SQL`), with a superuser Postgres URL (no S3 needed —
// the fs driver keeps the bytes):
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/backend-storage-rls-integration.test.ts

import { assertEquals, assertRejects } from "@std/assert";
import { builtinSql } from "../src/server/postgres.ts";
import { backend, fs, StorageError } from "../packages/backend/mod.ts";
import { completeUpload } from "../packages/backend/src/storage.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { db, storage } from "../packages/backend/server.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { postgresEnvironment as environment } from "./helpers/postgres-env.ts";
import {
  accessToken,
  ANON_KEY,
  ORIGIN,
  SECRET_KEY,
  type StorageHarness,
  storageHarness,
  supabaseKeys,
  USER_A,
  USER_B,
} from "./helpers/supabase-storage-suite.ts";

const PG_URL = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const reason = !PG_URL
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !builtinSql()
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";

/** Anyone signed in reads and creates; only an object's owner replaces or deletes it. */
const POLICIES = `
  create policy "t read" on storage.objects for select to authenticated
    using (bucket_id in ('shared', 'vers'));
  create policy "t insert" on storage.objects for insert to authenticated
    with check (bucket_id in ('shared', 'vers') and owner_id = auth.uid()::text);
  create policy "t update" on storage.objects for update to authenticated
    using (bucket_id in ('shared', 'vers') and owner_id = auth.uid()::text)
    with check (bucket_id in ('shared', 'vers') and owner_id = auth.uid()::text);
  create policy "t delete" on storage.objects for delete to authenticated
    using (bucket_id in ('shared', 'vers') and owner_id = auth.uid()::text);
  create policy "t buckets" on storage.buckets for select to authenticated using (true);
`;

type Who = "service" | string;

/** A `/storage/v1` request through the app's handler, as `who` (a user's token, or the service). */
async function call(
  h: StorageHarness,
  who: Who,
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: BodyInit | null } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = who === "service" ? SECRET_KEY : await accessToken(who);
  headers.set("apikey", who === "service" ? SECRET_KEY : ANON_KEY);
  headers.set("authorization", `Bearer ${token}`);
  const url = path.startsWith("/storage/v1") ? path : `/storage/v1${path}`;
  return await h.handler(
    new Request(new URL(url, ORIGIN), {
      method,
      headers,
      body: init.body ?? null,
      ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit),
  );
}

async function text(res: Response): Promise<string> {
  return await res.text();
}

/** A body that blocks after its first read until `release()`: the upload's stall. */
function stalledBody(content: string) {
  const reading = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent) return controller.close();
      reading.resolve();
      await released.promise;
      controller.enqueue(new TextEncoder().encode(content));
      sent = true;
    },
  }, { highWaterMark: 0 });
  return { stream, reading: reading.promise, release: () => released.resolve() };
}

const b64 = (s: string) => btoa(s);

Deno.test({
  name: `storage under SQL-RLS: writes land against the object as it is then${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const pg = await environment();
    installPostgres(undefined);
    const dir = await Deno.makeTempDir({ prefix: "dnx-rls-storage-" });
    const h = await storageHarness(backend({
      supabase: await supabaseKeys(),
      postgres: { sql: pg.app },
      storage: {
        secret: "storage-secret-at-least-32-characters",
        driver: fs({ dir }),
        rls: true,
        buckets: { shared: {}, vers: { versioned: true } },
      },
    }));
    const put = (who: Who, key: string, body: BodyInit, upsert: boolean) =>
      call(h, who, "POST", `/object/shared/${key}`, {
        headers: { "content-type": "text/plain", "x-upsert": String(upsert) },
        body,
      });
    const read = async (key: string) =>
      await text(await call(h, USER_A, "GET", `/object/shared/${key}`));
    try {
      await storage.listBuckets({ service: true });
      await db.service().unsafe(POLICIES).simple!();

      await t.step(
        "an upsert stalled past its check cannot replace an object created meanwhile",
        async () => {
          const slow = stalledBody("attacker");
          const pending = call(h, USER_B, "PUT", "/object/shared/race.txt", {
            headers: { "content-type": "text/plain", "x-upsert": "true" },
            body: slow.stream,
          });
          await slow.reading; // B's upsert passed its policy check while the path was free
          const created = await put(USER_A, "race.txt", "victim", false);
          assertEquals(created.status, 200, await created.clone().text());
          slow.release();
          const res = await pending;
          assertEquals(res.status, 403, await res.clone().text());
          await res.body?.cancel();
          assertEquals(await read("race.txt"), "victim");
          const [row] = await db.service()`select owner_id from storage.objects
          where bucket_id = 'shared' and name = 'race.txt'`;
          assertEquals(row.owner_id, USER_A);
          // The owner's own upsert still lands.
          const own = await put(USER_A, "race.txt", "victim-2", true);
          assertEquals(own.status, 200, await own.clone().text());
          assertEquals(await read("race.txt"), "victim-2");
        },
      );

      await t.step(
        "a TUS upsert completed after someone else created the object is refused",
        async () => {
          const created = await call(h, USER_B, "POST", "/upload/resumable", {
            headers: {
              "tus-resumable": "1.0.0",
              "upload-length": "8",
              "x-upsert": "true",
              "upload-metadata": `bucketName ${b64("shared")},objectName ${b64("tus.txt")},` +
                `contentType ${b64("text/plain")}`,
            },
          });
          assertEquals(created.status, 201, await created.clone().text());
          const location = created.headers.get("location")!;
          await created.body?.cancel();
          assertEquals((await put(USER_A, "tus.txt", "victim", false)).status, 200);
          const patched = await call(h, USER_B, "PATCH", location, {
            headers: {
              "tus-resumable": "1.0.0",
              "upload-offset": "0",
              "content-type": "application/offset+octet-stream",
            },
            body: "attacker",
          });
          assertEquals(patched.status, 403, await patched.clone().text());
          await patched.body?.cancel();
          assertEquals(await read("tus.txt"), "victim");
        },
      );

      await t.step("a signed upsert is pinned to the object it was signed for", async () => {
        const signed = await call(h, USER_B, "POST", "/object/upload/sign/shared/signed.txt", {
          headers: { "x-upsert": "true" },
        });
        assertEquals(signed.status, 200, await signed.clone().text());
        const { url } = await signed.json() as { url: string };
        assertEquals((await put(USER_A, "signed.txt", "victim", false)).status, 200);
        const uploaded = await call(h, "service", "PUT", url, {
          headers: { "content-type": "text/plain" },
          body: "attacker",
        });
        assertEquals(uploaded.status, 409, await uploaded.clone().text());
        await uploaded.body?.cancel();
        assertEquals(await read("signed.txt"), "victim");
        // Signed for a path that stays free, it lands.
        const fresh = await call(h, USER_B, "POST", "/object/upload/sign/shared/b-own.txt", {
          headers: { "x-upsert": "true" },
        });
        const { url: freshUrl } = await fresh.json() as { url: string };
        const ok = await call(h, "service", "PUT", freshUrl, {
          headers: { "content-type": "text/plain" },
          body: "mine",
        });
        assertEquals(ok.status, 200, await ok.clone().text());
        assertEquals(await read("b-own.txt"), "mine");
      });

      await t.step(
        "a direct signed upload's bytes stay staged when its pinned completion conflicts",
        async () => {
          // B signs a client upload (the plugin's own route) while the path is free…
          const asB = new Request(`${ORIGIN}/api/x`, {
            headers: { authorization: `Bearer ${await accessToken(USER_B)}`, apikey: ANON_KEY },
          });
          const plan = await runWithContext(
            createRequestContext(asB),
            () =>
              storage.bucket("shared").createSignedUploadUrl("direct.txt", {
                contentType: "text/plain",
              }),
          );
          // …A creates the object, then B's PUT arrives: it must not reach A's bytes.
          assertEquals((await put(USER_A, "direct.txt", "victim", false)).status, 200);
          const sent = await h.handler(
            new Request(new URL(plan.url, ORIGIN), {
              method: "PUT",
              headers: { "content-type": "text/plain" },
              body: "attacker",
            }),
          );
          assertEquals(sent.status, 200, await sent.clone().text());
          await sent.body?.cancel();
          assertEquals(await read("direct.txt"), "victim");
          const err = await assertRejects(() => completeUpload(plan.token), StorageError);
          assertEquals(err.code, "conflict");
          assertEquals(await read("direct.txt"), "victim");
        },
      );

      await t.step(
        "move and copy run as the caller; a taken destination keeps its bytes",
        async () => {
          assertEquals((await put(USER_B, "b-src.txt", "b-bytes", false)).status, 200);
          const taken = await call(h, USER_B, "POST", "/object/move", {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              bucketId: "shared",
              sourceKey: "b-src.txt",
              destinationKey: "race.txt",
            }),
          });
          assertEquals(taken.status, 409, await taken.clone().text());
          await taken.body?.cancel();
          assertEquals(await read("race.txt"), "victim-2");
          const moved = await call(h, USER_B, "POST", "/object/move", {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              bucketId: "shared",
              sourceKey: "b-src.txt",
              destinationKey: "b-dst.txt",
            }),
          });
          assertEquals(moved.status, 200, await moved.clone().text());
          await moved.body?.cancel();
          assertEquals(await read("b-dst.txt"), "b-bytes");
          // B may not copy over A's object.
          const over = await call(h, USER_B, "POST", "/object/copy", {
            headers: { "content-type": "application/json", "x-upsert": "true" },
            body: JSON.stringify({
              bucketId: "shared",
              sourceKey: "b-dst.txt",
              destinationKey: "race.txt",
            }),
          });
          assertEquals(over.status, 403, await over.clone().text());
          await over.body?.cancel();
          assertEquals(await read("race.txt"), "victim-2");
        },
      );

      await t.step(
        "emptying a versioned bucket deletes only what the caller may delete",
        async () => {
          const putV = (who: Who, body: string) =>
            call(h, who, "POST", "/object/vers/a.txt", {
              headers: { "content-type": "text/plain", "x-upsert": "true" },
              body,
            });
          assertEquals((await putV(USER_A, "v1")).status, 200);
          assertEquals((await putV(USER_A, "v2")).status, 200);
          const count = async () =>
            Number(
              (await db.service()`select count(*)::int as n from storage.objects
            where bucket_id = 'vers'`)[0].n,
            );
          assertEquals(await count(), 2, "one current, one noncurrent version");
          const emptied = await call(h, USER_B, "POST", "/bucket/vers/empty");
          assertEquals(emptied.status, 200, await emptied.clone().text());
          await emptied.body?.cancel();
          assertEquals(await count(), 2, "B may delete none of A's versions");
          const own = await call(h, USER_A, "POST", "/bucket/vers/empty");
          assertEquals(own.status, 200, await own.clone().text());
          await own.body?.cancel();
          assertEquals(await count(), 0);
        },
      );
    } finally {
      await h.close();
      installPostgres(undefined);
      await pg.drop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
