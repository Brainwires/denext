// @denext/backend storage on the fs driver, through a real request pipeline: the sign route
// (CSRF, schema, authorize), signed upload and download URLs (tamper, expiry, Range, HEAD,
// 304), refusals that store nothing (size, type, sniffing, traversal, symlinks), public buckets,
// image transforms, the server API inside and outside a request, and the plugin's setup checks.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { backendApp, ORIGIN, SECRET } from "./_backend-app.ts";
import { backend, fs, StorageError } from "../packages/backend/mod.ts";
import { storage } from "../packages/backend/server.ts";
import { signPayload } from "../packages/backend/src/signing.ts";
import { downloadPayload, uploadPayload } from "../packages/backend/src/storage.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { samplePng } from "./fixtures/sample-image.ts";

const allow = () => true;
const docs = { mime: ["text/plain", "image/png"], maxBytes: 64, authorize: allow };

async function uploadVia(
  app: Awaited<ReturnType<typeof backendApp>>,
  bucket: string,
  key: string,
  body: BodyInit,
  contentType: string,
  size: number,
) {
  const plan = await (await app.sign({ op: "upload", bucket, key, contentType, size })).json();
  const put = await app.call(plan.upload.url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
  return { plan, put };
}

async function storedFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string) => {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) await walk(join(dir, e.name), `${rel}${e.name}/`);
      else out.push(rel + e.name);
    }
  };
  await walk(join(root, ".storage"), "").catch(() => {});
  return out.sort();
}

Deno.test("fs storage: sign → PUT → complete → signed GET (full, Range, HEAD, 304, 416)", async () => {
  const app = await backendApp({ buckets: { docs } });
  try {
    const { plan, put } = await uploadVia(
      app,
      "docs",
      "notes/hello world.txt",
      "hello world",
      "text/plain",
      11,
    );
    assertEquals(plan.upload.method, "PUT");
    assertStringIncludes(plan.upload.url, "/_denext/storage/o/docs/notes/hello%20world.txt?");
    assertEquals(put.status, 200);
    const done = await app.sign({ op: "complete", token: plan.upload.token });
    const { object } = await done.json();
    assertEquals([object.key, object.size, object.contentType], [
      "notes/hello world.txt",
      11,
      "text/plain",
    ]);

    const url = await storage.bucket("docs", { service: true }).createSignedUrl(
      "notes/hello world.txt",
      {
        expiresIn: 60,
      },
    );
    const full = await app.call(url);
    assertEquals(full.status, 200);
    assertEquals(await full.text(), "hello world");
    assertEquals(full.headers.get("x-content-type-options"), "nosniff");
    assertStringIncludes(full.headers.get("content-security-policy")!, "sandbox");
    assertStringIncludes(full.headers.get("cache-control")!, "private, max-age=");
    assertEquals(full.headers.get("content-disposition"), "inline");

    const part = await app.call(url, { headers: { range: "bytes=6-" } });
    assertEquals(part.status, 206);
    assertEquals(part.headers.get("content-range"), "bytes 6-10/11");
    assertEquals(await part.text(), "world");
    const head = await app.call(url, { method: "HEAD" });
    assertEquals([head.status, head.headers.get("content-length"), await head.text()], [
      200,
      "11",
      "",
    ]);
    const cached = await app.call(url, { headers: { "if-none-match": full.headers.get("etag")! } });
    assertEquals(cached.status, 304);
    const bad = await app.call(url, { headers: { range: "bytes=50-" } });
    assertEquals([bad.status, bad.headers.get("content-range")], [416, "bytes */11"]);
    await bad.body?.cancel();
    const viaRoute =
      await (await app.sign({ op: "download", bucket: "docs", key: "notes/hello world.txt" }))
        .json();
    assertEquals(await (await app.call(viaRoute.url)).text(), "hello world");
  } finally {
    await app.close();
  }
});

