// Regression tests for the Next.js-advisory audit: issues of the classes Next.js has published
// advisories for (middleware bypass by path spelling, a client-sent internal header, an i18n
// prefix, a framework endpoint in front of middleware; cache confusion between a page URL's
// variants) that the audit reproduced against denext. Each test replays the request that got
// through.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "./helpers/released-app.ts";
import type { AppConfig } from "../src/server/app-config.ts";
import type { PageRoute, RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { createMiddlewareRunner } from "../src/server/middleware.ts";
import { decodeUnreserved, externalRewriteHeaders } from "../src/server/request-pipeline.ts";
import { REGEN_HEADER, REGEN_TOKEN } from "../src/server/app-config.ts";
import { verifyOrigin } from "../src/server/origin-check.ts";
import { inMemoryCacheStore, setCacheStore, unstable_cache } from "../src/server/cache.ts";
import { serveStatic } from "../src/server/static.ts";
import { localImageGate, optimizeImage } from "../src/server/image-optimizer.ts";
import { type NextRequest, NextResponse, NextURL } from "../src/compat/next/server.ts";
import { createPagesHandler } from "../packages/pages-router/src/handler.ts";
import type { PagesScan } from "../packages/pages-router/src/scan.ts";

const pageBase = {
  kind: "page" as const,
  layoutChain: [] as string[],
  loading: null,
  error: null,
  notFound: null,
  forbidden: null,
  unauthorized: null,
  templateChain: [] as string[],
};

function manifestOf(pages: Record<string, string>): () => RouteManifest {
  const list: PageRoute[] = Object.entries(pages).map(([routePath, filePath]) => ({
    ...pageBase,
    pattern: parsePattern(routePath.replace(/^\//, "")),
    routePath,
    filePath,
  }));
  return () => ({
    pages: list,
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  });
}

const SECRET = "TOP-SECRET";
const secretPage = { default: () => h("h1", null, SECRET) };
const homePage = { default: () => h("h1", null, "home") };

function appWith(config: Partial<AppConfig> & { pages: Record<string, unknown> }) {
  const { pages, ...rest } = config;
  return createApp({
    getManifest: manifestOf(Object.fromEntries(Object.keys(pages).map((p) => [p, p]))),
    load: (fp) => Promise.resolve(pages[fp]),
    ...rest,
  });
}

/** A request's status and whether its body carries the guarded content. */
async function probe(
  app: (r: Request) => Promise<Response>,
  path: string,
  headers?: HeadersInit,
): Promise<{ status: number; leaked: boolean; location: string | null }> {
  const res = await app(new Request("http://localhost" + path, { headers }));
  const body = await res.text();
  return {
    status: res.status,
    leaked: body.includes(SECRET),
    location: res.headers.get("location"),
  };
}

/** A middleware that refuses everything its matcher selects. */
const guard = (matcher: string[]) =>
  createMiddlewareRunner({
    middleware: () => new Response("blocked", { status: 401 }),
    config: { matcher },
  });

// ---------------------------------------------------------------------------
// Path spelling: one resource, several spellings, a matcher that saw only one.
// ---------------------------------------------------------------------------

Deno.test("decodeUnreserved decodes only percent-encoded unreserved characters", () => {
  assertEquals(decodeUnreserved("/%61dmin/%2E%7e"), "/admin/.~");
  assertEquals(decodeUnreserved("/a%2Fb%5Cc%20d%00"), "/a%2Fb%5Cc%20d%00"); // reserved: kept
  assertEquals(decodeUnreserved("/%2541"), "/%2541"); // `%25` is `%`: not decoded twice
  assertEquals(decodeUnreserved("/caf%C3%A9/%zz/%"), "/caf%C3%A9/%zz/%");
  assertEquals(decodeUnreserved("/plain"), "/plain");
});

Deno.test("middleware bypass: a percent-encoded spelling of a guarded path is redirected to the one the matcher sees", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "private"));
    await Deno.writeTextFile(join(root, "private", "report.txt"), SECRET);
    const app = appWith({
      pages: { "/admin": secretPage, "/users/[id]": secretPage },
      getMiddleware: () => guard(["/private/:path*", "/admin/:path*", "/users/admin"]),
      publicDir: root,
    });
    assertEquals((await probe(app, "/private/report.txt")).status, 401);
    for (
      const [spelling, canonical] of [
        ["/%70rivate/report.txt", "/private/report.txt"], // a public/ file (static decodes)
        ["/private/report%2Etxt", "/private/report.txt"],
        ["/users/%61dmin", "/users/admin"], // a dynamic segment (its param is decoded)
        ["/%61dmin", "/admin"],
      ]
    ) {
      const res = await probe(app, spelling);
      assert(!res.leaked, `${spelling} reached the guarded content`);
      assertEquals(res.status, 308, spelling);
      assertEquals(res.location, canonical);
      assertEquals((await probe(app, canonical)).status, 401, canonical);
    }
    // The query string survives the redirect.
    assertEquals((await probe(app, "/%61dmin?a=%62")).location, "/admin?a=%62");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("middleware bypass: an encoded path separator never names a public/ file", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "private"));
    await Deno.writeTextFile(join(root, "private", "report.txt"), SECRET);
    const app = appWith({
      pages: {},
      getMiddleware: () => guard(["/private/:path*"]),
      publicDir: root,
    });
    for (
      const spelling of [
        "/private%2Freport.txt",
        "/private%2freport.txt",
        "/private%5Creport.txt",
        "/x/..%2Fprivate/report.txt",
        "/x/..%2fprivate%2freport.txt",
      ]
    ) {
      const res = await probe(app, spelling);
      assert(!res.leaked, `${spelling} reached the guarded file`);
      assertEquals(res.status, 404, spelling);
      assertEquals(await serveStatic(root, spelling), null, spelling);
    }
    assertEquals(await serveStatic(root, "/private/report.txt%00"), null);
    // The plain spelling is still served (by the primitive; the app's middleware refuses it).
    assertEquals(await (await serveStatic(root, "/private/report.txt"))!.text(), SECRET);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("middleware bypass: a public/ file answers only the spelling it is stored under", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "private"));
    await Deno.writeTextFile(join(root, "private", "report.txt"), SECRET);
    await Deno.writeTextFile(join(root, "private", "report.txt.gz"), "not-really-gzip");
    await Deno.writeTextFile(join(root, "café.txt"), "accent");
    // A symlink inside public/ is still served under its own name (and only that name).
    await Deno.symlink(join(root, "private", "report.txt"), join(root, "Link.txt"));
    const app = appWith({
      pages: {},
      getMiddleware: () => guard(["/private/:path*"]),
      publicDir: root,
    });
    // On a case-insensitive file system (macOS, Windows) these open the same file; on a
    // case-sensitive one they name nothing. Either way: never the guarded content.
    for (
      const spelling of [
        "/PRIVATE/report.txt",
        "/Private/report.txt",
        "/private/REPORT.TXT",
        "/private/Report.txt",
        "/link.txt",
        "/LINK.TXT",
      ]
    ) {
      const res = await probe(app, spelling);
      assert(!res.leaked, `${spelling} reached the guarded file`);
      assert(res.status === 404 || res.status === 401, `${spelling}: ${res.status}`);
      assertEquals(await serveStatic(root, spelling), null, spelling);
      assertEquals(await serveStatic(root, spelling, "gzip"), null, spelling);
    }
    assertEquals(await (await serveStatic(root, "/Link.txt"))!.text(), SECRET);
    // Unicode normalization is not a different spelling: NFC and NFD both name the file.
    assertEquals(await (await serveStatic(root, "/caf%C3%A9.txt"))!.text(), "accent");
    const nfd = await serveStatic(root, "/cafe%CC%81.txt");
    if (nfd) assertEquals(await nfd.text(), "accent"); // a normalization-insensitive FS only
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// CVE-2025-57822 (GHSA-4342-x723-ch2f): request headers reflected into NextResponse.next().
// The intent headers are the middleware RESPONSE's protocol; a client must not supply them.
// ---------------------------------------------------------------------------

