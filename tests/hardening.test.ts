import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import {
  createRequestContext,
  draftMode,
  type DraftTokenStore,
  runWithContext,
  setDraftTokenStore,
} from "../src/server/request-context.ts";
import { absoluteUrl, requestOrigin } from "../src/server/absolute-url.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageProps } from "../src/server/types.ts";

// ---- Absolute-URL helper ---------------------------------------------------

Deno.test("requestOrigin uses Host and ignores forwarded headers by default", () => {
  assertEquals(requestOrigin(new Request("http://localhost:8000/x")), "http://localhost:8000");

  // SECURITY: forwarded headers are attacker-controllable, so untrusted by default.
  const spoofed = new Request("http://localhost:8000/x", {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "evil.com" },
  });
  assertEquals(requestOrigin(spoofed), "http://localhost:8000");
});

Deno.test("requestOrigin trusts forwarded headers only when opted in", () => {
  const proxied = new Request("http://internal:3000/x", {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "example.com" },
  });
  assertEquals(
    requestOrigin(proxied, { trustForwardedHeaders: true }),
    "https://example.com",
  );

  // Only the first value of a comma-separated forwarded header is used.
  const chained = new Request("http://internal/x", {
    headers: { "x-forwarded-proto": "https, http", "x-forwarded-host": "a.com, b.com" },
  });
  assertEquals(requestOrigin(chained, { trustForwardedHeaders: true }), "https://a.com");
});

Deno.test("canonicalOrigin overrides request headers entirely", () => {
  const req = new Request("http://internal/x", {
    headers: { host: "evil.com", "x-forwarded-host": "also-evil.com" },
  });
  assertEquals(
    requestOrigin(req, { canonicalOrigin: "https://example.com", trustForwardedHeaders: true }),
    "https://example.com",
  );
  // A trailing slash on the canonical origin is trimmed.
  assertEquals(
    requestOrigin(req, { canonicalOrigin: "https://example.com/" }),
    "https://example.com",
  );
});

Deno.test("absoluteUrl resolves a path against the request origin", () => {
  const req = new Request("https://example.com/page");
  assertEquals(absoluteUrl(req, "/opengraph-image"), "https://example.com/opengraph-image");
  // An already-absolute URL is returned unchanged.
  assertEquals(absoluteUrl(req, "https://cdn.x/og.png"), "https://cdn.x/og.png");
});

Deno.test("requestOrigin prefers the Host header over the URL host by default", () => {
  // The connection URL host differs from the Host header; without forwarded trust,
  // the standard Host header wins (the URL host is only the last-resort fallback).
  const req = new Request("http://127.0.0.1:3000/x", { headers: { host: "example.com" } });
  assertEquals(requestOrigin(req), "http://example.com");
  // With no Host header, it falls back to the URL host.
  assertEquals(
    requestOrigin(new Request("http://fallback.host:8080/x")),
    "http://fallback.host:8080",
  );
});

Deno.test("absoluteUrl honors a pinned canonicalOrigin for the base", () => {
  const req = new Request("http://internal:3000/page", { headers: { host: "internal:3000" } });
  assertEquals(
    absoluteUrl(req, "/sitemap.xml", { canonicalOrigin: "https://example.com" }),
    "https://example.com/sitemap.xml",
  );
});

// ---- Pluggable draft-token store -------------------------------------------

Deno.test("draftMode honors an injected token store (shared-store deployments)", () => {
  const backing = new Set<string>();
  const store: DraftTokenStore = {
    has: (t) => backing.has(t),
    add: (t) => void backing.add(t),
    delete: (t) => void backing.delete(t),
  };
  setDraftTokenStore(store);
  try {
    // enable() records into the injected store.
    const ctx = createRequestContext(new Request("http://x/"));
    runWithContext(ctx, () => draftMode().enable());
    const setCookie = ctx.outgoingHeaders.getSetCookie()[0];
    const token = /__denext_draft=([^;]+)/.exec(setCookie)![1];
    assert(backing.has(token));

    // A request with the minted token is enabled; a forged value is not.
    runWithContext(
      createRequestContext(
        new Request("http://x/", { headers: { cookie: `__denext_draft=${token}` } }),
      ),
      () => assertEquals(draftMode().isEnabled, true),
    );
    runWithContext(
      createRequestContext(
        new Request("http://x/", { headers: { cookie: "__denext_draft=forged" } }),
      ),
      () => assertEquals(draftMode().isEnabled, false),
    );
  } finally {
    // Restore a fresh default-equivalent in-memory store for other tests.
    const fresh = new Set<string>();
    setDraftTokenStore({
      has: (t) => fresh.has(t),
      add: (t) => void fresh.add(t),
      delete: (t) => void fresh.delete(t),
    });
  }
});

// ---- <html lang> + og:image via createApp ----------------------------------

function manifest(over: Partial<RouteManifest> = {}): RouteManifest {
  return {
    pages: [{
      kind: "page",
      pattern: parsePattern("x"),
      routePath: "/x",
      filePath: "page.tsx",
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
    ...over,
  };
}

Deno.test("<html lang> reflects the active locale", async () => {
  const modules: Record<string, unknown> = {
    "page.tsx": { default: (p: PageProps) => h("h1", null, String(p.params.locale)) },
  };
  const app = createApp({
    getManifest: () => manifest(),
    load: (fp) => Promise.resolve(modules[fp]),
    i18n: { locales: ["en", "fr"], defaultLocale: "en" },
  });

  const fr = await app(new Request("http://localhost/fr/x"));
  assertStringIncludes(await fr.text(), `<html lang="fr">`);

  const en = await app(new Request("http://localhost/x"));
  assertStringIncludes(await en.text(), `<html lang="en">`);
});

Deno.test("og:image auto-populates from a dynamic opengraph-image route", async () => {
  const modules: Record<string, unknown> = {
    "page.tsx": { default: () => h("h1", null, "hi") },
  };
  const app = createApp({
    getManifest: () => manifest({ openGraphImage: "opengraph-image.tsx" }),
    load: (fp) => Promise.resolve(modules[fp]),
  });
  const res = await app(new Request("http://localhost/x"));
  assertStringIncludes(
    await res.text(),
    `<meta property="og:image" content="http://localhost/opengraph-image">`,
  );
});

Deno.test("a page's own og:image is not overridden", async () => {
  const modules: Record<string, unknown> = {
    "page.tsx": {
      default: () => h("h1", null, "hi"),
      metadata: { openGraph: { images: "https://cdn.x/custom.png" } },
    },
  };
  const app = createApp({
    getManifest: () => manifest({ openGraphImage: "opengraph-image.tsx" }),
    load: (fp) => Promise.resolve(modules[fp]),
  });
  const html = await (await app(new Request("http://localhost/x"))).text();
  assertStringIncludes(html, `<meta property="og:image" content="https://cdn.x/custom.png">`);
  assert(!html.includes("/opengraph-image"));
});
