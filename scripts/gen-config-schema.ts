// Generate the config key list + JSON Schema from the `DenextConfig` TypeScript type.
//
// The TS type IS the schema (`defineConfig` type-checks against it), but the runtime
// needs a plain list of its keys (the validator's unknown-key warning, the loader's field
// copy) and editors/tools want a JSON Schema. Both used to be hand-maintained copies of
// the interface; this script derives them from one `deno doc --json` pass over
// src/server/config.ts so they cannot drift:
//
//   src/server/config-keys.generated.ts  — import-free runtime module: the top-level
//                                          `DenextConfig` keys + the `experimental.*` keys
//   denext.config.schema.json            — JSON Schema (draft 2020-12), build-time
//                                          artifact for editors/tools; never bundled
//
//   deno task gen:config-schema   # regenerate both (also runs inside `deno task docs:api`)
//
// tests/config-schema.test.ts re-runs `generate()` and fails when either file is stale.
// Zero-npm: only `deno doc` and `deno fmt` (so the output is fmt-stable) are used.
//
// Schema mapping (shallow on purpose — it mirrors what the runtime validator enforces):
//   keyword string/boolean/number → `type`; string/boolean/number literal → `enum`;
//   a union of literals → one `enum`, a union of mappable members → `anyOf`; arrays →
//   `type: array` (+ `items`); a locally declared interface → `type: object` with its
//   properties (recursively); a local type alias → its target. Anything else (imported
//   types, conditional/intersection types) keeps only its JSDoc `description` — the
//   schema never claims a shape the type doesn't spell out.
//   Three shapes the config surface leans on are described too, each carrying an
//   `x-denext` marker so a form renderer can tell them from a plain array/object:
//     * a THUNK whose return type resolves to `T[]` (`redirects: () => RedirectRule[] |
//       Promise<RedirectRule[]>`) → that array's schema + `x-denext.wrapper: "function"`.
//       Any other function type (`commands[].run`, `live.*`) still maps to `{}`.
//     * the standard generics `Array`/`ReadonlyArray` (→ array), `Promise`/`Readonly`
//       (→ unwrapped), `Partial` (→ unwrapped, nothing required).
//     * a MAP — `Record<K, V>`, a mapped type, or an inline index signature → an open
//       `type: object` whose `additionalProperties` is the value schema, plus
//       `x-denext.widget: "map"`.
//   `default` / `minimum` / `maximum` are emitted only from explicit `@default`,
//   `@minimum` and `@maximum` JSDoc tags (added where config-validate.ts enforces that
//   exact bound); nothing is ever inferred from a type or a prose description.
//   `additionalProperties: false` is set exactly where the runtime WARNS on unknown keys
//   (the root and `experimental`); nested objects are left open, as the loader passes
//   them through untouched. Descriptions are the first JSDoc paragraph, verbatim except
//   for `{@link}` markup.

/** The repo root (this script lives in `scripts/`). */
const ROOT = new URL("../", import.meta.url).pathname;
/** The module whose `DenextConfig` / `ExperimentalConfig` interfaces are the source. */
import { denoDocJson } from "./deno-doc.ts";

export const CONFIG_SOURCE = `${ROOT}src/server/config.ts`;
/** Sibling modules whose exported interfaces `DenextConfig` fields reference. */
const CONFIG_TYPE_SOURCES = [
  new URL("../src/server/i18n.ts", import.meta.url).pathname,
  new URL("../src/server/segment-config.ts", import.meta.url).pathname,
  new URL("../src/server/cache.ts", import.meta.url).pathname,
  new URL("../src/plugin/mod.ts", import.meta.url).pathname,
];
/** Output: the import-free runtime key list. */
export const KEYS_OUT = `${ROOT}src/server/config-keys.generated.ts`;
/** Output: the JSON Schema. */
export const SCHEMA_OUT = `${ROOT}denext.config.schema.json`;

