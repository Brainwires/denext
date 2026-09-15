import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { deleteConfigValue, readConfigModel, setConfigValue } from "../src/build/config-edit.ts";

const PLAIN = `import { htmx } from "@denext/htmx";

export default {
  basePath: "/app",
  images: { domains: ["a.com"] },
  redirects: () => [],
  plugins: [htmx()],
};
`;

// --- readConfigModel --------------------------------------------------------

Deno.test("readConfigModel: classifies data literals and code, per key", async () => {
  const model = await readConfigModel(PLAIN);
  assertEquals(model.form, "object");
  assertEquals(model.keys.basePath, { kind: "editable", text: `"/app"`, value: "/app" });
  assertEquals(model.keys.images.kind, "editable");
  assertEquals(model.keys.images.value, { domains: ["a.com"] });
  assertEquals(model.keys.redirects.kind, "editable", "a rule thunk is data wearing a wrapper");
  assertEquals(model.keys.redirects.text, "() => []");
  assertEquals(model.keys.redirects.wrapper, "function");
  assertEquals(model.keys.redirects.value, []);
  assertEquals(model.keys.plugins, { kind: "readonly", text: "[htmx()]" });
  assert(!("i18n" in model.keys), "an absent key is simply missing");
});

Deno.test("readConfigModel: every supported module form is recognised", async () => {
  const forms: [string, string][] = [
    [`export default { basePath: "/a" };`, "object"],
    [`export default defineConfig({ basePath: "/a" });`, "defineConfig"],
    [`export default { basePath: "/a" } satisfies DenextConfig;`, "object"],
    [`export default (phase) => ({ basePath: "/a" });`, "factory"],
    [`export default function cfg() {\n  return { basePath: "/a" };\n}`, "factory"],
    [`export const basePath = "/a";`, "named"],
    [`export default makeConfig();`, "unsupported"],
  ];
  for (const [source, form] of forms) {
    const model = await readConfigModel(source);
    assertEquals(model.form, form, source);
    if (form !== "unsupported") assertEquals(model.keys.basePath.value, "/a", source);
  }
});

// --- setConfigValue ---------------------------------------------------------

Deno.test("readConfigModel: every thunk form around a data array reads as editable rows", async () => {
  const rows = [{ source: "/a", destination: "/b", permanent: true }];
  const bodies = [
    '() => [{ source: "/a", destination: "/b", permanent: true }]',
    '() => ([{ source: "/a", destination: "/b", permanent: true }])',
    'async () => [{ source: "/a", destination: "/b", permanent: true }]',
    'function () {\n    return [{ source: "/a", destination: "/b", permanent: true }];\n  }',
  ];
  for (const body of bodies) {
    const model = await readConfigModel(`export default {\n  redirects: ${body},\n};\n`);
    const info = model.keys.redirects;
    assertEquals(info.kind, "editable", body);
    assertEquals(info.wrapper, "function", body);
    assertEquals(info.value, rows, body);
  }
  // The method shorthand carries its own name, so the slot text is the whole member.
  const method = await readConfigModel(
    'export default {\n  headers() {\n    return [{ source: "/x" }];\n  },\n};\n',
  );
  assertEquals(method.keys.headers.kind, "editable");
  assertEquals(method.keys.headers.wrapper, "function");
  assertEquals(method.keys.headers.value, [{ source: "/x" }]);
});

Deno.test("readConfigModel: a thunk that returns anything but data stays read-only", async () => {
  const sources = [
    "export default {\n  redirects: () => [rule()],\n};\n",
    "export default {\n  redirects: () => loadRules(),\n};\n",
    "export default {\n  redirects: () => ({ a: 1 }),\n};\n",
    "export default {\n  redirects: () => {\n    log();\n    return [{ a: 1 }];\n  },\n};\n",
  ];
  for (const source of sources) {
    const info = (await readConfigModel(source)).keys.redirects;
    assertEquals(info.kind, "readonly", source);
    assertEquals(info.wrapper, undefined, source);
  }
});

