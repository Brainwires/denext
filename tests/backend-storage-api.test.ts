// @denext/backend storage beyond the supabase-js suite: the server API's Supabase-parity methods
// (runtime buckets, info / exists, copy / move, folder listings, batch signing), the Storage
// API's error envelope and refusals, the TUS endpoint's protocol edges (version, offsets, owner
// binding, expiry, empty uploads), the identity resolver hook, the multipart reader, and the
// small validators.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { backend, fs, StorageError } from "../packages/backend/mod.ts";
import { storage } from "../packages/backend/server.ts";
import { runtime } from "../packages/backend/src/runtime.ts";
import { parseMultipart } from "../packages/backend/src/multipart.ts";
import { parseMimeList, parseSizeLimit } from "../packages/backend/src/storage-ops.ts";
import { shapeListing } from "../packages/backend/src/storage-meta.ts";
import { parseUploadMetadata } from "../packages/backend/src/storage-tus.ts";
import { transformOf } from "../packages/backend/src/storage-api.ts";
import { bucketAndKey } from "../packages/backend/src/serve.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import {
  accessToken,
  ANON_KEY,
  cookieFor,
  ORIGIN,
  SECRET_KEY,
  storageHarness,
  supabaseKeys,
  USER_A,
  USER_B,
} from "./helpers/supabase-storage-suite.ts";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof StorageError ? err.code : String(err);
  }
};

async function harness() {
  return await storageHarness(backend({
    supabase: await supabaseKeys(),
    storage: {
      secret: "storage-secret-at-least-32-characters",
      driver: fs({ dir: ".storage" }),
      buckets: {
        own: {
          authorize: ({ identity, key }) =>
            identity.role === "authenticated" && key.startsWith(`${identity.userId}/`),
        },
      },
      authorize: ({ op }) => op === "download",
    },
  }));
}

Deno.test({
  name: "server API: runtime buckets, info, exists, copy, move, folders, batch signing",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const h = await harness();
  try {
    const opts = { service: true };
    await storage.createBucket(
      "rt-files",
      { fileSizeLimit: "2KB", allowedMimeTypes: ["text/*"] },
      opts,
    );
    assertEquals(await code(storage.createBucket("rt-files", {}, opts)), "duplicate");
    assertEquals(await code(storage.createBucket("Bad Name", {}, opts)), "invalid_bucket");
    assertEquals(await code(storage.createBucket("upload", {}, opts)), "invalid_bucket");
    assertEquals(await code(storage.createBucket("own", {}, opts)), "duplicate");
    assertEquals(await code(storage.createBucket("nope")), "forbidden");
    const info = await storage.getBucket("rt-files", opts);
    assertEquals(
      [info.public, info.fileSizeLimit, info.allowedMimeTypes, info.declared],
      [false, 2048, ["text/*"], false],
    );
    assertEquals((await storage.getBucket("own", opts)).declared, true);
    const names = (await storage.listBuckets(opts)).map((b) => b.name);
    assertEquals(names, ["own", "rt-files"]);
    await storage.updateBucket("rt-files", { public: true }, opts);
    assertEquals((await storage.getBucket("rt-files", opts)).fileSizeLimit, 2048, "partial update");
    assertEquals(await code(storage.updateBucket("own", { public: true }, opts)), "bad_request");
    assertEquals(await code(storage.updateBucket("ghost", {}, opts)), "unknown_bucket");
    assertEquals(await code(storage.deleteBucket("ghost", opts)), "unknown_bucket");
    assertEquals(await code(storage.emptyBucket("ghost", opts)), "unknown_bucket");

    const files = storage.bucket("rt-files", opts);
    await files.upload("a/one.txt", "one", { contentType: "text/plain", metadata: { n: 1 } });
    assertEquals(
      await code(files.upload("a/one.txt", "dup", { contentType: "text/plain", upsert: false })),
      "duplicate",
    );
    assertEquals(await code(files.upload("big.txt", "x".repeat(3000))), "too_large");
    assertEquals(await code(files.upload("x.bin", new Uint8Array([0, 1, 2]))), "mime_not_allowed");
    const details = await files.info("a/one.txt");
    assertEquals([details?.size, details?.contentType, details?.metadata], [3, "text/plain", {
      n: 1,
    }]);
    assertEquals(await files.info("missing.txt"), null);
    assertEquals([await files.exists("a/one.txt"), await files.exists("missing.txt")], [
      true,
      false,
    ]);
    const copied = await files.copy("a/one.txt", "b/two.txt");
    assertEquals([copied.key, copied.metadata], ["b/two.txt", { n: 1 }]);
    const moved = await files.move("b/two.txt", "c/three.txt");
    assertEquals(moved.key, "c/three.txt");
    assertEquals(await files.exists("b/two.txt"), false);
    assertEquals(await code(files.move("c/three.txt", "c/three.txt")), "bad_request");
    assertEquals(await code(files.move("ghost.txt", "g.txt")), "not_found");
    assertEquals(await code(files.copy("ghost.txt", "g.txt")), "not_found");
    const folder = await files.listFolder("", { sortBy: { order: "desc" } });
    assertEquals(folder.map((e) => [e.name, e.id === null]), [["c", true], ["a", true]]);
    const inA = await files.listFolder("a/", { search: "ON" });
    assertEquals(inA.map((e) => [e.name, e.metadata?.size]), [["one.txt", 3]]);
    const urls = await files.createSignedUrls(["a/one.txt", "nope.txt"]);
    assert(urls[0]?.includes("/_denext/storage/o/rt-files/a/one.txt"));
    assertEquals(urls[1], null);
    assertEquals(
      files.getPublicUrl("a/one.txt", { transform: { width: 64 } }),
      "/_denext/storage/o/rt-files/a/one.txt?w=64",
    );
    await storage.emptyBucket("rt-files", opts);
    assertEquals(await files.listFolder(""), []);
    await storage.deleteBucket("rt-files", opts);
    assertEquals(await code(storage.bucket("rt-files").info("x")), "unknown_bucket");
  } finally {
    await h.close();
  }
});