Deno.test("fs storage: a tampered, expired or unsigned download URL is refused", async () => {
  const app = await backendApp({ buckets: { docs } });
  try {
    await storage.bucket("docs", { service: true }).upload("a.txt", "secret", {
      contentType: "text/plain",
    });
    const url = new URL(
      await storage.bucket("docs", { service: true }).createSignedUrl("a.txt"),
      ORIGIN,
    );
    const other = new URL(url);
    other.pathname = other.pathname.replace("a.txt", "b.txt");
    const longer = new URL(url);
    longer.searchParams.set("exp", String(Number(url.searchParams.get("exp")) + 1000));
    const unsigned = new URL(url);
    unsigned.search = "";
    const expiredExp = Math.floor(Date.now() / 1000) - 5;
    const expired = `/_denext/storage/o/docs/a.txt?exp=${expiredExp}&sig=${await signPayload(
      downloadPayload("docs", "a.txt", expiredExp),
      [SECRET],
    )}`;
    const forged = `/_denext/storage/o/docs/a.txt?exp=${expiredExp + 9999}&sig=${await signPayload(
      downloadPayload("docs", "a.txt", expiredExp + 9999),
      ["x".repeat(32)],
    )}`;
    for (
      const [target, code] of [
        [other, "bad_signature"],
        [longer, "bad_signature"],
        [unsigned, "bad_signature"],
        [expired, "expired"],
        [forged, "bad_signature"],
      ] as const
    ) {
      const res = await app.call(String(target));
      assertEquals(res.status, 403, String(target));
      assertEquals((await res.json()).error.code, code);
    }
  } finally {
    await app.close();
  }
});

Deno.test("fs storage: upload refusals store nothing (type, size, sniffing, signature)", async () => {
  const app = await backendApp({ buckets: { docs } });
  try {
    // Sent with another content type than the one signed.
    let { put } = await uploadVia(app, "docs", "a.txt", "hello", "text/plain", 5);
    const wrongType = await app.call(
      (await (await app.sign({
        op: "upload",
        bucket: "docs",
        key: "b.txt",
        contentType: "text/plain",
        size: 5,
      })).json()).upload.url,
      {
        method: "PUT",
        headers: { "content-type": "text/html" },
        body: "hello",
      },
    );
    assertEquals([put.status, wrongType.status], [200, 415]);
    await wrongType.body?.cancel();
    // A declared image that is really HTML.
    ({ put } = await uploadVia(
      app,
      "docs",
      "x.png",
      "<html><script>alert(1)</script>",
      "image/png",
      31,
    ));
    assertEquals([put.status, (await put.json()).error.code], [415, "mime_mismatch"]);
    // More bytes than declared; fewer than declared.
    ({ put } = await uploadVia(app, "docs", "c.txt", "hello!", "text/plain", 5));
    assertEquals(put.status, 400);
    await put.body?.cancel();
    ({ put } = await uploadVia(app, "docs", "d.txt", "hey", "text/plain", 5));
    assertEquals(put.status, 400);
    await put.body?.cancel();
    // Over the bucket cap: refused at signing, and a streamed body without a length is cut off.
    const big = await app.sign({
      op: "upload",
      bucket: "docs",
      key: "e.txt",
      contentType: "text/plain",
      size: 65,
    });
    assertEquals([big.status, (await big.json()).error.code], [413, "too_large"]);
    const plan = await storage.bucket("docs", { service: true }).createSignedUploadUrl("f.txt", {
      contentType: "text/plain",
    });
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("0123456789"));
        c.close();
      },
    });
    const streamed = await app.call(plan.url, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: stream,
    });
    assertEquals([streamed.status, (await streamed.json()).error.code], [413, "too_large"]);
    const declared = await app.call(plan.url, {
      method: "PUT",
      headers: { "content-type": "text/plain", "content-length": "100" },
      body: "x",
    });
    assertEquals(declared.status, 413);
    await declared.body?.cancel();
    // A cap raised in the URL no longer matches its signature.
    const raised = plan.url.replace("max=64", "max=6400");
    const tampered = await app.call(raised, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    assertEquals([tampered.status, (await tampered.json()).error.code], [403, "bad_signature"]);
    const exp = Math.floor(Date.now() / 1000) - 1;
    const sig = await signPayload(uploadPayload("docs", "g.txt", exp, "text/plain", 64), [SECRET]);
    const old = await app.call(
      `/_denext/storage/o/docs/g.txt?exp=${exp}&ct=text%2Fplain&max=64&sig=${sig}`,
      { method: "PUT", headers: { "content-type": "text/plain" }, body: "x" },
    );
    assertEquals(old.status, 403);
    await old.body?.cancel();
    const nobody = await app.call(plan.url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
    });
    assertEquals(nobody.status, 400);
    await nobody.body?.cancel();
    // Only the one good upload exists, and no temp file was left behind.
    const files = await storedFiles(app.root);
    assertEquals(files.filter((f) => !f.startsWith(".denext-meta/")), ["docs/a.txt"]);
    // A completion for an upload that never arrived is refused.
    const ghost = await storage.bucket("docs", { service: true }).createSignedUploadUrl(
      "never.txt",
      {
        contentType: "text/plain",
        size: 3,
      },
    );
    const missing = await app.sign({ op: "complete", token: ghost.token });
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  } finally {
    await app.close();
  }
});

