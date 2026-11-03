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
import { runtime } from "../packages/backend/src/runtime.ts";
import { signedUploadId } from "../packages/backend/src/storage-tus.ts";

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

Deno.test("s3 storage: a signed upload's bytes reach the key only at its completion", async () => {
  const fake = new FakeS3();
  const app = await backendApp({ buckets, driver: driver(fake), multipartThreshold: 1024 });
  const text = (key: string) => new TextDecoder().decode(fake.objects.get(key)?.body);
  const staged = () => [...fake.objects.keys()].filter((k) => k.startsWith(".denext-staging/"));
  const putTo = (plan: { url: string; headers: Record<string, string> }, body: string) =>
    fake.fetch(plan.url, { method: "PUT", headers: plan.headers, body }).then((r) => r.status);
  const sign = (body: unknown) =>
    withFetch(app, fake, () =>
      fetch(`${ORIGIN}/_denext/storage/sign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
  try {
    const media = storage.bucket("media", { service: true });
    await media.upload("doc.txt", "original", { contentType: "text/plain" });
    const opts = { contentType: "text/plain" };

    // The presigned PUT lands in the staging place; the object keeps its bytes until completion.
    const first = await media.createSignedUploadUrl("doc.txt", opts);
    assertEquals(await putTo(first, "replaced"), 200);
    assertEquals(text("media/doc.txt"), "original", "the PUT did not touch the key");
    assertEquals(staged().length, 1);
    // Abandoned with `abort`: the staged bytes go, the object is untouched.
    const aborted = await sign({ op: "abort", token: first.token });
    assertEquals(aborted.status, 200);
    await aborted.body?.cancel();
    assertEquals([text("media/doc.txt"), staged()], ["original", []]);

    // Completed: the bytes move to the key with the row; nothing is left staged.
    const second = await media.createSignedUploadUrl("doc.txt", opts);
    assertEquals(await putTo(second, "replaced"), 200);
    const done = await sign({ op: "complete", token: second.token });
    assertEquals(done.status, 200, await done.clone().text());
    await done.body?.cancel();
    assertEquals([text("media/doc.txt"), staged()], ["replaced", []]);
    assertEquals((await media.info("doc.txt"))?.size, 8);

    // Multipart parts go to the staging place too.
    const big = new Uint8Array(5 * 1024 * 1024 + 1).fill(0x61);
    const planned = await sign({
      op: "upload",
      bucket: "media",
      key: "doc.txt",
      contentType: "text/plain",
      size: big.byteLength,
    });
    const { multipart } = await planned.json();
    for (const part of multipart.parts) {
      assertStringIncludes(new URL(part.url).pathname, "/.denext-staging/media/");
    }

    // Abandoned without a word: once it can no longer be completed, the sweep (run by the next
    // upload) frees what it left in the staging place.
    const left = await media.createSignedUploadUrl("doc.txt", opts);
    assertEquals(await putTo(left, "left behind"), 200);
    const [leftKey] = staged();
    const rt = runtime();
    const id = signedUploadId(leftKey.split("/").at(-1)!);
    const row = (await rt.meta.getResumable(id))!;
    await rt.meta.deleteResumable(id); // past its completion window
    await rt.meta.createResumable({ ...row, expires_at: Date.now() - 1 });
    await media.createSignedUploadUrl("other.txt", opts);
    // The sweep runs in the background: the bytes go first, the row last.
    for (
      let i = 0;
      i < 200 && (fake.objects.has(leftKey) || await rt.meta.getResumable(id) !== null);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assertEquals(fake.objects.has(leftKey), false, "the abandoned upload was swept");
    assertEquals(await rt.meta.getResumable(id), null);
    assertEquals(text("media/doc.txt"), "replaced");
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
    assertEquals(fake.objects.has("media/sized.bin"), false, "the PUT went to the staging place");
    const staged = [...fake.objects.keys()].find((k) => k.startsWith(".denext-staging/media/"))!;
    fake.objects.get(staged)!.body = new Uint8Array(9);
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
    assertEquals(fake.objects.has(staged), false, "the refused bytes are removed");
  } finally {
    await app.close();
  }
});

Deno.test("s3 storage: the store refuses a presigned part of any size but the planned one", async () => {
  const fake = new FakeS3();
  fake.verify = { region: "us-east-1", credentials: CREDENTIALS };
  const app = await backendApp({
    buckets,
    driver: driver(fake),
    multipartThreshold: 1024,
    partSize: 1,
  });
  try {
    const size = 5 * 1024 * 1024 + 300; // two parts: the 5 MiB minimum, then 300 bytes
    const planned = await withFetch(app, fake, () =>
      fetch(`${ORIGIN}/_denext/storage/sign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "upload",
          bucket: "media",
          key: "parts.bin",
          contentType: "application/octet-stream",
          size,
        }),
      }));
    const { multipart } = await planned.json();
    const [first, last] = multipart.parts;
    const put = async (url: string, bytes: number) => {
      const res = await fake.fetch(url, { method: "PUT", body: new Uint8Array(bytes) });
      await res.body?.cancel();
      return res.status;
    };
    // The last part was planned at 300 bytes: S3 refuses 5 MiB through its URL (the signed
    // `content-length` no longer matches), so an upload cannot outgrow its plan at the store.
    assertEquals(await put(last.url, 5 * 1024 * 1024), 403);
    assertEquals(await put(last.url, 301), 403);
    assertEquals(await put(first.url, multipart.partSize + 1), 403);
    assertEquals(await put(first.url, multipart.partSize), 200);
    assertEquals(await put(last.url, 300), 200);

    // The browser client sends exactly the planned parts: it passes the same check.
    const file = new Blob([new Uint8Array(size)], { type: "application/octet-stream" });
    const stored = await withFetch(app, fake, () => uploadFile("media", file, { key: "ok.bin" }));
    assertEquals(stored.size, size);
    assertEquals(fake.objects.get("media/ok.bin")?.body.byteLength, size);
  } finally {
    await app.close();
  }
});

