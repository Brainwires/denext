// The widget rule table, checked against the REAL committed `denext.config.schema.json` rather
// than a fixture: if the generator stops describing a field, or starts describing one it used to
// skip, the mapping test is where it shows up.
//
// The contract these tests lock down is the one the 2.5 UI promises: a config editor built from
// the schema, with a type-appropriate control for every field and an explicit, enumerated list
// of the values it deliberately will not own.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  branchFor,
  itemSchema,
  loadConfigSchema,
  MAP_SEGMENT,
  mapValueSchema,
  pathKey,
  resolveAt,
  type SchemaNode,
  walkSchema,
} from "../src/ui/form/schema.ts";
import { OVERRIDES } from "../src/ui/form/schema-overrides.ts";
import { widgetFor, type WidgetKind, type WidgetSpec } from "../src/ui/form/widget.ts";
import { decode, encode } from "../src/ui/form/value.ts";

const SCHEMA = loadConfigSchema();

/** Every kind the renderer has a row for. */
const KINDS: ReadonlySet<string> = new Set<WidgetKind>([
  "text",
  "textarea",
  "number",
  "toggle",
  "select",
  "segmented",
  "multi-select",
  "chips",
  "list-of-forms",
  "map",
  "union",
  "group",
  "code",
]);

/** The widget for a config path, resolved through the real schema. */
function specAt(...path: string[]): WidgetSpec {
  const parent = path.length > 1 ? resolveAt(SCHEMA, path.slice(0, -1)) : SCHEMA;
  const required = parent.required?.includes(path[path.length - 1]) ?? false;
  return widgetFor(resolveAt(SCHEMA, path), path, required);
}

/** The widget kind for a config path. */
function kindAt(...path: string[]): WidgetKind {
  return specAt(...path).kind;
}

/** Assert one kind per property of an array's item schema. */
function assertRowKinds(list: string[], expected: Record<string, WidgetKind>): void {
  for (const [property, kind] of Object.entries(expected)) {
    assertEquals(kindAt(...list, "0", property), kind, `${pathKey(list)}[].${property}`);
  }
  const items = itemSchema(resolveAt(SCHEMA, list));
  assertEquals(
    Object.keys(items.properties ?? {}).sort(),
    Object.keys(expected).sort(),
    `every property of ${pathKey(list)}[] is asserted`,
  );
}

Deno.test("every node of the committed schema resolves to a concrete widget kind", () => {
  let seen = 0;
  walkSchema(SCHEMA, (node, path) => {
    seen++;
    const spec = widgetFor(node, path, false);
    assert(KINDS.has(spec.kind), `${pathKey(path)} → ${spec.kind}`);
    assertEquals(spec.path, path);
    assertEquals(spec.schema, node);
  });
  assert(seen > 150, `the schema should still describe the whole config (saw ${seen} nodes)`);
});

Deno.test("the read-only set is exactly the values denext cannot serialise", () => {
  const readOnly = new Set<string>();
  walkSchema(SCHEMA, (node, path) => {
    if (widgetFor(node, path, false).kind === "code") readOnly.add(pathKey(path));
  });
  assertEquals([...readOnly].sort(), [
    // `CacheStore` is an object of methods: seven opaque `{}` nodes.
    "cache.store.deleteByPath",
    "cache.store.deleteByTag",
    "cache.store.expireByTag",
    "cache.store.getData",
    "cache.store.getPage",
    "cache.store.setData",
    "cache.store.setPage",
    // A project command's handler (its `flags`/`positionals` are typed lists).
    "commands[].run",
    // A message catalogue: `Record<string, unknown>` — a map whose values are opaque.
    "i18n.messages",
    // The Live authorization callbacks.
    "live.authorize",
    "live.canJoinRoom",
    "live.canSubscribe",
    "live.canWatchTags",
    // Unified plugin arrays (no `items`) and an opaque options bag.
    "mdx.recmaPlugins",
    "mdx.rehypePlugins",
    "mdx.remarkPlugins",
    "mdx.remarkRehypeOptions",
    // Policy, not a schema gap: the plugins panel owns this array (READ_ONLY_PATHS)…
    "plugins",
    // …and a plugin's `setup` is a live function either way.
    "plugins[].setup",
  ]);
});

Deno.test("every top-level config key maps to the widget its type deserves", () => {
  const kinds: Record<string, WidgetKind> = {};
  for (const key of Object.keys(SCHEMA.properties ?? {})) kinds[key] = kindAt(key);
  assertEquals(kinds, {
    mode: "segmented",
    spa: "group",
    i18n: "group",
    basePath: "text",
    trailingSlash: "toggle",
    assetPrefix: "text",
    redirects: "list-of-forms",
    rewrites: "list-of-forms",
    headers: "list-of-forms",
    scheduledTasks: "map",
    tasks: "group",
    images: "group",
    tailwind: "group",
    mdx: "group",
    cache: "group",
    hsts: "union",
    csp: "union",
    publicEnv: "chips",
    streaming: "toggle",
    live: "group",
    apiBatch: "group",
    apiMaxBodyBytes: "number",
    actionMaxBodyBytes: "number",
    canonicalOrigin: "text",
    trustForwardedHeaders: "toggle",
    requestTimeout: "number",
    maxConcurrency: "number",
    slotBackstop: "number",
    cacheKeyParams: "chips",
    nodeResolve: "toggle",
    cacheComponents: "toggle",
    reactCompiler: "toggle",
    asyncContext: "toggle",
    features: "map",
    experimental: "group",
    classComponents: "toggle",
    compatibilityMode: "segmented",
    plugins: "code",
    commands: "list-of-forms",
  });
});

