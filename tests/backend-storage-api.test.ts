// @denext/backend storage beyond the supabase-js suite: the server API's Supabase-parity methods
// (runtime buckets, info / exists, copy / move, folder listings, batch signing), the Storage
// API's error envelope and refusals, the TUS endpoint's protocol edges (version, offsets, owner
// binding, expiry, empty uploads), the identity resolver hook, the multipart reader, and the
// small validators.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { backend, fs, StorageError } from "../packages/backend/mod.ts";
import { storage } from "../packages/backend/server.ts";
import { runtime } from "../packages/backend/src/runtime.ts";
import { streamMultipart } from "../packages/backend/src/multipart.ts";
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
  name: "image transforms take AVIF sources: render/image and signed transform URLs",
}, async () => {
  const h = await harness();
  const service = { authorization: `Bearer ${SECRET_KEY}` };
  const call = (path: string, init: RequestInit = {}) =>
    h.fetch(`${ORIGIN}/storage/v1${path}`, init);
  try {
    const { encode } = await import("@denext/avif");
    const rgba = new Uint8Array(120 * 60 * 4).fill(180);
    const file = new Uint8Array(await encode({ data: rgba, width: 120, height: 60 }));
    const key = `${USER_A}/photo.avif`;
    const put = await call(`/object/own/${key}`, {
      method: "POST",
      headers: { ...service, "content-type": "image/avif" },
      body: file,
    });
    assertEquals(put.status, 200);
    await put.body?.cancel();
    const rendered = await call(`/render/image/authenticated/own/${key}?width=40`, {
      headers: service,
    });
    assertEquals([rendered.status, rendered.headers.get("content-type")], [200, "image/webp"]);
    assertEquals(new TextDecoder().decode((await rendered.bytes()).subarray(8, 12)), "WEBP");
    const origin = await call(
      `/render/image/authenticated/own/${key}?width=40&height=40&resize=fill&format=origin`,
      { headers: service },
    );
    assertEquals([origin.status, origin.headers.get("content-type")], [200, "image/avif"]);
    const { decode } = await import("@denext/avif");
    const back = await decode(await origin.bytes());
    assertEquals([back.width, back.height], [40, 40]);
    const signed = await storage.bucket("own", { service: true }).createSignedUrl(key, {
      transform: { width: 32 }, // the `images` sizes: the native route is allowlisted
    });
    const viaSigned = await h.fetch(new URL(signed, ORIGIN).href);
    assertEquals([viaSigned.status, viaSigned.headers.get("content-type")], [200, "image/webp"]);
    await viaSigned.body?.cancel();
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
    // The creation sweeps expired uploads in the background: wait for the row to go (the
    // deadline only bounds a failure).
    const deadline = Date.now() + 15_000;
    while (await rt.meta.getResumable("f".repeat(32)) !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(await rt.meta.getResumable("f".repeat(32)), null);
  } finally {
    await h.close();
  }
});