/** A `deno doc --json` type node (`value` is shaped per `kind`). */
export interface DocType {
  kind: string;
  repr?: string;
  value?: unknown;
}
/** One JSDoc tag as `deno doc --json` reports it (custom tags arrive verbatim). */
export interface DocTag {
  kind: string;
  /** The raw tag text (e.g. `"@minimum 1"`) for tags deno doc doesn't model. */
  value?: string;
}
/** An interface property (or method) as `deno doc --json` reports it. */
export interface DocProp {
  name: string;
  optional?: boolean;
  tsType?: DocType;
  jsDoc?: { doc?: string; tags?: DocTag[] };
  location?: { line?: number };
}
/** One declaration of a documented symbol. */
export interface DocDecl {
  kind: string;
  jsDoc?: { doc?: string };
  def?: { properties?: DocProp[]; methods?: DocProp[]; tsType?: DocType };
}
/** The symbols of a module, keyed by exported name (first declaration wins). */
export type SymbolTable = Map<string, DocDecl>;
/** A JSON Schema fragment (draft 2020-12 subset). */
export type Schema = Record<string, unknown>;

/** Resolution context for the type → schema mapping. */
export interface SchemaContext {
  /** The documented symbols of the config module (for local `typeRef`s). */
  table: SymbolTable;
  /** Interface names being expanded (cycle guard). */
  stack: string[];
}

/** Flatten a v2 `deno doc --json` document (`{ nodes: { url: { symbols } } }`) to a table. */
export function symbolTable(docJson: unknown): SymbolTable {
  const nodes = (docJson as { nodes?: Record<string, { symbols?: unknown[] }> }).nodes ?? {};
  const table: SymbolTable = new Map();
  for (const node of Object.values(nodes)) {
    for (const sym of node.symbols ?? []) {
      const { name, declarations } = sym as { name: string; declarations?: DocDecl[] };
      const decl = declarations?.[0];
      if (decl && !table.has(name)) table.set(name, decl);
    }
  }
  return table;
}

/** The properties (and methods) of interface `name`, in declaration order. */
export function interfaceProps(table: SymbolTable, name: string): DocProp[] {
  const decl = table.get(name);
  if (!decl || decl.kind !== "interface") {
    throw new Error(`interface \`${name}\` not found in ${CONFIG_SOURCE}`);
  }
  const line = (p: DocProp) => p.location?.line ?? 0;
  return [...(decl.def?.properties ?? []), ...(decl.def?.methods ?? [])]
    .sort((a, b) => line(a) - line(b));
}

/**
 * The first JSDoc paragraph as one line, with `{@link Target | label}` reduced to its
 * label (or target). Backticks are kept — editors render them fine and stripping them
 * would garble code-ish text like `"spa"`.
 */
export function description(doc: string | undefined): string {
  return (doc ?? "")
    .split(/\n\s*\n/)[0]
    .replace(/\{@link(?:code|plain)?\s+([^}]+)\}/g, (_m, body: string) => {
      const pipe = body.indexOf("|");
      return (pipe >= 0 ? body.slice(pipe + 1) : body).trim().replace(/#/g, ".");
    })
    .replace(/\s+/g, " ")
    .trim();
}

const KEYWORD_TYPES: Record<string, string> = {
  string: "string",
  boolean: "boolean",
  number: "number",
  null: "null",
};

/** `string` / `boolean` / `number` / `null` → `type`; other keywords are unconstrained. */
function keywordSchema(t: DocType): Schema {
  const type = KEYWORD_TYPES[String(t.value)];
  return type ? { type } : {};
}

/** A string/boolean/number literal → a one-value `enum`. */
function literalSchema(t: DocType): Schema {
  const v = t.value as { kind: string } & Record<string, unknown>;
  const lit = v?.[v.kind];
  return typeof lit === "string" || typeof lit === "boolean" || typeof lit === "number"
    ? { enum: [lit] }
    : {};
}

/** All-literal union → one `enum`; all-mappable → `anyOf`; otherwise unconstrained. */
function unionSchema(t: DocType, ctx: SchemaContext): Schema {
  const members = (t.value as DocType[]).map((m) => tsTypeToSchema(m, ctx));
  if (members.some((m) => Object.keys(m).length === 0)) return {};
  const enums = members.map((m) => m.enum);
  if (enums.every(Array.isArray)) return { enum: enums.flat() };
  return { anyOf: members };
}

