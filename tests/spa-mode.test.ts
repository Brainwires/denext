// Unit tests for SPA mode ("React but not Next", `mode: "spa"`): the pure shell/
// entry generators and the config validation. The full build→browser path is
// covered by tests/e2e/spa.e2e.test.ts (opt-in).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { generateSpaEntry, pnpmCatalogPackages, spaShellHtml } from "../src/build/spa.ts";
import { validateDenextConfig } from "../src/build/paths.ts";
import type { DenextConfig } from "../src/server/config.ts";

Deno.test("generateSpaEntry imports instrumentation-client FIRST when the project has one (prod + dev)", () => {
  const prod = generateSpaEntry(
    "file:///app/src/main.tsx",
    false,
    "/proj/instrumentation-client.ts",
  );
  const lines = prod.split("\n");
  // instrumentation-client is the very FIRST import (line 1), before the class-runtime wiring
  // and the app entry.
  assertEquals(lines[1], 'import "file:///proj/instrumentation-client.ts";', "before the entry");
  assert(
    prod.indexOf('import "file:///proj/instrumentation-client.ts";') <
      prod.indexOf('import "file:///app/src/main.tsx";'),
    "instrumentation precedes the app entry",
  );
  assertStringIncludes(prod, 'import "file:///app/src/main.tsx";');
  const dev = generateSpaEntry("file:///app/src/main.tsx", true, "/proj/instrumentation-client.ts");
  assertEquals(dev.split("\n")[1], 'import "file:///proj/instrumentation-client.ts";');
  assertStringIncludes(dev, "enableFastRefresh();");
  assert(
    !generateSpaEntry("file:///app/src/main.tsx").includes("instrumentation"),
    "none by default",
  );
});

Deno.test("generateSpaEntry imports the entry module for its side effects", () => {
  const src = generateSpaEntry("file:///app/src/main.tsx");
  assertStringIncludes(src, 'import "file:///app/src/main.tsx";');
});

Deno.test("spaShellHtml: defaults (title, rootId, lang) and the entry script", async () => {
  const html = await spaShellHtml({
    spa: { entry: "./src/main.tsx" },
    scriptSrc: "/_denext/client/index.js",
  });
  assertStringIncludes(html, "<!doctype html>");
  assertStringIncludes(html, '<html lang="en">');
  assertStringIncludes(html, "<title>denext app</title>");
  assertStringIncludes(html, '<div id="root"></div>');
  assertStringIncludes(html, '<script type="module" src="/_denext/client/index.js"></script>');
  // No stylesheet or dev-reload script unless requested.
  assert(!html.includes('<link rel="stylesheet"'));
  assert(!html.includes("dev-reload"));
});

Deno.test("spaShellHtml: honors title/rootId/lang and links the stylesheet + dev script", async () => {
  const html = await spaShellHtml({
    spa: { entry: "./src/main.tsx", title: "My IDE", rootId: "app", lang: "fr" },
    scriptSrc: "/_denext/client/index.js",
    styleHref: "/_denext/client/index.css",
    devScriptSrc: "/_denext/dev-reload.js",
  });
  assertStringIncludes(html, '<html lang="fr">');
  assertStringIncludes(html, "<title>My IDE</title>");
  assertStringIncludes(html, '<div id="app"></div>');
  assertStringIncludes(html, '<link rel="stylesheet" href="/_denext/client/index.css" />');
  assertStringIncludes(html, '<script src="/_denext/dev-reload.js"></script>');
});

Deno.test("spaShellHtml: escapes the title (no HTML injection via config)", async () => {
  const html = await spaShellHtml({
    spa: { entry: "./src/main.tsx", title: "<script>x</script>" },
    scriptSrc: "/_denext/client/index.js",
  });
  assert(!html.includes("<title><script>"), "title must be escaped");
  assertStringIncludes(html, "&lt;script&gt;x&lt;/script&gt;");
});

Deno.test('validateDenextConfig: mode must be "spa" when set', () => {
  assertThrows(
    () => validateDenextConfig({ mode: "mpa" as unknown as "spa" }),
    Error,
    "`mode`",
  );
});

Deno.test("validateDenextConfig: mode:spa requires a spa.entry", () => {
  assertThrows(
    () => validateDenextConfig({ mode: "spa" } as DenextConfig),
    Error,
    "`spa`",
  );
  assertThrows(
    () => validateDenextConfig({ mode: "spa", spa: { entry: "" } }),
    Error,
    "`spa.entry`",
  );
});

Deno.test("validateDenextConfig: a valid spa config passes", () => {
  validateDenextConfig({ mode: "spa", spa: { entry: "./src/main.tsx" } });
});

