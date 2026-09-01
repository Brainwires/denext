// Coverage for the server route renderer (`src/server/render-page.ts`), driven two
// ways, both browser-free:
//   1. End-to-end through the no-JS test client against `examples/hello` — this
//      exercises `renderPage` + the layout chain + not-found/api paths as the real
//      request pipeline composes them.
//   2. Unit tests of the pure/entry helpers: `mergeMetadata`, `mergeViewport`,
//      `renderRootNotFound`, and `renderGlobalError`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { createTestApp, createTestClient } from "denext/testing";
import {
  mergeMetadata,
  mergeViewport,
  renderGlobalError,
  renderRootNotFound,
} from "../src/server/render-page.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { Metadata, ModuleLoader } from "../src/server/types.ts";

const HELLO = new URL("../examples/hello", import.meta.url).pathname;
const ISLANDS = new URL("../examples/islands", import.meta.url).pathname;

// ── End-to-end via the no-JS client (drives renderPage + layout chain) ─────────

Deno.test("render-page e2e: home, about, dynamic blog, api, and 404 all render", async () => {
  const client = createTestClient(await createTestApp(HELLO));

  const home = await client.get("/");
  assertEquals(home.status, 200);
  assertStringIncludes(home.text, "Hello from denext");
  // The layout wraps the page (nav + footer chrome) and the merged metadata title
  // lands in the document <head>.
  assertStringIncludes(home.text, "<title>denext — home</title>");
  assertStringIncludes(home.text, "Built on Deno");

  const about = await client.get("/about");
  assertEquals(about.status, 200);

  // A dynamic async server component: /blog/[slug].
  const blog = await client.get("/blog/hello-world");
  assertEquals(blog.status, 200);
  assertStringIncludes(blog.text, "Hello World"); // slug title-cased server-side
  assertStringIncludes(blog.text, "denext — blog: hello-world"); // metadata(props)

  // An unmatched path renders the root not-found UI with a 404.
  const missing = await client.get("/definitely/not/here");
  assertEquals(missing.status, 404);
  assertStringIncludes(missing.text, "404");

  // API route handlers (GET/POST) return their JSON responses.
  const api = await client.get("/api/hello?name=deno");
  assertEquals(api.status, 200);
  assertEquals(api.json(), { message: "Hello, deno!", runtime: "deno" });

  const posted = await client.post("/api/hello", { json: { a: 1 } });
  assertEquals(posted.status, 201);
  assertEquals(posted.json(), { youSent: { a: 1 } });

  // The SSR output is a full, valid HTML document, with the layout's
  // `metadata.head` stylesheet link present.
  assertStringIncludes(home.text, "<!DOCTYPE html>");
  assertStringIncludes(home.text, "<html");
  assertStringIncludes(home.text, "</html>");
  assertStringIncludes(home.text, `href="/styles.css"`);
});

Deno.test("render-page e2e: an islands page renders on the Flight path with all directives", async () => {
  const client = createTestClient(await createTestApp(ISLANDS));
  const res = await client.get("/");
  assertEquals(res.status, 200);
  // Server-rendered island HTML is present for first paint (the client:* islands
  // that SSR), and the page carries the Flight payload the browser hydrates from.
  assertStringIncludes(res.text, "Island hydration directives");
  assertStringIncludes(res.text, "data-dnx-island");
  // Every directive carves an island with its own hydration strategy.
  assertStringIncludes(res.text, `data-dnx-strategy="load"`);
  assertStringIncludes(res.text, `data-dnx-strategy="visible"`);
  assertStringIncludes(res.text, `data-dnx-strategy="only"`);
  assertStringIncludes(res.text, `data-dnx-strategy-param="(min-width: 600px)"`);
});

// ── renderRootNotFound / renderGlobalError (direct) ────────────────────────────

const manifest = (over: Partial<RouteManifest>): RouteManifest => over as RouteManifest;

Deno.test("renderRootNotFound: default UI + 404 when no not-found module exists", async () => {
  const load: ModuleLoader = () => Promise.reject(new Error("should not load"));
  const page = await renderRootNotFound(manifest({}), load);
  assertEquals(page.status, 404);
  assertStringIncludes(page.html, "This page could not be found.");
  assertStringIncludes(page.html, "denext-not-found");
  assertEquals(page.metadata.title, "404 — Not Found");
});

