// Drift check for the generated config artifacts (src/server/config-keys.generated.ts +
// denext.config.schema.json) against the `DenextConfig` type, plus unit tests of the
// deno-doc → JSON-Schema mapping shared through scripts/lib/ts-to-schema.ts.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { generate, KEYS_OUT, SCHEMA_OUT } from "../scripts/gen-config-schema.ts";
import {
  constraints,
  description,
  type DocType,
  propertyNames,
  symbolTable,
  tsTypeToSchema,
} from "../scripts/lib/ts-to-schema.ts";
import { CONFIG_KEYS, EXPERIMENTAL_KEYS } from "../src/server/config-keys.generated.ts";

const STALE = "is stale — run `deno task gen:config-schema` (or `deno task docs:api`) and commit";

Deno.test("generated config keys + JSON Schema match the DenextConfig type (drift check)", async () => {
  // Re-derive both artifacts from a fresh `deno doc --json` pass and compare byte-for-byte
  // with the committed files. Adding/removing a `DenextConfig` or `ExperimentalConfig` field
  // (or editing its JSDoc) without regenerating fails here.
  const { keysModule, schema } = await generate();
  assertEquals(await Deno.readTextFile(KEYS_OUT), keysModule, `config-keys.generated.ts ${STALE}`);
  assertEquals(await Deno.readTextFile(SCHEMA_OUT), schema, `denext.config.schema.json ${STALE}`);
});

