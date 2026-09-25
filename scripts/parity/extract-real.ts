// Real-side surface extractor: the authoritative React / ReactDOM / Next surface,
// read from a real `node_modules` install via the TypeScript compiler API.
//
// Why the compiler API and not `deno doc`: `@types/react` ships its API as
// `export = React` with everything inside `declare namespace React`. `deno doc` does
// not flatten that (it reports ~25 top-level symbols and misses every hook), whereas
// `import * as React` + `checker.getTypeOfSymbol(React).getProperties()` yields the
// full 40+-member surface with call signatures. Proven before implementing.

// This module runs ONLY inside refresh.ts's child process (an arbitrary temp cwd with
// its own node_modules, no deno.json in scope), so it must self-resolve typescript via
// an explicit `npm:` specifier rather than a bare import from the repo's import map —
// hence the lint exception.
// deno-lint-ignore no-import-prefix
import ts from "npm:typescript@5";
import { CATALOG, REAL_PACKAGES } from "./spec.ts";
import type { CallSig, Surface, SurfaceSymbol } from "./types.ts";

/** Minimal entry shape the real-side extractor needs: the public specifier + npm import. */
export interface RealTarget {
  specifier: string;
  real: string;
}

/** Read the installed version of each named package from its node_modules manifest. */
export function readVersionsFor(
  workDir: string,
  packages: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pkg of packages) {
    try {
      const manifest = JSON.parse(
        Deno.readTextFileSync(`${workDir}/node_modules/${pkg}/package.json`),
      ) as { version: string };
      out[pkg] = manifest.version;
    } catch {
      out[pkg] = "unresolved";
    }
  }
  return out;
}

/** Read the installed version of each real (React/Next) package from node_modules. */
export function readVersions(workDir: string): Record<string, string> {
  return readVersionsFor(workDir, REAL_PACKAGES);
}

/** Reduce a TS call signature to the structural fields parity checks. */
function callSig(sig: ts.Signature): CallSig {
  const params = sig.getParameters().map(paramShape);
  const restParam = params.some((p) => p.rest);
  // Required arity: the leading run of non-optional, non-rest params.
  const firstOptional = params.findIndex((p) => p.optional || p.rest);
  const requiredArity = firstOptional === -1 ? params.length : firstOptional;
  return { arity: params.length, requiredArity, restParam };
}

function paramShape(p: ts.Symbol): { optional: boolean; rest: boolean } {
  const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
  if (!decl) return { optional: false, rest: false };
  return { optional: !!decl.questionToken || !!decl.initializer, rest: !!decl.dotDotDotToken };
}

const TYPE_FLAGS = [
  ts.SymbolFlags.Type,
  ts.SymbolFlags.Interface,
  ts.SymbolFlags.TypeAlias,
  ts.SymbolFlags.Namespace,
];

/** The structural kind, by symbol flags (a callable is a "function" regardless). */
const KIND_FLAGS: Array<[number, SurfaceSymbol["kind"]]> = [
  [ts.SymbolFlags.Interface, "interface"],
  [ts.SymbolFlags.TypeAlias, "typeAlias"],
  [ts.SymbolFlags.Namespace, "namespace"],
  [ts.SymbolFlags.Class, "class"],
];

function kindOf(flags: number, callable: boolean): SurfaceSymbol["kind"] {
  if (callable) return "function";
  return KIND_FLAGS.find(([flag]) => flags & flag)?.[1] ?? "value";
}

/**
 * Members only for object/namespace-ish exports (no call signatures, has props) — that
 * captures Children, MetadataRoute, default namespaces, and skips the huge member lists of
 * component/function types the diff would never use anyway.
 */
function membersOf(type: ts.Type, callable: boolean): string[] | undefined {
  if (callable) return undefined;
  const props = type.getProperties();
  return props.length ? props.map((p) => p.getName()).sort() : undefined;
}

/** The first call signature's type-parameter count; undefined for a non-callable. */
function typeParamCountOf(cs: readonly ts.Signature[]): number | undefined {
  if (cs.length === 0) return undefined;
  return cs[0].getTypeParameters()?.length ?? 0;
}

/** Normalize one exported member symbol. */
function normalize(checker: ts.TypeChecker, sym: ts.Symbol): SurfaceSymbol {
  const flags = sym.getFlags();
  const type = checker.getTypeOfSymbol(sym);
  const cs = type.getCallSignatures();
  const callable = cs.length > 0;
  return {
    name: sym.getName(),
    kind: kindOf(flags, callable),
    isValue: !!(flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Alias)),
    isType: TYPE_FLAGS.some((f) => flags & f),
    callSignatures: callable ? cs.map(callSig) : undefined,
    typeParamCount: typeParamCountOf(cs),
    members: membersOf(type, callable),
  };
}

