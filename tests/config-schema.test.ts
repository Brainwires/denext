// Drift check for the generated config artifacts (src/server/config-keys.generated.ts +
// denext.config.schema.json) against the `DenextConfig` type, plus unit tests of the
// deno-doc → JSON-Schema mapping in scripts/gen-config-schema.ts.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  description,
  type DocType,
  generate,
  KEYS_OUT,
  propertyNames,
  SCHEMA_OUT,
  symbolTable,
  tsTypeToSchema,
} from "../scripts/gen-config-schema.ts";
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
  assert(!("type" in schema.properties.redirects), "a function field carries no JSON type");
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