Deno.test("the committed schema mirrors the runtime validator's contract", async () => {
  const schema = JSON.parse(await Deno.readTextFile(SCHEMA_OUT));
  assertEquals(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assertEquals(schema.title, "denext.config");
  assertEquals(schema.type, "object");
  // Closed exactly where warnUnknownConfigKeys warns: the root and `experimental`.
  assertEquals(Object.keys(schema.properties), [...CONFIG_KEYS]);
  assertEquals(schema.additionalProperties, false);
  assertEquals(Object.keys(schema.properties.experimental.properties), [...EXPERIMENTAL_KEYS]);
  assertEquals(schema.properties.experimental.additionalProperties, false);
  // Nested objects stay open (the loader passes them through untouched).
  assertEquals(schema.properties.spa.additionalProperties, undefined);
  // Spot-check the type mapping on real fields.
  assertEquals(schema.properties.mode.enum, ["spa"]);
  assertEquals(schema.properties.basePath.type, "string");
  assertEquals(schema.properties.publicEnv.type, "array");
  assertEquals(schema.properties.publicEnv.items, { type: "string" });
  assertEquals(schema.properties.spa.required, ["entry"]);
  // A thunk returning a rule array is described as THAT array, marked as function-wrapped
  // so a config writer knows the literal belongs inside `() => [...]`.
  assertEquals(schema.properties.redirects.type, "array");
  assertEquals(Object.keys(schema.properties.redirects.items.properties), [
    "source",
    "destination",
    "permanent",
  ]);
  assertEquals(schema.properties.redirects.items.properties.permanent.type, "boolean");
  assertEquals(schema.properties.redirects["x-denext"].wrapper, "function");
  // An array of literals keeps its allowed values (a multi-select, not a free-text list).
  assertEquals(schema.properties.images.properties.formats, {
    description: schema.properties.images.properties.formats.description,
    type: "array",
    items: { enum: ["image/webp", "image/avif"] },
  });
  // A `Record<K, V>` is an open object with one value schema — key/value rows, not fields.
  assertEquals(schema.properties.features.type, "object");
  assertEquals(schema.properties.features.additionalProperties, { type: "boolean" });
  // No marker: a map is recognised structurally, from its `additionalProperties`.
  assertEquals(schema.properties.features["x-denext"], undefined);
  // The legacy block and every member of it carry the `@deprecated` mark the editor hides on.
  assertEquals(schema.properties.experimental.deprecated, true);
  for (const key of EXPERIMENTAL_KEYS) {
    assertEquals(schema.properties.experimental.properties[key].deprecated, true, key);
  }
  // A bound reaches the schema only from an explicit JSDoc tag backing a validator rule.
  assertEquals(schema.properties.apiBatch.properties.maxItems.minimum, 1);
  assertEquals(schema.properties.apiBatch.properties.maxItems.maximum, 100);
  assertEquals(schema.properties.basePath.minimum, undefined);
  // A handler function has no serialisable shape: description only, never a claimed type.
  const run = schema.properties.commands.items.properties.run;
  assertEquals(Object.keys(run), ["description"], "`commands[].run` stays unconstrained");
  // Every field carries its JSDoc (doc-lint guarantees the source has one) — honest copies.
  for (const [key, prop] of Object.entries<{ description?: string }>(schema.properties)) {
    assert(prop.description && prop.description.length > 0, `\`${key}\` has no description`);
  }
});

Deno.test("tsTypeToSchema maps deno doc type nodes (unit)", () => {
  const ctx = { table: new Map(), stack: [] };
  const kw = (v: string): DocType => ({ kind: "keyword", value: v });
  const lit = (s: string): DocType => ({ kind: "literal", value: { kind: "string", string: s } });
  assertEquals(tsTypeToSchema(kw("boolean"), ctx), { type: "boolean" });
  assertEquals(tsTypeToSchema(kw("unknown"), ctx), {});
  assertEquals(tsTypeToSchema(undefined, ctx), {});
  assertEquals(tsTypeToSchema(lit("auto"), ctx), { enum: ["auto"] });
  assertEquals(
    tsTypeToSchema({ kind: "literal", value: { kind: "boolean", boolean: false } }, ctx),
    { enum: [false] },
  );
  assertEquals(tsTypeToSchema({ kind: "union", value: [lit("a"), lit("b")] }, ctx), {
    enum: ["a", "b"],
  });
  assertEquals(tsTypeToSchema({ kind: "union", value: [kw("boolean"), lit("auto")] }, ctx), {
    anyOf: [{ type: "boolean" }, { enum: ["auto"] }],
  });
  // An unmappable member makes the whole union unconstrained (never a partial claim).
  assertEquals(
    tsTypeToSchema({ kind: "union", value: [kw("boolean"), { kind: "fnOrConstructor" }] }, ctx),
    {},
  );
  assertEquals(tsTypeToSchema({ kind: "array", value: kw("string") }, ctx), {
    type: "array",
    items: { type: "string" },
  });
  assertEquals(tsTypeToSchema({ kind: "array", value: { kind: "fnOrConstructor" } }, ctx), {
    type: "array",
  });
  // Imported / unknown references stay open; unknown kinds too.
  assertEquals(
    tsTypeToSchema(
      { kind: "typeRef", value: { typeName: "X", resolution: { kind: "import" } } },
      ctx,
    ),
    {},
  );
  assertEquals(tsTypeToSchema({ kind: "conditional" }, ctx), {});
});

Deno.test("tsTypeToSchema describes thunks, standard generics and maps (unit)", () => {
  const ctx = { table: new Map(), stack: [] };
  const kw = (v: string): DocType => ({ kind: "keyword", value: v });
  const generic = (typeName: string, ...typeParams: DocType[]): DocType => ({
    kind: "typeRef",
    value: { typeName, typeParams },
  });
  const fn = (tsType?: DocType): DocType => ({ kind: "fnOrConstructor", value: { tsType } });
  const array = (el: DocType): DocType => ({ kind: "array", value: el });

  // A thunk is described by what it RETURNS, through `Promise` and through a union.
  assertEquals(tsTypeToSchema(fn(generic("Promise", array(kw("string")))), ctx), {
    type: "array",
    items: { type: "string" },
    "x-denext": { wrapper: "function" },
  });
  assertEquals(
    tsTypeToSchema(
      fn({ kind: "union", value: [array(kw("number")), generic("Promise", kw("void"))] }),
      ctx,
    ),
    { type: "array", items: { type: "number" }, "x-denext": { wrapper: "function" } },
  );
  // Anything else a function may return has no serialisable shape.
  assertEquals(tsTypeToSchema(fn(kw("void")), ctx), {});
  assertEquals(tsTypeToSchema(fn(generic("Promise", kw("void"))), ctx), {});
  assertEquals(tsTypeToSchema(fn(), ctx), {});

  // Standard generics: array-ish expand, wrappers unwrap, `Partial` drops `required`.
  const arrayOfString = { type: "array", items: { type: "string" } };
  assertEquals(tsTypeToSchema(generic("Array", kw("string")), ctx), arrayOfString);
  assertEquals(tsTypeToSchema(generic("ReadonlyArray", kw("string")), ctx), arrayOfString);
  assertEquals(tsTypeToSchema(generic("Array"), ctx), { type: "array" });
  assertEquals(tsTypeToSchema(generic("Promise", kw("boolean")), ctx), { type: "boolean" });
  const literal = (name: string): DocType => ({
    kind: "typeLiteral",
    value: { properties: [{ name, tsType: kw("string") }] },
  });
  assertEquals(tsTypeToSchema(generic("Readonly", literal("a")), ctx), {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
  });
  assertEquals(tsTypeToSchema(generic("Partial", literal("a")), ctx), {
    type: "object",
    properties: { a: { type: "string" } },
  });

  // Maps: `Record`, a mapped type and an index signature all describe one value schema.
  const boolMap = { type: "object", additionalProperties: { type: "boolean" } };
  assertEquals(tsTypeToSchema(generic("Record", kw("string"), kw("boolean")), ctx), boolMap);
  assertEquals(
    tsTypeToSchema({ kind: "mapped", value: { tsType: kw("boolean") } }, ctx),
    boolMap,
  );
  assertEquals(
    tsTypeToSchema(
      { kind: "typeLiteral", value: { indexSignatures: [{ tsType: kw("boolean") }] } },
      ctx,
    ),
    boolMap,
  );
  // An opaque value type is still a map — it just claims nothing about the values.
  assertEquals(tsTypeToSchema(generic("Record", kw("string"), kw("unknown")), ctx), {
    type: "object",
    additionalProperties: {},
  });
});

Deno.test("constraints reads only the explicit @default/@minimum/@maximum tags", () => {
  assertEquals(constraints(undefined), {});
  assertEquals(constraints([{ kind: "unsupported", value: "@minimum 1" }]), { minimum: 1 });
  assertEquals(
    constraints([
      { kind: "unsupported", value: "@default 3" },
      { kind: "unsupported", value: "@maximum 100" },
    ]),
    { default: 3, maximum: 100 },
  );
  // A prose body claims nothing, and an unrelated tag is never a schema keyword.
  assertEquals(constraints([{ kind: "unsupported", value: "@default the request origin" }]), {});
  assertEquals(constraints([{ kind: "unsupported", value: "@deprecated use `cache`" }]), {});
  assertEquals(constraints([{ kind: "param" }]), {});
});

Deno.test("local interface/alias references expand (with a cycle guard)", () => {
  const prop = (name: string, tsType: DocType, optional = true) => ({ name, tsType, optional });
  const ref = (typeName: string): DocType => ({
    kind: "typeRef",
    value: { typeName, resolution: { kind: "local" } },
  });
  const doc = {
    nodes: {
      "file:///x.ts": {
        symbols: [
          {
            name: "Node",
            declarations: [{
              kind: "interface",
              def: {
                properties: [
                  prop("id", { kind: "keyword", value: "string" }, false),
                  prop("next", ref("Node")),
                  prop("mode", ref("Mode")),
                ],
              },
            }],
          },
          {
            name: "Mode",
            declarations: [{ kind: "typeAlias", def: { tsType: ref("Node") } }],
          },
        ],
      },
    },
  };
  const table = symbolTable(doc);
  const schema = tsTypeToSchema(ref("Node"), { table, stack: [] });
  assertEquals(schema.type, "object");
  assertEquals(schema.required, ["id"]);
  const props = schema.properties as Record<string, Record<string, unknown>>;
  assertEquals(props.id, { type: "string" });
  assertEquals(props.next, {}, "a self-reference stays open instead of recursing forever");
  assertEquals(props.mode, {}, "an alias back to the interface being expanded stays open");
});

Deno.test("description keeps the first JSDoc paragraph and flattens {@link}", () => {
  assertEquals(
    description("See {@link Foo.bar | the bar}\nfor more.\n\nSecond paragraph."),
    "See the bar for more.",
  );
  assertEquals(description("Uses {@link SpaConfig#entry}."), "Uses SpaConfig.entry.");
  assertEquals(description("Keeps `code` ticks."), "Keeps `code` ticks.");
  assertEquals(description(undefined), "");
});

Deno.test("symbolTable + propertyNames read a v2 deno doc document in source order", () => {
  const doc = {
    nodes: {
      "file:///x.ts": {
        symbols: [{
          name: "A",
          declarations: [{
            kind: "interface",
            def: {
              properties: [{ name: "b", location: { line: 3 } }, {
                name: "a",
                location: { line: 2 },
              }],
              methods: [{ name: "m", location: { line: 4 } }],
            },
          }],
        }],
      },
    },
  };
  const table = symbolTable(doc);
  assertEquals(propertyNames(table, "A"), ["a", "b", "m"]);
  assertThrows(() => propertyNames(table, "Nope"), Error, "not found");
});

/** Every node of the committed schema, with the path it sits at. */
function nodesOf(
  schema: Record<string, unknown>,
): { path: string[]; node: Record<string, unknown>; named: boolean }[] {
  const out: { path: string[]; node: Record<string, unknown>; named: boolean }[] = [];
  const walk = (node: unknown, path: string[], named: boolean): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as Record<string, unknown>;
    if (path.length > 0) out.push({ path, node: n, named });
    for (const [key, child] of Object.entries((n.properties ?? {}) as Record<string, unknown>)) {
      walk(child, [...path, key], true);
    }
    // A row template, a map's value and a union branch all render under their PARENT's label,
    // so none of them is a place a person meets a name with nothing said about it.
    walk(n.items, [...path, "[]"], false);
    if (typeof n.additionalProperties === "object") {
      walk(n.additionalProperties, [...path, "<value>"], false);
    }
    ((n.anyOf ?? []) as unknown[]).forEach((branch, i) =>
      walk(branch, [...path, `anyOf[${i}]`], false)
    );
  };
  for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) {
    walk(child, [key], true);
  }
  return out;
}