/**
 * Extract the real surface for every catalog specifier.
 *
 * @param workDir A directory whose `node_modules` has react/react-dom/next/next-intl
 *   (+ their `@types`) and `typescript` installed.
 * @returns One {@link Surface} per specifier (unresolved specifiers have `resolved:false`).
 */
export function extractRealSurfaces(workDir: string): Surface[] {
  return extractRealSurfacesFor(workDir, CATALOG);
}

/**
 * Extract the real surface for an arbitrary set of targets (the same machinery the
 * React/Next catalog uses, opened up for the native/expo catalogs). Each target's
 * `real` specifier is pre-resolved; an unresolvable one becomes `resolved:false`.
 *
 * @param workDir A directory whose `node_modules` has each target's package installed.
 * @param targets The public-specifier ↔ npm-import pairs to extract.
 */
export function extractRealSurfacesFor(
  workDir: string,
  targets: readonly RealTarget[],
): Surface[] {
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    // Bundler, not Node10: Node10 ignores package.json `exports`, so a package that
    // publishes its types only through an exports map (expo-quick-actions) would resolve to
    // nothing and never be compared. Bundler reads `exports` (the `types` condition) and
    // still falls back to `types`/`typesVersions` and bare file lookup for packages without
    // one (next's `next/navigation.d.ts`).
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(compilerOptions);
  // Pre-resolve each specifier so an upstream-removed subpath (e.g.
  // react-dom/test-utils on React 19) becomes `resolved:false` instead of a crash.
  const containing = `${workDir}/__parity_entry__.ts`;
  const resolvedSpecs = targets.map((e) => ({
    entry: e,
    ok: !!ts.resolveModuleName(e.real, containing, compilerOptions, host).resolvedModule,
  }));
  const importable = resolvedSpecs.filter((r) => r.ok).map((r) => r.entry.real);
  Deno.writeTextFileSync(containing, entrySource(importable));
  const program = ts.createProgram([containing], compilerOptions, host);
  const checker = program.getTypeChecker();
  const nsTypes = namespaceTypes(program.getSourceFile(containing)!, checker, importable);
  const surfaces = resolvedSpecs.map(({ entry, ok }) =>
    ok
      ? {
        specifier: entry.specifier,
        resolved: true,
        symbols: surfaceSymbols(checker, nsTypes.get(entry.real)),
      }
      : { specifier: entry.specifier, resolved: false, symbols: {} }
  );
  try {
    Deno.removeSync(containing);
  } catch { /* best effort */ }
  return surfaces;
}

/** `import * as N<i> from "<real>"` per importable specifier, exporting them all. */
function entrySource(importable: string[]): string {
  return importable.map((real, i) => `import * as N${i} from ${JSON.stringify(real)};`).join("\n") +
    "\nexport const __ns = [" + importable.map((_, i) => `N${i}`).join(", ") + "];\n";
}

/** Map each import namespace back to its specifier by reading the import decls in order. */
function namespaceTypes(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  importable: string[],
): Map<string, ts.Type> {
  const nsTypes = new Map<string, ts.Type>();
  const names = sf.statements.filter(ts.isImportDeclaration).map(namespaceBinding)
    .filter((n) => n !== null);
  names.forEach((name, idx) => {
    const nsSym = checker.getSymbolAtLocation(name);
    if (nsSym) nsTypes.set(importable[idx], checker.getTypeOfSymbol(nsSym));
  });
  return nsTypes;
}

/** The local name of an `import * as N from …` declaration, or null for a named import. */
function namespaceBinding(decl: ts.ImportDeclaration): ts.Identifier | null {
  const bindings = decl.importClause?.namedBindings;
  return bindings && ts.isNamespaceImport(bindings) ? bindings.name : null;
}

/** Every public property of a namespace type, normalized. */
function surfaceSymbols(
  checker: ts.TypeChecker,
  type: ts.Type | undefined,
): Record<string, SurfaceSymbol> {
  const symbols: Record<string, SurfaceSymbol> = {};
  for (const prop of type?.getProperties() ?? []) {
    const name = prop.getName();
    if (!name.startsWith("__")) symbols[name] = normalize(checker, prop);
  }
  return symbols;
}
