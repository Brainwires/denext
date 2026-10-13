// The Supabase Storage parity suite: the REAL `@supabase/supabase-js` (and `tus-js-client` for
// resumable uploads) against a denext app with `@denext/backend` storage. One suite, run twice —
// on the fs driver with the sqlite metadata store and TypeScript rules
// (tests/backend-storage-supabase.test.ts), and on MinIO + Postgres with SQL-RLS policies on
// `storage.objects` (tests/backend-storage-supabase-integration.test.ts) — so both drivers, both
// stores and both authorization modes answer supabase-js the same way.
//
// The app under test declares two buckets — `private` (a user may touch only `<their id>/…`,
// by `authorize` or by policy) and `images` (public, PNG only, 64 KiB) — and the suite creates
// more at runtime with the secret key.

import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import * as tus from "tus-js-client";
import { Buffer } from "node:buffer";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../../src/plugin/mod.ts";
import type { DenextPlugin } from "../../src/plugin/mod.ts";
import type { DenextConfig } from "../../src/server/config.ts";
import type { ModuleLoader } from "../../src/server/types.ts";
import { createApp } from "../../src/server/app.ts";
import { scanRoutes } from "../../src/router/manifest.ts";
import { createRequestContext, runWithContext } from "../../src/server/request-context.ts";
import { denextAuth } from "../../src/server/auth/mod.ts";
import { credentials } from "../../src/server/auth/providers.ts";
import { issueAuthSession } from "../../src/server/auth/session.ts";
import type { AuthConfig } from "../../src/server/auth/types.ts";
import { installRuntime } from "../../packages/backend/src/runtime.ts";
import {
  generateSupabaseKeys,
  installedSupabaseKeys,
  signSupabaseJwt,
  type SupabaseKeysConfig,
} from "../../src/server/auth/gotrue/keys.ts";
import { samplePng } from "../fixtures/sample-image.ts";

export const ORIGIN = "https://app.test";
/** The secret key (service role) the suite's service client presents. */
export const SECRET_KEY = `sb_secret_${crypto.randomUUID().replaceAll("-", "")}`; // per run
/** The publishable key (anon). */
export const ANON_KEY = `sb_publishable_${crypto.randomUUID().replaceAll("-", "")}`;

/**
 * `backend({ supabase })`'s keys for a test app: the two API keys above and a fresh ES256
 * signing key, so the suite's users present real Supabase access tokens.
 */
export async function supabaseKeys(): Promise<SupabaseKeysConfig> {
  const { signingKey } = await generateSupabaseKeys();
  return { publishableKey: ANON_KEY, secretKey: SECRET_KEY, signingKeys: [signingKey] };
}

/** A Supabase access token for `id`, signed with the installed keys (an hour's lifetime). */
export async function accessToken(id: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signSupabaseJwt(installedSupabaseKeys()!, {
    sub: id,
    role: "authenticated",
    aud: "authenticated",
    email: `${id.slice(-1)}@users.test`,
    iat: now,
    exp: now + 3600,
  });
}
const load = ((path: string) => import(path)) as unknown as ModuleLoader;

const authConfig: AuthConfig = {
  secret: "storage-auth-secret-at-least-32-characters!",
  canonicalOrigin: ORIGIN,
  providers: [credentials({ authorize: () => null })],
};

/** A built app: an in-process `fetch` for supabase-js, and a real server for tus-js-client. */
export interface StorageHarness {
  root: string;
  fetch: typeof fetch;
  handler: (request: Request) => Promise<Response>;
  close(): Promise<void>;
}

/**
 * Build the app around `plugin` (a `backend({ storage })`), with denextAuth for cookie sessions.
 *
 * @param plugin The backend plugin.
 * @returns The harness.
 */
