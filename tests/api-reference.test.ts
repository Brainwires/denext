// The generated API reference (site/app/docs/api/reference.json, also the basis of
// llms-full.txt) must render every signature faithfully: no phantom `_: unknown` parameters
// (defaulted / destructured params) and no generic references stripped to a bare name.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  extendsOf,
  interfaceDetail,
  interfaceMembers,
  linkParents,
  type ParentGroup,
  typeStr,
} from "../scripts/lib/api-signature.ts";
import { readDocs } from "../src/mcp/rag/read.ts";
import { searchDocs } from "../src/mcp/rag/search.ts";

Deno.test("API reference: signatures carry real parameter names and generic type arguments", async () => {
  const ref = JSON.parse(
    await Deno.readTextFile(new URL("../site/app/docs/api/reference.json", import.meta.url)),
  ) as
    & { groups?: Array<{ symbols: Array<{ signature: string; name: string }> }> }
    & Record<string, unknown>;
  const groups = ref.groups ?? (Array.isArray(ref) ? ref as never : []);
  const sigs = (groups as Array<{ symbols: Array<{ signature: string }> }>).flatMap((g) =>
    g.symbols.map((s) => s.signature)
  );
  assert(sigs.length > 300, `reference looks empty (${sigs.length} signatures)`);
  const phantom = sigs.filter((s) => /\b_: unknown\b/.test(s));
  const barePromise = sigs.filter((s) => /\): Promise$/.test(s) || /: Promise[,)]/.test(s));
  assert(phantom.length === 0, `phantom params:\n${phantom.slice(0, 5).join("\n")}`);
  assert(barePromise.length === 0, `bare Promise:\n${barePromise.slice(0, 5).join("\n")}`);
});

Deno.test("API reference and llms-full.txt carry no terminal escape codes", async () => {
  // `deno doc --json` once wrote colour codes into template-literal types' `repr`
  // (`${\u001b[0m\u001b[38;5;12mContactTypes…`), and they were committed into both files.
  for (const path of ["../site/app/docs/api/reference.json", "../site/public/llms-full.txt"]) {
    const text = await Deno.readTextFile(new URL(path, import.meta.url));
    const raw = text.indexOf("\x1b");
    const escaped = text.indexOf("\\u001b");
    assert(raw < 0, `${path}: an ESC byte at ${raw}: ${JSON.stringify(text.slice(raw, raw + 40))}`);
    assert(
      escaped < 0,
      `${path}: an escaped ESC at ${escaped}: ${text.slice(escaped, escaped + 40)}`,
    );
  }
});

// deno-lint-ignore no-explicit-any
type Ref = { groups: Array<{ module: string; symbols: any[] }> };
const readReference = async (): Promise<Ref> =>
  JSON.parse(
    await Deno.readTextFile(new URL("../site/app/docs/api/reference.json", import.meta.url)),
  );
const findSymbol = (ref: Ref, module: string, name: string) =>
  ref.groups.find((g) => g.module === module)?.symbols.find((s) => s.name === name);

Deno.test("API reference: an interface lists its members, with types and doc comments", async () => {
  const el = findSymbol(await readReference(), "denext/testing", "TestElement");
  // deno-lint-ignore no-explicit-any
  const bySignature = new Map(el?.members?.map((m: any) => [m.signature, m]));
  const ns = bySignature.get("readonly namespaceURI: string | null") as {
    kind: string;
    doc: string;
  };
  assertEquals(ns?.kind, "property");
  assert(ns.doc.includes("namespace"), ns.doc);
  const get = bySignature.get(
    "getAttributeNS(namespace: string | null, localName: string): string | null",
  ) as { kind: string; name: string };
  assertEquals(get?.kind, "method");
  assertEquals(get.name, "getAttributeNS");
});

Deno.test("API reference: every interface declares members or a parent, unless it is a registry", async () => {
  const ref = await readReference();
  // Empty on purpose: `.denext/*.ts` fills these by declaration merging.
  const open = new Set(["RegisteredApi", "RegisteredRoutes"]);
  const bare = ref.groups.flatMap((g) =>
    g.symbols
      .filter((s) => s.kind === "interface" && !s.members && !s.extends && !open.has(s.name))
      .map((s) => `${g.module}/${s.name}`)
  );
  assertEquals(bare, []);
});

