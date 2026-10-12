// @denext/backend storage on the `s3()` driver against an in-memory S3 (tests/_fake-s3.ts),
// and the browser client (`uploadFile` / `getFileUrl`) end to end: presigned PUT + verify on
// completion, multipart (client and server side), presigned GETs, public redirects,
// transforms fetched from the store, listing with URL-encoded keys, and error mapping.
// The same flows against a real MinIO run in backend-s3-minio.test.ts when one is configured.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { FakeS3 } from "./_fake-s3.ts";
import { backendApp, ORIGIN } from "./_backend-app.ts";
import { s3, StorageError } from "../packages/backend/mod.ts";
import { storage } from "../packages/backend/server.ts";
import { getFileUrl, StorageClientError, uploadFile } from "../packages/backend/client.ts";
import { samplePng } from "./fixtures/sample-image.ts";

const CREDENTIALS = { accessKeyId: "AKIDTEST", secretAccessKey: "secret-test-key" };
const S3_ENDPOINT = "http://s3.test";

function driver(fake: FakeS3) {
  return s3({
    endpoint: S3_ENDPOINT,
    region: "us-east-1",
    bucket: fake.bucket,
    credentials: CREDENTIALS,
    fetch: fake.fetch,
  });
}

/** Route the client's fetches: the store's host to the fake, everything else to the app. */
function withFetch<T>(
  app: { handler: (r: Request) => Promise<Response> },
  fake: FakeS3,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN);
    if (url.origin === S3_ENDPOINT) return fake.fetch(url, init);
    const headers = new Headers(init?.headers);
    headers.set("host", new URL(ORIGIN).host);
    if (init?.method === "POST") headers.set("origin", ORIGIN);
    return app.handler(new Request(url, { ...init, headers }));
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const buckets = {
  media: {
    mime: ["image/png", "application/octet-stream", "text/plain"],
    authorize: () => true,
    maxBytes: 64 * 1024 * 1024,
  },
  pub: { public: true, authorize: () => true },
};

Deno.test("s3 storage: client upload → presigned PUT → verified completion → presigned GET", async () => {
  const fake = new FakeS3();
  const app = await backendApp({ buckets, driver: driver(fake) });
  try {
    const progress: number[] = [];
    const file = new File([samplePng() as BlobPart], "Photo.PNG", { type: "image/png" });
    const stored = await withFetch(
      app,
      fake,
      () =>
        uploadFile("media", file, {
          key: "u1/photo.png",
          onProgress: ({ loaded }) => progress.push(loaded),
          endpoint: "/_denext/storage",
        }),
    );
    assertEquals([stored.key, stored.size, stored.contentType], [
      "u1/photo.png",
      file.size,
      "image/png",
    ]);
    assertEquals(progress.at(-1), file.size);
    assertEquals(fake.objects.get("media/u1/photo.png")?.contentType, "image/png");
    const put = fake.calls.find((c) => c.method === "PUT")!;
    const signed = new URL(put.url).searchParams.get("X-Amz-SignedHeaders");
    assertEquals(
      signed,
      "content-length;content-type;host",
      "the presigned PUT pins type and size",
    );

    const url = await withFetch(
      app,
      fake,
      () => getFileUrl("media", "u1/photo.png", { expiresIn: 120, endpoint: "/_denext/storage" }),
    );
    assert(url.startsWith(`${S3_ENDPOINT}/test-bucket/media/u1/photo.png?`), url);
    assertEquals(new URL(url).searchParams.get("X-Amz-Expires"), "120");
    const got = await fake.fetch(url);
    assertEquals((await got.bytes()).byteLength, file.size);

    // A transform goes through the plugin, which reads the object from the store.
    const sized = await withFetch(
      app,
      fake,
      () =>
        getFileUrl("media", "u1/photo.png", {
          transform: { width: 32 },
          endpoint: "/_denext/storage",
        }),
    );
    assertStringIncludes(sized, "/_denext/storage/o/media/u1/photo.png?exp=");
    const img = await app.call(sized);
    assertEquals([img.status, img.headers.get("content-type")], [200, "image/webp"]);
    await img.body?.cancel();
  } finally {
    await app.close();
  }
});

