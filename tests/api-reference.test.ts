// The generated API reference (site/app/docs/api/reference.json, also the basis of
// llms-full.txt) must render every signature faithfully: no phantom `_: unknown` parameters
// (defaulted / destructured params) and no generic references stripped to a bare name.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classDetail,
  classMembers,
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

/** A class member of the committed reference, by module, class and member name. */
const classMember = (ref: Ref, module: string, name: string, member: string) =>
  // deno-lint-ignore no-explicit-any
  (findSymbol(ref, module, name).members as any[]).find((m) => m.name === member);

Deno.test("API reference: a class lists its members, with types, doc comments and static marks", async () => {
  const ref = await readReference();
  const absorb = classMember(ref, "denext/testing", "CookieJar", "absorb");
  assertEquals([absorb.kind, absorb.signature], ["method", "absorb(headers: Headers): void"]);
  assertStringIncludes(absorb.doc, "Set-Cookie");
  const ctor = classMember(ref, "denext/server", "PageCache", "constructor");
  assertEquals([ctor.kind, ctor.signature], ["constructor", "constructor(buildId?: string)"]);
  const wrap = classMember(ref, "denext", "Snapshot", "wrap");
  assertEquals(wrap.static, true);
  assertStringIncludes(wrap.signature, "static wrap<F>(");
  const err = findSymbol(ref, "denext/testing", "StoreContractError");
  assertEquals(err.signature, "class StoreContractError extends Error");
  assertEquals(err.extends, [{ type: "Error" }]);
  const classes = ref.groups.flatMap((g) => g.symbols).filter((s) => s.kind === "class");
  const bare = classes.filter((s) => !s.members && !s.extends && !s.implements);
  assertEquals(bare.map((s) => s.name), []);
});

Deno.test("API reference: a utility-type parent links the type it takes its members from", async () => {
  const ref = await readReference();
  assertEquals(findSymbol(ref, "denext/server", "BootMigrateOptions")?.extends, [{
    type: `Omit<PostgresMigrateOptions, "dryRun" | "quiet">`,
    ref: "denext-server/PostgresMigrateOptions",
    refName: "PostgresMigrateOptions",
  }]);
  assertEquals(findSymbol(ref, "denext/server", "ServeOptions")?.extends, [{
    type: "Partial<AppConfig>",
    ref: "denext-server/AppConfig",
    refName: "AppConfig",
  }]);
});

Deno.test("API reference: every parent left unlinked is a platform type, not an undocumented export", async () => {
  const ref = await readReference();
  // Lib / Web types: no denext module exports them, so they have no page to link.
  const platform = new Set([
    "Array",
    "AsyncDisposable",
    "AsyncIterableIterator",
    "Error",
    "PromiseLike",
    "ReadableStream",
    "Response",
    "URLSearchParams",
    "WebGL2RenderingContext",
  ]);
  const unlinked = ref.groups.flatMap((g) =>
    g.symbols.flatMap((s) =>
      [...s.extends ?? [], ...s.implements ?? []]
        .filter((p) => !p.ref)
        .map((p) => p.type.replace(/^(?:Omit|Pick|Partial|Required|Readonly)</, ""))
        .map((type) => type.replace(/[<,>].*$/s, ""))
        .filter((name) => !platform.has(name) && name !== "RequestInit")
        .map((name) => `${g.module}/${s.name} → ${name}`)
    )
  );
  assertEquals(unlinked, []);
});

