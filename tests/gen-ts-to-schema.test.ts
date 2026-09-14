// The TypeScript-type → JSON-Schema mapper shared by the config schema and the plugin
// catalog (scripts/lib/ts-to-schema.ts), plus the catalog builder's options-schema rules
// (scripts/gen-plugin-catalog.ts): every plugin row carries its factory's options schema,
// and the generator refuses a plugin that names no options type or whose `configKeys`
// drift from it.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { denoDocJson } from "../scripts/deno-doc.ts";
import {
  type DocType,
  interfaceSchema,
  type Schema,
  symbolTable,
  tsTypeToSchema,
  widgetHint,
} from "../scripts/lib/ts-to-schema.ts";
import {
  buildCatalog,
  CATALOG_OUT,
  type PackageSource,
  type PluginCatalog,
} from "../scripts/gen-plugin-catalog.ts";

const ctx = { table: new Map(), stack: [] };
const kw = (v: string): DocType => ({ kind: "keyword", value: v });
const lit = (s: string): DocType => ({ kind: "literal", value: { kind: "string", string: s } });
const generic = (typeName: string, ...typeParams: DocType[]): DocType => ({
  kind: "typeRef",
  value: { typeName, typeParams },
});

/** `deno doc --json` of a throwaway module, as a symbol table. */
async function docOf(source: string): Promise<ReturnType<typeof symbolTable>> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/mod.ts`, source);
    return symbolTable(await denoDocJson(`${dir}/mod.ts`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The properties of an object schema. */
function props(schema: Schema): Record<string, Schema> {
  return schema.properties as Record<string, Schema>;
}

Deno.test("mapper: primitives, literal unions and mixed unions", () => {
  assertEquals(tsTypeToSchema(kw("string"), ctx), { type: "string" });
  assertEquals(tsTypeToSchema(kw("number"), ctx), { type: "number" });
  assertEquals(tsTypeToSchema(kw("any"), ctx), {});
  assertEquals(tsTypeToSchema({ kind: "union", value: [lit("a"), lit("b")] }, ctx), {
    enum: ["a", "b"],
  });
  assertEquals(tsTypeToSchema({ kind: "union", value: [kw("string"), lit("off")] }, ctx), {
    anyOf: [{ type: "string" }, { enum: ["off"] }],
  });
});

Deno.test("mapper: Array<T>, ReadonlyArray<T> and readonly T[] are arrays", () => {
  const arrayOfString = { type: "array", items: { type: "string" } };
  assertEquals(tsTypeToSchema(generic("Array", kw("string")), ctx), arrayOfString);
  assertEquals(tsTypeToSchema(generic("ReadonlyArray", kw("string")), ctx), arrayOfString);
  const readonlyArray: DocType = {
    kind: "typeOperator",
    value: { operator: "readonly", tsType: { kind: "array", value: kw("string") } },
  };
  assertEquals(tsTypeToSchema(readonlyArray, ctx), arrayOfString);
  // Other type operators claim nothing.
  const keyOf: DocType = { kind: "typeOperator", value: { operator: "keyof", tsType: kw("x") } };
  assertEquals(tsTypeToSchema(keyOf, ctx), {});
});

Deno.test("mapper: Record<K, V> is an open object with no widget marker", () => {
  const schema = tsTypeToSchema(generic("Record", kw("string"), kw("number")), ctx);
  assertEquals(schema, { type: "object", additionalProperties: { type: "number" } });
  assertEquals(schema["x-denext"], undefined, "maps are recognised structurally, not by a tag");
});

Deno.test("mapper: a foreign type reference is {} even when a re-export put it in the table", () => {
  const table = symbolTable({
    nodes: {
      "file:///x.ts": {
        symbols: [{
          name: "Layer",
          declarations: [{
            kind: "interface",
            def: { properties: [{ name: "id", tsType: kw("string") }] },
          }],
        }],
      },
    },
  });
  const ref = (specifier: string): DocType => ({
    kind: "typeRef",
    value: { typeName: "Layer", resolution: { kind: "import", specifier } },
  });
  const scoped = { table, stack: [] };
  assertEquals(tsTypeToSchema(ref("npm:effect/Layer"), scoped), {});
  assertEquals(tsTypeToSchema(ref("@denext/denext/server"), scoped), {});
  assertEquals(tsTypeToSchema(ref("jsr:@std/http"), scoped), {});
  // A relative import is the package's own type: it expands.
  assertEquals(tsTypeToSchema(ref("./layer.ts"), scoped).type, "object");
});

Deno.test("mapper: a function returning an array is that array, wrapped; others are {}", () => {
  const fn = (tsType?: DocType): DocType => ({ kind: "fnOrConstructor", value: { tsType } });
  assertEquals(tsTypeToSchema(fn({ kind: "array", value: kw("string") }), ctx), {
    type: "array",
    items: { type: "string" },
    "x-denext": { wrapper: "function" },
  });
  assertEquals(tsTypeToSchema(fn(kw("boolean")), ctx), {});
});

Deno.test("mapper: `@widget textarea` becomes x-denext.widget; an unknown widget is ignored", async () => {
  const table = await docOf(`/** Probe. */