Deno.test("s3 storage: content that contradicts its type is deleted at completion", async () => {
  const fake = new FakeS3();
  const app = await backendApp({ buckets, driver: driver(fake) });
  try {
    const html = new File(["<html><script>alert(1)</script>"], "x.png", { type: "image/png" });
    const err = await withFetch(
      app,
      fake,
      () => assertRejects(() => uploadFile("media", html, { key: "evil.png" }), StorageClientError),
    );
    assertEquals([err.code, err.status], ["mime_mismatch", 415]);
    assertEquals(fake.objects.has("media/evil.png"), false, "the object is gone");
    // The store refuses a body other than the signed size (S3 checks signed headers).
    const plan = await storage.bucket("media", { service: true }).createSignedUploadUrl(
      "sized.bin",
      {
        contentType: "application/octet-stream",
        size: 4,
      },
    );
    const wrong = await fake.fetch(plan.url, { method: "PUT", body: new Uint8Array(4) });
    assertEquals(wrong.status, 403, "content-type was signed but not sent");
    await wrong.body?.cancel();
    // Bytes swapped behind the server's back after signing: completion catches the size.
    await fake.fetch(plan.url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-length": "4" },
      body: "1234",
    });
    fake.objects.get("media/sized.bin")!.body = new Uint8Array(9);
    const app2 = await withFetch(
      app,
      fake,
      () =>
        fetch(`${ORIGIN}/_denext/storage/sign`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "complete", token: plan.token }),
        }),
    );
    assertEquals([app2.status, (await app2.json()).error.code], [400, "bad_request"]);
    assertEquals(fake.objects.has("media/sized.bin"), false);
  } finally {
    await app.close();
  }
});

Deno.test("s3 storage: large files go multipart from the client (parts, ETags, abort on failure)", async () => {
  const fake = new FakeS3();
  const app = await backendApp({
    buckets,
    driver: driver(fake),
    multipartThreshold: 1024,
    partSize: 1,
  });
  try {
    const size = 5 * 1024 * 1024 + 300; // two parts: the 5 MiB minimum, then the rest
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes[size - 1] = 7;
    const file = new Blob([bytes], { type: "image/png" });
    let last = 0;
    const stored = await withFetch(
      app,
      fake,
      () =>
        uploadFile("media", file, {
          key: "big.png",
          concurrency: 2,
          onProgress: ({ loaded }) => (last = loaded),
        }),
    );
    assertEquals([stored.size, last], [size, size]);
    const obj = fake.objects.get("media/big.png")!;
    assertEquals([obj.body.byteLength, obj.body[size - 1], obj.contentType], [
      size,
      7,
      "image/png",
    ]);
    assertEquals(
      fake.calls.filter((c) => c.method === "PUT" && c.url.includes("partNumber")).length,
      2,
    );

    // A part that fails aborts the whole upload on the server.
    fake.failNext = "PUT";
    await withFetch(
      app,
      fake,
      () => assertRejects(() => uploadFile("media", file, { key: "fail.png" })),
    );
    assertEquals(fake.uploads.size, 0, "the multipart upload was aborted");
    assertEquals(fake.objects.has("media/fail.png"), false);
    // A store that hides the ETag header cannot complete a multipart upload.
    const hiding = new FakeS3();
    const original = hiding.fetch;
    hiding.fetch = async (input, init) => {
      const res = await original(input, init);
      const headers = new Headers(res.headers);
      headers.delete("etag");
      return new Response(res.body, { status: res.status, headers });
    };
    const app2 = await backendApp({ buckets, driver: driver(hiding), multipartThreshold: 1024 });
    try {
      const err = await withFetch(
        app2,
        hiding,
        () => assertRejects(() => uploadFile("media", file), StorageClientError),
      );
      assertEquals(err.code, "missing_etag");
    } finally {
      await app2.close();
    }
  } finally {
    await app.close().catch(() => {});
  }
});

