import {
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import {
  createMiddlewareRunner,
  matcherToRegExp,
  next,
  redirect,
  rewrite,
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
      },
      {
        kind: "page",
        pattern: parsePattern("home"),
        routePath: "/home",
        filePath: "home.tsx",
        layoutChain: [],
      },
    ],
    api: [],
    rootLayout: null,
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