Deno.test("renderRootNotFound: custom not-found is wrapped by the root layout", async () => {
  const NotFound = () => h("p", { class: "nf" }, "gone");
  const Layout = ({ children }: { children: VNode }) => h("div", { class: "shell" }, children);
  const load: ModuleLoader = (p) =>
    Promise.resolve(
      p.includes("layout")
        ? { default: Layout, metadata: { description: "shell layout" } }
        : { default: NotFound },
    );
  const page = await renderRootNotFound(
    manifest({ rootNotFound: "app/not-found.tsx", rootLayout: "app/layout.tsx" }),
    load,
  );
  assertEquals(page.status, 404);
  assertStringIncludes(page.html, `class="shell"`);
  assertStringIncludes(page.html, `class="nf"`);
  assertStringIncludes(page.html, "gone");
  // The layout's metadata was merged in.
  assertEquals(page.metadata.description, "shell layout");
});

Deno.test("renderGlobalError: returns null when no global-error module exists", async () => {
  const load: ModuleLoader = () => Promise.reject(new Error("nope"));
  const page = await renderGlobalError(manifest({}), load, new Error("boom"));
  assertEquals(page, null);
});

Deno.test("renderGlobalError: renders the global-error component with a 500", async () => {
  const GlobalError = ({ error }: { error: Error }) =>
    h("div", { class: "ge" }, `err: ${error.message}`);
  const load: ModuleLoader = () => Promise.resolve({ default: GlobalError });
  const page = await renderGlobalError(
    manifest({ rootGlobalError: "app/global-error.tsx" }),
    load,
    new Error("kaboom"),
  );
  assert(page, "a global-error module produces a page");
  assertEquals(page!.status, 500);
  assertStringIncludes(page!.html, `class="ge"`);
  assertEquals(page!.metadata.title, "Error");
});

// ── mergeMetadata / mergeViewport (pure) ───────────────────────────────────────

Deno.test("mergeMetadata: a template applies to descendants' string titles", () => {
  const out = mergeMetadata([
    { title: { template: "%s | Acme", default: "Acme" } },
    { title: "Dashboard" },
  ]);
  assertEquals(out.title, "Dashboard | Acme");
});

Deno.test("mergeMetadata: title.absolute ignores an ancestor template", () => {
  const out = mergeMetadata([
    { title: { template: "%s | Acme" } },
    { title: { absolute: "Standalone" } },
  ]);
  assertEquals(out.title, "Standalone");
});

Deno.test("mergeMetadata: default title is used when no descendant string title", () => {
  const out = mergeMetadata([{ title: { default: "Fallback" } }]);
  assertEquals(out.title, "Fallback");
});

Deno.test("mergeMetadata: later scalars override; objects deep-merge; jsonLd accumulates", () => {
  const metas: Metadata[] = [
    {
      description: "old",
      openGraph: { title: "og-old", type: "website" } as never,
      alternates: { canonical: "/a" } as never,
      icons: { icon: "/a.png" } as never,
      jsonLd: { "@type": "Organization" } as never,
    },
    {
      description: "new",
      keywords: ["x", "y"],
      openGraph: { title: "og-new" } as never,
      alternates: { languages: { en: "/en" } } as never,
      icons: { apple: "/apple.png" } as never,
      jsonLd: { "@type": "Article" } as never,
    },
  ];
  const out = mergeMetadata(metas);
  assertEquals(out.description, "new");
  assertEquals(out.keywords, ["x", "y"]);
  // openGraph deep-merges (type from first, title overridden by second).
  assertEquals((out.openGraph as Record<string, unknown>).type, "website");
  assertEquals((out.openGraph as Record<string, unknown>).title, "og-new");
  // alternates + icons merge both entries.
  assertEquals((out.alternates as Record<string, unknown>).canonical, "/a");
  assert((out.alternates as Record<string, unknown>).languages);
  assertEquals((out.icons as Record<string, unknown>).icon, "/a.png");
  assertEquals((out.icons as Record<string, unknown>).apple, "/apple.png");
  // jsonLd accumulates into an array (layout + page both emitted).
  assert(Array.isArray(out.jsonLd));
  assertEquals((out.jsonLd as unknown[]).length, 2);
});

Deno.test("mergeMetadata: head fragments concatenate and meta merges", () => {
  const out = mergeMetadata([
    { head: "<meta name=a>", meta: { a: "1" } as never },
    { head: "<meta name=b>", meta: { b: "2" } as never },
  ]);
  assertEquals(out.head, "<meta name=a><meta name=b>");
  assertEquals(out.meta, { a: "1", b: "2" });
});

Deno.test("mergeViewport: later entries override earlier ones", () => {
  const out = mergeViewport([
    { themeColor: "#fff", width: "device-width" } as never,
    { themeColor: "#000" } as never,
  ]);
  assertEquals((out as Record<string, unknown>).themeColor, "#000");
  assertEquals((out as Record<string, unknown>).width, "device-width");
});
