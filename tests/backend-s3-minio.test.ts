// @denext/backend storage against a REAL S3-compatible store (MinIO, R2, AWS): presigned PUT
// then GET, the store refusing a body that breaks the signed headers, multipart from the client,
// list paging with awkward keys, head and delete, a bucket's `authorize` deciding per denextAuth
// session and op (the sign route and the server API), `{ service: true }` outside a request, and
// an image transform the app serves from the store's original. Opt-in — it needs a throwaway bucket:
//
//   docker run --rm -d --name dnx-minio -p 127.0.0.1:9100:9000 \
//     -e MINIO_ROOT_USER=dnxtest -e MINIO_ROOT_PASSWORD=dnxtest-secret minio/minio server /data
//   DENEXT_TEST_S3_ENDPOINT=http://127.0.0.1:9100 DENEXT_TEST_S3_ACCESS_KEY=dnxtest \
//   DENEXT_TEST_S3_SECRET_KEY=dnxtest-secret deno test -A tests/backend-s3-minio.test.ts
//
// (`DENEXT_TEST_S3_BUCKET` defaults to `denext-test`, created when missing;
// `DENEXT_TEST_S3_REGION` to `us-east-1`.) Without `DENEXT_TEST_S3_ENDPOINT` every test here is
// skipped, so CI stays green with no store; tests/backend-s3.test.ts covers the same flows
// against an in-memory S3.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { backendApp, ORIGIN } from "./_backend-app.ts";
import { s3, StorageError } from "../packages/backend/mod.ts";
import { storage } from "../packages/backend/server.ts";
import { uploadFile } from "../packages/backend/client.ts";
import { sha256Hex, signRequest } from "../packages/backend/src/sigv4.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { samplePng } from "./fixtures/sample-image.ts";

const env = (name: string) => Deno.env.get(name) || undefined;
const ENDPOINT = env("DENEXT_TEST_S3_ENDPOINT");
const ignore = !ENDPOINT;
const REGION = env("DENEXT_TEST_S3_REGION") ?? "us-east-1";
const BUCKET = env("DENEXT_TEST_S3_BUCKET") ?? "denext-test";
const CREDENTIALS = {
  accessKeyId: env("DENEXT_TEST_S3_ACCESS_KEY") ?? "",
  secretAccessKey: env("DENEXT_TEST_S3_SECRET_KEY") ?? "",
};
/** Each run writes under its own prefix bucket name, so reruns never see old objects. */
const RUN = `run${Date.now().toString(36)}`;

/** Create the bucket when it does not exist yet (MinIO starts empty). */
async function ensureBucket(): Promise<void> {
  const origin = new URL(ENDPOINT!).origin;
  const head = await signRequest({ method: "HEAD", origin, path: `/${BUCKET}` }, {
    region: REGION,
    service: "s3",
    credentials: CREDENTIALS,
  }, await sha256Hex(""));
  delete head.headers.host;
  const exists = await fetch(head.url, { method: "HEAD", headers: head.headers });
  if (exists.ok) return;
  const put = await signRequest({ method: "PUT", origin, path: `/${BUCKET}` }, {
    region: REGION,
    service: "s3",
    credentials: CREDENTIALS,
  }, await sha256Hex(""));
  delete put.headers.host;
  const created = await fetch(put.url, { method: "PUT", headers: put.headers });
  assert(created.ok, `create bucket: ${created.status} ${await created.text()}`);
}

async function app(multipartThreshold?: number) {
  await ensureBucket();
  return await backendApp({
    driver: s3({ endpoint: ENDPOINT, region: REGION, bucket: BUCKET, credentials: CREDENTIALS }),
    buckets: {
      [RUN]: {
        mime: ["image/png", "text/plain", "application/octet-stream"],
        authorize: () => true,
        maxBytes: 64 * 1024 * 1024,
      },
    },
    ...(multipartThreshold ? { multipartThreshold } : {}),
  });
}

/** The browser: the store's URLs go out for real; the app's go to its handler. */
function browser<T>(handler: (r: Request) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), ORIGIN);
    if (url.origin !== ORIGIN) return original(url, init);
    const headers = new Headers(init?.headers);
    headers.set("host", new URL(ORIGIN).host);
    headers.set("origin", ORIGIN);
    return handler(new Request(url, { ...init, headers }));
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

Deno.test(
  { name: "minio: presigned PUT, then presigned GET (and a Range through it)", ignore },
  async () => {
    const a = await app();
    try {
      const bucket = storage.bucket(RUN, { service: true });
      const plan = await bucket.createSignedUploadUrl("docs/hello world+1.txt", {
        contentType: "text/plain",
        size: 11,
      });
      const put = await fetch(plan.url, {
        method: "PUT",
        headers: plan.headers,
        body: new TextEncoder().encode("hello world"),
      });
      assertEquals(put.status, 200, await put.text());
      const done = await a.sign({ op: "complete", token: plan.token });
      assertEquals((await done.json()).object.size, 11);
      const url = await bucket.createSignedUrl("docs/hello world+1.txt", { expiresIn: 60 });
      assertEquals(await (await fetch(url)).text(), "hello world");
      const ranged = await fetch(url, { headers: { range: "bytes=6-10" } });
      assertEquals([ranged.status, await ranged.text()], [206, "world"]);
      const download = await bucket.download("docs/hello world+1.txt");
      assertEquals(await new Response(download!.body).text(), "hello world");
    } finally {
      await a.close();
    }
  },
);

