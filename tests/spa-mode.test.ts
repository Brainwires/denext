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

Deno.test("spaShellHtml: defaults (title, rootId, lang) and the entry script", () => {
  const html = spaShellHtml({
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

Deno.test("spaShellHtml: honors title/rootId/lang and links the stylesheet + dev script", () => {
  const html = spaShellHtml({
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

Deno.test("spaShellHtml: escapes the title (no HTML injection via config)", () => {
  const html = spaShellHtml({
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
