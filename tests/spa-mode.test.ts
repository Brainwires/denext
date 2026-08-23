// Unit tests for SPA mode ("React but not Next", `mode: "spa"`): the pure shell/
// entry generators and the config validation. The full build→browser path is
// covered by tests/e2e/spa.e2e.test.ts (opt-in).

import { assert, assertStringIncludes, assertThrows } from "@std/assert";
import { generateSpaEntry, spaShellHtml } from "../src/build/spa.ts";
import { validateDenextConfig } from "../src/build/paths.ts";
import type { DenextConfig } from "../src/server/config.ts";

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