Deno.test("setConfigValue: replaces only the value span of a plain default export", async () => {
  const r = await setConfigValue(PLAIN, ["basePath"], "/docs");
  assert(r.ok);
  assertEquals(r.source, PLAIN.replace(`"/app"`, `"/docs"`));
  assertStringIncludes(r.diff, `-  basePath: "/app",`);
  assertStringIncludes(r.diff, `+  basePath: "/docs",`);
});

Deno.test("setConfigValue: edits a defineConfig() argument", async () => {
  const src = `import { defineConfig } from "denext/server";

export default defineConfig({
  basePath: "/app",
});
`;
  const r = await setConfigValue(src, ["basePath"], "/docs");
  assert(r.ok);
  assertEquals(r.source, src.replace(`"/app"`, `"/docs"`));
});

Deno.test("setConfigValue: edits a Next-style factory and a function declaration", async () => {
  const arrow = `export default (phase) => ({\n  basePath: "/app",\n});\n`;
  const fn = `export default function cfg() {\n  return {\n    basePath: "/app",\n  };\n}\n`;
  for (const src of [arrow, fn]) {
    const r = await setConfigValue(src, ["basePath"], "/docs");
    assert(r.ok, src);
    assertEquals(r.source, src.replace(`"/app"`, `"/docs"`));
  }
});

Deno.test("setConfigValue: named config exports are edited and appended", async () => {
  const src = `export const basePath = "/app";\nexport const images = { domains: ["a.com"] };\n`;
  const set = await setConfigValue(src, ["basePath"], "/docs");
  assert(set.ok);
  assertEquals(
    set.source,
    `export const basePath = "/docs";\nexport const images = { domains: ["a.com"] };\n`,
  );

  const nested = await setConfigValue(src, ["images", "domains"], ["b.com"]);
  assert(nested.ok);
  assertStringIncludes(nested.source, `export const images = { domains: ["b.com"] };`);

  const added = await setConfigValue(src, ["i18n"], { locales: ["en"] });
  assert(added.ok);
  assertEquals(added.source, `${src}export const i18n = { locales: ["en"] };\n`);
});

Deno.test("setConfigValue: refuses a value that is code, and hands back the patch", async () => {
  const r = await setConfigValue(PLAIN, ["plugins"], []);
  assert(!r.ok);
  assertStringIncludes(r.reason, "holds code");
  assertEquals(r.snippet, "[htmx()]");
  assertStringIncludes(r.diff ?? "", "-  plugins: [htmx()],");
  assertStringIncludes(r.diff ?? "", "+  plugins: [],");
});

Deno.test("setConfigValue: byte offsets survive multi-byte characters", async () => {
  const src = `// ☕ the café config — naïve, but multi-byte
export default {
  title: "naïve café ☕",
  basePath: "/app",
};
`;
  const r = await setConfigValue(src, ["basePath"], "/docs");
  assert(r.ok);
  assertEquals(r.source, src.replace(`"/app"`, `"/docs"`));
  const nested = await setConfigValue(src, ["title"], "über");
  assert(nested.ok);
  assertEquals(nested.source, src.replace(`"naïve café ☕"`, `"über"`));
});

Deno.test("setConfigValue: comments and blank lines around the edit stay byte-exact", async () => {
  const src = `export default {
  // The base path. Keep the leading slash.
  basePath: "/app",

  /* Images come from the CDN. */
  images: { domains: ["a.com"] },
};
`;
  const r = await setConfigValue(src, ["images"], { domains: ["b.com"] });
  assert(r.ok);
  assertEquals(
    r.source,
    `export default {
  // The base path. Keep the leading slash.
  basePath: "/app",

  /* Images come from the CDN. */
  images: { domains: ["b.com"] },
};
`,
  );
});

Deno.test("setConfigValue: inserts into an empty object and creates missing parents", async () => {
  const empty = `export default {};\n`;
  const one = await setConfigValue(empty, ["basePath"], "/app");
  assert(one.ok);
  assertEquals(one.source, `export default { basePath: "/app" };\n`);

  const nested = await setConfigValue(empty, ["images", "domains"], ["a.com"]);
  assert(nested.ok);
  assertEquals(nested.source, `export default { images: { domains: ["a.com"] } };\n`);

  const appended = await setConfigValue(PLAIN, ["i18n"], { locales: ["en", "fr"] });
  assert(appended.ok);
  assertStringIncludes(appended.source, `  i18n: { locales: ["en", "fr"] },\n};`);
});