export async function storageHarness(
  plugin: DenextPlugin,
  root?: string,
): Promise<StorageHarness> {
  root ??= await Deno.makeTempDir({ prefix: "dnx-sb-storage-" });
  await Deno.mkdir(`${root}/app`, { recursive: true });
  resetPlugins();
  installRuntime(undefined);
  const config = { plugins: [denextAuth(authConfig), plugin] } as DenextConfig;
  await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "prod", load });
  const manifest = await scanRoutes(`${root}/app`);
  const handler = createApp({
    getManifest: () => manifest,
    load,
    matchExternal: getPluginRequestHandler(),
  });
  const viaApp = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("host", new URL(ORIGIN).host);
    if (headers.has("cookie") && request.method !== "GET" && request.method !== "HEAD") {
      headers.set("origin", ORIGIN);
    }
    const body = request.body ? await request.arrayBuffer() : undefined;
    return await handler(
      new Request(new URL(url.pathname + url.search, ORIGIN), {
        method: request.method,
        headers,
        body,
      }),
    );
  }) as typeof fetch;
  return {
    root,
    fetch: viaApp,
    handler,
    async close() {
      resetPlugins();
      installRuntime(undefined);
      await Deno.remove(root!, { recursive: true }).catch(() => {});
    },
  };
}

/** A signed-in user's session cookie. */
export async function cookieFor(id: string): Promise<string> {
  const ctx = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(ctx, () => issueAuthSession(authConfig, { id }, "credentials"));
  const [cookie] = ctx.outgoingHeaders.getSetCookie()
    .filter((c) => c.startsWith("__Host-denext_auth="));
  return cookie.slice(0, cookie.indexOf(";"));
}

function client(h: StorageHarness, key: string, token?: string) {
  return createClient(ORIGIN, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: h.fetch },
    ...(token ? { accessToken: () => Promise.resolve(token) } : {}),
  });
}

/** The PNG's width and height (from its IHDR chunk). */
function pngSize(bytes: Uint8Array): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return [view.getUint32(16), view.getUint32(20)];
}

const text = (s: string) => new TextEncoder().encode(s);

/** `user A` and `user B`'s ids. */
export const USER_A = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000a";
export const USER_B = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a000b";

/**
 * Run the suite.
 *
 * @param t The test context (each scenario is a step).
 * @param h The app.
 */
