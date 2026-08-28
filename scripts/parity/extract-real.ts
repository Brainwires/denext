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

/** Read the installed version of each real package from its node_modules manifest. */
export function readVersions(workDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pkg of REAL_PACKAGES) {
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

/** Reduce a TS call signature to the structural fields parity checks. */
function callSig(sig: ts.Signature): CallSig {
  const params = sig.getParameters();
  let requiredArity = 0;
  let restParam = false;
  let stillRequired = true;
  for (const p of params) {
    const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
    const optional = !!decl?.questionToken || !!decl?.initializer;
    const rest = !!decl?.dotDotDotToken;
    if (rest) restParam = true;
    if (stillRequired && !optional && !rest) requiredArity++;
    else stillRequired = false;
  }
  return { arity: params.length, requiredArity, restParam };
}

/** Normalize one exported member symbol. */
function normalize(checker: ts.TypeChecker, sym: ts.Symbol): SurfaceSymbol {
  const flags = sym.getFlags();
  const isValue = !!(flags & ts.SymbolFlags.Value) || !!(flags & ts.SymbolFlags.Alias);
  const isType = !!(flags & ts.SymbolFlags.Type) ||
    !!(flags & ts.SymbolFlags.Interface) ||
    !!(flags & ts.SymbolFlags.TypeAlias) ||
    !!(flags & ts.SymbolFlags.Namespace);
  const type = checker.getTypeOfSymbol(sym);
  const cs = type.getCallSignatures();
  const callSignatures = cs.length ? cs.map(callSig) : undefined;
  const typeParamCount = cs.length ? (cs[0].getTypeParameters()?.length ?? 0) : undefined;

  // Members only for object/namespace-ish exports (no call signatures, has props) —
  // that captures Children, MetadataRoute, default namespaces, and skips the huge
  // member lists of component/function types the diff would never use anyway.
  let members: string[] | undefined;
  if (!cs.length) {
    const props = type.getProperties();
    if (props.length) members = props.map((p) => p.getName()).sort();
  }

  const kind = cs.length
    ? "function"
    : (flags & ts.SymbolFlags.Interface
      ? "interface"
      : flags & ts.SymbolFlags.TypeAlias
      ? "typeAlias"
      : flags & ts.SymbolFlags.Namespace
      ? "namespace"
      : flags & ts.SymbolFlags.Class
      ? "class"
      : "value");

  return { name: sym.getName(), kind, isValue, isType, callSignatures, typeParamCount, members };
}

/**
 * Extract the real surface for every catalog specifier.
 *
 * @param workDir A directory whose `node_modules` has react/react-dom/next/next-intl
 *   (+ their `@types`) and `typescript` installed.
 * @returns One {@link Surface} per specifier (unresolved specifiers have `resolved:false`).
 */
export function extractRealSurfaces(workDir: string): Surface[] {
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(compilerOptions);

  // Pre-resolve each specifier so an upstream-removed subpath (e.g.
  // react-dom/test-utils on React 19) becomes `resolved:false` instead of a crash.
  const containing = `${workDir}/__parity_entry__.ts`;
  const resolvedSpecs = CATALOG.map((e) => {
    const r = ts.resolveModuleName(e.real, containing, compilerOptions, host);
    return { entry: e, ok: !!r.resolvedModule };
  });

  const importable = resolvedSpecs.filter((r) => r.ok);
  const entrySource = importable
    .map((r, i) => `import * as N${i} from ${JSON.stringify(r.entry.real)};`)
    .join("\n") +
    "\nexport const __ns = [" + importable.map((_, i) => `N${i}`).join(", ") + "];\n";
  Deno.writeTextFileSync(containing, entrySource);

  const program = ts.createProgram([containing], compilerOptions, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(containing)!;

  // Map each import namespace back to its specifier by reading the import decls.
  const nsTypes = new Map<string, ts.Type>();
  let idx = 0;
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) && stmt.importClause?.namedBindings &&
      ts.isNamespaceImport(stmt.importClause.namedBindings)
    ) {
      const local = stmt.importClause.namedBindings.name;
      const nsSym = checker.getSymbolAtLocation(local);
      if (nsSym) nsTypes.set(importable[idx].entry.real, checker.getTypeOfSymbol(nsSym));
      idx++;
    }
  }

  const surfaces: Surface[] = [];
  for (const { entry, ok } of resolvedSpecs) {
    if (!ok) {
      surfaces.push({ specifier: entry.specifier, resolved: false, symbols: {} });
      continue;
    }
    const type = nsTypes.get(entry.real);
    const symbols: Record<string, SurfaceSymbol> = {};
    for (const prop of type?.getProperties() ?? []) {
      const name = prop.getName();
      if (name.startsWith("__")) continue;
      symbols[name] = normalize(checker, prop);
    }
    surfaces.push({ specifier: entry.specifier, resolved: true, symbols });
  }

  try {
    Deno.removeSync(containing);
  } catch { /* best effort */ }
  return surfaces;
}
