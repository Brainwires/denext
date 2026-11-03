// Renders `deno doc --json` type nodes and interface and class members as TypeScript source, for the API
// reference (scripts/gen-api-reference.ts). Kept free of top-level side effects so
// tests/api-reference.test.ts can import it.

/** A `deno doc` node. The JSON has no published types. */
// deno-lint-ignore no-explicit-any
export type Doc = any;

/** An `@param` tag. */
export interface ApiParam {
  /** The parameter's name. */
  name: string;
  /** Its documentation. */
  doc: string;
}

/** One member of an interface or class, as the reference lists it. */
export interface ApiMember {
  /** What sort of member it is. */
  kind:
    | "constructor"
    | "property"
    | "method"
    | "getter"
    | "setter"
    | "call"
    | "construct"
    | "index";
  /** The member's name; "" for a call, construct or index signature. */
  name: string;
  /** The member as TypeScript source. */
  signature: string;
  /** Its JSDoc prose, if any. */
  doc?: string;
  /** Its `@param` tags, if any. */
  params?: ApiParam[];
  /** Its `@returns` tag, if any. */
  returns?: string;
  /** Set on a class's static member (its signature also starts with `static`). */
  static?: true;
}

/**
 * One `extends` or `implements` entry; `ref` is the `<module slug>/<symbol slug>` of the
 * documented type it names.
 */
export interface ApiParent {
  /** The parent as written, type arguments included. */
  type: string;
  /** Where its entry is. */
  ref?: string;
  /**
   * The name in `type` that `ref` points at, when it is not the head: the type a utility type
   * such as `Omit<X, "k">` takes its members from.
   */
  refName?: string;
}

/**
 * Flatten JSDoc inline markup for a PLAIN-TEXT context (list blurbs, the page lead, the
 * `<meta description>`): `{@link Target | label}` → its label/name, and drop `` `code` ``
 * backticks. The rich per-symbol Description renders `docFull` (kept raw) instead.
 */