Deno.test("s3 storage: server-side upload streams multipart, lists URL-encoded keys, maps errors", async () => {
  const fake = new FakeS3();
  const app = await backendApp({
    buckets: { media: { maxBytes: 32 * 1024 * 1024 } },
    driver: driver(fake),
  });
  try {
    const bucket = storage.bucket("media", { service: true });
    const big = new Uint8Array(9 * 1024 * 1024 + 5);
    big[big.length - 1] = 1;
    const chunks = new ReadableStream<Uint8Array>({
      start(c) {
        for (let at = 0; at < big.length; at += 1024 * 1024) {
          c.enqueue(big.subarray(at, at + 1024 * 1024));
        }
        c.close();
      },
    });
    const info = await bucket.upload("dir/big.bin", chunks, {
      contentType: "application/octet-stream",
    });
    assertEquals(info.size, big.length);
    assertEquals(fake.objects.get("media/dir/big.bin")?.body.byteLength, big.length);
    for (const key of ["a b+c.txt", "dir/ü.txt", "z.txt"]) {
      await bucket.upload(key, "x", { contentType: "text/plain" });
    }
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list("", { limit: 2, cursor });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.cursor;
    } while (cursor);
    assertEquals(keys, ["a b+c.txt", "dir/big.bin", "dir/ü.txt", "z.txt"]);
    assertEquals((await bucket.list("dir/")).objects.map((o) => o.size), [big.length, 1]);
    const head = await bucket.head("a b+c.txt");
    assertEquals([head?.size, head?.contentType], [1, "text/plain"]);
    assertEquals(await new Response((await bucket.download("z.txt"))!.body).text(), "x");
    assertEquals(await bucket.head("missing"), null);
    assertEquals(await bucket.download("missing"), null);
    await bucket.remove(["z.txt", "missing"]);
    assertEquals(fake.objects.has("media/z.txt"), false);

    fake.failNext = "GET";
    const err = await assertRejects(() => bucket.download("a b+c.txt"), StorageError);
    assertEquals(err.code, "driver_error");
    assertStringIncludes(err.message, "InternalError — boom & bust");
    // A server-side multipart upload that fails mid-way is aborted.
    fake.failNext = "PUT";
    await assertRejects(
      () => bucket.upload("fail.bin", new Blob([new Uint8Array(9 * 1024 * 1024)]).stream()),
      StorageError,
    );
    assertEquals(fake.uploads.size, 0);
  } finally {
    await app.close();
  }
});

Deno.test("s3 storage: public objects redirect to a short-lived presigned GET; abort + late errors", async () => {
  const fake = new FakeS3();
  const app = await backendApp({ buckets, driver: driver(fake), multipartThreshold: 1024 });
  try {
    await storage.bucket("pub", { service: true }).upload("logo.png", samplePng());
    const res = await app.call("/_denext/storage/o/pub/logo.png");
    assertEquals(res.status, 302);
    const location = new URL(res.headers.get("location")!);
    assertEquals(location.searchParams.get("X-Amz-Expires"), "300");
    assertEquals((await (await fake.fetch(location)).bytes()).byteLength, samplePng().byteLength);
    // Direct stores take uploads at their own URL, never through the plugin.
    const put = await app.call("/_denext/storage/o/pub/logo.png", { method: "PUT", body: "x" });
    assertEquals(put.status, 501);
    await put.body?.cancel();
    // Abort a multipart plan through the sign route.
    const plan = await (await app.sign({
      op: "upload",
      bucket: "media",
      key: "m.bin",
      contentType: "application/octet-stream",
      size: 6 * 1024 * 1024,
    })).json();
    assertEquals(plan.multipart.parts.length, 1);
    assertEquals(fake.uploads.size, 1);
    assertEquals(await (await app.sign({ op: "abort", token: plan.multipart.token })).json(), {
      ok: true,
    });
    assertEquals(fake.uploads.size, 0);
    // Completion without parts, with parts out of order, or that S3 rejects late.
    const plan2 = await (await app.sign({
      op: "upload",
      bucket: "media",
      key: "n.bin",
      contentType: "application/octet-stream",
      size: 6 * 1024 * 1024,
    })).json();
    const noParts = await app.sign({ op: "complete", token: plan2.multipart.token });
    assertEquals(noParts.status, 400);
    await noParts.body?.cancel();
    const disorder = await app.sign({
      op: "complete",
      token: plan2.multipart.token,
      parts: [{ partNumber: 2, etag: "x" }],
    });
    assertEquals(disorder.status, 400);
    await disorder.body?.cancel();
    const late = await app.sign({
      op: "complete",
      token: plan2.multipart.token,
      parts: [{ partNumber: 1, etag: "x" }],
    });
    assertEquals([late.status, (await late.json()).error.code], [502, "driver_error"]);
  } finally {
    await app.close();
  }
});