Deno.test("fs storage: keys cannot escape the bucket (encoded traversal, NUL, symlinks)", async () => {
  const app = await backendApp({ buckets: { docs, pub: { public: true } } });
  try {
    await Deno.writeTextFile(join(app.root, "outside.txt"), "TOP SECRET");
    for (
      const path of [
        "/_denext/storage/o/pub/..%2F..%2Foutside.txt",
        "/_denext/storage/o/pub/a%2F..%2F..%2F..%2Foutside.txt",
        "/_denext/storage/o/pub/a%00b",
        "/_denext/storage/o/pub/%E0%A4%A",
        "/_denext/storage/o/pub/a%5Cb",
      ]
    ) {
      const res = await app.call(path);
      assertEquals(res.status, 400, path);
      assertEquals((await res.json()).error.code, "invalid_key");
    }
    // A literal dot-dot segment is resolved by the URL parser before routing: it lands outside
    // the storage prefix entirely.
    const dotted = await app.call("/_denext/storage/o/pub/%2e%2e/%2e%2e/outside.txt");
    assertEquals(dotted.status, 404);
    assert(!(await dotted.text()).includes("TOP SECRET"));
    for (
      const path of [
        "/_denext/storage/o/pub",
        "/_denext/storage/o/nope/a.txt",
        "/_denext/storage/elsewhere",
      ]
    ) {
      const res = await app.call(path);
      assertEquals(res.status, 404, path);
      await res.body?.cancel();
    }
    // A symlink planted inside the bucket that points outside is never followed.
    await Deno.mkdir(join(app.root, ".storage", "pub"), { recursive: true });
    await Deno.symlink(
      join(app.root, "outside.txt"),
      join(app.root, ".storage", "pub", "link.txt"),
    );
    const link = await app.call("/_denext/storage/o/pub/link.txt");
    assertEquals(link.status, 404);
    await link.body?.cancel();
    assertEquals(await storage.bucket("pub", { service: true }).head("link.txt"), null);
    assertEquals(await storage.bucket("pub", { service: true }).download("link.txt"), null);
    await storage.bucket("pub", { service: true }).remove("link.txt");
    assert(
      (await Deno.lstat(join(app.root, ".storage", "pub", "link.txt"))).isSymlink,
      "remove left the link alone",
    );
    assertEquals(await Deno.readTextFile(join(app.root, "outside.txt")), "TOP SECRET");
    // Keys the filesystem cannot hold portably, and a key/prefix collision.
    await assertRejects(
      () => storage.bucket("pub", { service: true }).upload("a:b.txt", "x"),
      StorageError,
      "fs driver",
    );
    await assertRejects(
      () => storage.bucket("pub", { service: true }).upload("dot.", "x"),
      StorageError,
      "fs driver",
    );
    await storage.bucket("pub", { service: true }).upload("dir", "x");
    const conflict = await assertRejects(
      () => storage.bucket("pub", { service: true }).upload("dir/child.txt", "x"),
      StorageError,
    );
    assertEquals(conflict.code, "conflict");
  } finally {
    await app.close();
  }
});