Deno.test("CVE-2025-57822: a client-sent x-middleware-rewrite reflected by NextResponse.next({ headers }) is not obeyed", async () => {
  const seen: (string | null)[] = [];
  const reflecting = createMiddlewareRunner({
    middleware: (req: Request) => {
      seen.push(req.headers.get("x-middleware-rewrite"));
      if (new URL(req.url).pathname.startsWith("/admin")) {
        return new Response("blocked", { status: 401 });
      }
      // The misuse the advisory describes: the REQUEST's headers handed to the response.
      return NextResponse.next({ headers: req.headers });
    },
  });
  const app = appWith({
    pages: { "/admin": secretPage, "/": homePage },
    getMiddleware: () => reflecting,
  });
  assertEquals((await probe(app, "/admin")).status, 401);

  // An internal rewrite past the middleware's own check.
  const internal = await probe(app, "/", { "x-middleware-rewrite": "/admin" });
  assert(!internal.leaked, "the client's header rewrote the request to the guarded page");
  assertEquals(internal.status, 200);

  // A proxied fetch of a URL the client chose (an external rewrite is fetched by the server).
  const external = await probe(app, "/", { "x-middleware-rewrite": "https://example.com/x" });
  assertEquals(external.status, 200, "the client's header made the server proxy another origin");

  // Request-header overrides are part of the same protocol.
  const res = await app(
    new Request("http://localhost/", {
      headers: {
        "x-middleware-override-headers": "cookie",
        "x-middleware-request-cookie": "session=admin",
        "x-middleware-next": "1",
      },
    }),
  );
  await res.text();
  assertEquals(res.status, 200);
  for (const [name] of res.headers) {
    assert(!name.startsWith("x-middleware-"), `${name} reached the client`);
  }
  assertEquals(seen.filter((v) => v !== null), [], "middleware saw a client's intent header");
});

