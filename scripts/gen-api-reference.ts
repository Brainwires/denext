// Generate the in-site API reference from `deno doc --json`.
// Runs deno doc over denext's first-party public entry points and emits a compact
// JSON the docs site (site) renders at /docs/api as static 0-KB-JS HTML.
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

import { denoDocJsonMany } from "./deno-doc.ts";
import { dirname, fromFileUrl } from "@std/path";
import {
  type ApiMember,
  type ApiParam,
  type ApiParent,
  classDetail,
  classParents,
  extendsOf,
  interfaceDetail,
  linkParents,
  paramsOf,
  paramStr,
  plainText,
  returnsOf,
  typeParamsStr,
  typeStr,
} from "./lib/api-signature.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const OUT = `${ROOT}site/app/docs/api/reference.json`;
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
  { module: "denext/desktop/updater", file: `${ROOT}src/desktop/updater.ts` },
  { module: "denext/desktop/client", file: `${ROOT}src/desktop/client.ts` },
  { module: "denext/desktop/window", file: `${ROOT}src/desktop/window.ts` },
  { module: "denext/desktop/app", file: `${ROOT}src/desktop/app.ts` },
  { module: "denext/desktop/clerk", file: `${ROOT}src/desktop/clerk.ts` },
  { module: "denext/mobile", file: `${ROOT}src/mobile/mod.ts` },
  { module: "denext/mobile/clerk", file: `${ROOT}src/mobile/clerk.ts` },
  { module: "denext/updates", file: `${ROOT}src/updates/mod.ts` },
  { module: "denext/navigation", file: `${ROOT}src/navigation/mod.ts` },
  { module: "denext/virtual-masonry", file: `${ROOT}src/virtual-masonry.ts` },
  { module: "denext/mvu", file: `${ROOT}src/mvu.ts` },
  { module: "denext/feature", file: `${ROOT}src/feature.ts` },
  { module: "denext/gleam", file: `${ROOT}src/gleam.ts` },
  { module: "denext/platform", file: `${ROOT}src/platform.ts` },
  { module: "denext/result", file: `${ROOT}src/result.ts` },
  { module: "denext/markdown", file: `${ROOT}src/markdown/mod.ts` },
  { module: "denext/deploy", file: `${ROOT}src/deploy/mod.ts` },
  { module: "denext/signals", file: `${ROOT}src/compat/preact/signals.ts` },
  { module: "denext/prisma-adapter", file: `${ROOT}src/server/prisma-adapter/mod.ts` },
  { module: "denext/jsx-directives", file: `${ROOT}src/jsx-directives.ts` },
  { module: "denext/cli/command", file: `${ROOT}src/cli/command.ts` },
  { module: "denext/plugin-kit", file: `${ROOT}src/plugin/kit.ts` },
  { module: "denext/plugin-kit/vite-emitter", file: `${ROOT}src/plugin/vite-emitter.ts` },
  { module: "denext/ui-kit", file: `${ROOT}src/ui/kit.ts` },
  ...(await expoEntries()),
];

/**
 * The `denext/expo/*` shims (React Native mode), one entry per module, read from
 * `deno.json`'s `exports` so a new shim is documented without editing this list. They come
 * last and in export-map order; the docs site lists them in their own section.
 */
async function expoEntries(): Promise<{ module: string; file: string }[]> {
  const cfg = JSON.parse(await Deno.readTextFile(`${ROOT}deno.json`)) as {
    exports: Record<string, string>;
  };
  return Object.entries(cfg.exports)
    .filter(([key]) => key.startsWith("./expo/"))
    .map(([key, file]) => ({
      module: `denext/${key.slice(2)}`,
      file: `${ROOT}${file.replace(/^\.\//, "")}`,
    }));
}

