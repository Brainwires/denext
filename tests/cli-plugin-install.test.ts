import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createConfigSource,
  ejectPlugin,
  injectPlugin,
  listPlugins,
  normalizeSpec,
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

// --- ejectPlugin ------------------------------------------------------------

Deno.test("ejectPlugin: sole plugin → removes import and the whole plugins key", () => {
  const src =
    `import { htmx } from "@denext/htmx";\n\nexport default {\n  plugins: [htmx()],\n};\n`;
  const r = ejectPlugin(src, resolvePluginNames("@denext/htmx"));
  assert(r.removedImport && r.removedPlugin && !r.notPresent);
  assertEquals(r.source.includes("htmx"), false);
  assertEquals(r.source.includes("plugins"), false);
  assertStringIncludes(r.source, `export default {`);
});

Deno.test("ejectPlugin: removes from the front of a multi-plugin array", () => {
  const src = `import { htmx } from "@denext/htmx";\n` +
    `import { pagesRouter } from "@denext/pages-router";\n\n` +
    `export default {\n  plugins: [htmx(), pagesRouter()],\n};\n`;
  const r = ejectPlugin(src, resolvePluginNames("@denext/htmx"));
  assert(r.removedImport && r.removedPlugin);
  assertStringIncludes(r.source, `plugins: [pagesRouter()]`);
  assertEquals(r.source.includes("@denext/htmx"), false);
  assertStringIncludes(r.source, `import { pagesRouter } from "@denext/pages-router";`);
});

Deno.test("ejectPlugin: removes from the end of a multi-plugin array", () => {
  const src = `import { pagesRouter } from "@denext/pages-router";\n` +
    `import { htmx } from "@denext/htmx";\n\n` +
    `export default {\n  plugins: [pagesRouter(), htmx()],\n};\n`;
  const r = ejectPlugin(src, resolvePluginNames("@denext/htmx"));
  assert(r.removedPlugin);
  assertStringIncludes(r.source, `plugins: [pagesRouter()]`);
});

Deno.test("ejectPlugin: trims a shared import, keeps other named bindings", () => {
  const src = `import { htmx, Htmx } from "@denext/htmx";\n\n` +
    `export default {\n  plugins: [htmx()],\n};\n`;
  const r = ejectPlugin(src, resolvePluginNames("@denext/htmx"));
  assert(r.removedImport && r.removedPlugin);
  assertStringIncludes(r.source, `import { Htmx } from "@denext/htmx";`);
});

Deno.test("ejectPlugin: idempotent when the plugin isn't present", () => {
  const src = `export default {\n  plugins: [],\n};\n`;
  const r = ejectPlugin(src, resolvePluginNames("@denext/htmx"));
  assert(r.notPresent && !r.removedImport && !r.removedPlugin);
  assertEquals(r.source, src);
});

// --- listPlugins ------------------------------------------------------------

Deno.test("listPlugins: pairs each factory with its import specifier", () => {
  const src = `import { htmx } from "@denext/htmx";\n` +
    `import { pagesRouter } from "@denext/pages-router";\n\n` +
    `export default {\n  plugins: [htmx(), pagesRouter()],\n};\n`;
  const list = listPlugins(src);
  assertEquals(list, [
    { factory: "htmx", call: "htmx()", importSpec: "@denext/htmx", imported: "htmx" },
    {
      factory: "pagesRouter",
      call: "pagesRouter()",
      importSpec: "@denext/pages-router",
      imported: "pagesRouter",
    },
  ]);
});

Deno.test("listPlugins: handles call args and a missing import", () => {
  const src = `import { htmx } from "@denext/htmx";\n\n` +
    `export default {\n  plugins: [htmx({ path: "/x" }), mystery()],\n};\n`;
  const list = listPlugins(src);
  assertEquals(list[0], {
    factory: "htmx",
    call: "htmx()",
    importSpec: "@denext/htmx",
    imported: "htmx",
  });
  assertEquals(list[1], {
    factory: "mystery",
    call: "mystery()",
    importSpec: null,
    imported: "mystery",
  });
});