Deno.test("spaShellHtml: opt-in csp injects a strict <meta> CSP (no frame-ancestors)", async () => {
  const html = await spaShellHtml({
    spa: { entry: "./src/main.tsx", csp: "strict" },
    scriptSrc: "/_denext/client/index.js",
  });
  assertStringIncludes(html, '<meta http-equiv="Content-Security-Policy"');
  assertStringIncludes(html, "default-src 'self'");
  assertStringIncludes(html, "script-src 'self'");
  assertStringIncludes(html, "object-src 'none'");
  assertStringIncludes(html, "base-uri 'self'");
  // frame-ancestors is header-only (ignored in <meta>) and must be stripped.
  assert(!html.includes("frame-ancestors"), "frame-ancestors must be dropped from the meta CSP");
});

Deno.test("spaShellHtml: no csp by default (React SPA parity) and csp:'off' is a no-op", async () => {
  const off = await spaShellHtml({
    spa: { entry: "./src/main.tsx", csp: "off" },
    scriptSrc: "/_denext/client/index.js",
  });
  const none = await spaShellHtml({
    spa: { entry: "./src/main.tsx" },
    scriptSrc: "/_denext/client/index.js",
  });
  assert(!off.includes("Content-Security-Policy"));
  assert(!none.includes("Content-Security-Policy"));
});

Deno.test("spaShellHtml: csp object adds global opt-ins (connect-src)", async () => {
  const html = await spaShellHtml({
    spa: { entry: "./src/main.tsx", csp: { connectSrc: ["https://api.example.com"] } },
    scriptSrc: "/_denext/client/index.js",
  });
  assertStringIncludes(html, "connect-src 'self' https://api.example.com");
});

Deno.test("pnpmCatalogPackages: lists catalog:/workspace: deps across every group", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/package.json`,
      JSON.stringify({
        dependencies: { react: "^19.0.0", zustand: "catalog:", "@acme/ui": "workspace:*" },
        devDependencies: { vitest: "catalog:testing" },
        peerDependencies: { "react-dom": "^19.0.0" },
        optionalDependencies: { fsevents: "workspace:^" },
      }),
    );
    assertEquals(await pnpmCatalogPackages(dir), ["zustand", "@acme/ui", "vitest", "fsevents"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pnpmCatalogPackages: empty for a missing or invalid package.json", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await pnpmCatalogPackages(dir), []);
    await Deno.writeTextFile(`${dir}/package.json`, "{ not json");
    assertEquals(await pnpmCatalogPackages(dir), []);
    await Deno.writeTextFile(`${dir}/package.json`, JSON.stringify({ dependencies: { a: 1 } }));
    assertEquals(await pnpmCatalogPackages(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("spaShellHtml: renders spa.loading inside #root (boot placeholder) + head, cleared on mount", async () => {
  const html = await spaShellHtml({
    spa: {
      entry: "./src/main.tsx",
      head: `<script>document.documentElement.style.background="#0a0a0a"</script>`,
      loading: `<div id="boot-shell">splash</div>`,
    },
    scriptSrc: "/_denext/client/index.js",
  });
  // The boot placeholder is INSIDE the mount element so it paints before the bundle runs.
  assertStringIncludes(html, '<div id="root"><div id="boot-shell">splash</div></div>');
  // The pre-paint script is in <head> (runs before the module entry).
  assertStringIncludes(
    html,
    `<script>document.documentElement.style.background="#0a0a0a"</script>`,
  );
  assert(html.indexOf("<head>") < html.indexOf("background"), "pre-paint script is in <head>");
});

Deno.test("spaShellHtml: no spa.loading leaves #root empty (default)", async () => {
  const html = await spaShellHtml({ spa: { entry: "./src/main.tsx" }, scriptSrc: "/x.js" });
  assertStringIncludes(html, '<div id="root"></div>');
});

Deno.test("collectSpaPreloads: transitive STATIC import graph only (dynamic imports excluded)", async () => {
  const { collectSpaPreloads } = await import("../src/build/spa.ts");
  const dir = await Deno.makeTempDir({ prefix: "denext_preload_" });
  try {
    // index → chunk-a (static) → chunk-b (static); index also dynamically imports main (excluded).
    await Deno.writeTextFile(
      join(dir, "index.js"),
      `import{x}from"/_denext/client/chunk-a.js";import"/_denext/client/chunk-a.js";` +
        `const m=()=>import("/_denext/client/main.js");m();`,
    );
    await Deno.writeTextFile(
      join(dir, "chunk-a.js"),
      `export{y}from"/_denext/client/chunk-b.js";`,
    );
    await Deno.writeTextFile(join(dir, "chunk-b.js"), `export const y=1;`);
    await Deno.writeTextFile(join(dir, "main.js"), `console.log("app");`);
    const pre = await collectSpaPreloads(dir, "index.js");
    assertEquals(pre.sort(), ["chunk-a.js", "chunk-b.js"], "static graph, deduped, no main");
    assert(!pre.includes("main.js"), "dynamic import is NOT preloaded");
    assert(!pre.includes("index.js"), "the entry itself is not listed");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