Deno.test("validators: sizes, mime lists, multipart, paths, transforms, listings", async () => {
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
  // The streaming form reader: fields before the file, the file as a stream, in any chunking.
  const form = (text: string, chunk = 3) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
        c.close();
      },
    });
  const body = '--b\r\ncontent-disposition: form-data; name="cacheControl"\r\n\r\n60\r\n' +
    '--b\r\ncontent-disposition: form-data; name="q\\"x"; filename="f.txt"\r\n' +
    "content-type: text/plain\r\n\r\nbody --b inside\r\n-- more\r\n--b--";
  for (const chunk of [1, 3, 7, 1000]) {
    const parsed = await streamMultipart(form(body, chunk), 'multipart/form-data; boundary="b"');
    assertEquals(parsed.fields.get("cacheControl"), "60");
    assertEquals([parsed.file?.name, parsed.file?.filename, parsed.file?.contentType], [
      'q"x',
      "f.txt",
      "text/plain",
    ]);
    assertEquals(await new Response(parsed.file!.stream).text(), "body --b inside\r\n-- more");
  }
  const none = await streamMultipart(
    form('--b\r\ncontent-disposition: form-data; name="x"\r\n\r\n1\r\n--b--'),
    "multipart/form-data; boundary=b",
  );
  assertEquals([none.fields.get("x"), none.file], ["1", null]);
  const refused = async (text: string, type = "multipart/form-data; boundary=b") => {
    try {
      const out = await streamMultipart(form(text), type);
      if (out.file) await new Response(out.file.stream).text();
      return "ok";
    } catch (err) {
      return err instanceof StorageError ? err.code : String(err);
    }
  };
  assertEquals(await refused("", "multipart/form-data"), "bad_request");
  assertEquals(await refused("nothing"), "bad_request");
  assertEquals(await refused("--bX"), "bad_request");
  assertEquals(await refused("--b\r\nno headers end"), "bad_request");
  assertEquals(
    await refused('--b\r\ncontent-disposition: form-data; name=""\r\n\r\nno end'),
    "bad_request",
  );
  assertEquals(
    await refused('--b\r\ncontent-disposition: form-data; name="big"\r\n\r\n' + "x".repeat(70_000)),
    "bad_request",
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
    archived_at: null,
    is_delete_marker: false,
    is_versioned: false,
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

Deno.test({
  name: "versions on the server API; the admin hooks; lifecycle validation",
}, async () => {
  const h = await harness();
  try {
    const opts = { service: true };
    await storage.createBucket("hist", { versioningStatus: "ENABLED" }, opts);
    assertEquals((await storage.getBucket("hist", opts)).versioningStatus, "ENABLED");
    assertEquals(
      await code(storage.createBucket("hist2", { versioningStatus: "SUSPENDED" }, opts)),
      "bad_request",
    );
    const files = storage.bucket("hist", opts);
    await files.upload("a.txt", "one", { contentType: "text/plain" });
    const v1 = (await files.info("a.txt"))!.version;
    await files.upload("a.txt", "two", { contentType: "text/plain" });
    const old = await files.download("a.txt", { versionId: v1 });
    assertEquals(await new Response(old!.body).text(), "one");
    assertEquals((await files.info("a.txt", { versionId: v1 }))?.archivedAt !== null, true);
    assertEquals(await files.download("a.txt", { versionId: "nope" }), null);
    const versions = await files.listFolder("", { versions: "include" });
    assertEquals(versions.length, 2);
    await files.remove([{ key: "a.txt", versionId: v1 }]);
    assertEquals((await files.listFolder("", { versions: "only" })).length, 0);
    await files.remove("a.txt");
    assertEquals(await files.exists("a.txt"), false);
    assertEquals((await files.listFolder("", { deleteMarkers: "only" })).length, 1);
    // A move in a versioned bucket is a copy and a delete.
    await files.upload("m.txt", "m", { contentType: "text/plain" });
    await files.move("m.txt", "n.txt");
    assertEquals([await files.exists("m.txt"), await files.exists("n.txt")], [false, true]);
    // Lifecycle.
    assertEquals(await storage.getBucketLifecycle("hist", opts), null);
    const policy = {
      rules: [{
        status: "Enabled" as const,
        filter: {},
        noncurrentVersionExpiration: { noncurrentDays: 1 },
      }],
    };
    await storage.updateBucketLifecycle("hist", policy, opts);
    assertEquals((await storage.getBucketLifecycle("hist", opts))?.rules[0].id, "rule-1");
    for (
      const bad of [
        {},
        { rules: [] },
        { rules: [{ ...policy.rules[0], status: "On" }] },
        { rules: [{ ...policy.rules[0], expiration: { days: 1 } }] },
        { rules: [{ ...policy.rules[0], noncurrentVersionExpiration: { noncurrentDays: 0 } }] },
        {
          rules: [{
            ...policy.rules[0],
            noncurrentVersionExpiration: { noncurrentDays: 1, newerNoncurrentVersions: 101 },
          }],
        },
        { rules: [{ ...policy.rules[0], id: "x" }, { ...policy.rules[0], id: "x" }] },
        { rules: ["x"] },
      ]
    ) {
      assertEquals(
        await code(storage.updateBucketLifecycle("hist", bad as never, opts)),
        "bad_request",
        JSON.stringify(bad),
      );
    }
    await storage.updateBucketLifecycle("hist", null, opts);
    assertEquals(await storage.getBucketLifecycle("hist", opts), null);
    await storage.updateBucket("hist", { versioningStatus: "SUSPENDED" }, opts);
    assertEquals(
      await code(storage.updateBucket("hist", { versioningStatus: "DISABLED" }, opts)),
      "bad_request",
    );
    // The admin hooks `denext ui` uses.
    const admin = runtime().admin!;
    assertEquals((await admin.buckets()).map((b) => b.name), ["own", "hist"]);
    assertEquals([await admin.hasBucket("hist"), await admin.hasBucket("ghost")], [true, false]);
    await files.upload("z.txt", "z", { contentType: "text/plain" });
    await admin.remove("hist", "z.txt");
    assertEquals(await files.exists("z.txt"), false);
    // Upload as the service: the bytes and the metadata row land together; a duplicate is
    // refused unless replacing is asked for.
    const bytes = (text: string) => new TextEncoder().encode(text);
    assertEquals(
      await admin.upload("hist", "up.txt", bytes("hey"), {
        contentType: "text/plain",
        upsert: false,
      }),
      { key: "up.txt", size: 3 },
    );
    assertEquals(await new Response((await files.download("up.txt"))!.body).text(), "hey");
    assertEquals((await files.info("up.txt"))?.contentType, "text/plain");
    assertEquals(
      await code(admin.upload("hist", "up.txt", bytes("x"), { upsert: false })),
      "duplicate",
    );
    await admin.upload("hist", "up.txt", bytes("again"), { upsert: true });
    assertEquals(await new Response((await files.download("up.txt"))!.body).text(), "again");
    assertEquals(
      await code(admin.upload("ghost", "a", bytes("x"), { upsert: false })),
      "unknown_bucket",
    );
    await storage.emptyBucket("hist", opts);
    await storage.deleteBucket("hist", opts);
  } finally {
    await h.close();
  }
});

Deno.test("sqlite metadata: a file from before versioning is upgraded in place", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { sqliteMetaStore } = await import("../packages/backend/src/storage-meta-sqlite.ts");
  const dir = await Deno.makeTempDir();
  const path = `${dir}/old.db`;
  const old = new DatabaseSync(path);
  old.exec(`
    create table buckets (id text primary key, name text not null unique, owner text, owner_id text,
      public integer not null default 0, file_size_limit integer, allowed_mime_types text,
      created_at text not null, updated_at text not null);
    create table objects (id text primary key, bucket_id text not null references buckets(id),
      name text not null, owner text, owner_id text, version text not null, metadata text,
      user_metadata text, created_at text not null, updated_at text not null,
      last_accessed_at text not null, unique (bucket_id, name));
    insert into buckets values ('b', 'b', null, null, 0, null, null, 't', 't');
    insert into objects values ('o1', 'b', 'k', null, null, 'v1', '{"size":1}', null, 't', 't', 't');
  `);
  old.close();
  const store = sqliteMetaStore(path);
  try {
    const row = await store.getObject("b", "k", { kind: "service" });
    assertEquals([row?.version, row?.archived_at, row?.is_versioned], ["v1", null, false]);
    assertEquals((await store.getBucket("b", { kind: "service" }))?.versioning_status, "DISABLED");
    await store.replaceCurrent({
      bucket_id: "b",
      name: "k",
      owner_id: null,
      version: "v2",
      metadata: null,
      user_metadata: null,
    }, true);
    assertEquals(
      (await store.getVersion("b", "k", "v1", { kind: "service" }))?.archived_at !== null,
      true,
    );
  } finally {
    store.close?.();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sqlite metadata: a key prefix matches case-sensitively, wildcards literally", async () => {
  const { sqliteMetaStore } = await import("../packages/backend/src/storage-meta-sqlite.ts");
  const store = sqliteMetaStore(":memory:");
  const S = { kind: "service" } as const;
  try {
    await store.createBucket(
      { id: "docs", public: false, file_size_limit: null, allowed_mime_types: null },
      S,
    );
    const metadata = {
      eTag: '"x"',
      size: 1,
      mimetype: "text/plain",
      cacheControl: "no-cache",
      lastModified: new Date().toISOString(),
      contentLength: 1,
      httpStatusCode: 200,
    };
    for (
      const name of [
        "alice/a.txt",
        "ALICE/secret.txt",
        "Alice/other.txt",
        "a%b/x",
        "axb/y",
        "a_c/z",
      ]
    ) {
      await store.writeObject(
        {
          bucket_id: "docs",
          name,
          owner_id: null,
          version: crypto.randomUUID(),
          metadata,
          user_metadata: null,
        },
        true,
        S,
      );
    }
    const flat = (prefix: string) =>
      store.listFlat("docs", {
        prefix,
        limit: 100,
        offset: 0,
        column: "name",
        order: "asc",
      } as never, S).then((rows) => rows.map((r) => r.name));
    // list-v2 (flat): another tenant's `ALICE/` / `Alice/` folder is not under `alice/`.
    assertEquals(await flat("alice/"), ["alice/a.txt"]);
    assertEquals(await flat("ALICE/"), ["ALICE/secret.txt"]);
    // `%` and `_` in a prefix are characters, not patterns.
    assertEquals(await flat("a%"), ["a%b/x"]);
    assertEquals(await flat("a_"), ["a_c/z"]);
    const level = await store.listObjects("docs", {
      prefix: "alice/",
      search: "",
      limit: 100,
      offset: 0,
      column: "name",
      order: "asc",
    } as never, S);
    assertEquals(level.map((r) => r.name), ["a.txt"]);
  } finally {
    store.close?.();
  }
});

Deno.test({
  name: "client: listFilesV2, version-aware info and remove, signed resumable uploads",
}, async () => {
  const h = await harness();
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), ORIGIN);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${SECRET_KEY}`);
    return h.fetch(url, { ...init, headers });
  }) as typeof fetch;
  try {
    const { getFileInfo, listFilesV2, removeFiles, uploadResumable } = await import(
      "../packages/backend/client.ts"
    );
    await storage.createBucket("v2", { versioningStatus: "ENABLED" }, { service: true });
    const files = storage.bucket("v2", { service: true });
    for (const k of ["a/1.txt", "a/2.txt", "b.txt"]) {
      await files.upload(k, k, { contentType: "text/plain" });
    }
    const page = await listFilesV2("v2", { limit: 2 });
    assertEquals([page.objects.map((o) => o.key), page.hasNext], [["a/1.txt", "a/2.txt"], true]);
    const rest = await listFilesV2("v2", { limit: 2, cursor: page.nextCursor });
    assertEquals([rest.objects.map((o) => o.key), rest.hasNext], [["b.txt"], false]);
    const top = await listFilesV2("v2", { withDelimiter: true });
    assertEquals([top.folders, top.objects.map((o) => o.name)], [[{ name: "a", key: "a/" }], [
      "b.txt",
    ]]);
    const v1 = (await getFileInfo("v2", "b.txt")).version;
    await files.upload("b.txt", "again", { contentType: "text/plain" });
    assertEquals((await getFileInfo("v2", "b.txt", { versionId: v1 })).version, v1);
    assertEquals((await removeFiles("v2", [{ path: "b.txt", versionId: v1 }])).length, 1);
    // A signed resumable upload (the token, not the session, authorizes it).
    const signed = await h.fetch(`${ORIGIN}/storage/v1/object/upload/sign/v2/t.txt`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET_KEY}` },
    });
    const { token } = await signed.json();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      h.fetch(
        new URL(String(input instanceof Request ? input.url : input), ORIGIN),
        init,
      )) as typeof fetch;
    await uploadResumable("v2", "t.txt", new Blob(["signed bytes"], { type: "text/plain" }), {
      signature: token,
      chunkSize: 5,
    });
    assertEquals((await files.info("t.txt"))?.size, 12);
    const wrong = await uploadResumable("v2", "other.txt", new Blob(["x"]), { signature: token })
      .catch((e) => e);
    assertEquals(wrong.status, 400);
    await storage.emptyBucket("v2", { service: true });
    await storage.deleteBucket("v2", { service: true });
  } finally {
    globalThis.fetch = original;
    await h.close();
  }
});

