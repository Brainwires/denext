// The TypeScript-type → JSON-Schema mapper shared by the doc-driven generators:
// `scripts/gen-config-schema.ts` (the `DenextConfig` schema) and
// `scripts/gen-plugin-catalog.ts` (each first-party plugin's options schema). Pure
// functions over `deno doc --json` nodes plus a context carrying the symbol table, so both
// generators describe a type the same way and cannot drift apart.
//
// Mapping (shallow on purpose: it describes only what the type spells out):
//   keyword string/boolean/number → `type`; string/boolean/number literal → `enum`;
//   a union of literals → one `enum`, a union of mappable members → `anyOf`; arrays (and
//   `readonly T[]`) → `type: array` (+ `items`); a documented interface → `type: object`
//   with its properties (recursively); a documented type alias → its target. Anything else
//   (a type from another package or npm, conditional/intersection types) keeps only its
//   JSDoc `description`: the schema never claims a shape the type doesn't spell out.
//   Shapes described beyond that:
//     * a THUNK whose return type resolves to `T[]` (`redirects: () => RedirectRule[] |
//       Promise<RedirectRule[]>`) → that array's schema + `x-denext.wrapper: "function"`.
//       Any other function type (`commands[].run`, `live.*`) still maps to `{}`.
//     * the standard generics `Array`/`ReadonlyArray` (→ array), `Promise`/`Readonly`
//       (→ unwrapped), `Partial` (→ unwrapped, nothing required).
//     * a MAP (`Record<K, V>`, a mapped type, or an inline index signature) → an open
//       `type: object` whose `additionalProperties` is the value schema. No marker: a form
//       renderer recognises a map structurally, from a non-empty `additionalProperties`.
//   Per-property JSDoc tags: `@default` / `@minimum` / `@maximum` become the matching
//   keyword (a JSON-literal body only), and `@widget textarea` becomes
//   `x-denext.widget: "textarea"` (any other widget name is ignored). Nothing is inferred
//   from a type or a prose description. Descriptions are the first JSDoc paragraph,
//   verbatim except for `{@link}` markup.

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
  /** The tag's prose, for a tag deno doc DOES model (`@deprecated`). */
  doc?: string;
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
  /** The documented symbols of the source module(s) (for local `typeRef`s). */
  table: SymbolTable;
  /** Interface names being expanded (cycle guard; its length is the nesting depth). */
  stack: string[];
  /**
   * How many interfaces deep a reference may still expand; a deeper one maps to `{}`.
   * Unset means unbounded (the config schema). The plugin catalog caps it so an options
   * type that reaches a large object graph cannot balloon the committed JSON.
   */
  maxDepth?: number;
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
    throw new Error(`interface \`${name}\` not found in the documented symbols`);
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
 * all share one schema. A form renderer offers key/value rows when that value schema says
 * something; `additionalProperties: {}` honestly says "any value" when the value type
 * itself doesn't map (and such a map stays read-only there).
 */