Deno.test("setConfigValue: a long value expands, staying inside deno fmt's width", async () => {
  const short = await setConfigValue(PLAIN, ["images"], {
    domains: ["one.example.com", "two.example.com", "three.example.com", "four.example.com"],
  });
  assert(short.ok);
  // The object no longer fits on one line; the array still does.
  assertStringIncludes(
    short.source,
    `  images: {\n    domains: ["one.example.com", "two.example.com", "three.example.com",`,
  );

  const long = await setConfigValue(PLAIN, ["images"], {
    domains: [
      "one.images.example.com",
      "two.images.example.com",
      "three.images.example.com",
      "four.images.example.com",
    ],
  });
  assert(long.ok);
  assertStringIncludes(long.source, `  images: {\n    domains: [\n      "one.images.example.com",`);
  for (const line of long.source.split("\n")) assert(line.length <= 100, line);
});

Deno.test("setConfigValue: bails on an unsupported module", async () => {
  const r = await setConfigValue(`export default makeConfig();\n`, ["basePath"], "/a");
  assert(!r.ok);
  assertStringIncludes(r.reason, "no editable config object");
  assert(r.diff === undefined);
});

Deno.test("setConfigValue: refuses to walk through a non-object value", async () => {
  const r = await setConfigValue(PLAIN, ["redirects", "0"], "x");
  assert(!r.ok);
  assertStringIncludes(r.reason, "`redirects` is not an object literal");
});

// --- deleteConfigValue ------------------------------------------------------

Deno.test("deleteConfigValue: removes the last key with its line", async () => {
  const r = await deleteConfigValue(PLAIN, ["plugins"]);
  assert(r.ok);
  assertEquals(
    r.source,
    `import { htmx } from "@denext/htmx";

export default {
  basePath: "/app",
  images: { domains: ["a.com"] },
  redirects: () => [],
};
`,
  );
});

Deno.test("deleteConfigValue: removes a nested key and a named export", async () => {
  const nested = await deleteConfigValue(PLAIN, ["images", "domains"]);
  assert(nested.ok);
  assertStringIncludes(nested.source, "  images: { },\n");

  const named = await deleteConfigValue(
    `export const basePath = "/app";\nexport const images = {};\n`,
    ["basePath"],
  );
  assert(named.ok);
  assertEquals(named.source, `export const images = {};\n`);
});

Deno.test("deleteConfigValue: an absent key is an honest refusal", async () => {
  const r = await deleteConfigValue(PLAIN, ["i18n"]);
  assert(!r.ok);
  assertStringIncludes(r.reason, "`i18n` is not set");
});

Deno.test("setConfigValue: the diff is a real unified diff of the write", async () => {
  const r = await setConfigValue(PLAIN, ["basePath"], "/docs");
  assert(r.ok);
  assertEquals(r.diff.split("\n").slice(0, 3), [
    "--- a/denext.config.ts",
    "+++ b/denext.config.ts",
    "@@ -1,7 +1,7 @@",
  ]);
});

Deno.test("setConfigValue: a CRLF config gets CRLF in everything the splice inserts", async () => {
  const src = 'export default {\r\n  basePath: "/a",\r\n};\r\n';
  const bareLf = /(?<!\r)\n/;
  const nested = await setConfigValue(src, ["images", "remotePatterns"], [{
    hostname: "cdn.example",
  }]);
  if (!nested.ok) throw new Error(nested.reason);
  assertEquals(bareLf.test(nested.source), false, "a nested insert adds no bare LF");
  const top = await setConfigValue(src, ["i18n"], { locales: ["en"], defaultLocale: "en" });
  if (!top.ok) throw new Error(top.reason);
  assertEquals(bareLf.test(top.source), false, "a new top-level key adds no bare LF");
});