Deno.test("fs storage: authorize decides every op inside a request (deny by default)", async () => {
  const seen: unknown[] = [];
  const app = await backendApp({
    buckets: {
      locked: {},
      owned: {
        authorize: ({ session, op, key, bucket, request }) => {
          seen.push({ session, op, key, bucket, path: new URL(request.url).pathname });
          return key.startsWith("mine/") && op !== "delete";
        },
      },
      truthy: { authorize: () => 1 as unknown as boolean },
    },
  });
  try {
    const locked = await app.sign({
      op: "upload",
      bucket: "locked",
      key: "a.txt",
      contentType: "text/plain",
      size: 1,
    });
    assertEquals([locked.status, (await locked.json()).error.code], [403, "forbidden"]);
    const truthy = await app.sign({
      op: "upload",
      bucket: "truthy",
      key: "a.txt",
      contentType: "text/plain",
      size: 1,
    });
    assertEquals(truthy.status, 403, "only `true` allows");
    await truthy.body?.cancel();
    const theirs = await app.sign({
      op: "upload",
      bucket: "owned",
      key: "theirs/a.txt",
      contentType: "text/plain",
      size: 1,
    });
    assertEquals(theirs.status, 403);
    await theirs.body?.cancel();
    const mine = await app.sign({
      op: "upload",
      bucket: "owned",
      key: "mine/a.txt",
      contentType: "text/plain",
      size: 1,
    });
    assertEquals(mine.status, 200);
    await mine.body?.cancel();
    const unknown = await app.sign({
      op: "upload",
      bucket: "nope",
      key: "a",
      contentType: "text/plain",
      size: 1,
    });
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();
    assertEquals(seen.at(-1), {
      session: null,
      op: "upload",
      key: "mine/a.txt",
      bucket: "owned",
      path: "/_denext/storage/sign",
    });

    // The server API inside a request runs authorize; outside one only a service handle works.
    const inRequest = <T>(fn: () => Promise<T>) =>
      runWithContext(createRequestContext(new Request(`${ORIGIN}/api/x`)), fn);
    await storage.bucket("owned", { service: true }).upload("theirs/b.txt", "x");
    await assertRejects(
      () => inRequest(() => storage.bucket("owned").download("theirs/b.txt")),
      StorageError,
      "download is not allowed",
    );
    await assertRejects(
      () => inRequest(() => storage.bucket("owned").remove(["mine/a.txt"])),
      StorageError,
      "delete",
    );
    await assertRejects(
      () => inRequest(() => storage.bucket("owned").list("theirs/")),
      StorageError,
      "list",
    );
    await assertRejects(
      () => inRequest(() => storage.bucket("locked").head("x")),
      StorageError,
      "download",
    );
    assertEquals((await inRequest(() => storage.bucket("owned").list("mine/"))).objects, []);
    // A service handle skips authorize (the rules still apply).
    await inRequest(() => storage.bucket("owned", { service: true }).remove("theirs/b.txt"));
    assertEquals(await storage.bucket("owned", { service: true }).head("theirs/b.txt"), null);
    await assertRejects(
      () => storage.bucket("nope", { service: true }).head("x"),
      StorageError,
      "unknown bucket",
    );
  } finally {
    await app.close();
  }
});

Deno.test("fs storage: authorize sees the denextAuth session of the request", async () => {
  const authConfig: AuthConfig = {
    secret: "auth-secret-at-least-32-characters-long",
    canonicalOrigin: ORIGIN,
    providers: [credentials({ authorize: () => null })],
  };
  const app = await backendApp(
    {
      buckets: {
        avatars: {
          mime: ["image/png"],
          authorize: ({ session, key }) => !!session && key.startsWith(`${session.user.id}/`),
        },
      },
    },
    { plugins: [denextAuth(authConfig)] },
  );
  try {
    const ctx = createRequestContext(new Request(`${ORIGIN}/`));
    await runWithContext(
      ctx,
      () => issueAuthSession(authConfig, { id: "u1", email: "u1@x.test" }, "credentials"),
    );
    const cookie = ctx.outgoingHeaders.getSetCookie().find((c) =>
      c.startsWith("__Host-denext_auth=")
    )!.split(";")[0];
    const body = {
      op: "upload",
      bucket: "avatars",
      key: "u1/me.png",
      contentType: "image/png",
      size: samplePng().byteLength,
    };
    const anon = await app.sign(body);
    assertEquals(anon.status, 403);
    await anon.body?.cancel();
    const other = await app.sign({ ...body, key: "u2/me.png" }, { cookie });
    assertEquals(other.status, 403);
    await other.body?.cancel();
    const own = await app.sign(body, { cookie });
    assertEquals(own.status, 200);
    const plan = await own.json();
    const put = await app.call(plan.upload.url, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: samplePng() as BodyInit,
    });
    assertEquals(put.status, 200);
    await put.body?.cancel();
    const done = await app.sign({ op: "complete", token: plan.upload.token }, { cookie });
    assertEquals((await done.json()).object.key, "u1/me.png");
  } finally {
    await app.close();
  }
});