export function plainText(s: string): string {
  return s
    .replace(/\{@link(?:code|plain)?\s+([^}]+)\}/g, (_m, body: string) => {
      const pipe = body.indexOf("|");
      const text = (pipe >= 0 ? body.slice(pipe + 1) : body).trim();
      return text.replace(/#/g, ".");
    })
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const tagsOf = (decl: Doc): Doc[] => decl.jsDoc?.tags ?? [];

/** The `@param` tags of a declaration or member. */
export function paramsOf(decl: Doc): ApiParam[] {
  return tagsOf(decl)
    .filter((t) => t.kind === "param" && (t.name || t.doc))
    .map((t) => ({ name: String(t.name ?? ""), doc: plainText(String(t.doc ?? "")) }));
}

/** The `@returns` tag of a declaration or member, or "". */
export function returnsOf(decl: Doc): string {
  const t = tagsOf(decl).find((x) => x.kind === "return");
  return t ? plainText(String(t.doc ?? "")) : "";
}

// deno doc v2 keeps every node's payload under `value`. Its `repr` is the source text for
// keywords and plain references, but EMPTY for a generic reference's arguments and for composites,
// and a string literal's `repr` has lost its quotes, so those are reassembled from their parts.
const TYPE_BY_KIND: Record<string, (t: Doc) => string> = {
  typeRef: (t) => typeRefStr(t),
  union: (t) => joinMembers(t.value, " | ", t),
  intersection: (t) => joinMembers(t.value, " & ", t),
  array: (t) => (t.value ? `${typeStr(t.value)}[]` : fallbackTypeStr(t)),
  tuple: (t) => `[${(t.value ?? []).map(typeStr).join(", ")}]`,
  fnOrConstructor: (t) => (t.value?.params ? fnTypeStr(t.value) : fallbackTypeStr(t)),
  typeLiteral: (t) => (t.value ? typeLiteralStr(t.value) : t.repr || "object"),
  parenthesized: (t) => `(${typeStr(t.value)})`,
  rest: (t) => `...${typeStr(t.value)}`,
  optional: (t) => `${typeStr(t.value)}?`,
  typeOperator: (t) => `${t.value.operator} ${typeStr(t.value.tsType)}`,
  typeQuery: (t) => `typeof ${t.value}`,
  this: () => "this",
  indexedAccess: (t) => `${typeStr(t.value.objType)}[${typeStr(t.value.indexType)}]`,
  conditional: (t) => conditionalStr(t.value),
  infer: (t) => `infer ${t.value.typeParam.name}`,
  mapped: (t) => mappedStr(t.value),
  literal: (t) => literalStr(t.value, t),
  typePredicate: (t) => predicateStr(t.value),
  importType: (t) => importStr(t.value),
};

/** Members joined by `sep`, or the node's own repr when deno doc gave no member list. */
function joinMembers(members: Doc[] | undefined, sep: string, t: Doc): string {
  return Array.isArray(members) ? members.map(typeStr).join(sep) : fallbackTypeStr(t);
}

/** A type node as TypeScript source. */
export function typeStr(t: Doc): string {
  if (!t) return "unknown";
  const render = TYPE_BY_KIND[t.kind];
  return render ? render(t) : fallbackTypeStr(t);
}

/** `repr` when deno doc gives one, else the node kind. */
function fallbackTypeStr(t: Doc): string {
  return t.repr || t.kind || "unknown";
}

function typeRefStr(t: Doc): string {
  const ref = t.value ?? t.typeRef ?? {};
  return `${refName(ref, t)}${typeArgsStr(ref.typeParams)}`;
}

function refName(ref: Doc, t: Doc): string {
  return ref.typeName ?? t.repr ?? "unknown";
}

/** `<A, B>` for a generic reference's type arguments, or "". */
function typeArgsStr(typeParams: Doc[] | undefined): string {
  return typeParams?.length ? `<${typeParams.map(typeStr).join(", ")}>` : "";
}

function fnTypeStr(f: Doc): string {
  const prefix = f.constructor === true ? "new " : "";
  return `${prefix}${typeParamsStr(f)}(${paramsStr(f.params)}) => ${typeStr(f.tsType)}`;
}

function conditionalStr(c: Doc): string {
  const test = `${typeStr(c.checkType)} extends ${typeStr(c.extendsType)}`;
  return `${test} ? ${typeStr(c.trueType)} : ${typeStr(c.falseType)}`;
}

/** The `+readonly` / `-?` style modifier deno doc reports as `true`, `"+"` or `"-"`. */
function mappedModifier(value: unknown, word: string): string {
  return value === true ? word : typeof value === "string" ? `${value}${word}` : "";
}

function mappedStr(m: Doc): string {
  const readonly = mappedModifier(m.readonly, "readonly");
  const as = m.nameType ? ` as ${typeStr(m.nameType)}` : "";
  const key = `[${m.typeParam.name} in ${typeStr(m.typeParam.constraint)}${as}]`;
  const optional = mappedModifier(m.optional, "?");
  return `{ ${readonly ? `${readonly} ` : ""}${key}${optional}: ${typeStr(m.tsType)} }`;
}

/** A literal type: a string keeps its quotes, a template its backticks. */
function literalStr(value: Doc, t: Doc): string {
  const render = LITERAL_BY_KIND[value?.kind];
  return render ? render(value) : fallbackTypeStr(t);
}

const LITERAL_BY_KIND: Record<string, (value: Doc) => string> = {
  string: (v) => JSON.stringify(v.string),
  number: (v) => String(v.number),
  boolean: (v) => String(v.boolean),
  template: (v) => templateStr(v.tsTypes ?? []),
};

/** `` `a${T}b` ``: deno doc alternates literal text and `${…}` holes. */
function templateStr(parts: Doc[]): string {
  const body = parts.map((p, i) => i % 2 === 0 ? (p.value?.string ?? "") : `\${${typeStr(p)}}`);
  return `\`${body.join("")}\``;
}

function predicateStr(p: Doc): string {
  const subject = p.param?.type === "this" ? "this" : (p.param?.name ?? "value");
  const is = p.type ? ` is ${typeStr(p.type)}` : "";
  return `${p.asserts ? "asserts " : ""}${subject}${is}`;
}

function importStr(i: Doc): string {
  const qualifier = i.qualifier ? `.${i.qualifier}` : "";
  return `import(${JSON.stringify(i.specifier)})${qualifier}${typeArgsStr(i.typeParams)}`;
}

/** `{ a: string; b?: number }`, one line. */
function typeLiteralStr(lit: Doc): string {
  const members = literalMembers(lit).map((m) => m.signature);
  return members.length ? `{ ${members.join("; ")} }` : "{}";
}

/** The identifier of a destructured parameter, by pattern kind. */
const PATTERN_NAMES: Record<string, string> = { object: "options", array: "items" };

/**
 * One parameter as `name?: Type`. deno doc encodes a defaulted parameter as
 * `{ kind: "assign", left, right }`, a rest parameter as `{ kind: "rest", arg }`, and a
 * destructured one as `{ kind: "object" | "array" }` — none of which carry `name` directly.
 */
export function paramStr(p: Doc): string {
  if (!p) return "_: unknown";
  if (p.kind === "assign") return optionalize(paramStr(inner(p.left, p)));
  if (p.kind === "rest") return `...${paramStr(inner(p.arg, p))}`;
  return plainParamStr(p);
}

/** A parameter list, without its parentheses. */
function paramsStr(params: Doc[] | undefined): string {
  return (params ?? []).map(paramStr).join(", ");
}

/** `name?: Type` for an identifier or destructuring-pattern parameter. */
function plainParamStr(p: Doc): string {
  const name = p.name ?? PATTERN_NAMES[p.kind] ?? "_";
  return `${name}${p.optional ? "?" : ""}: ${typeStr(p.tsType)}`;
}

/** A wrapped parameter node with the wrapper's type annotation when its own is missing. */
function inner(node: Doc, wrapper: Doc): Doc {
  return { ...node, tsType: node?.tsType ?? wrapper.tsType };
}

/** `name: T` → `name?: T` (a defaulted parameter is optional to callers). */
function optionalize(sig: string): string {
  return sig.includes("?:") ? sig : sig.replace(/: /, "?: ");
}

/** `<T, U>` for a declaration's type parameters, or "". */
export function typeParamsStr(def: Doc): string {
  const tp = (def.typeParams ?? []).map((p: { name: string }) => p.name);
  return tp.length ? `<${tp.join(", ")}>` : "";
}

/** A member name as source: `[Symbol.iterator]` when computed, quoted when not an identifier. */
function memberKey(m: Doc): string {
  const name = String(m.name);
  if (m.computed) return name.startsWith("[") ? name : `[${name}]`;
  return /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(name) ? name : JSON.stringify(name);
}

const optionalMark = (m: Doc): string => m.optional ? "?" : "";
const readonlyMark = (m: Doc): string => m.readonly ? "readonly " : "";

function propertySignature(p: Doc): string {
  return `${readonlyMark(p)}${memberKey(p)}${optionalMark(p)}: ${typeStr(p.tsType)}`;
}

/** The part of a signature after its name: `<T>(a: A): R`. */
function callableSuffix(m: Doc): string {
  return `${typeParamsStr(m)}(${paramsStr(m.params)}): ${typeStr(m.returnType ?? m.tsType)}`;
}

function methodSignature(m: Doc): string {
  if (m.kind === "getter") return `get ${memberKey(m)}(): ${typeStr(m.returnType)}`;
  if (m.kind === "setter") return `set ${memberKey(m)}(${paramsStr(m.params)})`;
  return `${memberKey(m)}${optionalMark(m)}${callableSuffix(m)}`;
}

function indexSignature(i: Doc): string {
  return `${readonlyMark(i)}[${paramsStr(i.params)}]: ${typeStr(i.tsType)}`;
}

const METHOD_KINDS: Record<string, ApiMember["kind"]> = { getter: "getter", setter: "setter" };

/** A member entry with only the doc fields it has, so the reference stays small. */
function member(
  kind: ApiMember["kind"],
  name: string,
  signature: string,
  node: Doc,
): ApiMember {
  const out: ApiMember = { kind, name, signature };
  const doc = String(node.jsDoc?.doc ?? "").trim();
  if (doc) out.doc = doc;
  const params = paramsOf(node);
  if (params.length) out.params = params;
  const returns = returnsOf(node);
  if (returns) out.returns = returns;
  return out;
}

/** The members an interface or type literal declares, in source-kind order. */
function literalMembers(def: Doc): ApiMember[] {
  return [
    ...(def.callSignatures ?? []).map((c: Doc) => member("call", "", callableSuffix(c), c)),
    ...(def.constructSignatures ?? def.constructors ?? []).map((c: Doc) =>
      member("construct", "", `new ${callableSuffix(c)}`, c)
    ),
    ...(def.indexSignatures ?? []).map((i: Doc) => member("index", "", indexSignature(i), i)),
    ...(def.properties ?? []).map((p: Doc) =>
      member("property", String(p.name), propertySignature(p), p)
    ),
    ...(def.methods ?? []).map((m: Doc) =>
      member(METHOD_KINDS[m.kind] ?? "method", String(m.name), methodSignature(m), m)
    ),
  ];
}

/**
 * Every member an interface declares itself, signature and docs. Inherited members stay on the
 * parent's own entry: copying them down would repeat each parent once per child.
 */
export function interfaceMembers(def: Doc): ApiMember[] {
  return literalMembers(def);
}

/** The rendered `extends` clause entries of an interface. */
export function extendsOf(def: Doc): string[] {
  return (def.extends ?? []).map(typeStr);
}

/** An interface declaration's members and parents, each only when it has some; {} for any other kind. */
export function interfaceDetail(decl: Doc): { members?: ApiMember[]; extends?: ApiParent[] } {
  if (decl.kind !== "interface") return {};
  const def = decl.def ?? {};
  const members = interfaceMembers(def);
  const parents = extendsOf(def);
  return {
    ...(members.length ? { members } : {}),
    ...(parents.length ? { extends: parents.map((type) => ({ type })) } : {}),
  };
}

/**
 * A class's own public members: constructors, properties, methods and accessors, each static one
 * marked. Private members (`private` or `#name`) and inherited ones are left out.
 */
export function classMembers(def: Doc): ApiMember[] {
  return [
    ...callable(def.constructors).map((c) =>
      classMember("constructor", "constructor", `constructor(${paramsStr(c.params)})`, c)
    ),
    ...(def.indexSignatures ?? []).map((i: Doc) => member("index", "", indexSignature(i), i)),
    ...publicOnly(def.properties).map((p) =>
      classMember("property", String(p.name), propertySignature(p), p)
    ),
    // A class method keeps its parameters and return type under `functionDef`.
    ...callable((def.methods ?? []).map((m: Doc) => ({ ...m, ...m.functionDef }))).map((m) =>
      classMember(METHOD_KINDS[m.kind] ?? "method", String(m.name), methodSignature(m), m)
    ),
  ];
}

/**
 * The public constructors or methods a caller sees: an overloaded one's overload signatures, not
 * the implementation signature behind them (the one with a body, which TypeScript hides).
 */
function callable(members: Doc[] | undefined): Doc[] {
  const visible = publicOnly(members);
  const key = (m: Doc) => `${m.isStatic ? "static " : ""}${m.kind ?? ""} ${m.name}`;
  const overloaded = new Set(visible.filter((m) => !m.hasBody).map(key));
  return visible.filter((m) => !(m.hasBody && overloaded.has(key(m))));
}

/** The members a caller can reach: not `private`, not a `#private` name. */
function publicOnly(members: Doc[] | undefined): Doc[] {
  return (members ?? []).filter((m) =>
    m.accessibility !== "private" && !String(m.name).startsWith("#")
  );
}

/** A class member entry, its signature led by its `protected` / `static` / `abstract` modifiers. */
function classMember(
  kind: ApiMember["kind"],
  name: string,
  signature: string,
  node: Doc,
): ApiMember {
  const modifiers = [
    node.accessibility === "protected" ? "protected " : "",
    node.isStatic ? "static " : "",
    node.isAbstract ? "abstract " : "",
  ].join("");
  const out = member(kind, name, `${modifiers}${signature}`, node);
  if (node.isStatic) out.static = true;
  return out;
}

/** A class's `extends` parent (type arguments included) and its `implements` entries. */
export function classParents(def: Doc): { extends: string[]; implements: string[] } {
  const base = typeof def.extends === "string" && def.extends
    ? [`${def.extends}${typeArgsStr(def.superTypeParams)}`]
    : [];
  return { extends: base, implements: (def.implements ?? []).map(typeStr) };
}

/** A class declaration's members and parents, each only when it has some; {} for any other kind. */
export function classDetail(
  decl: Doc,
): { members?: ApiMember[]; extends?: ApiParent[]; implements?: ApiParent[] } {
  if (decl.kind !== "class") return {};
  const def = decl.def ?? {};
  const members = classMembers(def);
  const parents = classParents(def);
  const entries = (types: string[]) => types.map((type) => ({ type }));
  return {
    ...(members.length ? { members } : {}),
    ...(parents.extends.length ? { extends: entries(parents.extends) } : {}),
    ...(parents.implements.length ? { implements: entries(parents.implements) } : {}),
  };
}

/** The parts of a reference group {@linkcode linkParents} reads. */
export interface ParentGroup {
  /** The module's name. */
  module: string;
  /** Its symbols. */
  symbols: { name: string; slug: string; extends?: ApiParent[]; implements?: ApiParent[] }[];
}

/** Each of a group's symbols as `[name, "<module slug>/<symbol slug>"]`. */
function symbolRefs(g: ParentGroup): [string, string][] {
  const module = g.module.replace(/\//g, "-");
  return g.symbols.map((s) => [s.name, `${module}/${s.slug}`]);
}

/** A utility type whose members come from its first type argument, and that argument's name. */
const MEMBER_SOURCE =
  /^(?:Omit|Pick|Partial|Required|Readonly)<\s*([\p{ID_Start}$_][\p{ID_Continue}$]*)/u;

/** The name a parent's members come from: `X` for `X<T>`, and for `Omit<X, "k">` too. */
function memberSource(type: string): { name: string; wrapped: boolean } {
  const inner = MEMBER_SOURCE.exec(type)?.[1];
  return inner
    ? { name: inner, wrapped: true }
    : { name: type.replace(/<.*$/s, ""), wrapped: false };
}

/**
 * Point each `extends` / `implements` entry at the parent's page: the same module's symbol first,
 * else the first module that documents the name. A utility type (`Omit<X, "k">`, `Partial<X>`)
 * links the type it takes its members from. A lib type (`Error`, `Iterable<T>`) that no module
 * exports stays plain text.
 */
export function linkParents(groups: ParentGroup[]): void {
  const anywhere = new Map(groups.flatMap(symbolRefs).reverse());
  for (const g of groups) {
    const local = new Map(symbolRefs(g));
    for (const parent of g.symbols.flatMap((s) => [...s.extends ?? [], ...s.implements ?? []])) {
      const { name, wrapped } = memberSource(parent.type);
      const ref = local.get(name) ?? anywhere.get(name);
      if (!ref) continue;
      parent.ref = ref;
      if (wrapped) parent.refName = name;
    }
  }
}