Deno.test("CVE-2025-57822: a middleware's own rewrite and request-header overrides still apply", async () => {
  const mw = createMiddlewareRunner({
    middleware: (req: Request) => {
      const headers = new Headers(req.headers);
      headers.set("x-from-middleware", "yes");
      return new URL(req.url).pathname === "/old"
        ? NextResponse.rewrite(new URL("/", req.url), { request: { headers } })
        : NextResponse.next({ request: { headers } });
    },
  });
  const app = appWith({
    pages: { "/": homePage },
    getMiddleware: () => mw,
  });
  const res = await app(
    new Request("http://localhost/old", { headers: { "x-middleware-x": "1" } }),
  );
  assertEquals(res.status, 200);
  assert((await res.text()).includes("home"));
});

// ---------------------------------------------------------------------------
// i18n (CVE-2026-64642 / CVE-2026-44573 class): a locale prefix must not hide a path from a
// guard written inside the middleware, as it does not from a matcher.
// ---------------------------------------------------------------------------

Deno.test("i18n: NextRequest.nextUrl.pathname is the path without its locale prefix in middleware", async () => {
  const seen: string[] = [];
  const mw = createMiddlewareRunner({
    middleware: (req: Request) => {
      const { nextUrl } = req as NextRequest;
      seen.push(`${nextUrl.locale}:${nextUrl.pathname}`);
      if (nextUrl.pathname.startsWith("/admin")) return new Response("blocked", { status: 401 });
      return NextResponse.next();
    },
  });
  const app = appWith({
    pages: { "/admin": secretPage, "/": homePage },
    getMiddleware: () => mw,
    i18n: { locales: ["en", "fr"], defaultLocale: "en" },
  });
  for (const path of ["/admin", "/fr/admin", "/en/admin"]) {
    const res = await probe(app, path);
    assert(!res.leaked, `${path} passed the middleware's own path check`);
    assertEquals(res.status, 401, path);
  }
  assertEquals(seen, ["en:/admin", "fr:/admin", "en:/admin"]);
  assertEquals((await probe(app, "/fr")).status, 200);
  assertEquals(seen.at(-1), "fr:/");
});