Deno.test("fs storage: outside a request only a service handle (or a public download) works", async () => {
  const app = await backendApp({
    buckets: { owned: { authorize: () => true }, pub: { public: true, authorize: () => true } },
  });
  try {
    const owned = storage.bucket("owned");
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ["upload", () => owned.upload("a.txt", "x", { contentType: "text/plain" })],
      ["download", () => owned.download("a.txt")],
      ["download", () => owned.head("a.txt")],
      ["download", () => owned.createSignedUrl("a.txt")],
      ["upload", () => owned.createSignedUploadUrl("a.txt", { contentType: "text/plain" })],
      ["list", () => owned.list()],
      ["delete", () => owned.remove("a.txt")],
    ];
    for (const [op, run] of refusals) {
      const error = await assertRejects(run, StorageError, "{ service: true }");
      assertEquals([error.code, error.message.startsWith(op)], ["forbidden", true]);
    }
    // Even with an authorize that allows everything: there is no session to pass it.
    await storage.bucket("owned", { service: true }).upload("a.txt", "x", {
      contentType: "text/plain",
    });
    await storage.bucket("pub", { service: true }).upload("p.txt", "x", {
      contentType: "text/plain",
    });
    // A public bucket's downloads are open to anyone, so they need no session.
    assertEquals((await storage.bucket("pub").head("p.txt"))?.size, 1);
    assertStringIncludes(await storage.bucket("pub").createSignedUrl("p.txt"), "/o/pub/p.txt");
  } finally {
    await app.close();
  }
});

