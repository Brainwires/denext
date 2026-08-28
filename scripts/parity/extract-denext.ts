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
  if (dec?.kind === "interface") {
    const names = [
      ...(def.methods ?? []).map((m: Json) => m.name),
      ...(def.properties ?? []).map((p: Json) => p.name),
    ];
    return names.length ? [...new Set(names)].sort() : undefined;
  }
  if (dec?.kind === "namespace") {
    const els = def.elements ?? def.namespace?.elements ?? [];
    const names = els.map((e: Json) => e.name).filter(Boolean);
    return names.length ? [...new Set<string>(names)].sort() : undefined;
  }
  if (dec?.kind === "variable") return membersFromType(def.tsType, new Map());
  return undefined;
}

/** Normalize one deno-doc symbol into the shared shape. */
function normalize(sym: Json, byName: Map<string, Json>): SurfaceSymbol {
  // deno doc lists a function's overloads (+ impl) as multiple `declarations` on one
  // symbol; the first sets the kind, but arity must span them all.
  const decls: Json[] = sym.declarations ?? [];
  const dec = decls[0] ?? {};
  const def = dec.def ?? {};
  const kind: string = dec.kind ?? "value";

  let isValue = false;
  let isType = false;
  let callSignatures: CallSig[] | undefined;
  let typeParamCount: number | undefined;
  let members: string[] | undefined;

  switch (kind) {
    case "function": {
      isValue = true;
      const fnDecls = decls.filter((d) => d.kind === "function");
      callSignatures = fnDecls.map((d) => callSigFrom(d.def?.params ?? []));
      typeParamCount = (def.typeParams ?? []).length;
      break;
    }
    case "variable": {
      isValue = true;
      const t = def.tsType;
      if (t?.kind === "fnOrConstructor") {
        callSignatures = [callSigFrom(t.value?.params ?? [])];
        typeParamCount = (t.value?.typeParams ?? []).length;
      }
      members = membersFromType(t, byName);
      break;
    }
    case "class":
      isValue = true;
      isType = true;
      typeParamCount = (def.typeParams ?? []).length;
      break;
    case "interface":
      isType = true;
      typeParamCount = (def.typeParams ?? []).length;
      members = membersOfDecl(sym);
      break;
    case "typeAlias":
      isType = true;
      typeParamCount = (def.typeParams ?? []).length;
      break;
    case "namespace":
      // A types-only namespace (e.g. Next's MetadataRoute) is a type surface.
      isType = true;
      members = membersOfDecl(sym);
      break;
    case "enum":
      isValue = true;
      isType = true;
      break;
    default:
      isValue = true;
  }

  return { name: sym.name, kind, isValue, isType, callSignatures, typeParamCount, members };
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
      const dec = s.declarations?.[0];
      if (!dec || dec.declarationKind === "private") continue;
      if (s.name === "default" || s.name.startsWith("__")) continue;
      if (out[s.name]) continue;
      out[s.name] = normalize(s, byName);
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