Deno.test("API reference: denext_read_docs and denext_search_docs reach class members", async () => {
  const page = await readDocs("api:denext-testing/CookieJar");
  assert(!page.isError);
  assertStringIncludes(page.text, "- `absorb(headers: Headers): void` — Absorb every `Set-Cookie`");
  const snapshot = await readDocs("api:denext/Snapshot");
  assertStringIncludes(snapshot.text, "`static wrap<F>(");
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

Deno.test("classMembers: constructors, properties, methods and accessors, static marked, private left out", () => {
  const fn = (params: unknown[], returnType: unknown, extra: object = {}) => ({
    params,
    returnType,
    hasBody: true,
    ...extra,
  });
  const key = { kind: "identifier", name: "key", optional: false, tsType: stringType };
  const members = classMembers({
    constructors: [
      {
        name: "constructor",
        params: [{ ...key, optional: true }],
        hasBody: true,
        jsDoc: { doc: "Make one." },
      },
    ],
    properties: [
      prop("size", kw("number"), { readonly: true }),
      prop("shared", stringType, { isStatic: true }),
      prop("hidden", stringType, { accessibility: "private" }),
      prop("#secret", stringType),
      prop("base", stringType, { accessibility: "protected", optional: true }),
    ],
    methods: [
      { name: "get", kind: "method", functionDef: { params: [key], returnType: stringType } },
      { name: "get", kind: "method", functionDef: { params: [], returnType: stringType } },
      { name: "get", kind: "method", functionDef: fn([key], stringType) },
      {
        name: "of",
        kind: "method",
        isStatic: true,
        functionDef: fn([], kw("this"), { typeParams: [{ name: "T" }] }),
      },
      {
        name: "run",
        kind: "method",
        isAbstract: true,
        functionDef: { params: [], returnType: kw("void") },
      },
      { name: "tidy", kind: "method", accessibility: "private", functionDef: fn([], kw("void")) },
      { name: "label", kind: "getter", functionDef: fn([], stringType) },
      { name: "label", kind: "setter", functionDef: fn([{ ...key, name: "v" }], kw("void")) },
    ],
  });
  assertEquals(members.map((m) => [m.kind, m.signature, m.static ?? false]), [
    ["constructor", "constructor(key?: string)", false],
    ["property", "readonly size: number", false],
    ["property", "static shared: string", true],
    ["property", "protected base?: string", false],
    ["method", "get(key: string): string", false],
    ["method", "get(): string", false],
    ["method", "static of<T>(): this", true],
    ["method", "abstract run(): void", false],
    ["getter", "get label(): string", false],
    ["setter", "set label(v: string)", false],
  ]);
  assertEquals(members[0].doc, "Make one.");
});

Deno.test("classDetail: a class's parents keep their type arguments; only a class gets detail", () => {
  const ref = (typeName: string) => ({ repr: typeName, kind: "typeRef", value: { typeName } });
  assertEquals(
    classDetail({
      kind: "class",
      def: { extends: "Base", superTypeParams: [ref("T")], implements: [ref("Disposable")] },
    }),
    { extends: [{ type: "Base<T>" }], implements: [{ type: "Disposable" }] },
  );
  assertEquals(classDetail({ kind: "class", def: {} }), {});
  assertEquals(classDetail({ kind: "interface", def: { extends: "Base" } }), {});
});

Deno.test("linkParents: a utility type links its member source; implements entries link too", () => {
  const groups: ParentGroup[] = [
    {
      module: "denext",
      symbols: [{ name: "Options", slug: "Options" }, { name: "Run", slug: "Run" }],
    },
    {
      module: "denext/server",
      symbols: [{
        name: "Child",
        slug: "Child",
        extends: [{ type: `Omit<Options, "a">` }, { type: "Partial<Options>" }, {
          type: 'Pick<Init, "b">',
        }],
        implements: [{ type: "Run" }],
      }],
    },
  ];
  linkParents(groups);
  assertEquals(groups[1].symbols[0].extends, [
    { type: `Omit<Options, "a">`, ref: "denext/Options", refName: "Options" },
    { type: "Partial<Options>", ref: "denext/Options", refName: "Options" },
    { type: `Pick<Init, "b">` },
  ]);
  assertEquals(groups[1].symbols[0].implements, [{ type: "Run", ref: "denext/Run" }]);
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
