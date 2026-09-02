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

// deno doc represents a type as `{ repr, kind, ... }`; `repr` is empty for some
// composite types, so fall back to the kind.
// deno-lint-ignore no-explicit-any
const typeStr = (t: any): string => (t?.repr && t.repr.length ? t.repr : (t?.kind ?? "unknown"));

// deno-lint-ignore no-explicit-any
function signatureOf(name: string, decl: any): string {
  const def = decl.def ?? {};
  const tp = (def.typeParams ?? []).map((p: { name: string }) => p.name);
  const tpStr = tp.length ? `<${tp.join(", ")}>` : "";
  switch (decl.kind) {
    case "function": {
      // deno-lint-ignore no-explicit-any
      const params = (def.params ?? []).map((p: any) =>
        `${p.name ?? "_"}${p.optional ? "?" : ""}: ${typeStr(p.tsType)}`
      ).join(", ");
      return `${name}${tpStr}(${params}): ${typeStr(def.returnType)}`;
    }
    case "variable":
      return `${name}: ${typeStr(def.tsType)}`;
    case "typeAlias":
      return `type ${name}${tpStr} = ${typeStr(def.tsType)}`;
    case "interface":
      return `interface ${name}${tpStr}`;
    case "class":
      return `class ${name}${tpStr}`;
    case "enum":
      return `enum ${name}`;
    default:
      return name;
  }
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

async function docFor(file: string): Promise<Group["symbols"]> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", file],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(`deno doc failed for ${file}: ${new TextDecoder().decode(stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(stdout));
  // v2: { nodes: { "<file url>": { symbols: [...] } } }
  // deno-lint-ignore no-explicit-any
  const symbols: any[] = Object.values(parsed.nodes ?? {}).flatMap((n: any) => n.symbols ?? []);
  const seen = new Set<string>();
  const out: Symbol[] = [];
  for (const s of symbols) {
    if (seen.has(s.name)) continue;
    const decl = s.declarations?.[0];
    if (!decl || decl.declarationKind === "private") continue;
    seen.add(s.name);
    out.push({
      name: s.name,
      slug: s.name, // finalized by assignSlugs once the whole module is collected
      kind: decl.kind,
      signature: signatureOf(s.name, decl),
      doc: docSummary(decl),
      docFull: String(decl.jsDoc?.doc ?? "").trim(),
      params: paramsOf(decl),
      returns: returnsOf(decl),
      examples: examplesOf(decl),
      denextOnly: !realNames.has(s.name),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  assignSlugs(out);
  return out;
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