Deno.test("every named config key describes itself", async () => {
  // The editor renders a key's JSDoc as its help text, so a key without any is a labelled
  // control with nothing to say what it does — which is how `experimental.compiler` and
  // `experimental.nodeResolve` came to sit unexplained beside the keys that replaced them.
  const schema = JSON.parse(await Deno.readTextFile(SCHEMA_OUT)) as Record<string, unknown>;
  const bare = nodesOf(schema)
    .filter((entry) => entry.named)
    .filter((entry) =>
      entry.node.type || entry.node.enum || entry.node.anyOf || entry.node.properties
    )
    .filter((entry) => !String(entry.node.description ?? "").trim())
    .map((entry) => entry.path.join("."));
  assertEquals(bare, [], `these keys render with no help text: ${bare.join(", ")}`);
});

Deno.test("a superseded key is marked, and says what replaced it", async () => {
  const schema = JSON.parse(await Deno.readTextFile(SCHEMA_OUT)) as Record<string, unknown>;
  /** One node of the committed schema, by the path it sits at. */
  const at = (...path: string[]): Record<string, unknown> => {
    let node = schema;
    for (const step of path) {
      const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
      node = properties?.[step] ?? {};
    }
    return node;
  };

  // A block that is ONLY `@deprecated` leaves no summary paragraph — deno doc reports the tag
  // structurally — so without this the key reached the editor with nothing at all to say what
  // it was, sitting beside the key that replaced it.
  assertEquals(at("experimental", "compiler").deprecated, true);
  assertStringIncludes(
    String(at("experimental", "compiler").description),
    "top-level `reactCompiler`",
  );
  assertEquals(at("experimental", "nodeResolve").deprecated, true);
  assertEquals(at("experimental", "reactCompiler").deprecated, true);
  assertStringIncludes(
    String(at("experimental", "reactCompiler").description),
    "top-level `reactCompiler`",
  );

  // The keys that REPLACED them are not marked, or the pair would look equally discouraged.
  assertEquals(at("reactCompiler").deprecated, undefined);
  assertEquals(at("asyncContext").deprecated, undefined);
  assertEquals(at("features").deprecated, undefined);
  assertEquals(at("nodeResolve").deprecated, undefined);

  // One that has its own summary keeps it, and gains only the flag.
  assertEquals(at("images", "domains").deprecated, true);
  assertStringIncludes(String(at("images", "domains").description), "remote hosts");
});
