import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { staticExport } from "../src/build/export.ts";

// End-to-end: a real app with a "use client" page exports to static HTML + a
// Flight bundle, and server-component code never reaches the client bundle.
Deno.test("staticExport renders a client-boundary page via Flight", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_flight_export_" });
  try {
    const root = new URL("../", import.meta.url).pathname;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${root}mod.ts`,
          "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
          "denext/server": `${root}src/server/mod.ts`,
          "denext/client": `${root}src/client/mod.ts`,
        },
      }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    // A client island.
    await Deno.writeTextFile(
      join(dir, "app", "Counter.tsx"),
      `"use client"\nexport function Counter(){ return <button>CLIENT_ISLAND</button>; }\n`,
    );
    // A server page (holds a secret) that embeds the client island.
    await Deno.writeTextFile(
      join(dir, "app", "page.tsx"),
      `"use server"\nimport { Counter } from "./Counter.tsx";\n` +
        `const DB = "EXPORT_SERVER_SECRET_42";\n` +
        `export default function Page(){ return <main>{DB.length}<Counter/></main>; }\n`,
    );

    const result = await staticExport(dir);
    assert(result.pages >= 1);

    const html = await Deno.readTextFile(join(result.outDir, "index.html"));
    // First-paint SSR of the island is present, plus the Flight island script.
    assertStringIncludes(html, "CLIENT_ISLAND");
    assertStringIncludes(html, `id="__denext_flight"`);
    // The server secret's VALUE is never in the HTML (only its length was used).
    assert(!html.includes("EXPORT_SERVER_SECRET_42"));

    // The Flight bundle exists and contains client code but not server code.
    const flightJs = await Deno.readTextFile(
      join(result.outDir, "_denext", "client", "flight.js"),
    );
    assertStringIncludes(flightJs, "CLIENT_ISLAND");
    assert(
      !flightJs.includes("EXPORT_SERVER_SECRET_42"),
      "server secret leaked into flight bundle",
    );

    // The boundary route did NOT get a whole-tree bundle (which would leak the
    // server secret). Besides flight.js the build may emit the code-split
    // `denext/lazy` chunk (the deferred-island bootstrap, dynamically imported by
    // every Flight entry) — that is client-only code and must also stay clean.
    for await (const e of Deno.readDir(join(result.outDir, "_denext", "client"))) {
      if (!e.isFile || !e.name.endsWith(".js")) continue;
      const js = await Deno.readTextFile(join(result.outDir, "_denext", "client", e.name));
      assert(
        !js.includes("EXPORT_SERVER_SECRET_42"),
        `server secret leaked into client chunk ${e.name}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A page with no interactivity exports to pure HTML — no hydration script and no
// client JS at all. Regression guard for the docs-site "0 KB JS" claim.
Deno.test("staticExport ships zero JS for a purely static page", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_static_export_" });
  try {
    const root = new URL("../", import.meta.url).pathname;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${root}mod.ts`,
          "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
          "denext/server": `${root}src/server/mod.ts`,
          "denext/client": `${root}src/client/mod.ts`,
        },
      }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "app", "page.tsx"),
      `export default function Page(){ return <main><h1>STATIC_DOC</h1></main>; }\n`,
    );

    const result = await staticExport(dir);
    const html = await Deno.readTextFile(join(result.outDir, "index.html"));
    assertStringIncludes(html, "STATIC_DOC");
    // No hydration bootstrap and no data island — nothing to run in the browser.
    assert(!html.includes("<script"), "a static page must ship no <script>");
    assert(!html.includes("__denext_data"), "a static page must ship no hydration data");

    // No client bundle was emitted for the route.
    let clientJs = 0;
    try {
      for await (const e of Deno.readDir(join(result.outDir, "_denext", "client"))) {
        if (e.name.endsWith(".js")) clientJs++;
      }
    } catch { /* no client dir at all is fine */ }
    assert(clientJs === 0, `a static page must emit no client JS (found ${clientJs})`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// SEO parity in SSG: automatic hreflang and authored JSON-LD reach the exported
// static HTML — per-locale variants included — just as they do on the served path.
Deno.test("staticExport emits hreflang + JSON-LD into per-locale static HTML", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_seo_export_" });
  try {
    const root = new URL("../", import.meta.url).pathname;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${root}mod.ts`,
          "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
          "denext/server": `${root}src/server/mod.ts`,
          "denext/client": `${root}src/client/mod.ts`,
        },
      }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "app", "page.tsx"),
      `export const metadata = {\n` +
        `  metadataBase: "https://x.com",\n` +
        `  jsonLd: { "@context": "https://schema.org", "@type": "WebSite", name: "X" },\n` +
        `};\n` +
        `export default function Page(){ return <main><h1>HOME</h1></main>; }\n`,
    );

    const result = await staticExport(dir, {
      i18n: { locales: ["en", "fr"], defaultLocale: "en" },
    });

    // Default locale (unprefixed) → out/index.html.
    const en = await Deno.readTextFile(join(result.outDir, "index.html"));
    assertStringIncludes(en, `<script type="application/ld+json">`);
    assertStringIncludes(en, `"@type":"WebSite"`);
    assertStringIncludes(en, `<link rel="alternate" hreflang="en" href="https://x.com/">`);
    assertStringIncludes(en, `<link rel="alternate" hreflang="fr" href="https://x.com/fr">`);
    assertStringIncludes(en, `hreflang="x-default" href="https://x.com/"`);
    assertStringIncludes(en, `<link rel="canonical" href="https://x.com/">`);

    // The fr variant → out/fr/index.html, canonical points at the fr URL.
    const fr = await Deno.readTextFile(join(result.outDir, "fr", "index.html"));
    assertStringIncludes(fr, `<link rel="canonical" href="https://x.com/fr">`);
    assertStringIncludes(fr, `<link rel="alternate" hreflang="fr" href="https://x.com/fr">`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
