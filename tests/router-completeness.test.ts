import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { createApp } from "../src/server/app.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { matchPage } from "../src/router/match.ts";
import { parsePattern } from "../src/router/segments.ts";
import { ErrorBoundary, forbidden, unauthorized } from "../src/runtime/error-boundary.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { VNode } from "../src/jsx/types.ts";
import type { PageProps } from "../src/server/types.ts";

function onePage(over: Partial<RouteManifest["pages"][number]>): RouteManifest {
  return {
    pages: [{
      kind: "page",
      pattern: parsePattern(""),
      routePath: "/",
      filePath: "page.tsx",
      layoutChain: [],
      templateChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      ...over,
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

Deno.test("forbidden() renders forbidden.tsx with a 403", async () => {
  const manifest = onePage({ forbidden: "forbidden.tsx" });
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) =>
      Promise.resolve(
        fp === "forbidden.tsx"
          ? { default: () => h("h1", null, "No entry") }
          : { default: () => forbidden() },
      ),
  });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 403);
  assertStringIncludes(await res.text(), "<h1>No entry</h1>");
});

Deno.test("unauthorized() renders a default 401 when no unauthorized.tsx", async () => {
  const manifest = onePage({});
  const app = createApp({
    getManifest: () => manifest,
    load: () => Promise.resolve({ default: () => unauthorized() }),
  });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 401);
  assertStringIncludes(await res.text(), "signed in");
});

Deno.test("error boundaries do not swallow forbidden()/unauthorized()", async () => {
  // A forbidden() thrown inside an ErrorBoundary must bubble, not render the fallback.
  let threw = false;
  try {
    await renderToString(
      h(ErrorBoundary, {
        fallback: () => h("p", null, "caught"),
        children: h(function Boom(): VNode {
          return forbidden();
        }, null),
      }),
    );
  } catch (e) {
    threw = e instanceof Error && e.message === "NEXT_FORBIDDEN";
  }
  assertEquals(threw, true);
});

Deno.test("template wraps the page (server)", async () => {
  const manifest = onePage({ templateChain: ["tpl.tsx"] });
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) =>
      Promise.resolve(
        fp === "tpl.tsx"
          ? {
            default: (p: { children: never }) => h("main", null, p.children),
          }
          : { default: (_p: PageProps) => h("h1", null, "Page") },
      ),
  });
  const res = await app(new Request("http://localhost/"));
  assertStringIncludes(await res.text(), "<main><h1>Page</h1></main>");
});

Deno.test("global-error.tsx replaces the tree on an uncaught error (500)", async () => {
  const manifest: RouteManifest = {
    ...onePage({}),
    rootGlobalError: "global-error.tsx",
  };
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) =>
      Promise.resolve(
        fp === "global-error.tsx"
          ? {
            default: (p: { error: Error }) => h("h1", null, `Boom: ${p.error.message}`),
          }
          : {
            default: () => {
              throw new Error("kaput");
            },
          },
      ),
  });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 500);
  // global-error.tsx replaced the tree and rendered the error it was handed. In
  // production that error is REDACTED (SRV-M1): the raw "kaput" must NOT reach the
  // client — the component sees the generic "Internal Server Error" instead. (Dev
  // mode + the digest are covered by tests/global-error-redaction.test.ts.)
  const body = await res.text();
  assertStringIncludes(body, "<h1>Boom: Internal Server Error</h1>");
  assertEquals(body.includes("kaput"), false, "the raw error must not leak to the client");
});

Deno.test("useSelectedLayoutSegments returns [] at the root during SSR", async () => {
  const { useSelectedLayoutSegments } = await import(
    "../src/client/navigation.ts"
  );
  const html = await renderToString(
    h(function C(): VNode {
      return h("i", null, useSelectedLayoutSegments().join(","));
    }, null),
  );
  assertEquals(html, "<i></i>");
});

Deno.test("scanner captures template/forbidden/unauthorized/global-error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rc_" });
  try {
    const files = [
      "layout.tsx",
      "template.tsx",
      "global-error.tsx",
      "page.tsx",
      "admin/forbidden.tsx",
      "admin/unauthorized.tsx",
      "admin/page.tsx",
    ];
    for (const rel of files) {
      const full = join(dir, rel);
      await Deno.mkdir(join(full, ".."), { recursive: true });
      await Deno.writeTextFile(full, "export default function(){}\n");
    }
    const manifest = await scanRoutes(dir);
    assertExists(manifest.rootGlobalError);
    assertStringIncludes(manifest.rootGlobalError, "global-error.tsx");

    const admin = matchPage(manifest, "/admin");
    assertExists(admin);
    assertEquals(admin.route.templateChain.length, 1);
    assertStringIncludes(admin.route.forbidden ?? "", "forbidden.tsx");
    assertStringIncludes(admin.route.unauthorized ?? "", "unauthorized.tsx");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