/** The denext-specific annotation keyword (an `x-` extension; validators ignore it). */
const EXT = "x-denext";

/** `X[]` → `type: array` with `items` when the element type maps. */
function arraySchema(t: DocType, ctx: SchemaContext): Schema {
  return elementSchema(t.value as DocType, ctx);
}

/** The array schema for element type `el` (`items` is omitted when the element is opaque). */
function elementSchema(el: DocType | undefined, ctx: SchemaContext): Schema {
  const items = tsTypeToSchema(el, ctx);
  return Object.keys(items).length ? { type: "array", items } : { type: "array" };
}

/**
 * A map (`Record<K, V>`, a mapped type, an index signature) → an open object whose values
 * all share one schema. The `x-denext.widget` marker tells a form renderer to offer
 * key/value rows rather than a fixed set of fields; `additionalProperties: {}` honestly
 * says "any value" when the value type itself doesn't map.
 */
function mapSchema(value: DocType | undefined, ctx: SchemaContext): Schema {
  return {
    type: "object",
    additionalProperties: tsTypeToSchema(value, ctx),
    [EXT]: { widget: "map" },
  };
}

/** `Partial<T>` → `T`'s schema with nothing required (the members all became optional). */
function partialSchema(target: DocType | undefined, ctx: SchemaContext): Schema {
  const { required: _dropped, ...rest } = tsTypeToSchema(target, ctx);
  return rest;
}

/**
 * The standard generics the config surface uses, resolved BEFORE the local-symbol lookup:
 * without these a `Record`/`Array`/`Promise` reference would fall through as an opaque
 * builtin and the field would keep only its description.
 */
const GENERIC_SCHEMAS: Record<string, (args: DocType[], ctx: SchemaContext) => Schema> = {
  Array: (args, ctx) => elementSchema(args[0], ctx),
  ReadonlyArray: (args, ctx) => elementSchema(args[0], ctx),
  Promise: (args, ctx) => tsTypeToSchema(args[0], ctx),
  Readonly: (args, ctx) => tsTypeToSchema(args[0], ctx),
  Record: (args, ctx) => mapSchema(args[1], ctx),
  Partial: (args, ctx) => partialSchema(args[0], ctx),
};

/** A reference to a LOCAL interface/alias expands; imported/builtin refs stay open. */
function typeRefSchema(t: DocType, ctx: SchemaContext): Schema {
  const { typeName, resolution, typeParams } = t.value as {
    typeName: string;
    resolution?: { kind: string };
    typeParams?: DocType[];
  };
  const generic = GENERIC_SCHEMAS[typeName];
  if (generic) return generic(typeParams ?? [], ctx);
  // Local refs expand; an imported ref expands too when its declaration was docced into the
  // table (see CONFIG_TYPE_SOURCES); anything else (builtins, foreign packages) stays open.
  if (resolution?.kind === "local" || ctx.table.has(typeName)) return namedSchema(typeName, ctx);
  return {};
}

/** An object type literal; an index signature additionally makes it an open map. */
function typeLiteralSchema(t: DocType, ctx: SchemaContext): Schema {
  const { properties, indexSignatures } = t.value as {
    properties?: DocProp[];
    indexSignatures?: { tsType?: DocType }[];
  };
  const index = indexSignatures?.[0];
  if (!index) return propsSchema(properties, ctx);
  const named = properties?.length ? propsSchema(properties, ctx) : {};
  return { ...named, ...mapSchema(index.tsType, ctx) };
}

/** A function return type, with union members flattened (`A[] | Promise<A[]>` → two). */
function returnedTypes(t: DocType | undefined): DocType[] {
  if (!t) return [];
  return t.kind === "union" ? (t.value as DocType[]).flatMap(returnedTypes) : [t];
}

/**
 * A function-typed field. `redirects`/`rewrites`/`headers` are thunks returning the rule
 * array denext resolves once at startup, so the schema describes THAT array (marked
 * `x-denext.wrapper: "function"`, so a writer knows to wrap the literal in `() => …`).
 * Every other function type — a handler like `commands[].run` or the `live.*` hooks —
 * has no serialisable shape and stays unconstrained.
 */