Deno.test({
  name: "authorize({ session }): a supabase-js caller's access token is a session",
}, async () => {
  // The documented `authorize: ({ session }) => !!session` refused every supabase-js upload:
  // a JWT identity reached `authorize` with no session. It now carries the token's session.
  const seen: unknown[] = [];
  const h = await storageHarness(backend({
    supabase: await supabaseKeys(),
    storage: {
      secret: "storage-secret-at-least-32-characters",
      driver: fs({ dir: ".storage" }),
      buckets: {
        mine: {
          authorize: ({ session, identity }) => {
            seen.push([session?.user.id ?? null, identity.source]);
            return !!session;
          },
        },
      },
    },
  }));
  try {
    const upload = (headers: Record<string, string>) =>
      h.fetch(`${ORIGIN}/storage/v1/object/mine/${USER_A}/note.txt`, {
        method: "POST",
        headers: { apikey: ANON_KEY, "content-type": "text/plain", "x-upsert": "true", ...headers },
        body: "hello",
      });
    const asUser = await upload({ authorization: `Bearer ${await accessToken(USER_A)}` });
    assertEquals(asUser.status, 200, await asUser.text());
    const asAnon = await upload({ authorization: `Bearer ${ANON_KEY}` });
    assert(asAnon.status >= 400, "anon has no session");
    await asAnon.body?.cancel();
    assertEquals(seen[0], [USER_A, "jwt"]);
    assertEquals(seen[1], [null, "api_key"]);
  } finally {
    await h.close();
  }
});