Deno.test("s3 storage: a never-completed upload is never an object, and a completion sweeps it", async () => {
  const fake = new FakeS3();
  fake.verify = { region: "us-east-1", credentials: CREDENTIALS };
  const small = { mime: ["text/plain"], maxBytes: 8, authorize: () => true };
  const app = await backendApp({ buckets: { small }, driver: driver(fake) });
  const staged = () => [...fake.objects.keys()].filter((k) => k.startsWith(".denext-staging/"));
  try {
    const bucket = storage.bucket("small", { service: true });
    // No size declared, so the PUT is not length-pinned: the store takes 64 bytes into the
    // staging place, past the bucket's 8-byte cap. The client never calls the completion.
    const left = await bucket.createSignedUploadUrl("never.txt", { contentType: "text/plain" });
    const put = await fake.fetch(left.url, {
      method: "PUT",
      headers: left.headers,
      body: "x".repeat(64),
    });
    assertEquals(put.status, 200);
    assertEquals(staged().length, 1);
    // Nothing checked it, so nothing serves, signs, lists or reports it.
    assertEquals(await bucket.download("never.txt"), null);
    assertEquals(await bucket.head("never.txt"), null);
    assertEquals(await bucket.exists("never.txt"), false);
    assertEquals((await bucket.list()).objects, []);
    assertEquals(await bucket.createSignedUrls(["never.txt"]), [null]);
    // A download URL for the key reaches nothing: the bytes are not at the key.
    const get = await fake.fetch(await bucket.createSignedUrl("never.txt"));
    assertEquals(get.status, 404);
    await get.body?.cancel();
    // Completing it now is refused (over the cap) and drops the staged bytes.
    const err = await assertRejects(
      () =>
        withFetch(app, fake, async () => {
          const res = await fetch(`${ORIGIN}/_denext/storage/sign`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: "complete", token: left.token }),
          });
          if (!res.ok) throw new Error((await res.json()).error.code);
        }),
      Error,
    );
    assertEquals(err.message, "too_large");
    assertEquals(staged(), []);

    // Abandoned: a second upload is signed and sent, the first's window then passes, and the
    // second's COMPLETION (no new upload was signed) frees what the first left behind.
    const abandoned = await bucket.createSignedUploadUrl("gone.txt", { contentType: "text/plain" });
    await (await fake.fetch(abandoned.url, {
      method: "PUT",
      headers: abandoned.headers,
      body: "left",
    })).body?.cancel();
    const [leftKey] = staged();
    const next = await bucket.createSignedUploadUrl("ok.txt", {
      contentType: "text/plain",
      size: 2,
    });
    await (await fake.fetch(next.url, { method: "PUT", headers: next.headers, body: "ok" })).body
      ?.cancel();
    const rt = runtime();
    const id = signedUploadId(leftKey.split("/").at(-1)!);
    const row = (await rt.meta.getResumable(id))!;
    await rt.meta.deleteResumable(id); // past its completion window
    await rt.meta.createResumable({ ...row, expires_at: Date.now() - 1 });
    const done = await withFetch(app, fake, () =>
      fetch(`${ORIGIN}/_denext/storage/sign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "complete", token: next.token }),
      }));
    assertEquals(done.status, 200, await done.clone().text());
    await done.body?.cancel();
    for (
      let i = 0;
      i < 200 && (fake.objects.has(leftKey) || await rt.meta.getResumable(id) !== null);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assertEquals(fake.objects.has(leftKey), false, "the completion swept the abandoned upload");
    assertEquals(await rt.meta.getResumable(id), null);
    assertEquals(await bucket.exists("gone.txt"), false);
    assertEquals(new TextDecoder().decode(fake.objects.get("small/ok.txt")?.body), "ok");
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
    // A client PUT to its presigned URL and never completed: its bytes, never sniffed, wait in
    // the staging place, so nothing is served at the key.
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
    assertEquals(fake.objects.has("media/ghost.bin"), false);
    const ghost = new URL(await media.createSignedUrl("ghost.bin"));
    assertEquals(ghost.searchParams.get("response-content-disposition"), "attachment");
    assertEquals(ghost.searchParams.has("response-content-type"), false);
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

Deno.test("s3: publicEndpoint signs browser URLs for the public host; server calls keep endpoint", async () => {
  const fake = new FakeS3();
  const seen: string[] = [];
  const app = await backendApp({
    driver: s3({
      endpoint: S3_ENDPOINT,
      publicEndpoint: "https://files.example",
      region: "us-east-1",
      bucket: fake.bucket,
      credentials: CREDENTIALS,
      fetch: (input, init) => {
        seen.push(new URL(input instanceof Request ? input.url : String(input)).origin);
        return fake.fetch(input, init);
      },
    }),
    buckets: { docs: { mime: ["text/plain"], authorize: () => true } },
  });
  try {
    const bucket = storage.bucket("docs", { service: true });
    const upload = await bucket.createSignedUploadUrl("a.txt", { contentType: "text/plain" });
    const url = new URL(upload.url);
    assertEquals(url.origin, "https://files.example");
    assertStringIncludes(url.searchParams.get("X-Amz-SignedHeaders") ?? "", "host");
    assertEquals(
      url.pathname.startsWith(`/${fake.bucket}/.denext-staging/docs/`),
      true,
      "path style, to the staging place",
    );
    await bucket.upload("b.txt", "server side", { contentType: "text/plain" });
    assertEquals(new Set(seen), new Set([S3_ENDPOINT]), "the server's own calls");
    const download = new URL(await bucket.createSignedUrl("b.txt"));
    assertEquals(download.origin, "https://files.example");
  } finally {
    await app.close();
  }
});

Deno.test("s3: a driver without uploadPart sends TUS parts to length-pinned presigned URLs", async () => {
  const fake = new FakeS3();
  fake.verify = { region: "us-east-1", credentials: CREDENTIALS };
  const d = driver(fake);
  delete d.direct!.uploadPart;
  const app = await backendApp({
    driver: d,
    buckets: { docs: { mime: ["text/plain"], authorize: () => true, maxBytes: 64 << 20 } },
  });
  const tus = { "tus-resumable": "1.0.0" };
  try {
    const size = 6 * 1024 * 1024 + 10;
    const created = await app.call("/storage/v1/upload/resumable", {
      method: "POST",
      headers: {
        ...tus,
        "upload-length": String(size),
        "upload-metadata": `bucketName ${btoa("docs")},objectName ${btoa("p.txt")},contentType ${
          btoa("text/plain")
        }`,
      },
    });
    assertEquals(created.status, 201, await created.clone().text());
    await created.body?.cancel();
    // The server PUTs each part itself, through the global fetch: route the store to the fake.
    const res = await withFetch(app, fake, () =>
      app.call(created.headers.get("location")!, {
        method: "PATCH",
        headers: {
          ...tus,
          "upload-offset": "0",
          "content-type": "application/offset+octet-stream",
        },
        body: new Uint8Array(size).fill(97),
      }));
    assertEquals(res.status, 204, await res.clone().text());
    await res.body?.cancel();
    const parts = fake.calls.filter((c) => c.method === "PUT" && c.url.includes("partNumber"));
    assert(parts.length >= 1);
    for (const part of parts) {
      assertStringIncludes(
        new URL(part.url).searchParams.get("X-Amz-SignedHeaders")!,
        "content-length",
      );
    }
    assertEquals((await storage.bucket("docs", { service: true }).info("p.txt"))?.size, size);
  } finally {
    await app.close();
  }
});

Deno.test("s3: TUS uploads become multipart parts, with a tail between short PATCHes", async () => {
  const fake = new FakeS3();
  const app = await backendApp({
    driver: driver(fake),
    buckets: {
      docs: { mime: ["text/plain", "image/png"], authorize: () => true, maxBytes: 64 << 20 },
    },
  });
  const base = "/storage/v1/upload/resumable";
  const tus = { "tus-resumable": "1.0.0" };
  const meta = (name: string, type: string) =>
    `bucketName ${btoa("docs")},objectName ${btoa(name)},contentType ${btoa(type)}`;
  const MiB = 1024 * 1024;
  try {
    const size = 6 * MiB + 10;
    const bytes = new Uint8Array(size).fill(97);
    const created = await app.call(base, {
      method: "POST",
      headers: {
        ...tus,
        "upload-length": String(size),
        "upload-metadata": meta("big.txt", "text/plain"),
      },
    });
    assertEquals(created.status, 201, await created.clone().text());
    const url = created.headers.get("location")!;
    const patch = async (from: number, to: number) => {
      const res = await app.call(url, {
        method: "PATCH",
        headers: {
          ...tus,
          "upload-offset": String(from),
          "content-type": "application/offset+octet-stream",
        },
        body: bytes.slice(from, to),
      });
      assertEquals(res.status, 204, await res.clone().text());
      return Number(res.headers.get("upload-offset"));
    };
    // 1 MiB, then 2 MiB: both wait as the tail (under the 5 MiB part minimum)…
    assertEquals(await patch(0, MiB), MiB);
    assertEquals(await patch(MiB, 3 * MiB), 3 * MiB);
    // …then 3 MiB makes a 6 MiB part, and the last 10 bytes the final part.
    assertEquals(await patch(3 * MiB, 6 * MiB), 6 * MiB);
    assertEquals(await patch(6 * MiB, size), size);
    const info = await storage.bucket("docs", { service: true }).info("big.txt");
    assertEquals(info?.size, size);
    // A PNG that is not one is refused when the parts are assembled, and nothing is kept.
    const fakePng = new TextEncoder().encode("not a png at all");
    const png = await app.call(base, {
      method: "POST",
      headers: {
        ...tus,
        "upload-length": String(fakePng.length),
        "upload-metadata": meta("x.png", "image/png"),
        "content-type": "application/offset+octet-stream",
      },
      body: fakePng,
    });
    assertEquals(png.status, 415, await png.text());
    assertEquals(await storage.bucket("docs", { service: true }).exists("x.png"), false);
    // A TUS upload completes on the server, so its checks cannot be skipped: a length over the
    // bucket's cap is refused at creation, and bytes past the declared length at the PATCH.
    const over = await app.call(base, {
      method: "POST",
      headers: {
        ...tus,
        "upload-length": String((64 << 20) + 1),
        "upload-metadata": meta("over.txt", "text/plain"),
      },
    });
    assertEquals(over.status, 413, await over.text());
    const short = await app.call(base, {
      method: "POST",
      headers: { ...tus, "upload-length": "4", "upload-metadata": meta("lie.txt", "text/plain") },
    });
    assertEquals(short.status, 201, await short.clone().text());
    await short.body?.cancel();
    const lie = await app.call(short.headers.get("location")!, {
      method: "PATCH",
      headers: {
        ...tus,
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      body: "more than four",
    });
    // Refused as too large (413, `too_large`) before a byte is stored — not any error (a 500
    // would have passed the old `>= 400`).
    const lieBody = await lie.text();
    assertEquals(lie.status, 413, lieBody);
    assertStringIncludes(lieBody, "too_large");
    assertEquals(await storage.bucket("docs", { service: true }).exists("lie.txt"), false);
  } finally {
    await app.close();
  }
});

Deno.test("TUS part upload: a presigned PUT that never answers is given up on (F-L7)", async () => {
  const { putPart } = await import("../packages/backend/src/storage-tus.ts");
  let sawSignal = false;
  const hanging: typeof fetch = (_url, init) => {
    sawSignal = init?.signal instanceof AbortSignal;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  };
  const err = await assertRejects(
    () => putPart("https://store.example/part?x=1", new Uint8Array(8), 30, hanging),
    StorageError,
  );
  assert(sawSignal, "the PUT carries an abort signal");
  assertStringIncludes(err.message, "timed out");
  // An answer in time: its ETag.
  const ok: typeof fetch = () =>
    Promise.resolve(new Response(null, { status: 200, headers: { etag: '"p1"' } }));
  assertEquals(await putPart("https://store.example/part", new Uint8Array(8), 1_000, ok), '"p1"');
});

Deno.test("s3: a ranged get reports the range the store answered, none when it sent it all", async () => {
  let answer = (): Response =>
    new Response("hello world", { status: 200, headers: { "content-length": "11" } });
  const d = s3({
    endpoint: S3_ENDPOINT,
    region: "us-east-1",
    bucket: "b",
    credentials: CREDENTIALS,
    fetch: () => Promise.resolve(answer()),
  });
  // A store that ignores `Range`: the whole object, and no range claimed for it.
  const whole = await d.get("own", "k", { start: 2, end: 4 });
  assertEquals([whole?.size, whole?.range], [11, undefined]);
  await whole?.body.cancel();
  // A store that honours it: the range from its Content-Range, which may be shorter than the
  // one asked for (the server then refuses it rather than serving a short part).
  answer = () => new Response("llo", { status: 206, headers: { "content-range": "bytes 2-4/11" } });
  const part = await d.get("own", "k", { start: 2, end: 6 });
  assertEquals([part?.size, part?.range], [11, { start: 2, end: 4 }]);
  await part?.body.cancel();
});