function fnSchema(t: DocType, ctx: SchemaContext): Schema {
  const returns = (t.value as { tsType?: DocType } | undefined)?.tsType;
  for (const member of returnedTypes(returns)) {
    const schema = tsTypeToSchema(member, ctx);
    if (schema.type === "array") return { ...schema, [EXT]: { wrapper: "function" } };
  }
  return {};
}

const SCHEMA_BY_KIND: Record<string, (t: DocType, ctx: SchemaContext) => Schema> = {
  keyword: keywordSchema,
  literal: literalSchema,
  union: unionSchema,
  array: arraySchema,
  typeRef: typeRefSchema,
  typeLiteral: typeLiteralSchema,
  mapped: (t, ctx) => mapSchema((t.value as { tsType?: DocType }).tsType, ctx),
  fnOrConstructor: fnSchema,
};

/** Map one `deno doc` type node to a JSON Schema fragment (`{}` = unconstrained). */
export function tsTypeToSchema(t: DocType | undefined, ctx: SchemaContext): Schema {
  if (!t) return {};
  return (SCHEMA_BY_KIND[t.kind] ?? (() => ({})))(t, ctx);
}

/** A locally declared symbol by name: interface → object schema; alias → its target. */
function namedSchema(name: string, ctx: SchemaContext): Schema {
  const decl = ctx.table.get(name);
  if (!decl || ctx.stack.includes(name)) return {};
  if (decl.kind === "interface") return interfaceSchema(name, ctx);
  if (decl.kind === "typeAlias") return tsTypeToSchema(decl.def?.tsType, ctx);
  return {};
}

/** JSDoc tags that map 1:1 onto a JSON Schema keyword. */
const CONSTRAINT_TAGS = ["default", "minimum", "maximum"] as const;

/**
 * The JSON Schema keywords a property's `@default` / `@minimum` / `@maximum` JSDoc tags
 * spell out. Nothing is inferred: a bound reaches the schema only when the source states
 * it (and, by house rule, only where `config-validate.ts` already enforces it), so the
 * schema can never claim a constraint the runtime does not apply. A tag whose body is not
 * a JSON literal is ignored rather than guessed at.
 *
 * @param tags The property's JSDoc tags, as `deno doc --json` reports them.
 * @returns A schema fragment with the recognized keywords (empty when there are none).
 */
export function constraints(tags: DocTag[] | undefined): Schema {
  const out: Schema = {};
  for (const tag of tags ?? []) {
    const match = /^@([a-z]+)\s+(\S.*)$/.exec(String(tag.value ?? "").trim());
    if (!match) continue;
    const [, name, body] = match;
    if (!CONSTRAINT_TAGS.includes(name as (typeof CONSTRAINT_TAGS)[number])) continue;
    try {
      out[name] = JSON.parse(body.trim());
    } catch {
      // Not a JSON literal (`@default the request's origin`) — describe nothing.
    }
  }
  return out;
}

