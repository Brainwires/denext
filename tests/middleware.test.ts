import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import {
  composeMiddleware,
  createMiddlewareRunner,
  matcherToRegExp,
  matches,
  MIDDLEWARE_NEXT_HEADER,
  MIDDLEWARE_OVERRIDE_HEADER,
  MIDDLEWARE_REQUEST_PREFIX,
  MIDDLEWARE_REWRITE_HEADER,
  next,
  redirect,
  rewrite,
  setRequestAdapter,
} from "../src/server/middleware.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageProps } from "../src/server/types.ts";

function pageManifest(): RouteManifest {
  return {
    pages: [
      {
        kind: "page",
        pattern: parsePattern("secret"),
        routePath: "/secret",
        filePath: "secret.tsx",
        layoutChain: [],
        loading: null,
        error: null,
        notFound: null,
        forbidden: null,
        unauthorized: null,
        templateChain: [],
      },
      {
        kind: "page",
        pattern: parsePattern("home"),
        routePath: "/home",
        filePath: "home.tsx",
        layoutChain: [],
        loading: null,
        error: null,
        notFound: null,
        forbidden: null,
        unauthorized: null,
        templateChain: [],
      },
    ],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

const modules: Record<string, unknown> = {
  "secret.tsx": { default: (_p: PageProps) => h("h1", null, "secret") },
  "home.tsx": { default: (_p: PageProps) => h("h1", null, "home") },
};

function appWith(mw: unknown) {
  return createApp({
    getManifest: pageManifest,
    load: (fp) => Promise.resolve(modules[fp]),
    getMiddleware: () => createMiddlewareRunner(mw as never),
  });
}

Deno.test("matcherToRegExp compiles patterns", () => {
  assertEquals(matcherToRegExp("/about").test("/about"), true);
  assertEquals(matcherToRegExp("/about").test("/about/x"), false);
  assertEquals(matcherToRegExp("/blog/:slug").test("/blog/hi"), true);
  assertEquals(matcherToRegExp("/blog/:slug").test("/blog/a/b"), false);
  assertEquals(matcherToRegExp("/api/:path*").test("/api/a/b/c"), true);
  // path-to-regexp modifiers (Next.js semantics): `*` and `?` make the segment AND its
  // leading slash optional, `+` needs at least one segment.
  assertEquals(matcherToRegExp("/api/:path*").test("/api"), true);
  // A trailing slash is always optional (path-to-regexp non-strict, what Next does): the
  // router serves `/api/` as the `/api` page, so a guard must cover both spellings.
  assertEquals(matcherToRegExp("/api/:path*").test("/api/"), true);
  assertEquals(matcherToRegExp("/about").test("/about/"), true);
  assertEquals(matcherToRegExp("/:path*").test("/"), true);
  assertEquals(matcherToRegExp("/api/:path*").test("/apix"), false);
  assertEquals(matcherToRegExp("/api/:path+").test("/api"), false);
  assertEquals(matcherToRegExp("/api/:path+").test("/api/a"), true);
  assertEquals(matcherToRegExp("/api/:path+").test("/api/a/b"), true);
  assertEquals(matcherToRegExp("/docs/:page?").test("/docs"), true);
  assertEquals(matcherToRegExp("/docs/:page?").test("/docs/intro"), true);
  assertEquals(matcherToRegExp("/docs/:page?").test("/docs/a/b"), false);
});

Deno.test("matcherToRegExp: regex groups, custom param patterns, object entries", () => {
  // Next's canonical "everything except" matcher from its middleware docs.
  const except = matcherToRegExp("/((?!api|_next/static|_next/image|favicon.ico).*)");
  for (const p of ["/", "/about", "/blog/x"]) assertEquals(except.test(p), true, p);
  for (const p of ["/api", "/api/x", "/_next/static/a.js", "/favicon.ico"]) {
    assertEquals(except.test(p), false, p);
  }
  assertEquals(matcherToRegExp("/blog/:id(\\d+)").test("/blog/12"), true);
  assertEquals(matcherToRegExp("/blog/:id(\\d+)").test("/blog/abc"), false);
  assertEquals(matcherToRegExp("/:lang(en|de)/:path*").test("/de/a/b"), true);
  assertEquals(matcherToRegExp("/:lang(en|de)/:path*").test("/fr"), false);
  assertEquals(matcherToRegExp("/(.*)").test("/anything/here"), true);
  // Object entries (`{ source, has, missing }`): `source` is honored; has/missing are
  // accepted but not evaluated (the middleware runs for every matching path).
  assertEquals(matches({ matcher: [{ source: "/admin/:path*", has: [] }] }, "/admin/x"), true);
  assertEquals(matches({ matcher: { source: "/admin/:path*" } }, "/other"), false);
  assertThrows(() => matcherToRegExp("/((?!api.*)"), Error, "unbalanced");
});

Deno.test("trailing-slash path is canonicalized (308) so middleware can't be bypassed", async () => {
  // `/secret/` resolves to the `/secret` page (empty segments are dropped) — a guard on
  // `/secret` must not be skippable by appending a slash (CVE-2024-51479 class). With
  // `trailingSlash` unset the pipeline 308s to the canonical form, and the matcher itself
  // treats the slash as optional, so both layers hold.
  const app = appWith({
    default: (req: Request) =>
      new URL(req.url).pathname === "/secret" ? new Response("blocked", { status: 401 }) : next(),
    config: { matcher: "/secret" },
  });
  assertEquals((await app(new Request("http://localhost/secret"))).status, 401);
  const slashed = await app(new Request("http://localhost/secret/"));
  assertEquals(slashed.status, 308);
  assertEquals(new URL(slashed.headers.get("location")!, "http://localhost").pathname, "/secret");
});

Deno.test("duplicate-slash path is canonicalized (308) so middleware can't be bypassed", async () => {
  // The router drops empty segments, so `//secret` resolves to the `/secret` page —
  // but a matcher anchored on `/secret` tested against the raw pathname would NOT run,
  // letting `//secret` reach the page unguarded. The pipeline now 308-redirects the
  // non-canonical form so matcher + router evaluate the same path.
  const app = appWith({
    default: (req: Request) =>
      new URL(req.url).pathname === "/secret" ? new Response("blocked", { status: 401 }) : next(),
  });
  // Guard holds on the canonical path.
  assertEquals((await app(new Request("http://localhost/secret"))).status, 401);
  // `//secret` must not slip past it: it redirects to the canonical form (query kept).
  const res = await app(new Request("http://localhost//secret?x=1"));
  assertEquals(res.status, 308);
  assertEquals(res.headers.get("location"), "/secret?x=1");
});

Deno.test("middleware can short-circuit with a Response", async () => {
  const app = appWith({
    default: () => new Response("blocked", { status: 401 }),
  });
  const res = await app(new Request("http://localhost/secret"));
  assertEquals(res.status, 401);
  assertEquals(await res.text(), "blocked");
});

Deno.test("middleware redirect returns a 307 with Location", async () => {
  const app = appWith({
    default: (req: Request) => {
      if (new URL(req.url).pathname === "/secret") {
        return redirect("/home");
      }
      return next();
    },
  });
  const res = await app(new Request("http://localhost/secret"));
  await res.body?.cancel();
  assertEquals(res.status, 307);
  assertEquals(res.headers.get("location"), "/home");
});

Deno.test("middleware redirect normalizes a protocol-relative open-redirect", async () => {
  const app = appWith({
    default: (req: Request) => {
      // Simulate an attacker-controlled ?next= reaching redirect() verbatim.
      const next = new URL(req.url).searchParams.get("next") ?? "/";
      return redirect(next);
    },
  });
  // `//evil.com` (browser-cross-origin) is collapsed to a same-origin path.
  let res = await app(new Request("http://localhost/go?next=//evil.com"));
  await res.body?.cancel();
  assertEquals(res.headers.get("location"), "/evil.com");
  // A backslash escape too.
  res = await app(new Request("http://localhost/go?next=/\\evil.com"));
  await res.body?.cancel();
  assertEquals(res.headers.get("location"), "/evil.com");
  // An explicit absolute URL is preserved (intentional external redirect).
  res = await app(new Request("http://localhost/go?next=https://ok.example/x"));
  await res.body?.cancel();
  assertEquals(res.headers.get("location"), "https://ok.example/x");
});

Deno.test("middleware rewrite routes to a different page", async () => {
  const app = appWith({
    default: () => rewrite("/home"),
  });
  const res = await app(new Request("http://localhost/secret"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "<h1>home</h1>");
});

Deno.test("next() injects response headers", async () => {
  const app = appWith({
    default: () => next({ headers: { "x-mw": "1" } }),
  });
  const res = await app(new Request("http://localhost/home"));
  assertEquals(res.headers.get("x-mw"), "1");
  assertStringIncludes(await res.text(), "<h1>home</h1>");
});

Deno.test("array export runs entries in order", async () => {
  const order: string[] = [];
  const app = appWith({
    default: [
      () => {
        order.push("a");
        return next();
      },
      () => {
        order.push("b");
        return next();
      },
    ],
  });
  const res = await app(new Request("http://localhost/home"));
  assertEquals(res.status, 200);
  assertEquals(order, ["a", "b"]);
});

Deno.test("a Response short-circuits the chain", async () => {
  let reached = false;
  const app = appWith({
    default: [
      () => new Response("stop", { status: 418 }),
      () => {
        reached = true;
        return next();
      },
    ],
  });
  const res = await app(new Request("http://localhost/home"));
  await res.body?.cancel();
  assertEquals(res.status, 418);
  assertEquals(reached, false);
});

Deno.test("rewrite threads its URL into later entries", async () => {
  const seen: string[] = [];
  const app = appWith({
    default: [
      () => rewrite("/home"),
      (req: Request) => {
        seen.push(new URL(req.url).pathname);
        return next();
      },
    ],
  });
  const res = await app(new Request("http://localhost/secret"));
  assertStringIncludes(await res.text(), "<h1>home</h1>");
  // The second entry sees the rewritten path, not /secret.
  assertEquals(seen, ["/home"]);
});

Deno.test("next({headers}) accumulates across the chain", async () => {
  const app = appWith({
    default: [
      () => next({ headers: { "x-a": "1" } }),
      () => next({ headers: { "x-b": "2" } }),
    ],
  });
  const res = await app(new Request("http://localhost/home"));
  assertEquals(res.headers.get("x-a"), "1");
  assertEquals(res.headers.get("x-b"), "2");
});

Deno.test("per-entry matcher gates individual entries", async () => {
  const app = appWith({
    default: [
      { handler: () => new Response("blocked", { status: 403 }), config: { matcher: "/secret" } },
    ],
  });
  // /home is not matched by the entry -> page renders.
  const home = await app(new Request("http://localhost/home"));
  assertEquals(home.status, 200);
  // /secret is matched -> entry blocks.
  const secret = await app(new Request("http://localhost/secret"));
  await secret.body?.cancel();
  assertEquals(secret.status, 403);
});

Deno.test("composeMiddleware returns null for an empty chain", () => {
  assertEquals(composeMiddleware([]), null);
});

// ---- NextResponse wire-protocol (header-encoded intents) ------------------
//
// The compat layer's NextResponse.next()/.rewrite() are real Response objects that
// carry the intent as headers; the runner must decode those rather than treat the
// Response as a short-circuit.

Deno.test("a Response carrying x-middleware-rewrite is honored as a rewrite", async () => {
  const run = composeMiddleware([{
    handler: () =>
      new Response(null, {
        headers: { [MIDDLEWARE_REWRITE_HEADER]: "/home", "x-custom": "1" },
      }),
  }])!;
  const outcome = await run(new Request("http://localhost/secret"));
  assertEquals(outcome.type, "rewrite");
  if (outcome.type !== "rewrite") throw new Error("unreachable");
  assertEquals(outcome.url, "http://localhost/home");
  assertEquals(outcome.headers?.get("x-custom"), "1", "non-intent headers pass through");
  assertEquals(
    outcome.headers?.get(MIDDLEWARE_REWRITE_HEADER),
    null,
    "the intent marker must not leak to the client",
  );
});

Deno.test("a Response carrying x-middleware-next continues routing (not a short-circuit)", async () => {
  const run = composeMiddleware([{
    handler: () =>
      new Response("should-not-be-sent", {
        status: 418,
        headers: { [MIDDLEWARE_NEXT_HEADER]: "1", "x-h": "v" },
      }),
  }])!;
  const outcome = await run(new Request("http://localhost/home"));
  assertEquals(outcome.type, "next", "the next marker means continue, not respond with 418");
  if (outcome.type !== "next") throw new Error("unreachable");
  assertEquals(outcome.headers?.get("x-h"), "v");
});

Deno.test("next({request:{headers}}) overrides are applied to the forwarded request", async () => {
  let seen: string | null = "unset";
  const run = composeMiddleware([
    {
      handler: () =>
        new Response(null, {
          headers: {
            [MIDDLEWARE_NEXT_HEADER]: "1",
            [MIDDLEWARE_OVERRIDE_HEADER]: "x-user",
            [`${MIDDLEWARE_REQUEST_PREFIX}x-user`]: "alice",
          },
        }),
    },
    {
      handler: (req) => {
        seen = req.headers.get("x-user"); // later entry sees the override
        return next();
      },
    },
  ])!;
  const outcome = await run(new Request("http://localhost/home"));
  assertEquals(seen, "alice", "the overridden request header reaches the next entry");
  if (outcome.type === "next") {
    assertEquals(outcome.requestHeaders?.get("x-user"), "alice", "outcome carries request headers");
  }
});

Deno.test("multiple Set-Cookie headers from next() survive as separate entries", async () => {
  const headers = new Headers();
  headers.append("set-cookie", "a=1");
  headers.append("set-cookie", "b=2");
  headers.set(MIDDLEWARE_NEXT_HEADER, "1");
  const run = composeMiddleware([{ handler: () => new Response(null, { headers }) }])!;
  const outcome = await run(new Request("http://localhost/home"));
  if (outcome.type !== "next") throw new Error("expected next");
  assertEquals(
    outcome.headers?.getSetCookie().sort(),
    ["a=1", "b=2"],
    "both cookies survive (a plain set() would collapse them)",
  );
});

Deno.test("matcherToRegExp escapes regex metacharacters in literal patterns", () => {
  const re = matcherToRegExp("/a.b");
  assertEquals(re.test("/a.b"), true, "the literal dot matches a literal dot");
  assertEquals(re.test("/aXb"), false, "the dot is escaped, not a wildcard");
  // Parentheses open a regex group (path-to-regexp); escape them for a literal paren.
  assertEquals(matcherToRegExp("/x(y)").test("/xy"), true);
  assertEquals(matcherToRegExp("/x\\(y\\)").test("/x(y)"), true);
  assertEquals(matcherToRegExp("/x\\(y\\)").test("/xy"), false);
  assertEquals(matcherToRegExp("/a+b").test("/a+b"), true);
  assertEquals(matcherToRegExp("/a+b").test("/aaab"), false);
});

Deno.test("setRequestAdapter wraps the request, and resetting restores identity", async () => {
  try {
    setRequestAdapter((r) => new Request(r, { headers: { "x-adapted": "yes" } }));
    let adapted: string | null = null;
    const run = composeMiddleware([{
      handler: (req) => {
        adapted = req.headers.get("x-adapted");
        return next();
      },
    }])!;
    await run(new Request("http://localhost/home"));
    assertEquals(adapted, "yes", "the installed adapter wraps the request");
  } finally {
    setRequestAdapter((r) => r); // reset to identity so other tests are unaffected
  }
  let afterReset: string | null = "unset";
  const run2 = composeMiddleware([{
    handler: (req) => {
      afterReset = req.headers.get("x-adapted");
      return next();
    },
  }])!;
  await run2(new Request("http://localhost/home"));
  assertEquals(afterReset, null, "after reset the request is passed through unmodified");
});

Deno.test("a relative rewrite destination resolves against the current URL", async () => {
  const run = composeMiddleware([{ handler: () => rewrite("sibling") }])!;
  const outcome = await run(new Request("http://localhost/a/b"));
  assertEquals(outcome.type, "rewrite");
  if (outcome.type !== "rewrite") throw new Error("unreachable");
  assertEquals(outcome.url, "http://localhost/a/sibling", "resolved relative to /a/b");
});

Deno.test("config.matcher limits which paths run middleware", async () => {
  let ran = 0;
  const app = appWith({
    default: () => {
      ran++;
      return new Response("mw", { status: 403 });
    },
    config: { matcher: "/secret" },
  });
  // /home is not matched -> middleware skipped, page renders.
  const home = await app(new Request("http://localhost/home"));
  assertEquals(home.status, 200);
  // /secret is matched -> middleware blocks.
  const secret = await app(new Request("http://localhost/secret"));
  await secret.body?.cancel();
  assertEquals(secret.status, 403);
  assertEquals(ran, 1);
});