Deno.test("i18n: NextURL keeps its locale prefix in href and across pathname writes", () => {
  const routing = { basePath: "", locale: "fr", locales: ["en", "fr"] };
  const url = NextURL.forRouting("http://localhost/fr/admin/users?x=1", routing);
  assertEquals(url.pathname, "/admin/users");
  assertEquals(url.locale, "fr");
  assertEquals(url.href, "http://localhost/fr/admin/users?x=1");
  assertEquals(String(url), "http://localhost/fr/admin/users?x=1");

  // The redirect idiom: clone, set a path, redirect — the visitor stays in their locale.
  const login = url.clone();
  login.pathname = "/login";
  assertEquals(login.pathname, "/login");
  assertEquals(login.href, "http://localhost/fr/login?x=1");
  assertEquals(NextResponse.redirect(login).headers.get("location"), login.href);
  login.pathname = "/";
  assertEquals(login.href, "http://localhost/fr?x=1");
  // A path that names a locale itself switches to it.
  login.pathname = "/en/login";
  assertEquals([login.locale, login.pathname, login.href], [
    "en",
    "/login",
    "http://localhost/en/login?x=1",
  ]);
  // The original is untouched by its clone.
  assertEquals(url.href, "http://localhost/fr/admin/users?x=1");

  // No prefix: the request's resolved (default) locale, the path as it is.
  const bare = NextURL.forRouting("http://localhost/admin", { ...routing, locale: "en" });
  assertEquals([bare.locale, bare.pathname], ["en", "/admin"]);
  bare.pathname = "/fr/x";
  assertEquals([bare.locale, bare.pathname, bare.href], ["fr", "/x", "http://localhost/fr/x"]);

  // Without i18n nothing is peeled (a first segment that looks like a locale is a path).
  const plain = NextURL.forRouting("http://localhost/fr/admin", { basePath: "" });
  assertEquals([plain.locale, plain.pathname], ["", "/fr/admin"]);
  assertEquals(new NextURL("http://localhost/fr/admin").pathname, "/fr/admin");
});

// ---------------------------------------------------------------------------
// The image endpoint is answered in front of the app (and so of middleware.ts): a local source
// is read only when the app itself would serve that file to this visitor.
// ---------------------------------------------------------------------------

/** A valid `w`×`h` PNG. */
async function png(w: number, h: number): Promise<Uint8Array> {
  const { PhotonImage } = await import("@denext/photon");
  const img = new PhotonImage(new Uint8Array(w * h * 4).fill(200), w, h);
  try {
    return img.get_bytes();
  } finally {
    img.free();
  }
}