/** `{ type: "object", properties, required? }` from a property list (open by default). */
function propsSchema(props: DocProp[] | undefined, ctx: SchemaContext): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const p of props ?? []) {
    const desc = description(p.jsDoc?.doc);
    properties[p.name] = {
      ...(desc ? { description: desc } : {}),
      ...tsTypeToSchema(p.tsType, ctx),
      ...constraints(p.jsDoc?.tags),
    };
    if (!p.optional) required.push(p.name); // deno doc omits the flag on required members
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** The object schema of interface `name` (properties + methods, declaration order). */
export function interfaceSchema(name: string, ctx: SchemaContext): Schema {
  const inner = { table: ctx.table, stack: [...ctx.stack, name] };
  return propsSchema(interfaceProps(ctx.table, name), inner);
}

/** The property names of interface `name`, in declaration order. */
export function propertyNames(table: SymbolTable, name: string): string[] {
  return interfaceProps(table, name).map((p) => p.name);
}

/** The JSON Schema document for `DenextConfig` (unformatted JSON text). */
export function renderSchema(table: SymbolTable): string {
  const ctx: SchemaContext = { table, stack: [] };
  const root = interfaceSchema("DenextConfig", ctx);
  const properties = root.properties as Record<string, Schema>;
  // Closed exactly where the runtime validator warns on unknown keys (config-validate.ts).
  const experimental = properties.experimental;
  if (experimental?.properties) experimental.additionalProperties = false;
  const schema: Schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "denext.config",
    description: `${description(table.get("DenextConfig")?.jsDoc?.doc)} ` +
      "Generated from the `DenextConfig` TypeScript type by scripts/gen-config-schema.ts; " +
      "unknown top-level and `experimental.*` keys are rejected here because denext warns " +
      "on them at runtime and ignores them.",
    type: "object",
    properties,
    ...(root.required ? { required: root.required } : {}),
    additionalProperties: false,
  };
  return JSON.stringify(schema, null, 2) + "\n";
}

/** The import-free TS module exporting the key lists (unformatted source text). */
export function renderKeysModule(configKeys: string[], experimentalKeys: string[]): string {
  const list = (keys: string[]) => keys.map((k) => `  ${JSON.stringify(k)},`).join("\n");
  return `// @generated by scripts/gen-config-schema.ts — do not edit.
//
// Derived from the \`DenextConfig\` and \`ExperimentalConfig\` interfaces in ./config.ts via
// \`deno doc --json\`. Regenerate with \`deno task gen:config-schema\` (also part of
// \`deno task docs:api\`); tests/config-schema.test.ts fails when this file is stale.
// Import-free on purpose: it is the runtime validator's and config loader's key list.

/**
 * Every top-level \`DenextConfig\` property name, in declaration order (a readonly tuple,
 * assignable to \`readonly string[]\`). The config loader copies exactly these fields and
 * the validator warns on any other, so a field exists at runtime only if it is listed here —
 * which is why the list is generated from the type rather than maintained by hand.
 */
export const CONFIG_KEYS = [
${list(configKeys)}
] as const;

/**
 * Every \`ExperimentalConfig\` property name — the recognized \`experimental.*\` sub-keys —
 * in declaration order. The validator warns on any other \`experimental.*\` key.
 */
export const EXPERIMENTAL_KEYS = [
${list(experimentalKeys)}
] as const;
`;
}

/** Format generated text with the repo's `deno fmt` settings, so the output is fmt-stable. */
export async function formatWith(text: string, ext: "ts" | "json"): Promise<string> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--config", `${ROOT}deno.json`, "--ext", ext, "-"],
    cwd: ROOT,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = cmd.stdin.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) throw new Error(`deno fmt failed: ${new TextDecoder().decode(stderr)}`);
  return new TextDecoder().decode(stdout);
}

/** Both artifacts, as the exact text the committed files should contain. */
export async function generate(): Promise<{ keysModule: string; schema: string }> {
  // `DenextConfig` references interfaces declared in sibling modules (`I18nConfig`,
  // `CspSetting`, …); doc those too so the schema expands them instead of leaving `{}`.
  const table = symbolTable(await denoDocJson(CONFIG_SOURCE));
  for (const extra of CONFIG_TYPE_SOURCES) {
    for (const [name, decl] of symbolTable(await denoDocJson(extra))) {
      if (!table.has(name)) table.set(name, decl);
    }
  }
  const keys = renderKeysModule(
    propertyNames(table, "DenextConfig"),
    propertyNames(table, "ExperimentalConfig"),
  );
  const [keysModule, schema] = await Promise.all([
    formatWith(keys, "ts"),
    formatWith(renderSchema(table), "json"),
  ]);
  return { keysModule, schema };
}

if (import.meta.main) {
  const { keysModule, schema } = await generate();
  await Deno.writeTextFile(KEYS_OUT, keysModule);
  await Deno.writeTextFile(SCHEMA_OUT, schema);
  console.log(`wrote ${KEYS_OUT}\nwrote ${SCHEMA_OUT}`);
}