interface Symbol {
  name: string;
  slug: string;
  kind: string;
  signature: string;
  doc: string;
  docFull: string;
  params: ApiParam[];
  returns: string;
  examples: string[];
  denextOnly: boolean;
  /** An interface's or class's own members (absent when it declares none). */
  members?: ApiMember[];
  /** What an interface or class extends (absent when nothing): inherited members stay on the parent. */
  extends?: ApiParent[];
  /** What a class implements (absent when nothing). */
  implements?: ApiParent[];
}
interface Group {
  module: string;
  symbols: Symbol[];
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
  interface: (name, def, tp) => `interface ${name}${tp}${extendsClause(def)}`,
  class: (name, def, tp) =>
    `${def.isAbstract ? "abstract " : ""}class ${name}${tp}${heritage(def)}`,
  enum: (name) => `enum ${name}`,
};

function signatureOf(name: string, decl: Decl): string {
  const def = decl.def ?? {};
  const render = SIGNATURES[decl.kind] ?? ((n: string) => n);
  return render(name, def, typeParamsStr(def));
}

/** ` extends A implements B, C` for a class, or "". */
function heritage(def: Decl): string {
  const parents = classParents(def);
  const base = parents.extends.length ? ` extends ${parents.extends[0]}` : "";
  return parents.implements.length ? `${base} implements ${parents.implements.join(", ")}` : base;
}

/** ` extends A, B` for an interface, or "". */
function extendsClause(def: Decl): string {
  const parents = extendsOf(def);
  return parents.length ? ` extends ${parents.join(", ")}` : "";
}

// deno-lint-ignore no-explicit-any
function docSummary(decl: any): string {
  const doc: string = decl.jsDoc?.doc ?? "";
  // First paragraph only, flattened to plain text.
  return plainText(doc.split(/\n\s*\n/)[0]);
}

// deno-lint-ignore no-explicit-any
function examplesOf(decl: any): string[] {
  return (decl.jsDoc?.tags ?? [])
    // deno-lint-ignore no-explicit-any
    .filter((t: any) => t.kind === "example")
    // deno-lint-ignore no-explicit-any
    .map((t: any) => String(t.doc ?? "").trim())
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

/** A `deno doc --json` document's symbols (v2 shape: `{ nodes: { "<file url>": { symbols } } }`). */
function denoDocSymbols(doc: unknown): Decl[] {
  const parsed = doc as { nodes?: Record<string, Decl> };
  return Object.values(parsed.nodes ?? {}).flatMap((n: Decl) => n.symbols ?? []);
}

function docFor(doc: unknown): Group["symbols"] {
  const symbols = denoDocSymbols(doc);
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
    ...interfaceDetail(decl),
    ...classDetail(decl),
  };
}

// A few `deno doc` children for every entry, not one each (see denoDocJsonMany).
const docs = await denoDocJsonMany(ENTRIES.map((e) => e.file));
const groups: Group[] = [];
for (const [i, { module }] of ENTRIES.entries()) {
  const symbols = docFor(docs[i]);
  // An Expo shim mirrors an `expo-*` package's API, so its exports have an upstream to read.
  if (module.startsWith("denext/expo/")) { for (const s of symbols) s.denextOnly = false; }
  groups.push({ module, symbols });
}

linkParents(groups);

await Deno.mkdir(dirname(OUT), { recursive: true });
// deno-doc.ts runs `deno doc` with NO_COLOR, and denext's Deno from 3.0.0-denext.7 writes no colour
// into `--json` at all; an escape byte here is a failure, as tests/api-reference.test.ts refuses a
// committed reference that carries one.
const json = JSON.stringify({ groups }, null, 2);
if (json.includes("\\u001b")) throw new Error(`api reference: an escape byte survived in ${OUT}`);
await Deno.writeTextFile(OUT, json + "\n");
const total = groups.reduce((n, g) => n + g.symbols.length, 0);
const denextOnly = groups.reduce((n, g) => n + g.symbols.filter((s) => s.denextOnly).length, 0);
console.log(
  `api reference: ${total} symbols across ${groups.length} entries ` +
    `(${denextOnly} denext-only) → ${OUT}`,
);