Deno.test("fs storage: the sign route applies csrf(), its schema and its limits", async () => {
  const app = await backendApp({ buckets: { docs } });
  try {
    const body = { op: "upload", bucket: "docs", key: "a.txt", contentType: "text/plain", size: 1 };
    const crossSite = await app.sign(body, { cookie: "sid=1", crossSite: true });
    assertEquals([crossSite.status, (await crossSite.json()).error.code], [403, "csrf_failed"]);
    const noOrigin = await app.call("/_denext/storage/sign", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      cookie: "sid=1",
      body: JSON.stringify(body),
    });
    assertEquals(noOrigin.status, 403);
    await noOrigin.body?.cancel();
    const sameSite = await app.sign(body, { cookie: "sid=1" });
    assertEquals(sameSite.status, 200);
    await sameSite.body?.cancel();
    // No ambient credential, no CSRF: a cookieless caller is judged by authorize alone.
    const cookieless = await app.sign(body, { crossSite: true });
    assertEquals(cookieless.status, 200);
    await cookieless.body?.cancel();

    const invalid = await app.sign({ op: "upload", bucket: "docs", size: "1" });
    const err = (await invalid.json()).error;
    assertEquals([invalid.status, err.code], [400, "validation"]);
    assert(err.fieldErrors.size && err.fieldErrors.contentType);
    const malformed = await app.call("/_denext/storage/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assertEquals(malformed.status, 400);
    await malformed.body?.cancel();
    const huge = await app.call("/_denext/storage/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });
    assertEquals(huge.status, 413);
    await huge.body?.cancel();
    const get = await app.call("/_denext/storage/sign");
    assertEquals([get.status, get.headers.get("allow")], [405, "POST"]);
    await get.body?.cancel();
    const patch = await app.call("/_denext/storage/o/docs/a.txt", { method: "PATCH" });
    assertEquals(patch.status, 405);
    await patch.body?.cancel();
    const mimeRefused = await app.sign({ ...body, contentType: "text/html" });
    assertEquals([mimeRefused.status, (await mimeRefused.json()).error.code], [
      415,
      "mime_not_allowed",
    ]);
    const badType = await app.sign({ ...body, contentType: "nonsense" });
    assertEquals(badType.status, 400);
    await badType.body?.cancel();
    const generated = await (await app.sign({
      op: "upload",
      bucket: "docs",
      contentType: "text/plain",
      size: 1,
      filename: "Report.TXT",
    })).json();
    assert(/^[0-9a-f-]{36}\.txt$/.test(generated.upload.key), generated.upload.key);
    const abort = await app.sign({ op: "abort", token: generated.upload.token });
    assertEquals(await abort.json(), { ok: true });
    const badToken = await app.sign({ op: "complete", token: "nope.nope" });
    assertEquals([badToken.status, (await badToken.json()).error.code], [403, "bad_signature"]);
    // An unexpected failure is a redacted 500, not a leak.
    const broken = await backendApp({
      buckets: { docs },
      driver: { ...fs({ dir: ".s" }), head: () => Promise.reject(new Error("disk on fire")) },
    });
    try {
      const res = await broken.call(
        await storage.bucket("docs", { service: true }).createSignedUrl("a.txt"),
      );
      assertEquals(res.status, 500);
      assertEquals((await res.json()).error.message, "storage request failed");
    } finally {
      await broken.close();
    }
  } finally {
    if (app) await app.close().catch(() => {});
  }
});

Deno.test("fs storage: public buckets serve stable URLs; transforms resize images", async () => {
  const app = await backendApp({
    buckets: {
      img: { public: true, mime: ["image/*", "text/plain"], authorize: allow },
      priv: { mime: ["image/png"], authorize: allow },
    },
  });
  try {
    await storage.bucket("img", { service: true }).upload("logo.png", samplePng());
    await storage.bucket("img", { service: true }).upload("note.txt", "plain", {
      contentType: "text/plain",
    });
    await storage.bucket("priv", { service: true }).upload(
      "p.png",
      new Blob([samplePng() as BlobPart]),
    );
    const stable = await storage.bucket("img", { service: true }).createSignedUrl("logo.png");
    assertEquals(stable, "/_denext/storage/o/img/logo.png");
    const plain = await app.call(stable);
    assertEquals([
      plain.status,
      plain.headers.get("content-type"),
      plain.headers.get("cache-control"),
    ], [200, "image/png", "public, max-age=3600"]);
    await plain.body?.cancel();
    const sized = await app.call(
      await storage.bucket("img", { service: true }).createSignedUrl("logo.png", {
        transform: { width: 32, quality: 80 },
      }),
    );
    assertEquals([sized.status, sized.headers.get("content-type")], [200, "image/webp"]);
    assertEquals(new TextDecoder().decode((await sized.bytes()).subarray(8, 12)), "WEBP");
    const again = await app.call("/_denext/storage/o/img/logo.png?w=32&q=80", { method: "HEAD" });
    assertEquals(again.status, 200);
    for (
      const [path, status] of [
        ["/_denext/storage/o/img/logo.png?w=33", 400],
        ["/_denext/storage/o/img/logo.png?w=99999", 400],
        ["/_denext/storage/o/img/logo.png?fmt=avif&w=32", 400],
        ["/_denext/storage/o/img/note.txt?w=32", 400],
        ["/_denext/storage/o/img/missing.png?w=32", 404],
      ] as const
    ) {
      const res = await app.call(path);
      assertEquals(res.status, status, path);
      await res.body?.cancel();
    }
    // A private transform is part of the signature: changing the width breaks it.
    const signed = await storage.bucket("priv", { service: true }).createSignedUrl("p.png", {
      transform: { width: 64 },
    });
    assertEquals((await app.call(signed)).status, 200);
    const widened = await app.call(signed.replace("w=64", "w=128"));
    assertEquals(widened.status, 403);
    await widened.body?.cancel();
    const viaRoute = await (await app.sign({
      op: "download",
      bucket: "img",
      key: "logo.png",
      transform: { width: 48 },
    })).json();
    assertEquals(viaRoute.url, "/_denext/storage/o/img/logo.png?w=48");
    const pubUpload = await backendApp({ buckets: { open: { public: true } } });
    try {
      const refused = await pubUpload.sign({
        op: "upload",
        bucket: "open",
        key: "a",
        contentType: "text/plain",
        size: 1,
      });
      assertEquals(refused.status, 403, "public means readable, not writable");
      await refused.body?.cancel();
    } finally {
      await pubUpload.close();
    }
  } finally {
    await app.close().catch(() => {});
  }
});

Deno.test("fs storage: server API — upload kinds, sniffed types, list paging, head, remove", async () => {
  const app = await backendApp({
    buckets: {
      files: { maxBytes: 1000, mime: ["text/plain", "image/png", "application/octet-stream"] },
    },
  });
  try {
    const bucket = storage.bucket("files", { service: true });
    assertEquals((await bucket.upload("png", samplePng())).contentType, "image/png");
    assertEquals(
      (await bucket.upload("bin", new Uint8Array([1, 2, 3]))).contentType,
      "application/octet-stream",
    );
    assertEquals(
      (await bucket.upload("txt", "hi", { contentType: "text/plain; charset=utf-8" })).contentType,
      "text/plain",
    );
    await bucket.upload("buf", new Uint8Array([9]).buffer, {
      contentType: "application/octet-stream",
    });
    await bucket.upload("stream", new Blob(["streamed"]).stream(), { contentType: "text/plain" });
    await assertRejects(() => bucket.upload("big", "x".repeat(1001)), StorageError, "exceeds");
    await assertRejects(
      () => bucket.upload("big", new Blob(["x".repeat(1001)]).stream()),
      StorageError,
      "exceeds",
    );
    await assertRejects(
      () => bucket.upload("html", "<b>", { contentType: "text/html" }),
      StorageError,
      "not allowed",
    );
    await assertRejects(
      () => bucket.upload("fake.png", "<html>", { contentType: "image/png" }),
      StorageError,
      "does not match",
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list("", { limit: 2, cursor });
      assert(page.objects.length <= 2);
      seen.push(...page.objects.map((o) => o.key));
      cursor = page.cursor;
    } while (cursor);
    assertEquals(seen, ["bin", "buf", "png", "stream", "txt"]);
    await bucket.upload("dir/a", "1", { contentType: "text/plain" });
    await bucket.upload("dir/sub/b", "2", { contentType: "text/plain" });
    assertEquals((await bucket.list("dir/")).objects.map((o) => o.key), ["dir/a", "dir/sub/b"]);
    assertEquals((await bucket.list("dir/s")).objects.map((o) => o.key), ["dir/sub/b"]);
    assertEquals((await bucket.list("missing/")).objects, []);
    await assertRejects(() => bucket.list("", { cursor: "!!" }), StorageError, "cursor");

    const head = await bucket.head("stream");
    assertEquals([head?.size, head?.contentType], [8, "text/plain"]);
    const down = await bucket.download("stream");
    assertEquals(await new Response(down!.body).text(), "streamed");
    await bucket.remove(["stream", "txt", "never-existed"]);
    assertEquals(await bucket.head("stream"), null);
    assertEquals(await bucket.download("txt"), null);
    // A file someone dropped in by hand (no sidecar) still serves, as octet-stream.
    await Deno.writeTextFile(join(app.root, ".storage", "files", "manual"), "m");
    assertEquals((await bucket.head("manual"))?.contentType, "application/octet-stream");
    await assertRejects(
      () => bucket.createSignedUploadUrl("x", { contentType: "text/plain", size: -1 }),
      StorageError,
      "non-negative",
    );
    await assertRejects(
      () => bucket.createSignedUploadUrl("x", { contentType: "text/plain", maxBytes: 5, size: 6 }),
      StorageError,
      "exceeds",
    );
  } finally {
    await app.close();
  }
});

Deno.test("backend(): setup validates options; no storage → no handler; basePath and the dev secret", async () => {
  assertThrows(() => backend({ storage: { buckets: { a: {} } } as never }), TypeError, "driver");
  assertThrows(
    () => backend({ storage: { driver: fs({ dir: "x" }), buckets: {} } }),
    TypeError,
    "no bucket",
  );
  assertThrows(
    () => backend({ storage: { driver: fs({ dir: "x" }), buckets: { Bad: {} } } }),
    StorageError,
  );
  assertThrows(
    () => backend({ storage: { driver: fs({ dir: "x" }), buckets: { a: { maxBytes: 0 } } } }),
    TypeError,
    "maxBytes",
  );
  assertThrows(() => fs({} as never), TypeError, "dir");

  resetPlugins();
  const load = ((p: string) => import(p)) as unknown as ModuleLoader;
  await applyPlugins({
    projectRoot: "/tmp/x",
    appDir: "/tmp/x/app",
    config: { plugins: [backend()] } as DenextConfig,
    mode: "prod",
    load,
  });
  assertEquals(getPluginRequestHandler(), undefined);

  const based = await backendApp({ buckets: { docs }, secret: undefined }, {
    config: { basePath: "/base/" },
    mode: "dev",
  });
  try {
    const url = await storage.bucket("docs", { service: true }).createSignedUrl("a.txt");
    assert(url.startsWith("/base/_denext/storage/o/docs/a.txt?exp="), url);
  } finally {
    await based.close();
  }
  const prod = await backendApp({ buckets: { docs }, secret: undefined });
  try {
    if (!Deno.env.get("DENEXT_STORAGE_SECRET")) {
      await assertRejects(
        () => storage.bucket("docs", { service: true }).createSignedUrl("a.txt"),
        StorageError,
        "DENEXT_STORAGE_SECRET",
      );
    }
  } finally {
    await prod.close();
  }
});