export async function runSupabaseStorageSuite(t: Deno.TestContext, h: StorageHarness) {
  const admin = client(h, SECRET_KEY);
  const anon = client(h, ANON_KEY);
  // Users present real Supabase access tokens (ES256 JWTs), as supabase-js does after sign-in.
  const userA = client(h, ANON_KEY, await accessToken(USER_A));
  const userB = client(h, ANON_KEY, await accessToken(USER_B));
  const run = `r${Date.now().toString(36)}`;
  const docs = `docs-${run}`;
  const other = `other-${run}`;

  // fallow-ignore-next-line complexity -- one supabase-js scenario; each `?.` in its asserts counts as a branch
  await t.step("buckets: create, get, list, update, duplicate; only the service role", async () => {
    const created = await admin.storage.createBucket(docs, {
      public: false,
      fileSizeLimit: "1KB",
      allowedMimeTypes: ["text/plain", "image/png"],
    });
    assertEquals(created, { data: { name: docs }, error: null });
    const again = await admin.storage.createBucket(docs);
    assertEquals(again.error?.statusCode, "409");
    const got = await admin.storage.getBucket(docs);
    assertEquals(
      [got.data?.id, got.data?.public, got.data?.file_size_limit, got.data?.allowed_mime_types],
      [docs, false, 1024, ["text/plain", "image/png"]],
    );
    const listed = await admin.storage.listBuckets();
    const names = (listed.data ?? []).map((b) => b.name);
    assert(
      names.includes(docs) && names.includes("private") && names.includes("images"),
      String(names),
    );
    const searched = await admin.storage.listBuckets({ search: run, sortColumn: "name" });
    assertEquals(searched.data?.map((b) => b.name), [docs]);
    assertEquals(
      (await admin.storage.updateBucket(docs, { public: false, fileSizeLimit: 4096 })).error,
      null,
    );
    assertEquals((await admin.storage.getBucket(docs)).data?.file_size_limit, 4096);
    assertEquals((await admin.storage.createBucket(other, { public: true })).error, null);
    const refused = await anon.storage.createBucket(`nope-${run}`);
    assertEquals(refused.error?.statusCode, "403");
    const userList = await userA.storage.listBuckets();
    assert(
      userList.error?.statusCode === "403" || !userList.data?.some((b) => b.name === docs),
      "a user does not see the buckets",
    );
    assertEquals((await admin.storage.getBucket(`missing-${run}`)).error?.statusCode, "404");
    const declared = await admin.storage.updateBucket("private", { public: true });
    assertEquals(declared.error?.statusCode, "400");
    const reserved = await admin.storage.createBucket("public");
    assertEquals(reserved.error?.statusCode, "400");
  });

  // fallow-ignore-next-line complexity -- one supabase-js scenario; each `?.` in its asserts counts as a branch
  await t.step("upload: string, Blob form with metadata, duplicate, upsert, update", async () => {
    const files = admin.storage.from(docs);
    const up = await files.upload("hello.txt", "hello world", { contentType: "text/plain" });
    assertEquals(up.error, null);
    assertEquals([up.data?.path, up.data?.fullPath], ["hello.txt", `${docs}/hello.txt`]);
    assertExists(up.data?.id);
    const dup = await files.upload("hello.txt", "again", { contentType: "text/plain" });
    assertEquals(dup.error?.statusCode, "409");
    const upsert = await files.upload("hello.txt", "hello upsert", {
      contentType: "text/plain",
      upsert: true,
    });
    assertEquals(upsert.error, null);
    const blob = await files.upload(
      "folder/note.txt",
      new Blob(["blob body"], { type: "text/plain" }),
      { cacheControl: "60", metadata: { owner: "x", n: 1 } },
    );
    assertEquals(blob.error, null);
    const updated = await files.update(
      "folder/note.txt",
      new Blob(["updated"], { type: "text/plain" }),
      {
        metadata: { owner: "y" },
      },
    );
    assertEquals(updated.error, null);
    const info = await files.info("folder/note.txt");
    assertEquals(info.error, null);
    assertEquals(
      [info.data?.size, info.data?.contentType, info.data?.cacheControl, info.data?.metadata],
      [7, "text/plain", "max-age=3600", { owner: "y" }],
    );
    const head = await files.info("hello.txt");
    assertEquals([head.data?.size, head.data?.name, head.data?.bucketId], [12, "hello.txt", docs]);
    const dl = await files.download("hello.txt");
    assertEquals(await dl.data?.text(), "hello upsert");
    assertEquals((await files.exists("hello.txt")).data, true);
    assertEquals((await files.exists("nope.txt")).data, false);
    assertEquals((await files.download("nope.txt")).error?.status, 404);
  });

  await t.step("limits: size, allow-list and sniffing are enforced on every path", async () => {
    const files = admin.storage.from(docs);
    const big = await files.upload("big.txt", "x".repeat(5000), { contentType: "text/plain" });
    assertEquals(big.error?.statusCode, "413");
    const blobBig = await files.upload(
      "big2.txt",
      new Blob(["x".repeat(5000)], { type: "text/plain" }),
    );
    assertEquals(blobBig.error?.statusCode, "413");
    const type = await files.upload("page.html", "<b>x</b>", { contentType: "text/html" });
    assertEquals(type.error?.statusCode, "415");
    const lie = await files.upload("fake.png", "not a png at all", { contentType: "image/png" });
    assertEquals(lie.error?.statusCode, "415");
    const traversal = await h.fetch(
      `${ORIGIN}/storage/v1/object/${docs}/x%2F..%2F..%2Fescape.txt`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET_KEY}`, "content-type": "text/plain" },
        body: "x",
      },
    );
    assertEquals([traversal.status, (await traversal.json()).error], [400, "InvalidKey"]);
    const signed = await files.createSignedUploadUrl("signed-big.txt");
    const viaSigned = await files.uploadToSignedUrl(
      "signed-big.txt",
      signed.data!.token,
      "x".repeat(5000),
      {
        contentType: "text/plain",
      },
    );
    assertEquals(viaSigned.error?.statusCode, "413");
    assertEquals((await files.exists("signed-big.txt")).data, false);
  });

  await t.step("list: folders first, search, sortBy, limit and offset", async () => {
    const files = admin.storage.from(docs);
    for (const name of ["a.txt", "b.txt", "folder/sub/deep.txt", "zeta/z.txt"]) {
      assertEquals((await files.upload(name, name, { contentType: "text/plain" })).error, null);
    }
    const root = await files.list();
    assertEquals(root.data?.map((e) => [e.name, e.id === null]), [
      ["folder", true],
      ["zeta", true],
      ["a.txt", false],
      ["b.txt", false],
      ["hello.txt", false],
    ]);
    const entry = root.data!.find((e) => e.name === "a.txt")!;
    assertEquals([entry.metadata?.size, entry.metadata?.mimetype], [5, "text/plain"]);
    assertEquals((await files.list("folder")).data?.map((e) => e.name), ["sub", "note.txt"]);
    assertEquals((await files.list("folder/")).data?.map((e) => e.name), ["sub", "note.txt"]);
    assertEquals((await files.list("", { search: "h" })).data?.map((e) => e.name), ["hello.txt"]);
    const desc = await files.list("", { sortBy: { column: "name", order: "desc" } });
    assertEquals(desc.data?.slice(-3).map((e) => e.name), ["hello.txt", "b.txt", "a.txt"]);
    const page = await files.list("", { limit: 2, offset: 2 });
    assertEquals(page.data?.length, 2);
    const bad = await files.list("", { sortBy: { column: "nope; drop table x", order: "asc" } });
    assertEquals(bad.error?.statusCode, "400");
  });

  await t.step("signed URLs: one, many, download, expiry; signed uploads", async () => {
    const files = admin.storage.from(docs);
    const one = await files.createSignedUrl("hello.txt", 60);
    assertEquals(one.error, null);
    const res = await h.fetch(one.data!.signedUrl);
    assertEquals([res.status, await res.text()], [200, "hello upsert"]);
    const asFile = await files.createSignedUrl("hello.txt", 60, { download: "greeting.txt" });
    const dl = await h.fetch(asFile.data!.signedUrl);
    assertStringIncludes(dl.headers.get("content-disposition") ?? "", 'filename="greeting.txt"');
    await dl.body?.cancel();
    const tampered = one.data!.signedUrl.replace("hello.txt", "a.txt");
    assertEquals((await h.fetch(tampered)).status, 400);
    const many = await files.createSignedUrls(["a.txt", "missing.txt"], 60);
    assertEquals(many.data?.map((d) => [d.path, d.error === null, !!d.signedUrl]), [
      ["a.txt", true, true],
      ["missing.txt", false, false],
    ]);
    assertEquals(await (await h.fetch(many.data![0].signedUrl!)).text(), "a.txt");
    const up = await files.createSignedUploadUrl("signed/up.txt");
    assertEquals(up.error, null);
    const put = await files.uploadToSignedUrl("signed/up.txt", up.data!.token, "via token", {
      contentType: "text/plain",
    });
    assertEquals([put.error, put.data?.fullPath], [null, `${docs}/signed/up.txt`]);
    assertEquals(await (await files.download("signed/up.txt")).data?.text(), "via token");
    const reuse = await files.uploadToSignedUrl("signed/up.txt", up.data!.token, "again", {
      contentType: "text/plain",
    });
    assertEquals(reuse.error?.statusCode, "409");
    const wrong = await files.uploadToSignedUrl("signed/other.txt", up.data!.token, "x", {
      contentType: "text/plain",
    });
    assertEquals(wrong.error?.statusCode, "400");
  });

  await t.step("copy and move: within a bucket, across buckets, conflicts", async () => {
    const files = admin.storage.from(docs);
    const copied = await files.copy("a.txt", "copies/a.txt");
    assertEquals([copied.error, copied.data?.path], [null, `${docs}/copies/a.txt`]);
    assertEquals(await (await files.download("copies/a.txt")).data?.text(), "a.txt");
    const cross = await files.copy("folder/note.txt", "from-docs.txt", {
      destinationBucket: other,
    });
    assertEquals(cross.error, null);
    assertEquals(
      (await admin.storage.from(other).info("from-docs.txt")).data?.metadata as unknown,
      { owner: "y" },
    );
    const moved = await files.move("b.txt", "moved/b.txt");
    assertEquals(moved.data, { message: "Successfully moved" });
    assertEquals((await files.exists("b.txt")).data, false);
    assertEquals(await (await files.download("moved/b.txt")).data?.text(), "b.txt");
    const clash = await files.move("a.txt", "hello.txt");
    assertEquals(clash.error?.statusCode, "409");
    const movedOut = await files.move("moved/b.txt", "b-moved.txt", { destinationBucket: other });
    assertEquals(movedOut.error, null);
    assertEquals(
      await (await admin.storage.from(other).download("b-moved.txt")).data?.text(),
      "b.txt",
    );
    const intoPng = await files.copy("a.txt", "x.txt", { destinationBucket: "images" });
    assertEquals(intoPng.error?.statusCode, "415");
  });

  await t.step("public bucket: public URL, transforms (cover, contain, fill, origin)", async () => {
    const images = admin.storage.from("images");
    const png = samplePng();
    assertEquals(
      (await images.upload("square.png", png, { contentType: "image/png", upsert: true })).error,
      null,
    );
    const { publicUrl } = images.getPublicUrl("square.png").data;
    const plain = await h.fetch(publicUrl);
    assertEquals([plain.status, plain.headers.get("content-type")], [200, "image/png"]);
    await plain.body?.cancel();
    const size = async (resize: "cover" | "contain" | "fill") => {
      const url = images.getPublicUrl("square.png", {
        transform: { width: 8, height: 4, resize, format: "origin" },
      }).data.publicUrl;
      const res = await h.fetch(url);
      assertEquals(res.status, 200, url);
      return pngSize(new Uint8Array(await res.arrayBuffer()));
    };
    assertEquals(await size("cover"), [8, 4]);
    assertEquals(await size("contain"), [4, 4]);
    assertEquals(await size("fill"), [8, 4]);
    const webp = await h.fetch(
      images.getPublicUrl("square.png", { transform: { width: 8 } }).data.publicUrl,
    );
    assertEquals(webp.headers.get("content-type"), "image/webp");
    await webp.body?.cancel();
    const signed = await images.createSignedUrl("square.png", 60, {
      transform: { width: 4, height: 4, format: "origin" },
    });
    assertStringIncludes(signed.data!.signedUrl, "/render/image/sign/");
    assertEquals(
      pngSize(new Uint8Array(await (await h.fetch(signed.data!.signedUrl)).arrayBuffer())),
      [4, 4],
    );
    const authed = await anon.storage.from("images").download("square.png", {
      transform: { width: 4, height: 4, format: "origin" },
    });
    assertEquals(pngSize(new Uint8Array(await authed.data!.arrayBuffer())), [4, 4]);
    const privateUrl = admin.storage.from(docs).getPublicUrl("hello.txt").data.publicUrl;
    assertEquals((await h.fetch(privateUrl)).status, 404);
  });

  await t.step("users: each may touch only their own folder; anon nothing", async () => {
    const a = userA.storage.from("private");
    const b = userB.storage.from("private");
    assertEquals(
      (await a.upload(`${USER_A}/mine.txt`, "A's", { contentType: "text/plain" })).error,
      null,
    );
    assertEquals(
      (await a.upload(`${USER_B}/theirs.txt`, "x", { contentType: "text/plain" })).error
        ?.statusCode,
      "403",
    );
    assertEquals(await (await a.download(`${USER_A}/mine.txt`)).data?.text(), "A's");
    const peek = await b.download(`${USER_A}/mine.txt`);
    assert(peek.error && [403, 404].includes(peek.error.status as number), String(peek.error));
    assertEquals((await b.remove([`${USER_A}/mine.txt`])).data ?? [], []);
    assertEquals((await a.exists(`${USER_A}/mine.txt`)).data, true);
    assertEquals(
      (await anon.storage.from("private").upload("x.txt", "x", { contentType: "text/plain" })).error
        ?.statusCode,
      "403",
    );
    const listA = await a.list(USER_A);
    assertEquals(listA.data?.map((e) => e.name), ["mine.txt"]);
    const signA = await a.createSignedUrl(`${USER_A}/mine.txt`, 60);
    assertEquals(await (await h.fetch(signA.data!.signedUrl)).text(), "A's");
    const signB = await b.createSignedUrl(`${USER_A}/mine.txt`, 60);
    assertExists(signB.error);
    // A refused credential is an error, never a silent anon.
    const expired = client(
      h,
      ANON_KEY,
      await accessToken(USER_A).then((t) => t.slice(0, -4) + "AAAA"),
    );
    assertEquals((await expired.storage.from("private").list(USER_A)).error?.statusCode, "400");
    const badKey = client(h, `sb_publishable_${crypto.randomUUID()}`);
    assertEquals((await badKey.storage.from("images").list()).error?.statusCode, "401");
    const removed = await a.remove([`${USER_A}/mine.txt`]);
    assertEquals(removed.data?.map((r) => r.name), [`${USER_A}/mine.txt`]);
  });

  await t.step("remove, empty and delete buckets", async () => {
    const files = admin.storage.from(docs);
    const removed = await files.remove(["a.txt", "hello.txt", "never.txt"]);
    assertEquals(removed.data?.map((r) => r.name).sort(), ["a.txt", "hello.txt"]);
    assertEquals((await files.exists("a.txt")).data, false);
    const notEmpty = await admin.storage.deleteBucket(docs);
    assertEquals(notEmpty.error?.statusCode, "409");
    assertEquals((await admin.storage.emptyBucket(docs)).data, { message: "Successfully emptied" });
    assertEquals((await files.list()).data, []);
    assertEquals((await admin.storage.deleteBucket(docs)).data, {
      message: "Successfully deleted",
    });
    assertEquals((await admin.storage.getBucket(docs)).error?.statusCode, "404");
    await admin.storage.emptyBucket(other);
    await admin.storage.deleteBucket(other);
  });

  await t.step("TUS: tus-js-client uploads in chunks; HEAD, conflicts, termination", async () => {
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, h.handler);
    const base = `http://127.0.0.1:${server.addr.port}/storage/v1/upload/resumable`;
    try {
      await admin.storage.createBucket(`tus-${run}`, { public: false });
      const size = 6 * 1024 * 1024 + 123;
      const bytes = new Uint8Array(size).map((_, i) => (i * 31) % 251);
      bytes.set(text("plain text start "), 0);
      const location = await new Promise<string>((resolve, reject) => {
        const upload = new tus.Upload(Buffer.from(bytes), {
          endpoint: base,
          chunkSize: 2 * 1024 * 1024,
          retryDelays: [],
          headers: {
            authorization: `Bearer ${SECRET_KEY}`,
            apikey: SECRET_KEY,
            "x-upsert": "true",
          },
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true,
          metadata: {
            bucketName: `tus-${run}`,
            objectName: "big/file.bin",
            contentType: "application/octet-stream",
            cacheControl: "3600",
          },
          onError: reject,
          onSuccess: () => resolve(upload.url!),
        });
        upload.start();
      });
      assertStringIncludes(location, "/storage/v1/upload/resumable/");
      const got = await admin.storage.from(`tus-${run}`).download("big/file.bin");
      const back = new Uint8Array(await got.data!.arrayBuffer());
      assertEquals(back.byteLength, size);
      assertEquals(back.subarray(size - 64), bytes.subarray(size - 64));
      assertEquals((await admin.storage.from(`tus-${run}`).info("big/file.bin")).data?.size, size);

      const headers = {
        "tus-resumable": "1.0.0",
        authorization: `Bearer ${SECRET_KEY}`,
        "upload-length": "10",
        "upload-metadata": `bucketName ${btoa(`tus-${run}`)},objectName ${
          btoa("manual.txt")
        },contentType ${btoa("text/plain")}`,
      };
      const created = await fetch(base, { method: "POST", headers });
      assertEquals(created.status, 201);
      const url = new URL(created.headers.get("location")!, base).toString();
      assertExists(created.headers.get("upload-expires"));
      const patch = (offset: number, body: string) =>
        fetch(url, {
          method: "PATCH",
          headers: {
            "tus-resumable": "1.0.0",
            authorization: `Bearer ${SECRET_KEY}`,
            "upload-offset": String(offset),
            "content-type": "application/offset+octet-stream",
          },
          body,
        });
      const first = await patch(0, "hello");
      assertEquals([first.status, first.headers.get("upload-offset")], [204, "5"]);
      const stale = await patch(0, "hello");
      assertEquals(stale.status, 409);
      await stale.body?.cancel();
      const head = await fetch(url, {
        method: "HEAD",
        headers: { "tus-resumable": "1.0.0", authorization: `Bearer ${SECRET_KEY}` },
      });
      assertEquals([head.headers.get("upload-offset"), head.headers.get("upload-length")], [
        "5",
        "10",
      ]);
      const over = await patch(5, "too many bytes");
      assertEquals(over.status, 413);
      await over.body?.cancel();
      const last = await patch(5, "world");
      assertEquals(last.status, 204);
      assertEquals(
        await (await admin.storage.from(`tus-${run}`).download("manual.txt")).data?.text(),
        "helloworld",
      );

      const doomed = await fetch(base, {
        method: "POST",
        headers: {
          ...headers,
          "upload-metadata": headers["upload-metadata"].replace(
            btoa("manual.txt"),
            btoa("doomed.txt"),
          ),
        },
      });
      const doomedUrl = new URL(doomed.headers.get("location")!, base).toString();
      const del = await fetch(doomedUrl, {
        method: "DELETE",
        headers: { "tus-resumable": "1.0.0", authorization: `Bearer ${SECRET_KEY}` },
      });
      assertEquals(del.status, 204);
      const gone = await fetch(doomedUrl, {
        method: "HEAD",
        headers: { "tus-resumable": "1.0.0", authorization: `Bearer ${SECRET_KEY}` },
      });
      assertEquals(gone.status, 404);
      assertEquals((await admin.storage.from(`tus-${run}`).exists("doomed.txt")).data, false);

      const tooBig = await fetch(base, {
        method: "POST",
        headers: { ...headers, "upload-length": String(60 * 1024 * 1024) },
      });
      assertEquals(tooBig.status, 413);
      await tooBig.body?.cancel();
      const anonTus = await fetch(base, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${ANON_KEY}` },
      });
      assertEquals(anonTus.status, 403);
      await anonTus.body?.cancel();
      await admin.storage.emptyBucket(`tus-${run}`);
      await admin.storage.deleteBucket(`tus-${run}`);
    } finally {
      await server.shutdown();
    }
  });
}
