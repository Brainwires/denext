// Production-hardening fixes from the 2.0 audit: static-file validators/ranges, safe env
// reads, `.env` tiers, remotePatterns port/glob, the request deadline across a streamed body,
// null-body status overrides, framework endpoint method gating, opaque action ids, bounded
// draft tokens, the Deno version floor, and the dev 500 page.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parseRange, serveStatic } from "../src/server/static.ts";
import { defaultEnvFiles } from "../src/server/env.ts";
import { isAllowedRemote } from "../src/server/image-optimizer.ts";
import { applyOutgoing } from "../src/server/response-headers.ts";
import { actionIdFor, describeActionId } from "../src/runtime/server-action.ts";
import { denoVersionOk, MIN_DENO_VERSION } from "../src/build/deno-version.ts";
import { envAll, envGet } from "../src/runtime/env-safe.ts";
import { devErrorPage } from "../src/build/dev-server/error-page.ts";
import { createApp } from "../src/server/app.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

Deno.test("static: ETag/Last-Modified validators, 304, byte ranges, cache-control", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "v.txt"), "0123456789");
    const full = (await serveStatic(dir, "/v.txt", undefined, new Request("http://x/v.txt")))!;
    assertEquals(full.status, 200);
    assertEquals(full.headers.get("accept-ranges"), "bytes");
    assertEquals(full.headers.get("vary"), "Accept-Encoding");
    assertStringIncludes(full.headers.get("cache-control")!, "must-revalidate");
    const etag = full.headers.get("etag")!;
    assert(etag.startsWith('W/"'), etag);
    assertEquals(await full.text(), "0123456789");

    const cond = (await serveStatic(
      dir,
      "/v.txt",
      undefined,
      new Request("http://x/v.txt", { headers: { "if-none-match": etag } }),
    ))!;
    assertEquals(cond.status, 304);
    assertEquals(cond.body, null);
    const ims = (await serveStatic(
      dir,
      "/v.txt",
      undefined,
      new Request("http://x/v.txt", {
        headers: { "if-modified-since": new Date(Date.now() + 60_000).toUTCString() },
      }),
    ))!;
    assertEquals(ims.status, 304);

    const part = (await serveStatic(
      dir,
      "/v.txt",
      undefined,
      new Request("http://x/v.txt", { headers: { range: "bytes=2-4" } }),
    ))!;
    assertEquals(part.status, 206);
    assertEquals(part.headers.get("content-range"), "bytes 2-4/10");
    assertEquals(part.headers.get("content-length"), "3");
    assertEquals(await part.text(), "234");
    const tail = (await serveStatic(
      dir,
      "/v.txt",
      undefined,
      new Request("http://x/v.txt", { headers: { range: "bytes=-3" } }),
    ))!;
    assertEquals(await tail.text(), "789");
    const bad = (await serveStatic(
      dir,
      "/v.txt",
      undefined,
      new Request("http://x/v.txt", { headers: { range: "bytes=50-" } }),
    ))!;
    assertEquals(bad.status, 416);
    assertEquals(bad.headers.get("content-range"), "bytes */10");
    assertEquals(parseRange("bytes=0-1,3-4", 10), undefined, "multiple ranges → whole file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("env: Next's .env tiers per mode; safe reads never throw", () => {
  assertEquals(defaultEnvFiles("development"), [
    ".env",
    ".env.development",
    ".env.local",
    ".env.development.local",
  ]);
  assertEquals(
    defaultEnvFiles("test"),
    [".env", ".env.test", ".env.test.local"],
    ".env.local is skipped for test",
  );
  assertEquals(typeof envGet("PATH"), "string");
  assertEquals(envGet("DENEXT_DEFINITELY_UNSET_" + Date.now()), undefined);
  assert(typeof envAll() === "object");
});

Deno.test("images.remotePatterns: port, glob pathname, search", () => {
  const opts = {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.example.com", pathname: "/public/**" },
      { hostname: "*.imgs.dev", port: "9000" },
      { hostname: "q.dev", search: "?v=1" },
    ],
  } as never;
  const ok = (u: string) => isAllowedRemote(new URL(u), opts);
  assert(ok("https://cdn.example.com/public/a/b.png"));
  assert(!ok("https://cdn.example.com/public-internal/x.png"), "a glob is not a string prefix");
  assert(
    ok("https://cdn.example.com:9000/public/a.png"),
    "an omitted port matches any port (Next semantics)",
  );
  assert(!ok("http://cdn.example.com/public/a.png"), "protocol enforced");
  assert(ok("https://a.imgs.dev:9000/x.png") && !ok("https://a.imgs.dev/x.png"));
  assert(ok("https://q.dev/i.png?v=1") && !ok("https://q.dev/i.png?v=2"));
});

Deno.test("request timeout stays armed across a streamed body (a hung Suspense hole cannot pin the request)", async () => {
  const never = new Promise<never>(() => {});
  const Hang = () => {
    throw never; // suspends forever
  };
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("slow"),
      routePath: "/slow",
      filePath: "slow.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
  const app = createApp({
    getManifest: () => manifest,
    load: () =>
      Promise.resolve({
        default: () =>
          h("main", null, h(Suspense, { fallback: h("p", null, "loading…") }, h(Hang, null))),
      }),
    streaming: true,
    requestTimeout: 300,
  });
  const started = Date.now();
  const res = await app(new Request("http://localhost/slow"));
  const html = await res.text();
  assert(Date.now() - started < 5_000, "the body completed instead of hanging");
  assertStringIncludes(html, "loading…", "the shell fallback stays in place");
});

Deno.test("applyOutgoing: a 204/304 status override drops the body instead of throwing", () => {
  const res = applyOutgoing(new Response("body"), new Headers(), 204);
  assertEquals(res.status, 204);
  assertEquals(res.body, null);
});

Deno.test("server-action ids are opaque hashes, stable, and describable in dev", () => {
  const a = actionIdFor("app/actions.ts", "deleteUser");
  const b = actionIdFor("app/actions.ts", "deleteUser");
  assertEquals(a, b);
  assert(!a.includes("#") && !a.includes("actions"), a);
  assert(a !== actionIdFor("app/actions.ts", "deleteUserX"));
  assertEquals(describeActionId(a), "app/actions.ts#deleteUser");
});

Deno.test("Deno version floor is minor-aware", () => {
  assert(denoVersionOk("2.9.6") && denoVersionOk("3.0.0") && denoVersionOk(MIN_DENO_VERSION));
  assert(!denoVersionOk("2.8.9") && !denoVersionOk("2.1.0") && !denoVersionOk("1.46.0"));
});

Deno.test("dev 500 page renders the recorded error with its codeframe", () => {
  const page = devErrorPage(
    {
      kind: "error",
      ts: 0,
      source: "server",
      level: "error",
      title: "Server render error",
      message: "boom <x>",
      codeframe: "1 | const a = (",
      stack: "at page.tsx:1",
    } as never,
    "/_denext/reload.js",
  );
  assert(page);
  assertStringIncludes(page!, "boom &lt;x&gt;");
  assertStringIncludes(page!, "const a = (");
  assertStringIncludes(page!, "/_denext/reload.js");
  assertEquals(devErrorPage(undefined, "/x"), null);
});