Deno.test("every row property of the eight list fields gets a typed control", () => {
  assertRowKinds(["redirects"], {
    source: "text",
    destination: "text",
    permanent: "toggle",
  });
  assertRowKinds(["rewrites"], { source: "text", destination: "text" });
  assertRowKinds(["headers"], { source: "text", headers: "list-of-forms" });
  assertRowKinds(["headers", "0", "headers"], { key: "text", value: "text" });
  assertRowKinds(["images", "remotePatterns"], {
    protocol: "text",
    hostname: "text",
    pathname: "text",
    port: "text",
    search: "text",
  });
  assertRowKinds(["images", "localPatterns"], { pathname: "text", search: "text" });
  assertRowKinds(["commands", "0", "flags"], {
    name: "text",
    alias: "text",
    altNames: "chips",
    type: "segmented",
    default: "union",
    help: "text",
    valueName: "text",
  });
  assertRowKinds(["commands", "0", "positionals"], {
    name: "text",
    help: "text",
    required: "toggle",
    variadic: "toggle",
  });
  assertRowKinds(["i18n", "domains"], {
    domain: "text",
    defaultLocale: "text",
    locales: "chips",
    http: "toggle",
  });
});

Deno.test("`redirects`, `rewrites` and `headers` keep the generator's function-wrapper marker", () => {
  for (const key of ["redirects", "rewrites", "headers"]) {
    assertEquals(
      resolveAt(SCHEMA, [key])["x-denext"]?.wrapper,
      "function",
      `${key} is edited as an array but written back as \`() => [...]\``,
    );
  }
});

Deno.test("required row fields are marked required, optional ones are not", () => {
  assert(specAt("redirects", "0", "source").required);
  assert(specAt("redirects", "0", "destination").required);
  assert(!specAt("redirects", "0", "permanent").required);
});

Deno.test("enums become segmented controls, and gain '— unset —' when optional", () => {
  const mode = specAt("mode");
  assertEquals(mode.kind, "segmented");
  assertEquals(mode.options?.map((option) => option.value), ["", "spa"]);
  assertEquals(mode.options?.[0].label, "— unset —");

  const prefix = specAt("i18n", "localePrefix");
  assertEquals(prefix.kind, "segmented");
  assertEquals(prefix.options?.map((option) => option.value), ["", "as-needed", "always"]);

  const required = widgetFor({ enum: ["a", "b"] }, ["x"], true);
  assertEquals(required.options?.map((option) => option.value), ["a", "b"]);
});

Deno.test("a long or wide enum becomes a select instead", () => {
  const many: SchemaNode = { type: "string", enum: ["a", "b", "c", "d", "e"] };
  assertEquals(widgetFor(many, ["x"], true).kind, "select");
  const wide: SchemaNode = { type: "string", enum: ["short", "an-extremely-long-option"] };
  assertEquals(widgetFor(wide, ["x"], true).kind, "select");
});

Deno.test("every union field gets a discriminator picker with readable branch labels", () => {
  const labels = (...path: string[]) => specAt(...path).branches?.map((branch) => branch.label);
  assertEquals(labels("csp"), ["strict", "off", "object"]);
  assertEquals(labels("spa", "csp"), ["strict", "off", "object"]);
  assertEquals(labels("cache", "store"), ["sqlite", "memory", "object"]);
  assertEquals(labels("hsts"), ["object", "false"]);
  assertEquals(labels("scheduledTasks", MAP_SEGMENT), ["string", "array"]);
});

Deno.test("a union branch is a widget of its own, rendered at the union's path", () => {
  const csp = specAt("csp");
  const object = csp.branches?.[2].spec;
  assertEquals(object?.kind, "group");
  assertEquals(object?.path, ["csp"]);
  assertEquals(object?.children?.map((child) => child.kind), ["chips", "chips", "chips", "chips"]);
  assertEquals(branchFor(csp.schema, "strict").enum, ["strict"]);
  assertEquals(branchFor(csp.schema, { scriptSrc: [] }).type, "object");
  // Nothing matches a number; the first branch is the honest fallback.
  assertEquals(branchFor(csp.schema, 7).enum, ["strict"]);
});