Deno.test("API reference: an interface names its parents and links the documented ones", async () => {
  const ref = await readReference();
  const parents = ref.groups.flatMap((g) => g.symbols).flatMap((s) => s.extends ?? []);
  assert(parents.length > 50, `${parents.length} parents`);
  const documented = new Set(
    ref.groups.flatMap((g) => g.symbols.map((s) => `${g.module.replace(/\//g, "-")}/${s.slug}`)),
  );
  const dangling = parents.filter((p) => p.ref && !documented.has(p.ref));
  assertEquals(dangling, []);
  assert(parents.some((p) => p.ref), "no parent is linked");
});

Deno.test("API reference: denext_read_docs and denext_search_docs reach interface members", async () => {
  const page = await readDocs("api:denext-testing/TestElement");
  assert(!page.isError);
  assertStringIncludes(page.text, "`getAttributeNS(namespace: string | null, localName: string)");
  assertStringIncludes(page.text, "`readonly namespaceURI: string | null` — The namespace");
  const hits = await searchDocs("getAttributeNS");
  assert(hits.some((h) => h.ref === "api:denext-testing/TestElement"), JSON.stringify(hits));
});

const prop = (name: string, tsType: unknown, extra: object = {}) => ({ name, tsType, ...extra });
const kw = (repr: string) => ({ repr, kind: "keyword", value: repr });
const stringType = kw("string");
const strLit = (s: string) => ({ repr: s, kind: "literal", value: { kind: "string", string: s } });

Deno.test("interfaceMembers: properties and methods carry their modifiers and documentation", () => {
  const members = interfaceMembers({
    properties: [
      prop("id", stringType, { readonly: true, jsDoc: { doc: " The id. " } }),
      prop("aria-label", stringType, { optional: true }),
      prop("Symbol.toStringTag", stringType, { computed: true }),
    ],
    methods: [
      {
        name: "read",
        kind: "method",
        optional: true,
        typeParams: [{ name: "T" }],
        params: [{ kind: "identifier", name: "key", optional: false, tsType: stringType }],
        returnType: kw("void"),
        jsDoc: {
          doc: "Reads.",
          tags: [
            { kind: "param", name: "key", doc: "The `key`." },
            { kind: "return", doc: "Nothing." },
          ],
        },
      },
      { name: "size", kind: "getter", params: [], returnType: kw("number") },
      {
        name: "size",
        kind: "setter",
        params: [{ kind: "identifier", name: "v", tsType: kw("number") }],
      },
    ],
  });
  assertEquals(members, [
    { kind: "property", name: "id", signature: "readonly id: string", doc: "The id." },
    { kind: "property", name: "aria-label", signature: `"aria-label"?: string` },
    {
      kind: "property",
      name: "Symbol.toStringTag",
      signature: "[Symbol.toStringTag]: string",
    },
    {
      kind: "method",
      name: "read",
      signature: "read?<T>(key: string): void",
      doc: "Reads.",
      params: [{ name: "key", doc: "The key." }],
      returns: "Nothing.",
    },
    { kind: "getter", name: "size", signature: "get size(): number" },
    { kind: "setter", name: "size", signature: "set size(v: number)" },
  ]);
});

Deno.test("interfaceMembers: call, construct and index signatures", () => {
  const params = [{ kind: "identifier", name: "a", tsType: stringType }];
  const signatures = interfaceMembers({
    callSignatures: [{ params, tsType: kw("void"), typeParams: [{ name: "T" }] }],
    constructSignatures: [{ params, returnType: kw("object") }],
    indexSignatures: [{ params: [{ ...params[0], name: "key" }], tsType: kw("unknown") }],
  }).map((m) => [m.kind, m.name, m.signature]);
  assertEquals(signatures, [
    ["call", "", "<T>(a: string): void"],
    ["construct", "", "new (a: string): object"],
    ["index", "", "[key: string]: unknown"],
  ]);
});