Deno.test("listPlugins: empty or absent plugins array → []", () => {
  assertEquals(listPlugins(`export default {\n  plugins: [],\n};\n`), []);
  assertEquals(listPlugins(`export default { images: {} };\n`), []);
});

Deno.test("eject then re-inject round-trips a lone plugin", () => {
  const names = resolvePluginNames("@denext/htmx");
  const original =
    `import { htmx } from "@denext/htmx";\n\nexport default {\n  plugins: [htmx()],\n};\n`;
  const removed = ejectPlugin(original, names).source;
  const readded = injectPlugin(removed, names).source;
  assertStringIncludes(readded, `import { htmx } from "@denext/htmx";`);
  assertStringIncludes(readded, `plugins: [htmx()]`);
});

// --- aliased and jsr: imports ------------------------------------------------

const OPENAPI_NAMES = resolvePluginNames("@denext/openapi");

Deno.test("normalizeSpec strips the scheme, the version and a subpath", () => {
  assertEquals(normalizeSpec("jsr:@denext/openapi@^0.3.0/mod.ts"), "@denext/openapi");
  assertEquals(normalizeSpec("@denext/openapi"), "@denext/openapi");
  assertEquals(normalizeSpec("npm:left-pad@1.3.0"), "left-pad");
});

Deno.test("listPlugins: an aliased import and a jsr: specifier are recognised", () => {
  const src = `import { openapi as oa } from "@denext/openapi";\n` +
    `import { htmx } from "jsr:@denext/htmx@^2.0.0";\n\n` +
    `export default {\n  plugins: [oa({ path: "/spec.json" }), htmx()],\n};\n`;
  assertEquals(listPlugins(src), [
    { factory: "oa", call: "oa()", importSpec: "@denext/openapi", imported: "openapi" },
    { factory: "htmx", call: "htmx()", importSpec: "jsr:@denext/htmx@^2.0.0", imported: "htmx" },
  ]);
});

Deno.test("injectPlugin: an aliased or jsr: import that is already wired is left alone", () => {
  const aliased = `import { openapi as oa } from "@denext/openapi";\n\n` +
    `export default {\n  plugins: [oa()],\n};\n`;
  assertEquals(injectPlugin(aliased, OPENAPI_NAMES).alreadyPresent, true);
  const viaJsr = `import { openapi } from "jsr:@denext/openapi@^0.3.0";\n\n` +
    `export default {\n  plugins: [openapi()],\n};\n`;
  assertEquals(injectPlugin(viaJsr, OPENAPI_NAMES).alreadyPresent, true);
});

Deno.test("injectPlugin: an aliased import with no call gets the call under the alias", () => {
  const src = `import { openapi as oa } from "@denext/openapi";\n\nexport default {};\n`;
  const result = injectPlugin(src, OPENAPI_NAMES);
  assertEquals([result.addedImport, result.addedPlugin], [false, true]);
  assertStringIncludes(result.source, "oa()");
  assert(!result.source.includes("openapi()"), "no call the imports don't bind");
});

Deno.test("ejectPlugin: removes an aliased binding and its call", () => {
  const src = `import { htmx } from "@denext/htmx";\n` +
    `import { openapi as oa } from "@denext/openapi";\n\n` +
    `export default {\n  plugins: [htmx(), oa({ path: "/x" })],\n};\n`;
  const result = ejectPlugin(src, OPENAPI_NAMES);
  assertEquals([result.removedImport, result.removedPlugin], [true, true]);
  assert(!result.source.includes("@denext/openapi"), result.source);
  assertStringIncludes(result.source, "plugins: [htmx()]");
});

Deno.test("ejectPlugin: removes an import written with a jsr: specifier", () => {
  const src = `import { openapi } from "jsr:@denext/openapi@^0.3.0";\n\n` +
    `export default {\n  plugins: [openapi()],\n};\n`;
  const result = ejectPlugin(src, OPENAPI_NAMES);
  assertEquals([result.removedImport, result.removedPlugin], [true, true]);
  assert(!result.source.includes("openapi"), result.source);
});
