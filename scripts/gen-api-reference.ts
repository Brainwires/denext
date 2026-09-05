// Generate the in-site API reference from `deno doc --json`.
// Runs deno doc over denext's first-party public entry points and emits a compact
// JSON the docs site (apps/web) renders at /docs/api as static 0-KB-JS HTML.
//
//   deno task docs:api      # regenerate reference.json
//   deno task docs:build    # regenerate + export the site
//
// `deno doc --lint` (deno task doc-lint) enforces that every public symbol carries
// JSDoc, so this reference is complete — a blank JSDoc would show as a blank entry.
//
// Each symbol also records:
//   • `docFull` / `params` / `returns` / `examples` — the FULL JSDoc, for the
//     per-symbol detail page (`/docs/api/[module]/[symbol]`).
//   • `denextOnly` — true when no React/Next/Remix export shares the name, i.e. a
//     migrating dev has no upstream API to look at. Sourced from the committed parity
//     baseline so the docs build needs no npm install.
//   • `slug` — a case-insensitively-unique URL segment (macOS's case-insensitive FS
//     would otherwise clobber e.g. `draftMode` vs `DraftMode` on static export).

import { denoDocJson } from "./deno-doc.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = `${ROOT}apps/web/app/docs/api/reference.json`;
const PARITY_BASELINE = `${ROOT}tests/fixtures/react-surface.baseline.json`;

// The first-party public API surface, in the order it appears in the reference.
// (The compat shims — `next/*`, `react-dom/*`, `next-intl/*` — mirror React/Next's
// own APIs and are documented there, so they're intentionally omitted here.)
const ENTRIES: { module: string; file: string }[] = [
  { module: "denext", file: `${ROOT}mod.ts` },
  { module: "denext/server", file: `${ROOT}src/server/mod.ts` },
  { module: "denext/client", file: `${ROOT}src/client/mod.ts` },
  { module: "denext/devtools", file: `${ROOT}src/devtools.ts` },
  { module: "denext/testing", file: `${ROOT}src/testing/mod.ts` },
  { module: "denext/live", file: `${ROOT}src/live.ts` },
  { module: "denext/lazy", file: `${ROOT}src/lazy.ts` },
  { module: "denext/desktop", file: `${ROOT}src/build/desktop.ts` },
  { module: "denext/cli/command", file: `${ROOT}src/cli/command.ts` },
];

interface Param {
  name: string;
  doc: string;
}
interface Symbol {
  name: string;
  slug: string;
  kind: string;
  signature: string;
  doc: string;
  docFull: string;
  params: Param[];
  returns: string;
  examples: string[];
  denextOnly: boolean;
}
interface Group {
  module: string;
  symbols: Symbol[];
}

// deno doc represents a type as `{ repr, kind, ... }`. `repr` is the source text for most
// nodes but is EMPTY for a generic reference (`Promise<T>` → repr "Promise", typeParams
// separate) and for composites, so those are reassembled from their parts.
// deno-lint-ignore no-explicit-any
type Doc = any;

// deno doc v2 keeps every node's payload under `value` (union members, the array element,
// the typeRef's `typeName`/`typeParams`, the function shape).
const TYPE_BY_KIND: Record<string, (t: Doc) => string> = {
  typeRef: (t) => typeRefStr(t),
  union: (t) => joinMembers(t.value, " | ", t),
  intersection: (t) => joinMembers(t.value, " & ", t),
  array: (t) => (t.value ? `${typeStr(t.value)}[]` : fallbackTypeStr(t)),
  fnOrConstructor: (t) => (t.value?.params ? fnTypeStr(t.value) : fallbackTypeStr(t)),
  typeLiteral: (t) => t.repr || "object",
};

/** Members joined by `sep`, or the node's own repr when deno doc gave no member list. */
function joinMembers(members: Doc[] | undefined, sep: string, t: Doc): string {
  return Array.isArray(members) ? members.map(typeStr).join(sep) : fallbackTypeStr(t);
}