Deno.test("records become key/value maps, opaque ones stay read-only", () => {
  assertEquals(kindAt("scheduledTasks"), "map");
  assertEquals(kindAt("features"), "map");
  assertEquals(kindAt("experimental", "features"), "map", "the legacy alias keeps its shape");
  assertEquals(kindAt("spa", "env"), "map");
  assertEquals(specAt("spa", "env").items?.kind, "text");
  assertEquals(specAt("features").items?.kind, "toggle");
  assertEquals(specAt("scheduledTasks").items?.kind, "union");
  // A map carries no marker; with opaque values (`Record<string, unknown>`) it stays read-only.
  assertEquals(resolveAt(SCHEMA, ["i18n", "messages"])["x-denext"], undefined);
  assertEquals(kindAt("i18n", "messages"), "code");
  assertEquals(mapValueSchema(resolveAt(SCHEMA, ["i18n", "messages"])), undefined);
});

Deno.test("arrays split by what their items are", () => {
  assertEquals(kindAt("images", "formats"), "multi-select");
  assertEquals(specAt("images", "formats").options?.map((option) => option.value), [
    "image/webp",
    "image/avif",
  ]);
  assertEquals(kindAt("images", "deviceSizes"), "chips");
  assertEquals(specAt("images", "deviceSizes").items?.kind, "number");
  assertEquals(kindAt("publicEnv"), "chips");
  assertEquals(kindAt("i18n", "locales"), "chips");
  assertEquals(kindAt("mdx", "remarkPlugins"), "code");
});

Deno.test("numbers carry the bounds the schema declares", () => {
  const maxItems = specAt("apiBatch", "maxItems");
  assertEquals(maxItems.kind, "number");
  assertEquals([maxItems.min, maxItems.max], [1, 100]);
  assertEquals(specAt("images", "minimumCacheTTL").min, 0);
  assertEquals(specAt("apiMaxBodyBytes").max, undefined);
});

Deno.test("a string opts into a textarea through the generator's widget hint", () => {
  const hinted: SchemaNode = { type: "string", "x-denext": { widget: "textarea" } };
  assertEquals(widgetFor(hinted, ["spa", "head"], false).kind, "textarea");
  // `@widget textarea` on `SpaConfig.head` / `.loading` reaches the committed schema…
  assertEquals(resolveAt(SCHEMA, ["spa", "head"])["x-denext"]?.widget, "textarea");
  assertEquals(kindAt("spa", "head"), "textarea");
  assertEquals(kindAt("spa", "loading"), "textarea");
  // …while an untagged string stays a one-line input, and so does an unknown hint.
  assertEquals(kindAt("spa", "title"), "text");
  const unknown = { type: "string", "x-denext": { widget: "wysiwyg" } } as unknown as SchemaNode;
  assertEquals(widgetFor(unknown, ["x"], false).kind, "text");
});

Deno.test("a textarea field round-trips multi-line HTML through the form codec", () => {
  const spec = specAt("spa", "loading");
  const html = '<div class="splash">\n  <img src="/logo.svg" alt="">\n</div>';
  assertEquals(decode(spec, encode(spec, html)), html);
});

Deno.test("paths collapse to the key OVERRIDES is written in", () => {
  assertEquals(pathKey([]), "");
  assertEquals(pathKey(["redirects", "2", "source"]), "redirects[].source");
  assertEquals(pathKey(["headers", "0", "headers", "1", "key"]), "headers[].headers[].key");
  assertEquals(pathKey(["spa", "env", MAP_SEGMENT]), "spa.env[]");
});

Deno.test("resolveAt walks properties, rows, map values and union branches", () => {
  assertEquals(resolveAt(SCHEMA, []).type, "object");
  assertEquals(resolveAt(SCHEMA, ["redirects", "7", "permanent"]).type, "boolean");
  assertEquals(resolveAt(SCHEMA, ["spa", "env", "MY_KEY"]).type, "string");
  // `scriptSrc` lives on `csp`'s object branch, not on `csp` itself.
  assertEquals(resolveAt(SCHEMA, ["csp", "scriptSrc"]).type, "array");
  assertThrows(
    () => resolveAt(SCHEMA, ["redirects", "0", "nope"]),
    Error,
    "no schema at `redirects[].nope`",
  );
});

Deno.test("itemSchema is total: an array without items yields an empty node", () => {
  assertEquals(itemSchema(resolveAt(SCHEMA, ["publicEnv"])).type, "string");
  assertEquals(itemSchema(resolveAt(SCHEMA, ["mdx", "remarkPlugins"])), {});
});

Deno.test("schema-overrides.ts ships empty — gaps are fixed in the generator", () => {
  assertEquals(OVERRIDES, {});
});

Deno.test("a union of nothing but finite scalars is one control, not a picker", () => {
  // `boolean | "auto"` is three values, so it renders as one choice over them rather than a
  // branch picker with a second control nested inside it repeating the key's name.
  const spec = specAt("compatibilityMode");
  assertEquals(spec.kind, "segmented");
  assertEquals(spec.branches, undefined, "there is no shape left to pick");
  assertEquals(spec.options?.map((option) => option.value), ["", "true", "false", "auto"]);

  // A union with an object branch is a real choice of shape and keeps its picker.
  assertEquals(specAt("csp").kind, "union");
  assertEquals(specAt("hsts").kind, "union");
  assertEquals(specAt("cache", "store").kind, "union");
});