Deno.test("typeStr: composite type nodes print as source, not as their kind", () => {
  const ref = (typeName: string) => ({ repr: typeName, kind: "typeRef", value: { typeName } });
  const cases: [unknown, string][] = [
    [strLit("a"), `"a"`],
    [{ kind: "literal", value: { kind: "number", number: 0 } }, "0"],
    [{ kind: "literal", value: { kind: "boolean", boolean: false } }, "false"],
    [
      {
        kind: "literal",
        value: { kind: "template", tsTypes: [strLit("data:"), stringType, strLit("")] },
      },
      "`data:${string}`",
    ],
    [{ kind: "tuple", value: [stringType, kw("number")] }, "[string, number]"],
    [{ kind: "parenthesized", value: stringType }, "(string)"],
    [{ kind: "typeOperator", value: { operator: "keyof", tsType: ref("T") } }, "keyof T"],
    [{ kind: "indexedAccess", value: { objType: ref("T"), indexType: strLit("k") } }, `T["k"]`],
    [{ kind: "typeQuery", value: "fetch" }, "typeof fetch"],
    [
      {
        kind: "conditional",
        value: {
          checkType: ref("T"),
          extendsType: stringType,
          trueType: { kind: "infer", value: { typeParam: { name: "U" } } },
          falseType: kw("never"),
        },
      },
      "T extends string ? infer U : never",
    ],
    [
      {
        kind: "mapped",
        value: {
          readonly: true,
          typeParam: { name: "K", constraint: ref("Keys") },
          nameType: ref("N"),
          optional: "-",
          tsType: stringType,
        },
      },
      "{ readonly [K in Keys as N]-?: string }",
    ],
    [
      {
        kind: "typeLiteral",
        value: { properties: [prop("a", stringType, { optional: true })], methods: [] },
      },
      "{ a?: string }",
    ],
    [{ kind: "typeLiteral", value: {} }, "{}"],
    [
      {
        kind: "fnOrConstructor",
        value: { constructor: true, params: [], tsType: ref("T"), typeParams: [{ name: "T" }] },
      },
      "new <T>() => T",
    ],
    [
      {
        kind: "typePredicate",
        value: { asserts: true, param: { type: "identifier", name: "x" }, type: stringType },
      },
      "asserts x is string",
    ],
    [
      {
        kind: "importType",
        value: { specifier: "./a.ts", qualifier: "B", typeParams: [ref("T")] },
      },
      `import("./a.ts").B<T>`,
    ],
    [{ kind: "this" }, "this"],
  ];
  for (const [node, source] of cases) assertEquals(typeStr(node), source);
});

Deno.test("extendsOf: a generic parent keeps its type arguments", () => {
  const parent = {
    kind: "typeRef",
    value: {
      typeName: "Base",
      typeParams: [{ repr: "T", kind: "typeRef", value: { typeName: "T" } }],
    },
  };
  assertEquals(extendsOf({ extends: [parent] }), ["Base<T>"]);
  assertEquals(extendsOf({}), []);
});

Deno.test("interfaceDetail: only an interface gets detail, and only the fields it has", () => {
  assertEquals(
    interfaceDetail({ kind: "function", def: { properties: [prop("a", stringType)] } }),
    {},
  );
  assertEquals(interfaceDetail({ kind: "interface" }), {});
  const detail = interfaceDetail({
    kind: "interface",
    def: {
      properties: [prop("a", stringType)],
      extends: [{ kind: "typeRef", value: { typeName: "B" } }],
    },
  });
  assertEquals(detail.members?.map((m) => m.signature), ["a: string"]);
  assertEquals(detail.extends, [{ type: "B" }]);
});

Deno.test("linkParents: the same module wins, then the first module; a lib type stays plain", () => {
  const sym = (name: string, parents?: string[]) => ({
    name,
    slug: name,
    ...(parents ? { extends: parents.map((type) => ({ type })) } : {}),
  });
  const groups: ParentGroup[] = [
    { module: "denext", symbols: [sym("Shared"), sym("Only")] },
    {
      module: "denext/server",
      symbols: [sym("Shared"), sym("Child", ["Shared<T>", "Only", "Error"])],
    },
  ];
  linkParents(groups);
  assertEquals(groups[1].symbols[1].extends, [
    { type: "Shared<T>", ref: "denext-server/Shared" },
    { type: "Only", ref: "denext/Only" },
    { type: "Error" },
  ]);
});