function typeStr(t: Doc): string {
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
  const params = (f.params ?? []).map(paramStr).join(", ");
  return `(${params}) => ${typeStr(f.tsType)}`;
}

/** The identifier of a destructured parameter, by pattern kind. */
const PATTERN_NAMES: Record<string, string> = { object: "options", array: "items" };

/**
 * One parameter as `name?: Type`. deno doc encodes a defaulted parameter as
 * `{ kind: "assign", left, right }`, a rest parameter as `{ kind: "rest", arg }`, and a
 * destructured one as `{ kind: "object" | "array" }` — none of which carry `name` directly.
 */
function paramStr(p: Doc): string {
  if (!p) return "_: unknown";
  if (p.kind === "assign") return optionalize(paramStr(inner(p.left, p)));
  if (p.kind === "rest") return `...${paramStr(inner(p.arg, p))}`;
  return plainParamStr(p);
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

// deno-lint-ignore no-explicit-any
type Decl = any;

/** `name<T>(a: A, b?: B): R` and friends, per declaration kind. */
const SIGNATURES: Record<string, (name: string, def: Decl, tp: string) => string> = {
  function: (name, def, tp) => {
    const params = (def.params ?? []).map(paramStr).join(", ");
    return `${name}${tp}(${params}): ${typeStr(def.returnType)}`;
  },
  variable: (name, def) => `${name}: ${typeStr(def.tsType)}`,
  typeAlias: (name, def, tp) => `type ${name}${tp} = ${typeStr(def.tsType)}`,
  interface: (name, _def, tp) => `interface ${name}${tp}`,
  class: (name, _def, tp) => `class ${name}${tp}`,
  enum: (name) => `enum ${name}`,
};

function signatureOf(name: string, decl: Decl): string {
  const def = decl.def ?? {};
  const render = SIGNATURES[decl.kind] ?? ((n: string) => n);
  return render(name, def, typeParamsStr(def));
}

/** `<T, U>` for a declaration's type parameters, or "". */
function typeParamsStr(def: Decl): string {
  const tp = (def.typeParams ?? []).map((p: { name: string }) => p.name);
  return tp.length ? `<${tp.join(", ")}>` : "";
}

/**
 * Flatten JSDoc inline markup for a PLAIN-TEXT context (list blurbs, the page lead, the
 * `<meta description>`): `{@link Target | label}` → its label/name, and drop `` `code` ``
 * backticks. The rich per-symbol Description renders `docFull` (kept raw) instead.
 */
function plainText(s: string): string {
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

// deno-lint-ignore no-explicit-any
function docSummary(decl: any): string {
  const doc: string = decl.jsDoc?.doc ?? "";
  // First paragraph only, flattened to plain text.
  return plainText(doc.split(/\n\s*\n/)[0]);
}

// deno-lint-ignore no-explicit-any
const tagsOf = (decl: any): any[] => decl.jsDoc?.tags ?? [];

// deno-lint-ignore no-explicit-any
function paramsOf(decl: any): Param[] {
  return tagsOf(decl)
    .filter((t) => t.kind === "param" && (t.name || t.doc))
    .map((t) => ({ name: String(t.name ?? ""), doc: plainText(String(t.doc ?? "")) }));
}

// deno-lint-ignore no-explicit-any
function returnsOf(decl: any): string {
  const t = tagsOf(decl).find((x) => x.kind === "return");
  return t ? plainText(String(t.doc ?? "")) : "";
}

// deno-lint-ignore no-explicit-any
function examplesOf(decl: any): string[] {
  return tagsOf(decl)
    .filter((t) => t.kind === "example")
    .map((t) => String(t.doc ?? "").trim())
    .filter(Boolean);
}

const KIND_ABBREV: Record<string, string> = {
  function: "fn",
  variable: "var",
  typeAlias: "type",
  interface: "iface",
  class: "class",
  enum: "enum",
  namespace: "ns",
};

/**
 * A case-insensitively-unique URL slug for each symbol within a module. Static export
 * writes one file per page, and a case-insensitive FS (macOS) would clobber symbols that
 * differ only in case (e.g. `draftMode` / `DraftMode`), so disambiguate those with a
 * kind suffix and a final numeric guard.
 */
/** Count each lower-cased name, so we know which names collide only by case. */
function countLower(symbols: Symbol[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of symbols) {
    const k = s.name.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** The un-disambiguated base segment for a symbol (kind suffix only when it collides). */
function slugBase(name: string, kind: string, collides: boolean): string {
  return collides ? `${name}-${KIND_ABBREV[kind] ?? kind}` : name;
}

/** `base`, or `base-2`/`base-3`/… until it's case-insensitively unused. */
function uniqueSlug(base: string, used: Set<string>): string {
  let slug = base;
  for (let i = 2; used.has(slug.toLowerCase()); i++) slug = `${base}-${i}`;
  return slug;
}

function assignSlugs(symbols: Symbol[]): void {
  const lowerCounts = countLower(symbols);
  const used = new Set<string>();
  for (const s of symbols) {
    const collides = (lowerCounts.get(s.name.toLowerCase()) ?? 0) > 1;
    s.slug = uniqueSlug(slugBase(s.name, s.kind, collides), used);
    used.add(s.slug.toLowerCase());
  }
}

// deno-lint-ignore no-explicit-any
function collectRealNames(surfaces: any[]): Set<string> {
  return new Set(
    surfaces
      .filter((s) => s.resolved !== false)
      .flatMap((s) => Object.keys(s.symbols ?? {})),
  );
}

/** Names of every export across the pinned real React/Next/Remix surface. */
async function realSurfaceNames(): Promise<Set<string>> {
  try {
    const baseline = JSON.parse(await Deno.readTextFile(PARITY_BASELINE));
    return collectRealNames(baseline.surfaces ?? []);
  } catch (e) {
    console.warn(`parity baseline unreadable (${e}); every symbol will be marked denext-only`);
    return new Set();
  }
}

const realNames = await realSurfaceNames();

/** `deno doc --json` for a module (v2 shape: `{ nodes: { "<file url>": { symbols } } }`). */
async function denoDocSymbols(file: string): Promise<Decl[]> {
  const parsed = (await denoDocJson(file)) as { nodes?: Record<string, Decl> };
  return Object.values(parsed.nodes ?? {}).flatMap((n: Decl) => n.symbols ?? []);
}

async function docFor(file: string): Promise<Group["symbols"]> {
  const symbols = await denoDocSymbols(file);
  const seen = new Set<string>();
  const out: Symbol[] = [];
  for (const s of symbols) {
    const decl = publicDecl(s);
    if (!decl || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(symbolEntry(s.name, decl));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  assignSlugs(out);
  return out;
}

/** A symbol's first declaration, unless it is private. */
function publicDecl(s: Decl): Decl | null {
  const decl = s.declarations?.[0];
  return decl && decl.declarationKind !== "private" ? decl : null;
}

function symbolEntry(name: string, decl: Decl): Symbol {
  return {
    name,
    slug: name, // finalized by assignSlugs once the whole module is collected
    kind: decl.kind,
    signature: signatureOf(name, decl),
    doc: docSummary(decl),
    docFull: String(decl.jsDoc?.doc ?? "").trim(),
    params: paramsOf(decl),
    returns: returnsOf(decl),
    examples: examplesOf(decl),
    denextOnly: !realNames.has(name),
  };
}

const groups: Group[] = [];
for (const { module, file } of ENTRIES) {
  groups.push({ module, symbols: await docFor(file) });
}

await Deno.mkdir(new URL(".", `file://${OUT}`).pathname, { recursive: true });
await Deno.writeTextFile(OUT, JSON.stringify({ groups }, null, 2) + "\n");
const total = groups.reduce((n, g) => n + g.symbols.length, 0);
const denextOnly = groups.reduce((n, g) => n + g.symbols.filter((s) => s.denextOnly).length, 0);
console.log(
  `api reference: ${total} symbols across ${groups.length} entries ` +
    `(${denextOnly} denext-only) → ${OUT}`,
);
