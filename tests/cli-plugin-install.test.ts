import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createConfigSource,
  injectPlugin,
  resolvePluginNames,
} from "../src/build/plugin-install.ts";

// --- resolvePluginNames -----------------------------------------------------

Deno.test("resolvePluginNames: bare scoped spec defaults to jsr and camelCases", () => {
  assertEquals(resolvePluginNames("@denext/htmx"), {
    addSpec: "jsr:@denext/htmx",
    importSpec: "@denext/htmx",
    factory: "htmx",
    call: "htmx()",
  });
  assertEquals(resolvePluginNames("@denext/pages-router").factory, "pagesRouter");
  assertEquals(resolvePluginNames("@denext/pages-router").call, "pagesRouter()");
});

Deno.test("resolvePluginNames: keeps an explicit scheme and strips a version", () => {
  assertEquals(resolvePluginNames("jsr:@denext/htmx@2.0.10"), {
    addSpec: "jsr:@denext/htmx@2.0.10",
    importSpec: "@denext/htmx",
    factory: "htmx",
    call: "htmx()",
  });
  const npm = resolvePluginNames("npm:some-plugin@^1.2.0");
  assertEquals(npm.addSpec, "npm:some-plugin@^1.2.0");
  assertEquals(npm.importSpec, "some-plugin");
  assertEquals(npm.factory, "somePlugin");
});

Deno.test("resolvePluginNames: --export and --no-call overrides", () => {
  const r = resolvePluginNames("my-plugin", { export: "configure", noCall: true });
  assertEquals(r.factory, "configure");
  assertEquals(r.call, "configure");
});

// --- createConfigSource -----------------------------------------------------

Deno.test("createConfigSource writes a minimal config", () => {
  const src = createConfigSource(resolvePluginNames("@denext/htmx"));
  assertStringIncludes(src, `import { htmx } from "@denext/htmx";`);
  assertStringIncludes(src, `plugins: [htmx()],`);
});

// --- injectPlugin -----------------------------------------------------------

Deno.test("injectPlugin: no plugins key → inserts one", () => {
  const src = `import type { DenextConfig } from "denext/server";\n\n` +
    `export default {\n  images: { deviceSizes: [640] },\n} satisfies DenextConfig;\n`;
  const r = injectPlugin(src, resolvePluginNames("@denext/htmx"));
  assert(r.addedImport && r.addedPlugin && !r.bailed);
  assertStringIncludes(r.source, `import { htmx } from "@denext/htmx";`);
  assertStringIncludes(r.source, `plugins: [htmx()],`);
  // Import goes after the existing import, config object stays intact.
  assertStringIncludes(r.source, `satisfies DenextConfig;`);
});

Deno.test("injectPlugin: existing plugins array → appends into it", () => {
  const src = `import { pagesRouter } from "@denext/pages-router";\n\n` +
    `export default {\n  plugins: [pagesRouter()],\n};\n`;
  const r = injectPlugin(src, resolvePluginNames("@denext/htmx"));
  assert(r.addedImport && r.addedPlugin);
  assertStringIncludes(r.source, `plugins: [htmx(), pagesRouter()]`);
  assertStringIncludes(r.source, `import { htmx } from "@denext/htmx";`);
  assertStringIncludes(r.source, `import { pagesRouter } from "@denext/pages-router";`);
});

Deno.test("injectPlugin: empty config object", () => {
  const r = injectPlugin(`export default {};\n`, resolvePluginNames("@denext/htmx"));
  assert(r.addedPlugin);
  assertStringIncludes(r.source, `plugins: [htmx()]`);
  assertStringIncludes(r.source, `import { htmx } from "@denext/htmx";`);
});

Deno.test("injectPlugin: idempotent when already wired", () => {
  const src =
    `import { htmx } from "@denext/htmx";\n\nexport default {\n  plugins: [htmx()],\n};\n`;
  const r = injectPlugin(src, resolvePluginNames("@denext/htmx"));
  assert(r.alreadyPresent);
  assertEquals(r.source, src);
});

Deno.test("injectPlugin: import present but call missing → adds only the call", () => {
  const src = `import { htmx } from "@denext/htmx";\n\nexport default {\n  plugins: [],\n};\n`;
  const r = injectPlugin(src, resolvePluginNames("@denext/htmx"));
  assert(!r.addedImport && r.addedPlugin && !r.alreadyPresent);
  assertStringIncludes(r.source, `plugins: [htmx()]`);
  // No duplicate import.
  assertEquals(r.source.match(/import \{ htmx \}/g)?.length, 1);
});

Deno.test("injectPlugin: bails on a non-object default export", () => {
  const src = `const config = { plugins: [] };\nexport default config;\n`;
  const r = injectPlugin(src, resolvePluginNames("@denext/htmx"));
  assert(r.bailed && !r.addedPlugin);
  // The import may still be added, but the object isn't touched.
  assertStringIncludes(r.source, `export default config;`);
});
