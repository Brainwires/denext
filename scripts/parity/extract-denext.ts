// denext-side surface extractor: denext's compat modules, read via `deno doc --json`.
//
// `deno doc` is used here (not the TS compiler API) because it natively resolves
// denext's import map and `jsr:` dependencies, which a standalone `ts.createProgram`
// would not. denext's compat files use plain top-level `export { … }` / `export
// function` / `export const`, which `deno doc` enumerates fully (unlike `@types/react`'s
// `export = React` namespace — see extract-real.ts). Reuses the extraction shape of
// `scripts/gen-api-reference.ts`.
//
// Tolerance note: denext often exports callables as `const x: typeof impl = impl`.
// `deno doc` reports those as `variable` with an opaque `typeRef`/`typeof` type, so
// their arity is unresolvable — we emit `callSignatures: undefined` and the diff skips
// the arity check rather than inventing a mismatch. This is the "internals may vary"
// contract: name presence and value-ness are enforced; internal typing is not.

import { CATALOG } from "./spec.ts";
import type { CallSig, Surface, SurfaceSymbol } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

/** Run `deno doc --json` over one file and return its flat symbol list. */
async function docFor(absFile: string): Promise<Json[]> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", absFile],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(`deno doc failed for ${absFile}: ${new TextDecoder().decode(stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(stdout));
  return Object.values(parsed.nodes ?? {}).flatMap((n: Json) => n.symbols ?? []);
}

/** Build one CallSig from a deno-doc params array + typeParams. */
function callSigFrom(params: Json[]): CallSig {
  let requiredArity = 0;
  let restParam = false;
  let stillRequired = true;
  for (const p of params) {
    const rest = p.kind === "rest";
    // deno doc encodes a defaulted param (`x = default`) as `{kind:"assign"}` with the
    // `optional` flag buried on `.left` — treat it as optional so a trailing default
    // stops the required count (else e.g. `redirect(url, status = 307)` looks arity-2).
    const optional = !!p.optional || p.kind === "assign";
    if (rest) restParam = true;
    if (stillRequired && !rest && !optional) requiredArity++;
    else stillRequired = false;
  }
  return { arity: params.length, requiredArity, restParam };
}

/** Resolve member names for a variable/const whose type is a local typeRef or literal. */
function membersFromType(tsType: Json, byName: Map<string, Json>): string[] | undefined {
  if (!tsType) return undefined;
  if (tsType.kind === "typeLiteral") {
    return (tsType.value?.properties ?? []).map((p: Json) => p.name).sort();
  }
  if (tsType.kind === "typeRef" && tsType.value?.resolution?.kind === "local") {
    const target = byName.get(tsType.value.typeName);
    if (target) return membersOfDecl(target);
  }
  return undefined;
}

/** Member names declared directly on an interface/namespace symbol. */
function membersOfDecl(sym: Json): string[] | undefined {
  const dec = sym.declarations?.[0];
  const def = dec?.def ?? {};
  if (dec?.kind === "interface") return uniqueSorted(interfaceMemberNames(def));
  if (dec?.kind === "namespace") return uniqueSorted(namespaceMemberNames(def));
  if (dec?.kind === "variable") return membersFromType(def.tsType, new Map());
  return undefined;
}

function interfaceMemberNames(def: Json): string[] {
  return [
    ...(def.methods ?? []).map((m: Json) => m.name),
    ...(def.properties ?? []).map((p: Json) => p.name),
  ];
}

function namespaceMemberNames(def: Json): string[] {
  const els = def.elements ?? def.namespace?.elements ?? [];
  return els.map((e: Json) => e.name).filter(Boolean);
}

/** Deduplicated + sorted, or undefined when empty (no member list). */
function uniqueSorted(names: string[]): string[] | undefined {
  return names.length ? [...new Set(names)].sort() : undefined;
}