Deno.test(
  { name: "minio: the store refuses a PUT that breaks the signed type or size", ignore },
  async () => {
    const a = await app();
    try {
      const plan = await storage.bucket(RUN, { service: true }).createSignedUploadUrl(
        "pinned.txt",
        {
          contentType: "text/plain",
          size: 5,
        },
      );
      const wrongType = await fetch(plan.url, {
        method: "PUT",
        headers: { "content-type": "text/html" },
        body: new TextEncoder().encode("hello"),
      });
      assertEquals(wrongType.status, 403);
      await wrongType.body?.cancel();
      const wrongSize = await fetch(plan.url, {
        method: "PUT",
        headers: plan.headers,
        body: new TextEncoder().encode("hello!"),
      });
      assert(
        wrongSize.status >= 400,
        `MinIO accepted a body of the wrong size (${wrongSize.status})`,
      );
      await wrongSize.body?.cancel();
      assertEquals(await storage.bucket(RUN, { service: true }).head("pinned.txt"), null);
    } finally {
      await a.close();
    }
  },
);

Deno.test(
  { name: "minio: multipart upload from the client, then a verified completion", ignore },
  async () => {
    const a = await app(1024);
    try {
      const size = 5 * 1024 * 1024 + 4096;
      const bytes = new Uint8Array(size);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      bytes[size - 1] = 42;
      const stored = await browser(
        a.handler,
        () => uploadFile(RUN, new Blob([bytes], { type: "image/png" }), { key: "big/part.png" }),
      );
      assertEquals(stored.size, size);
      const head = await storage.bucket(RUN, { service: true }).head("big/part.png");
      assertEquals([head?.size, head?.contentType], [size, "image/png"]);
      const tail = await fetch(
        await storage.bucket(RUN, { service: true }).createSignedUrl("big/part.png"),
        {
          headers: { range: `bytes=${size - 1}-` },
        },
      );
      assertEquals((await tail.bytes())[0], 42);
    } finally {
      await a.close();
    }
  },
);

Deno.test({
  name: "minio: server-side upload, list paging with awkward keys, head, delete",
  ignore,
}, async () => {
  const a = await app();
  try {
    const bucket = storage.bucket(RUN, { service: true });
    const keys = ["list/a b.txt", "list/a+b.txt", "list/ü.txt", "list/z/deep.txt", "list/%41.txt"];
    for (const key of keys) await bucket.upload(key, key, { contentType: "text/plain" });
    const big = new Uint8Array(9 * 1024 * 1024);
    big[big.length - 1] = 9;
    assertEquals(
      (await bucket.upload("list/zz-big.bin", new Blob([big]).stream())).size,
      big.length,
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list("list/", { limit: 2, cursor });
      assert(page.objects.length <= 2);
      seen.push(...page.objects.map((o) => o.key));
      cursor = page.cursor;
    } while (cursor);
    assertEquals(seen, [...keys, "list/zz-big.bin"].sort());
    assertEquals((await bucket.head("list/a+b.txt"))?.size, "list/a+b.txt".length);
    await bucket.remove(seen);
    assertEquals((await bucket.list("list/")).objects, []);
    assertEquals(await bucket.head("list/a b.txt"), null);
  } finally {
    await a.close();
  }
});