Deno.test("image endpoint: a local source behind middleware is not readable through /_denext/image", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "private"));
    await Deno.writeFile(join(root, "private", "scan.png"), await png(80, 80));
    await Deno.writeFile(join(root, "logo.png"), await png(80, 80));
    const mw = createMiddlewareRunner({
      middleware: (req: Request) =>
        req.headers.get("cookie") === "session=valid"
          ? undefined
          : new Response("blocked", { status: 401 }),
      config: { matcher: ["/private/:path*"] },
    });
    const app = appWith({ pages: {}, getMiddleware: () => mw, publicDir: root });
    const opts = { publicDir: root, authorizeLocal: localImageGate(app) };
    const image = (src: string, headers?: HeadersInit) =>
      optimizeImage(
        new Request(`http://localhost/_denext/image?url=${encodeURIComponent(src)}&w=64`, {
          headers,
        }),
        opts,
      );

    // Signed in: served, for this visitor alone.
    const own = await image("/private/scan.png", { cookie: "session=valid" });
    await own.body?.cancel();
    assertEquals(own.status, 200);
    assertEquals(own.headers.get("cache-control"), "private, no-cache");

    // Anonymous: refused — also now that the encoded image sits in the optimizer's cache.
    for (
      const src of [
        "/private/scan.png",
        "/private/scan.png?v=1",
        "/%70rivate/scan.png",
        "/private%2Fscan.png",
        "/PRIVATE/scan.png",
        "//localhost/private/scan.png",
      ]
    ) {
      const res = await image(src);
      await res.body?.cancel();
      assertEquals(res.status, 404, src);
    }
    const forged = await image("/private/scan.png", { cookie: "session=guess" });
    await forged.body?.cancel();
    assertEquals(forged.status, 404);

    // A public image stays publicly cacheable, with or without a cookie.
    for (const headers of [undefined, { cookie: "session=valid" }]) {
      const res = await image("/logo.png", headers);
      await res.body?.cancel();
      assertEquals(res.status, 200);
      assert(res.headers.get("cache-control")!.startsWith("public, max-age="));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("image endpoint: the gate probes as an anonymous visitor first, then as the visitor", async () => {
  const probes: Request[] = [];
  const gate = localImageGate((req) => {
    probes.push(req);
    return Promise.resolve(new Response("x", { status: req.headers.has("cookie") ? 200 : 302 }));
  });
  const request = new Request("http://app.example/_denext/image?url=x&w=64", {
    headers: {
      cookie: "s=1",
      authorization: "Bearer t",
      "x-api-key": "k",
      "x-forwarded-for": "203.0.113.9",
      "if-none-match": '"abc"',
      range: "bytes=0-1",
      "accept-encoding": "gzip",
    },
  });
  assertEquals(await gate("/a/b.png?v=2", request), "private");
  assertEquals(probes.map((p) => `${p.method} ${p.url}`), [
    "GET http://app.example/a/b.png?v=2",
    "GET http://app.example/a/b.png?v=2",
  ]);
  const [anonymous, own] = probes.map((p) => Object.fromEntries(p.headers));
  assertEquals(anonymous, { "x-forwarded-for": "203.0.113.9" });
  assertEquals(own, {
    authorization: "Bearer t",
    cookie: "s=1",
    "x-api-key": "k",
    "x-forwarded-for": "203.0.113.9",
  });
  // The probe stays on the app's own origin whatever the source spells.
  probes.length = 0;
  assertEquals(await gate("//evil.example/x.png", new Request("http://app.example/i")), false);
  for (const p of probes) assertEquals(new URL(p.url).origin, "http://app.example");
});

// ---------------------------------------------------------------------------
// Pages Router (CVE-2024-46982 / CVE-2025-49005 / CVE-2023-46298 class): a getServerSideProps
// answer is private, and the document / data / prefetch answers of one URL are told apart.
// ---------------------------------------------------------------------------

const EMPTY_SPECIALS = {
  app: null,
  document: null,
  error: null,
  notFound: null,
  serverError: null,
};

function pagesHandler(modules: Record<string, unknown>) {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: Object.keys(modules).map((file) => ({
      routePath: "/" + file,
      filePath: file,
      isApi: false,
      pattern: parsePattern(file),
    })),
    api: [],
  };
  return createPagesHandler({ getScan: () => scan, load: (f) => Promise.resolve(modules[f]) });
}

Deno.test("pages router: a getServerSideProps answer is private and varies on the data headers", async () => {
  const handle = pagesHandler({
    account: {
      getServerSideProps: () => Promise.resolve({ props: { email: "a@example.com" } }),
      default: (p: { email: string }) => h("p", null, p.email),
    },
    gone: { getServerSideProps: () => Promise.resolve({ notFound: true }), default: () => null },
    moved: {
      getServerSideProps: () => Promise.resolve({ redirect: { destination: "/account" } }),
      default: () => null,
    },
    own: {
      getServerSideProps: (ctx: { res: { setHeader(n: string, v: string): void } }) => {
        ctx.res.setHeader("Cache-Control", "private, max-age=30");
        return Promise.resolve({ props: {} });
      },
      default: () => h("p", null, "own"),
    },
    legacy: {
      default: Object.assign(() => h("p", null, "gip"), {
        getInitialProps: () => Promise.resolve({}),
      }),
    },
    plain: { default: () => h("p", null, "static") },
  });
  const PRIVATE = "private, no-cache, no-store, max-age=0, must-revalidate";
  const VARY = "x-denext-pages-data, x-denext-pages-prefetch";
  const get = async (path: string, headers?: HeadersInit) => {
    const res = (await handle(new Request("http://localhost" + path, { headers })))!;
    await res.body?.cancel();
    return res;
  };
  for (const path of ["/account", "/gone", "/moved", "/legacy"]) {
    for (const headers of [undefined, { "x-denext-pages-data": "1" }]) {
      const res = await get(path, headers);
      assertEquals(res.headers.get("cache-control"), PRIVATE, `${path} ${headers ? "data" : ""}`);
      assertEquals(res.headers.get("vary"), VARY, path);
    }
  }
  assertEquals((await get("/own")).headers.get("cache-control"), "private, max-age=30");
  // A page with no per-request data keeps the cache policy it had (none), and still varies.
  const plain = await get("/plain");
  assertEquals(plain.headers.get("cache-control"), null);
  assertEquals(plain.headers.get("vary"), VARY);
  assertEquals((await get("/plain", { "x-denext-pages-prefetch": "1" })).headers.get("vary"), VARY);
  assertEquals((await get("/account", { method: "HEAD" } as never)).headers.get("vary"), VARY);
});