function mapSchema(value: DocType | undefined, ctx: SchemaContext): Schema {
  return { type: "object", additionalProperties: tsTypeToSchema(value, ctx) };
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

/**
 * True for a reference imported by a bare or remote specifier (`npm:effect/Layer`,
 * `jsr:…`, `@denext/denext/server`): a type owned by another package, whose shape this
 * generator does not own and must not claim, even when a re-export put a same-named
 * symbol into the table.
 */
function isForeign(resolution: { kind: string; specifier?: string } | undefined): boolean {
  if (resolution?.kind !== "import") return false;
  return !/^\.{1,2}\//.test(resolution.specifier ?? "");
}

/** A reference to a LOCAL interface/alias expands; foreign/builtin refs stay open. */
function typeRefSchema(t: DocType, ctx: SchemaContext): Schema {
  const { typeName, resolution, typeParams } = t.value as {
    typeName: string;
    resolution?: { kind: string; specifier?: string };
    typeParams?: DocType[];
  };
  const generic = GENERIC_SCHEMAS[typeName];
  if (generic) return generic(typeParams ?? [], ctx);
  if (isForeign(resolution)) return {};
  // Local refs expand; a relatively imported ref expands too when its declaration was
  // docced into the table (a sibling source module); builtins stay open.
  if (resolution?.kind === "local" || ctx.table.has(typeName)) return namedSchema(typeName, ctx);
  return {};
}

/** `readonly T[]` → `T[]`'s schema; any other type operator (`keyof`, `unique`) stays open. */
function typeOperatorSchema(t: DocType, ctx: SchemaContext): Schema {
  const { operator, tsType } = t.value as { operator?: string; tsType?: DocType };
  return operator === "readonly" ? tsTypeToSchema(tsType, ctx) : {};
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
  typeOperator: typeOperatorSchema,
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
  if (ctx.maxDepth !== undefined && ctx.stack.length >= ctx.maxDepth) return {};
  if (decl.kind === "interface") return interfaceSchema(name, ctx);
  // An alias joins the cycle guard like an interface does: `type Tree = { children: Tree[] }`
  // would otherwise expand itself until the stack overflows.
  if (decl.kind === "typeAlias") {
    return tsTypeToSchema(decl.def?.tsType, { ...ctx, stack: [...ctx.stack, name] });
  }
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

/**
 * What a property's `@deprecated` tag says, or `undefined` when it carries none.
 *
 * Unlike `@default` and friends, deno doc MODELS this tag: it arrives as
 * `{ kind: "deprecated", doc }` rather than as raw `@tag body` text, so it is read by kind
 * rather than by the pattern {@link constraints} uses.
 *
 * @param tags The property's JSDoc tags, as `deno doc --json` reports them.
 * @returns The tag's prose (empty string when the tag is present but says nothing).
 */
export function deprecation(tags: DocTag[] | undefined): string | undefined {
  for (const tag of tags ?? []) {
    if (tag.kind === "deprecated") return description(tag.doc ?? "");
  }
  return undefined;
}

/** The only form-widget hints a `@widget` tag may name (what the UI renders specially). */
const WIDGET_HINTS: ReadonlySet<string> = new Set(["textarea"]);

/**
 * The form-widget hint a property's `@widget <name>` JSDoc tag asks for, or `undefined`.
 * Only a name in {@link WIDGET_HINTS} counts: an unknown one is ignored (never a throw), so
 * a typo degrades to the structural default instead of breaking generation.
 *
 * @param tags The property's JSDoc tags, as `deno doc --json` reports them.
 * @returns `"textarea"` when the tag asks for it; otherwise `undefined`.
 */
export function widgetHint(tags: DocTag[] | undefined): string | undefined {
  for (const tag of tags ?? []) {
    const match = /^@widget\s+(\S+)\s*$/.exec(String(tag.value ?? "").trim());
    if (match && WIDGET_HINTS.has(match[1])) return match[1];
  }
  return undefined;
}

/** One property's schema: description, type, tag constraints, and any widget hint. */
function propertySchema(p: DocProp, ctx: SchemaContext): Schema {
  const gone = deprecation(p.jsDoc?.tags);
  // A block that is ONLY `@deprecated` leaves no summary paragraph, so the key reached the
  // editor with no help text at all beside the key that replaced it. The tag's own prose says
  // what to use instead, which is exactly what someone looking at the old name needs.
  const desc = description(p.jsDoc?.doc) || (gone ? `Deprecated. ${gone}` : "");
  const schema: Schema = {
    ...(desc ? { description: desc } : {}),
    ...(gone === undefined ? {} : { deprecated: true }),
    ...tsTypeToSchema(p.tsType, ctx),
    ...constraints(p.jsDoc?.tags),
  };
  const widget = widgetHint(p.jsDoc?.tags);
  if (widget) schema[EXT] = { ...(schema[EXT] as Schema | undefined), widget };
  return schema;
}

/** `{ type: "object", properties, required? }` from a property list (open by default). */
function propsSchema(props: DocProp[] | undefined, ctx: SchemaContext): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const p of props ?? []) {
    properties[p.name] = propertySchema(p, ctx);
    if (!p.optional) required.push(p.name); // deno doc omits the flag on required members
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** The object schema of interface `name` (properties + methods, declaration order). */
export function interfaceSchema(name: string, ctx: SchemaContext): Schema {
  const inner = { ...ctx, stack: [...ctx.stack, name] };
  return propsSchema(interfaceProps(ctx.table, name), inner);
}

/** The property names of interface `name`, in declaration order. */
export function propertyNames(table: SymbolTable, name: string): string[] {
  return interfaceProps(table, name).map((p) => p.name);
}
