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
//   properties (recursively); a local type alias → its target. Anything else (functions,
//   imported types, generics) keeps only its JSDoc `description` — the schema never
//   claims a shape the type doesn't spell out.
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
/** An interface property (or method) as `deno doc --json` reports it. */
export interface DocProp {
  name: string;
  optional?: boolean;
  tsType?: DocType;
  jsDoc?: { doc?: string };
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

/** `X[]` → `type: array` with `items` when the element type maps. */
function arraySchema(t: DocType, ctx: SchemaContext): Schema {
  const items = tsTypeToSchema(t.value as DocType, ctx);
  return Object.keys(items).length ? { type: "array", items } : { type: "array" };
}

/** A reference to a LOCAL interface/alias expands; imported/builtin refs stay open. */
function typeRefSchema(t: DocType, ctx: SchemaContext): Schema {
  const { typeName, resolution } = t.value as {
    typeName: string;
    resolution?: { kind: string };
  };
  // Local refs expand; an imported ref expands too when its declaration was docced into the
  // table (see CONFIG_TYPE_SOURCES); anything else (builtins, foreign packages) stays open.
  if (resolution?.kind === "local" || ctx.table.has(typeName)) return namedSchema(typeName, ctx);
  return {};
}

const SCHEMA_BY_KIND: Record<string, (t: DocType, ctx: SchemaContext) => Schema> = {
  keyword: keywordSchema,
  literal: literalSchema,
  union: unionSchema,
  array: arraySchema,
  typeRef: typeRefSchema,
  typeLiteral: (t, ctx) => propsSchema((t.value as { properties?: DocProp[] }).properties, ctx),
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

/** `{ type: "object", properties, required? }` from a property list (open by default). */
function propsSchema(props: DocProp[] | undefined, ctx: SchemaContext): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const p of props ?? []) {
    const desc = description(p.jsDoc?.doc);
    properties[p.name] = {
      ...(desc ? { description: desc } : {}),
      ...tsTypeToSchema(p.tsType, ctx),
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