/** The kind-specific half of {@link normalize}. */
type Shape = Pick<
  SurfaceSymbol,
  "isValue" | "isType" | "callSignatures" | "typeParamCount" | "members"
>;

const typeParams = (def: Json): number => (def.typeParams ?? []).length;

/** Per deno-doc declaration kind (unknown kinds are plain values). */
const SHAPES: Record<
  string,
  (sym: Json, decls: Json[], def: Json, byName: Map<string, Json>) => Shape
> = {
  // deno doc lists a function's overloads (+ impl) as multiple `declarations` on one
  // symbol; the first sets the kind, but arity must span them all.
  function: (_sym, decls, def) => ({
    isValue: true,
    isType: false,
    callSignatures: decls.filter((d) => d.kind === "function").map((d) =>
      callSigFrom(d.def?.params ?? [])
    ),
    typeParamCount: typeParams(def),
  }),
  variable: (_sym, _decls, def, byName) => {
    const t = def.tsType;
    const fn = t?.kind === "fnOrConstructor" ? t.value : undefined;
    return {
      isValue: true,
      isType: false,
      callSignatures: fn ? [callSigFrom(fn.params ?? [])] : undefined,
      typeParamCount: fn ? (fn.typeParams ?? []).length : undefined,
      members: membersFromType(t, byName),
    };
  },
  class: (_sym, _decls, def) => ({ isValue: true, isType: true, typeParamCount: typeParams(def) }),
  interface: (sym, _decls, def) => ({
    isValue: false,
    isType: true,
    typeParamCount: typeParams(def),
    members: membersOfDecl(sym),
  }),
  typeAlias: (_sym, _decls, def) => ({
    isValue: false,
    isType: true,
    typeParamCount: typeParams(def),
  }),
  // A types-only namespace (e.g. Next's MetadataRoute) is a type surface.
  namespace: (sym) => ({ isValue: false, isType: true, members: membersOfDecl(sym) }),
  enum: () => ({ isValue: true, isType: true }),
};

/** Normalize one deno-doc symbol into the shared shape. */
function normalize(sym: Json, byName: Map<string, Json>): SurfaceSymbol {
  const decls: Json[] = sym.declarations ?? [];
  const dec = decls[0] ?? {};
  const kind: string = dec.kind ?? "value";
  const shape = SHAPES[kind] ?? (() => ({ isValue: true, isType: false }));
  return { name: sym.name, kind, ...shape(sym, decls, dec.def ?? {}, byName) };
}

/** A public, non-default, non-dunder export. */
function isPublicSymbol(s: Json): boolean {
  const dec = s.declarations?.[0];
  if (!dec || dec.declarationKind === "private") return false;
  return s.name !== "default" && !s.name.startsWith("__");
}

/**
 * Extract denext's surface for every catalog specifier. Files shared by several
 * specifiers (the JSX runtimes, react-dom/server fan-out) are documented once and
 * reused.
 *
 * @param root Repo root (absolute); catalog `denext` paths are resolved against it.
 * @returns One {@link Surface} per specifier.
 */
export async function extractDenextSurfaces(root: string): Promise<Surface[]> {
  const cache = new Map<string, Record<string, SurfaceSymbol>>();

  const surfaceForFile = async (rel: string): Promise<Record<string, SurfaceSymbol>> => {
    const cached = cache.get(rel);
    if (cached) return cached;
    const syms = await docFor(`${root}/${rel}`);
    const byName = new Map<string, Json>();
    for (const s of syms) {
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
    const out: Record<string, SurfaceSymbol> = {};
    for (const s of syms) {
      if (isPublicSymbol(s) && !out[s.name]) out[s.name] = normalize(s, byName);
    }
    cache.set(rel, out);
    return out;
  };

  const surfaces: Surface[] = [];
  for (const e of CATALOG) {
    surfaces.push({
      specifier: e.specifier,
      resolved: true,
      symbols: await surfaceForFile(e.denext),
    });
  }
  return surfaces;
}