Deno.test("s3(): options, addressing styles and credentials", async () => {
  const seen: string[] = [];
  const spy = (input: RequestInfo | URL) => {
    seen.push(String(input));
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  const aws = s3({
    region: "eu-west-1",
    bucket: "assets",
    credentials: CREDENTIALS,
    fetch: spy as typeof fetch,
  });
  await aws.head("b", "k");
  const custom = s3({
    endpoint: "https://r2.test/",
    region: "auto",
    bucket: "assets",
    credentials: CREDENTIALS,
    pathStyle: false,
    fetch: spy as typeof fetch,
  });
  await custom.head("b", "k");
  assertEquals(seen, [
    "https://assets.s3.eu-west-1.amazonaws.com/b/k",
    "https://assets.r2.test/b/k",
  ]);
  const presigned = new URL(await aws.direct!.presignGet("b", "k k", { expiresIn: 60 }));
  assertEquals(presigned.pathname, "/b/k%20k");
  await assertRejects(() => Promise.resolve().then(() => s3({} as never)), TypeError);
  if (!Deno.env.get("AWS_ACCESS_KEY_ID")) {
    const noCreds = s3({
      endpoint: S3_ENDPOINT,
      region: "us-east-1",
      bucket: "b",
      fetch: spy as typeof fetch,
    });
    await assertRejects(() => noCreds.head("b", "k"), StorageError, "no credentials");
  }
  const created = s3({
    endpoint: S3_ENDPOINT,
    region: "us-east-1",
    bucket: "b",
    credentials: CREDENTIALS,
    fetch: (() => Promise.resolve(new Response("<x/>"))) as typeof fetch,
  });
  await assertRejects(
    () => created.direct!.createMultipart("b", "k", "text/plain"),
    StorageError,
    "UploadId",
  );
  const denied = s3({
    endpoint: S3_ENDPOINT,
    region: "us-east-1",
    bucket: "b",
    credentials: CREDENTIALS,
    fetch: (() => Promise.resolve(new Response(null, { status: 403 }))) as typeof fetch,
  });
  const err = await assertRejects(() => denied.head("b", "k"), StorageError);
  assertEquals([err.code, err.message], ["driver_error", "s3 HEAD: HTTP 403"]);
});

Deno.test("s3 storage: presigned GETs force attachment unless the stored type is inline-safe", async () => {
  const fake = new FakeS3();
  const app = await backendApp({ buckets, driver: driver(fake) });
  try {
    const media = storage.bucket("media", { service: true });
    // A client PUT to its presigned URL and never completed: nothing sniffed the bytes.
    const plan = await media.createSignedUploadUrl("ghost.bin", {
      contentType: "application/octet-stream",
    });
    const html = new TextEncoder().encode("<script>alert(document.domain)</script>");
    const put = await fake.fetch(plan.url, {
      method: "PUT",
      headers: plan.headers,
      body: html,
    });
    assertEquals(put.status, 200);
    await put.body?.cancel();
    const ghost = new URL(await media.createSignedUrl("ghost.bin"));
    assertEquals(ghost.searchParams.get("response-content-disposition"), "attachment");
    assertEquals(ghost.searchParams.get("response-content-type"), "application/octet-stream");
    assertStringIncludes(ghost.searchParams.get("X-Amz-SignedHeaders") ?? "", "host");
    // A raster image stays inline; a key with nothing stored is an attachment, untyped.
    await media.upload("p.png", samplePng());
    const png = new URL(await media.createSignedUrl("p.png"));
    assertEquals(png.searchParams.get("response-content-disposition"), "inline");
    assertEquals(png.searchParams.get("response-content-type"), "image/png");
    const missing = new URL(await media.createSignedUrl("nothing-here"));
    assertEquals(missing.searchParams.get("response-content-disposition"), "attachment");
    assertEquals(missing.searchParams.has("response-content-type"), false);
    // The public redirect carries the same overrides.
    await storage.bucket("pub", { service: true }).upload("page.txt", "x", {
      contentType: "application/octet-stream",
    });
    const res = await app.call("/_denext/storage/o/pub/page.txt");
    const location = new URL(res.headers.get("location")!);
    assertEquals(location.searchParams.get("response-content-disposition"), "attachment");
  } finally {
    await app.close();
  }
});