Deno.test({
  name: "minio: authorize decides per session and op; outside a request only service; transforms",
  ignore,
}, async () => {
  await ensureBucket();
  const authConfig: AuthConfig = {
    secret: "minio-auth-secret-at-least-32-characters",
    canonicalOrigin: ORIGIN,
    providers: [credentials({ authorize: () => null })],
  };
  const name = `${RUN}-own`;
  const a = await backendApp(
    {
      driver: s3({ endpoint: ENDPOINT, region: REGION, bucket: BUCKET, credentials: CREDENTIALS }),
      buckets: {
        [name]: {
          mime: ["image/png", "text/plain"],
          authorize: ({ session, op, key }) =>
            !!session && key.startsWith(`${session.user.id}/`) && op !== "delete",
        },
      },
    },
    { plugins: [denextAuth(authConfig)] },
  );
  const service = storage.bucket(name, { service: true });
  try {
    const issuing = createRequestContext(new Request(`${ORIGIN}/`));
    await runWithContext(
      issuing,
      () => issueAuthSession(authConfig, { id: "u1", email: "u1@x.test" }, "credentials"),
    );
    const cookie = issuing.outgoingHeaders.getSetCookie().find((c) =>
      c.startsWith("__Host-denext_auth=")
    )!.split(";")[0];
    const plan = (key: string) => ({
      op: "upload",
      bucket: name,
      key,
      contentType: "text/plain",
      size: 5,
    });

    // The sign route: signed out, or someone else's key, is refused; the user's own is signed,
    // the store takes the PUT, and the completion is verified against the store.
    for (const [body, init] of [[plan("u1/a.txt"), {}], [plan("u2/a.txt"), { cookie }]] as const) {
      const refused = await a.sign(body, init);
      assertEquals([refused.status, (await refused.json()).error.code], [403, "forbidden"]);
    }
    const signed = await (await a.sign(plan("u1/a.txt"), { cookie })).json();
    const put = await fetch(signed.upload.url, {
      method: "PUT",
      headers: signed.upload.headers,
      body: new TextEncoder().encode("hello"),
    });
    assertEquals(put.status, 200, await put.text());
    const done = await a.sign({ op: "complete", token: signed.upload.token }, { cookie });
    assertEquals((await done.json()).object.size, 5);

    // The server API in that user's request runs authorize: own keys read and list, a delete
    // (denied for every key) and another user's key are refused.
    const asU1 = <T>(fn: () => Promise<T>) =>
      runWithContext(
        createRequestContext(new Request(`${ORIGIN}/api/x`, { headers: { cookie } })),
        fn,
      );
    await service.upload("u2/b.txt", "theirs", { contentType: "text/plain" });
    const mine = await asU1(() => storage.bucket(name).download("u1/a.txt"));
    assertEquals(await new Response(mine!.body).text(), "hello");
    assertEquals(
      (await asU1(() => storage.bucket(name).list("u1/"))).objects.map((o) => o.key),
      ["u1/a.txt"],
    );
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ["download", () => storage.bucket(name).download("u2/b.txt")],
      ["delete", () => storage.bucket(name).remove("u1/a.txt")],
    ];
    for (const [what, run] of refusals) {
      const error = await assertRejects(() => asU1(run), StorageError);
      assertEquals([error.code, error.message.startsWith(what)], ["forbidden", true]);
    }

    // Outside a request there is no session: only a service handle works.
    const outside = await assertRejects(
      () => storage.bucket(name).head("u1/a.txt"),
      StorageError,
      "{ service: true }",
    );
    assertEquals(outside.code, "forbidden");
    assertEquals((await service.head("u1/a.txt"))?.size, 5);

    // A transformed download is served by the app, which reads the original from the store.
    await service.upload("u1/logo.png", samplePng());
    const url = await service.createSignedUrl("u1/logo.png", { transform: { width: 32 } });
    assert(url.startsWith("/_denext/storage/o/"), url);
    const sized = await a.call(url);
    assertEquals([sized.status, sized.headers.get("content-type")], [200, "image/webp"]);
    assertEquals(new TextDecoder().decode((await sized.bytes()).subarray(8, 12)), "WEBP");
    const widened = await a.call(url.replace("w=32", "w=64"));
    assertEquals(widened.status, 403, "the transform is part of the signature");
    await widened.body?.cancel();
    // The untransformed URL goes straight to the store.
    const direct = await service.createSignedUrl("u1/logo.png");
    assert(direct.startsWith(new URL(ENDPOINT!).origin), direct);
    assertEquals((await (await fetch(direct)).bytes()).byteLength, samplePng().byteLength);
  } finally {
    await service.remove(["u1/a.txt", "u2/b.txt", "u1/logo.png"]).catch(() => {});
    await a.close();
  }
});

Deno.test(
  { name: "minio: publicEndpoint — browser URLs signed for another hostname of the store", ignore },
  async () => {
    await ensureBucket();
    // The same MinIO under a second name: `localhost` for the browser, the IP for the server.
    const internal = new URL(ENDPOINT!);
    const publicUrl = new URL(ENDPOINT!);
    publicUrl.hostname = internal.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const a = await backendApp({
      driver: s3({
        endpoint: internal.origin,
        publicEndpoint: publicUrl.origin,
        region: REGION,
        bucket: BUCKET,
        credentials: CREDENTIALS,
      }),
      buckets: { [RUN]: { mime: ["text/plain"], authorize: () => true } },
    });
    try {
      const bucket = storage.bucket(RUN, { service: true });
      const plan = await bucket.createSignedUploadUrl("public-host.txt", {
        contentType: "text/plain",
        size: 6,
      });
      assertEquals(new URL(plan.url).hostname, publicUrl.hostname);
      // The signature covers Host: the same URL sent to the internal name is refused.
      const wrongHost = new URL(plan.url);
      wrongHost.hostname = internal.hostname;
      const refused = await fetch(wrongHost, {
        method: "PUT",
        headers: plan.headers,
        body: new TextEncoder().encode("public"),
      });
      assertEquals(refused.status, 403);
      await refused.body?.cancel();
      const put = await fetch(plan.url, {
        method: "PUT",
        headers: plan.headers,
        body: new TextEncoder().encode("public"),
      });
      assertEquals(put.status, 200, await put.text());
      const stored = await bucket.download("public-host.txt");
      assertEquals(await new Response(stored!.body).text(), "public");
      const url = await bucket.createSignedUrl("public-host.txt");
      assertEquals(new URL(url).hostname, publicUrl.hostname);
      assertEquals(await (await fetch(url)).text(), "public");
      await bucket.remove("public-host.txt");
    } finally {
      await a.close();
    }
  },
);