export interface Probe {
  /**
   * Raw HTML.
   *
   * @widget textarea
   */
  head?: string;
  /**
   * A typo'd widget name.
   *
   * @widget foo
   */
  title?: string;
  /** No tag. */
  lang?: string;
}
`);
  const schema = props(interfaceSchema("Probe", { table, stack: [] }));
  assertEquals(schema.head, {
    description: "Raw HTML.",
    type: "string",
    "x-denext": { widget: "textarea" },
  });
  assertEquals(schema.title, { description: "A typo'd widget name.", type: "string" });
  assertEquals(schema.lang, { description: "No tag.", type: "string" });
});

Deno.test("widgetHint accepts only the widget names the UI renders", () => {
  assertEquals(widgetHint([{ kind: "unsupported", value: "@widget textarea" }]), "textarea");
  assertEquals(widgetHint([{ kind: "unsupported", value: "@widget map" }]), undefined);
  assertEquals(widgetHint([{ kind: "unsupported", value: "@widget" }]), undefined);
  assertEquals(widgetHint([{ kind: "unsupported", value: "@default 1" }]), undefined);
  assertEquals(widgetHint(undefined), undefined);
});

Deno.test("mapper: maxDepth caps how deep nested interfaces expand", async () => {
  const table = await docOf(`/** A. */
export interface A {
  /** B. */
  b?: B;
}
/** B. */
export interface B {
  /** C. */
  c?: C;
}
/** C. */
export interface C {
  /** A leaf. */
  leaf?: string;
}
`);
  const unbounded = props(interfaceSchema("A", { table, stack: [] }));
  assertEquals(props(props(unbounded.b).c).leaf.type, "string");
  const capped = props(interfaceSchema("A", { table, stack: [], maxDepth: 2 }));
  assertEquals(props(capped.b).c, { description: "C." }, "the third level is past the cap");
});

Deno.test("mapper: the real OpenApiOptions interface maps to an options schema", async () => {
  const table = symbolTable(
    await denoDocJson(new URL("../packages/openapi/mod.ts", import.meta.url).pathname),
  );
  const schema = interfaceSchema("OpenApiOptions", { table, stack: [], maxDepth: 4 });
  const properties = props(schema);
  assertEquals(schema.type, "object");
  assertEquals(properties.path.type, "string");
  assertEquals(properties.expose.enum, ["always", "dev"]);
  assertEquals(properties.servers.type, "array");
  assertEquals(props(properties.servers.items as Schema).url.type, "string");
  assertEquals(Object.keys(properties.include), ["description"], "a predicate stays opaque");
});

/** A fake plugin package for the pure catalog builder. */
function fakePlugin(catalog: Record<string, unknown>, doc?: unknown): PackageSource {
  return {
    dir: "packages/fake",
    config: {
      name: "@denext/fake",
      version: "0.1.0",
      exports: "./mod.ts",
      denext: { catalog: { kind: "plugin", factory: "fake", ...catalog } },
    },
    readme: "# Fake\n\nA fake plugin.\n",
    hasDocsPage: false,
    doc,
  };
}

/** A `deno doc --json` document exporting one options interface with a `path` property. */
const FAKE_DOC = {
  nodes: {
    "file:///fake/mod.ts": {
      symbols: [{
        name: "FakeOptions",
        declarations: [{
          kind: "interface",
          jsDoc: { doc: "Options for {@linkcode fake}." },
          def: {
            properties: [{
              name: "path",
              optional: true,
              tsType: kw("string"),
              jsDoc: { doc: "Where it mounts." },
            }],
          },
        }],
      }],
    },
  },
};

Deno.test("catalog builder: a plugin row carries its options type and schema", () => {
  const catalog = JSON.parse(
    buildCatalog([fakePlugin({ optionsType: "FakeOptions", configKeys: ["path"] }, FAKE_DOC)]),
  ) as PluginCatalog;
  const [row] = catalog.plugins;
  assertEquals(row.optionsType, "FakeOptions");
  assertEquals(row.optionsSchema, {
    description: "Options for fake.",
    type: "object",
    properties: { path: { description: "Where it mounts.", type: "string" } },
  });
});

Deno.test("catalog builder: a plugin without optionsType (or with an unexported one) throws", () => {
  assertThrows(
    () => buildCatalog([fakePlugin({ configKeys: ["path"] }, FAKE_DOC)]),
    Error,
    "a plugin must declare denext.catalog.optionsType",
  );
  assertThrows(
    () => buildCatalog([fakePlugin({ optionsType: "MissingOptions" }, FAKE_DOC)]),
    Error,
    "`MissingOptions` is not an exported interface",
  );
});

Deno.test("catalog builder: configKeys that drift from the options interface throw", () => {
  assertThrows(
    () =>
      buildCatalog([
        fakePlugin({ optionsType: "FakeOptions", configKeys: ["path", "gone"] }, FAKE_DOC),
      ]),
    Error,
    "configKeys lists gone, which `FakeOptions` does not declare",
  );
});

Deno.test("catalog builder: a library may not declare an optionsType", () => {
  const pkg = fakePlugin({});
  pkg.config.denext = { catalog: { kind: "library", optionsType: "FakeOptions" } };
  assertThrows(() => buildCatalog([pkg]), Error, "a library declares neither");
});

Deno.test("committed catalog: every plugin row carries a schema covering its configKeys", () => {
  const { plugins } = JSON.parse(Deno.readTextFileSync(CATALOG_OUT)) as PluginCatalog;
  for (const row of plugins) {
    if (row.kind === "library") {
      assertEquals(row.optionsSchema, undefined, `${row.name} is a library`);
      continue;
    }
    assert(row.optionsType, `${row.name} names its options type`);
    const declared = Object.keys(props(row.optionsSchema ?? {}));
    for (const key of row.configKeys ?? []) {
      assert(declared.includes(key), `${row.name}: configKeys \`${key}\` is not in the schema`);
    }
  }
});