// ---------------------------------------------------------------------------
// Cache-key omission (CVE-2026-103004 / CVE-2026-119790 class): an `unstable_cache` entry is
// keyed by its loader too, so two loaders never answer each other's calls.
// ---------------------------------------------------------------------------

Deno.test("unstable_cache: two loaders with the same keyParts and arguments never share an entry", async () => {
  setCacheStore(inMemoryCacheStore());
  try {
    const privateSettings = unstable_cache((id: string) =>
      Promise.resolve({ kind: "settings", id, apiKey: SECRET })
    );
    const publicProfile = unstable_cache((id: string) => Promise.resolve({ kind: "profile", id }));
    assertEquals((await privateSettings("42")).kind, "settings");
    const profile = await publicProfile("42");
    assert(
      !JSON.stringify(profile).includes(SECRET),
      "one loader was answered with another's entry",
    );
    assertEquals(profile, { kind: "profile", id: "42" });

    // The same with explicit, equal keyParts, and with no arguments at all.
    const a = unstable_cache(() => Promise.resolve("A"), ["shared"]);
    const b = unstable_cache(() => Promise.resolve("B"), ["shared"]);
    assertEquals([await a(), await b()], ["A", "B"]);

    // One loader still hits its own entry (wrapped once or again from the same source).
    let runs = 0;
    const load = (id: string) => Promise.resolve(`${id}:${++runs}`);
    assertEquals(await unstable_cache(load, ["k"])("x"), "x:1");
    assertEquals(await unstable_cache(load, ["k"])("x"), "x:1");
    assertEquals(await unstable_cache(load, ["k"])("y"), "y:2");
    assertEquals(await unstable_cache(load, ["other"])("x"), "x:3");
  } finally {
    setCacheStore(inMemoryCacheStore());
  }
});

// ---------------------------------------------------------------------------
// CVE-2025-30218 class: an internal marker must not travel to another origin.
// ---------------------------------------------------------------------------

Deno.test("CVE-2025-30218: an external rewrite forwards no internal marker (the regeneration token)", () => {
  const sent = externalRewriteHeaders(
    new Headers({
      [REGEN_HEADER]: REGEN_TOKEN,
      "x-denext-batch-item": "1",
      host: "app.example",
      "accept-language": "fr",
      "x-custom": "kept",
    }),
  );
  assertEquals(Object.fromEntries(sent), { "accept-language": "fr", "x-custom": "kept" });
});

// ---------------------------------------------------------------------------
// CVE-2026-27978: `Origin: null` (a sandboxed iframe, a data: page) is not the app's origin.
// ---------------------------------------------------------------------------

Deno.test("CVE-2026-27978: a null or opaque Origin never passes the Server Action / batch CSRF gate", () => {
  const post = (headers: Record<string, string>) =>
    new Request("http://app.example/_denext/action/x", {
      method: "POST",
      headers: { host: "app.example", ...headers },
    });
  for (
    const origin of ["null", "about:blank", "data:text/html,x", "file://", "blob:null/1", ""]
  ) {
    assertEquals(verifyOrigin(post({ origin }), {}), false, JSON.stringify(origin));
    assertEquals(
      verifyOrigin(post({ origin }), { allowedOrigins: ["null", "app.example"] }),
      false,
      `allow-listed: ${JSON.stringify(origin)}`,
    );
  }
  assertEquals(verifyOrigin(post({}), {}), false, "no Origin and no Referer");
  assertEquals(verifyOrigin(post({ origin: "http://app.example" }), {}), true);
});