Deno.test({
  name: "server API inside a request: identity, the fallback rule, the resolver hook",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const h = await harness();
  try {
    await storage.createBucket("open", { public: true }, { service: true });
    await storage.bucket("open", { service: true }).upload("f.txt", "hi", {
      contentType: "text/plain",
    });
    const asRequest = <T>(cookie: string | null, fn: () => Promise<T>) => {
      const headers = new Headers(cookie ? { cookie } : {});
      return runWithContext(createRequestContext(new Request(`${ORIGIN}/`, { headers })), fn);
    };
    // A runtime bucket follows `storage.authorize` (downloads only, here).
    assertEquals(await asRequest(null, () => code(storage.bucket("open").download("f.txt"))), "ok");
    assertEquals(
      await asRequest(null, () => code(storage.bucket("open").upload("g.txt", "x"))),
      "forbidden",
    );
    const cookieA = await cookieFor(USER_A);
    assertEquals(
      await asRequest(
        cookieA,
        () =>
          code(storage.bucket("own").upload(`${USER_A}/a.txt`, "a", { contentType: "text/plain" })),
      ),
      "ok",
    );
    assertEquals(
      await asRequest(
        cookieA,
        () =>
          code(storage.bucket("own").upload(`${USER_B}/a.txt`, "a", { contentType: "text/plain" })),
      ),
      "forbidden",
    );
    assertEquals(
      (await storage.bucket("own", { service: true }).info(`${USER_A}/a.txt`))?.owner,
      USER_A,
    );
    // A Supabase access token is the user it names, cookies or not.
    const res = await h.fetch(`${ORIGIN}/storage/v1/object/own/${USER_B}/b.txt`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await accessToken(USER_B)}`,
        apikey: ANON_KEY,
        "content-type": "text/plain",
      },
      body: "b",
    });
    assertEquals(res.status, 200, await res.clone().text());
    assertEquals((await res.json()).Key, `own/${USER_B}/b.txt`);
  } finally {
    await h.close();
  }
});

Deno.test({
  name: "Storage API: error envelope, unknown routes, methods, bodies, CSRF, batches",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const h = await harness();
  const service = { authorization: `Bearer ${SECRET_KEY}` };
  const call = (path: string, init: RequestInit = {}) =>
    h.fetch(`${ORIGIN}/storage/v1${path}`, init);
  const json = async (res: Response) => [res.status, (await res.json()).error];
  try {
    assertEquals(await json(await call("/nowhere")), [404, "not_found"]);
    assertEquals(await json(await call("/bucket/own", { method: "PATCH", headers: service })), [
      404,
      "not_found",
    ]);
    assertEquals(
      await json(await call("/bucket", { method: "POST", headers: service, body: "[1]" })),
      [400, "InvalidRequest"],
    );
    assertEquals(
      await json(await call("/bucket", { method: "POST", headers: service, body: "{}" })),
      [400, "InvalidRequest"],
    );
    assertEquals(
      await json(
        await call("/bucket", {
          method: "POST",
          headers: service,
          body: JSON.stringify({ id: "s", file_size_limit: "lots" }),
        }),
      ),
      [400, "InvalidRequest"],
    );
    assertEquals(await json(await call("/bucket?sortColumn=owner", { headers: service })), [
      400,
      "InvalidRequest",
    ]);
    const many = Array.from({ length: 1001 }, (_, i) => `k${i}`);
    assertEquals(
      await json(
        await call("/object/own", {
          method: "DELETE",
          headers: service,
          body: JSON.stringify({ prefixes: many }),
        }),
      ),
      [400, "InvalidRequest"],
    );
    assertEquals(
      await json(
        await call("/object/sign/own", {
          method: "POST",
          headers: service,
          body: JSON.stringify({ paths: "x" }),
        }),
      ),
      [400, "InvalidRequest"],
    );
    assertEquals(
      await json(
        await call("/object/move", {
          method: "POST",
          headers: service,
          body: JSON.stringify({ bucketId: "own" }),
        }),
      ),
      [400, "InvalidRequest"],
    );
    const meta = await call("/object/own/m.txt", {
      method: "POST",
      headers: { ...service, "content-type": "text/plain", "x-metadata": "!!" },
      body: "m",
    });
    assertEquals(await json(meta), [400, "InvalidRequest"]);
    const arrayMeta = await call("/object/own/m.txt", {
      method: "POST",
      headers: { ...service, "content-type": "text/plain", "x-metadata": btoa("[1]") },
      body: "m",
    });
    assertEquals(await json(arrayMeta), [400, "InvalidRequest"]);
    const badCache = await call("/object/own/m.txt", {
      method: "POST",
      headers: { ...service, "content-type": "text/plain", "cache-control": "max-age=1;x" },
      body: "m",
    });
    assertEquals(badCache.status, 400);
    await badCache.body?.cancel();
    assertEquals(await json(await call("/render/image/public/own/x.png?width=10")), [
      404,
      "not_found",
    ]);
    assertEquals(
      await json(
        await call("/render/image/authenticated/own/x.png?width=abc", { headers: service }),
      ),
      [400, "InvalidRequest"],
    );
    // A cookie-carrying cross-site write is refused before anything runs.
    const cookie = await cookieFor(USER_A);
    const crossSite = await h.handler(
      new Request(`${ORIGIN}/storage/v1/object/own/${USER_A}/x.txt`, {
        method: "POST",
        headers: {
          cookie,
          origin: "https://evil.test",
          host: "app.test",
          "content-type": "text/plain",
        },
        body: "x",
      }),
    );
    assertEquals(crossSite.status, 403);
    await crossSite.body?.cancel();
    // A form with no file, a malformed one.
    const form = await call("/object/own/f.txt", {
      method: "POST",
      headers: { ...service, "content-type": "multipart/form-data; boundary=abc" },
      body: '--abc\r\ncontent-disposition: form-data; name="cacheControl"\r\n\r\n60\r\n--abc--\r\n',
    });
    assertEquals(await json(form), [400, "InvalidRequest"]);
    const unterminated = await call("/object/own/f.txt", {
      method: "POST",
      headers: { ...service, "content-type": "multipart/form-data; boundary=abc" },
      body: '--abc\r\ncontent-disposition: form-data; name=""\r\n\r\nno end',
    });
    assertEquals(await json(unterminated), [400, "InvalidRequest"]);
    // Signed tokens are bound to their purpose.
    const up = await call("/object/upload/sign/own/t.txt", { method: "POST", headers: service });
    const { token } = await up.json();
    assertEquals(await json(await call(`/object/sign/own/t.txt?token=${token}`)), [
      400,
      "InvalidSignature",
    ]);
    assertEquals(await json(await call(`/object/sign/own/t.txt?token=x.y.z`)), [
      400,
      "InvalidSignature",
    ]);
  } finally {
    await h.close();
  }
});

Deno.test({
  name: "TUS: version, routes, metadata, offsets, owner binding, expiry, empty uploads",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const h = await harness();
  const base = `${ORIGIN}/storage/v1/upload/resumable`;
  const tusHeaders = { "tus-resumable": "1.0.0" };
  const meta = (bucket: string, name: string, extra = "") =>
    `bucketName ${btoa(bucket)},objectName ${btoa(name)},contentType ${btoa("text/plain")}${extra}`;
  const create = (headers: Record<string, string>, body?: string) =>
    h.fetch(base, { method: "POST", headers: { ...tusHeaders, ...headers }, body });
  try {
    const options = await h.fetch(base, { method: "OPTIONS" });
    assertEquals([options.status, options.headers.get("tus-version")], [204, "1.0.0"]);
    assertEquals((await h.fetch(base, { method: "POST" })).status, 412);
    assertEquals((await h.fetch(base, { method: "GET", headers: tusHeaders })).status, 405);
    assertEquals((await h.fetch(`${base}/x`, { method: "HEAD", headers: tusHeaders })).status, 404);
    assertEquals(
      (await h.fetch(`${base}/${"a".repeat(32)}`, { method: "HEAD", headers: tusHeaders })).status,
      404,
    );
    const service = { authorization: `Bearer ${SECRET_KEY}` };
    assertEquals((await create({ ...service, "upload-defer-length": "1" })).status, 400);
    assertEquals((await create({ ...service })).status, 400);
    assertEquals((await create({ ...service, "upload-length": "1" })).status, 400);
    assertEquals(
      (await create({ ...service, "upload-length": "1", "upload-metadata": "bucketName !!" }))
        .status,
      400,
    );
    assertEquals(
      (await create({
        ...service,
        "upload-length": "1",
        "upload-metadata": meta("own", "x.txt", `,metadata ${btoa("[]")}`),
      })).status,
      400,
    );
    assertEquals(parseUploadMetadata("a , b " + btoa("x")), { a: "", b: "x" });

    // creation-with-upload: the whole object in the POST.
    const whole = await create({
      ...service,
      "upload-length": "5",
      "upload-metadata": meta("own", "whole.txt"),
      "content-type": "application/offset+octet-stream",
    }, "hello");
    assertEquals([whole.status, whole.headers.get("upload-offset")], [201, "5"]);
    assertEquals(await storage.bucket("own", { service: true }).exists("whole.txt"), true);
    // An empty upload completes at creation.
    const empty = await create({
      ...service,
      "upload-length": "0",
      "upload-metadata": meta("own", "empty.txt"),
    });
    assertEquals(empty.status, 201);
    assertEquals((await storage.bucket("own", { service: true }).info("empty.txt"))?.size, 0);

    // A user's upload is theirs alone.
    const cookieA = await cookieFor(USER_A);
    const cookieB = await cookieFor(USER_B);
    const mine = await create({
      cookie: cookieA,
      "upload-length": "4",
      "upload-metadata": meta("own", `${USER_A}/r.txt`),
    });
    assertEquals(mine.status, 201);
    const url = new URL(mine.headers.get("location")!, ORIGIN).toString();
    const patch = (
      cookie: string,
      offset: string,
      body: string,
      type = "application/offset+octet-stream",
    ) =>
      h.fetch(url, {
        method: "PATCH",
        headers: { ...tusHeaders, cookie, "upload-offset": offset, "content-type": type },
        body,
      });
    assertEquals((await patch(cookieB, "0", "ab")).status, 403);
    assertEquals((await patch(cookieA, "0", "ab", "text/plain")).status, 415);
    assertEquals(
      (await h.fetch(url, {
        method: "PATCH",
        headers: {
          ...tusHeaders,
          cookie: cookieA,
          "content-type": "application/offset+octet-stream",
        },
        body: "x",
      })).status,
      400,
    );
    assertEquals((await patch(cookieA, "0", "ab")).status, 204);
    assertEquals(
      (await h.fetch(url, { method: "PUT", headers: { ...tusHeaders, cookie: cookieA } })).status,
      405,
    );
    assertEquals((await patch(cookieA, "2", "cd")).status, 204);
    const done = await storage.bucket("own", { service: true }).download(`${USER_A}/r.txt`);
    assertEquals(await new Response(done!.body).text(), "abcd");

    // An expired upload is gone, and a later creation sweeps it.
    const rt = runtime();
    const stale = {
      id: "e".repeat(32),
      bucket_id: "own",
      name: "stale.txt",
      upload_length: 3,
      upload_offset: 0,
      content_type: "text/plain",
      cache_control: "max-age=3600",
      user_metadata: null,
      owner_id: null,
      upsert: true,
      upload_id: null,
      parts: [],
      tail_size: 0,
      chunks: [],
      version: crypto.randomUUID(),
      expires_at: Date.now() - 1000,
      lease: null,
      lease_until: null,
    };
    await rt.meta.createResumable(stale);
    assertEquals(
      (await h.fetch(`${base}/${stale.id}`, {
        method: "HEAD",
        headers: { ...tusHeaders, ...service },
      })).status,
      410,
    );
    assertEquals(await rt.meta.getResumable(stale.id), null);
    await rt.meta.createResumable({ ...stale, id: "f".repeat(32) });
    await (await create({
      ...service,
      "upload-length": "1",
      "upload-metadata": meta("own", "s.txt"),
    })).body?.cancel();
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(await rt.meta.getResumable("f".repeat(32)), null);
  } finally {
    await h.close();
  }
});

Deno.test("validators: sizes, mime lists, multipart, paths, transforms, listings", () => {
  assertEquals(
    [
      parseSizeLimit(null),
      parseSizeLimit(10),
      parseSizeLimit("1KB"),
      parseSizeLimit("1.5 MB"),
      parseSizeLimit("2gb"),
    ],
    [null, 10, 1024, 1572864, 2 * 1024 ** 3],
  );
  for (const bad of [0, -1, 1.5, "x", "1TB", {}]) {
    assertThrows(() => parseSizeLimit(bad), StorageError);
  }
  assertEquals(parseMimeList([]), null);
  assertEquals(parseMimeList(["Image/*", " text/plain "]), ["image/*", "text/plain"]);
  assertThrows(() => parseMimeList("image/*"), StorageError);
  assertThrows(() => parseMimeList(["*/*"]), StorageError);
  const parts = parseMultipart(
    new TextEncoder().encode(
      '--b\r\ncontent-disposition: form-data; name="q\\"x"; filename="f.txt"\r\ncontent-type: text/plain\r\n\r\nbody\r\n--b--',
    ),
    'multipart/form-data; boundary="b"',
  );
  assertEquals(
    parts.map((p) => [p.name, p.filename, p.contentType, new TextDecoder().decode(p.body)]),
    [
      ['q"x', "f.txt", "text/plain", "body"],
    ],
  );
  assertThrows(() => parseMultipart(new Uint8Array(), "multipart/form-data"), StorageError);
  assertThrows(
    () => parseMultipart(new TextEncoder().encode("nothing"), "multipart/form-data; boundary=b"),
    StorageError,
  );
  assertThrows(
    () => parseMultipart(new TextEncoder().encode("--bX"), "multipart/form-data; boundary=b"),
    StorageError,
  );
  assertThrows(
    () =>
      parseMultipart(
        new TextEncoder().encode("--b\r\nno headers end"),
        "multipart/form-data; boundary=b",
      ),
    StorageError,
  );
  assertEquals(bucketAndKey("b/a%20b/c"), { bucket: "b", key: "a b/c" });
  assertThrows(() => bucketAndKey("nokey"), StorageError);
  assertThrows(() => bucketAndKey("b/%E0%A4%A"), StorageError);
  assertEquals(
    transformOf(new URLSearchParams("width=10&height=5&resize=fill&quality=50&format=origin")),
    {
      width: 10,
      height: 5,
      quality: 50,
      resize: "fill",
      format: "origin",
    },
  );
  for (const q of ["width=-1", "resize=stretch", "format=avif"]) {
    assertThrows(() => transformOf(new URLSearchParams(q)), StorageError);
  }
  const row = (name: string, at: string) => ({
    id: name,
    bucket_id: "b",
    name,
    owner: null,
    owner_id: null,
    version: "v",
    metadata: null,
    user_metadata: null,
    created_at: at,
    updated_at: at,
    last_accessed_at: at,
  });
  const listing = shapeListing([row("p/a", "2"), row("p/b", "1"), row("p/d/x", "3")], {
    prefix: "p/",
    search: "",
    limit: 10,
    offset: 0,
    column: "updated_at",
    order: "asc",
  });
  assertEquals(listing.map((e) => e.name), ["d", "b", "a"]);
});

Deno.test("storage helpers reject outside their runtime", async () => {
  await assertRejects(() => storage.listBuckets(), StorageError, "not configured");
});

Deno.test({
  name: "client helpers over the Storage API: list, info, move, copy, remove, sign, resumable",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const h = await harness();
  const cookie = await cookieFor(USER_A);
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), ORIGIN);
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    return h.fetch(url, { ...init, headers });
  }) as typeof fetch;
  try {
    const {
      copyFile,
      getFileInfo,
      getPublicUrl,
      getSignedUrls,
      listFiles,
      moveFile,
      removeFiles,
      StorageApiClientError,
      uploadResumable,
    } = await import("../packages/backend/client.ts");
    const dir = `${USER_A}/docs`;
    const progress: number[] = [];
    const body = new Blob(["0123456789".repeat(10)], { type: "text/plain" });
    assertEquals(
      await uploadResumable("own", `${dir}/a.txt`, body, {
        chunkSize: 30,
        onProgress: ({ loaded }) => progress.push(loaded),
      }),
      { key: `${dir}/a.txt` },
    );
    assertEquals(progress, [30, 60, 90, 100]);
    assertEquals((await getFileInfo("own", `${dir}/a.txt`)).size, 100);
    assertEquals(await copyFile("own", `${dir}/a.txt`, `${dir}/b.txt`), `own/${dir}/b.txt`);
    await moveFile("own", `${dir}/b.txt`, `${dir}/sub/c.txt`);
    assertEquals((await listFiles("own", dir)).map((e) => e.name), ["sub", "a.txt"]);
    const [signed, missing] = await getSignedUrls("own", [`${dir}/a.txt`, `${dir}/zz.txt`]);
    assertEquals([typeof signed, missing], ["string", null]);
    assertEquals((await (await h.fetch(new URL(signed!, ORIGIN))).text()).length, 100);
    assertEquals(
      getPublicUrl("own", "a b.png", { transform: { width: 10 }, download: true }),
      "/storage/v1/render/image/public/own/a%20b.png?width=10&download=",
    );
    assertEquals(getPublicUrl("own", "x"), "/storage/v1/object/public/own/x");
    assertEquals(
      (await removeFiles("own", [`${dir}/a.txt`, `${dir}/sub/c.txt`])).map((r) => r.name).sort(),
      [`${dir}/a.txt`, `${dir}/sub/c.txt`],
    );
    const refused = await getFileInfo("own", `${USER_B}/x.txt`).catch((e) => e);
    assert(refused instanceof StorageApiClientError && refused.status === 403, String(refused));
    const denied = await uploadResumable("own", `${USER_B}/x.txt`, body).catch((e) => e);
    assert(denied instanceof StorageApiClientError && denied.status === 403, String(denied));
    // A cancelled upload is terminated on the server.
    const controller = new AbortController();
    const cancelled = await uploadResumable("own", `${dir}/cancel.txt`, body, {
      chunkSize: 10,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }).catch((e) => e);
    assert(cancelled instanceof Error);
    assertEquals(await storage.bucket("own", { service: true }).exists(`${dir}/cancel.txt`), false);
  } finally {
    globalThis.fetch = original;
    await h.close();
  }
});
