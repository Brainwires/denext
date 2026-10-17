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
// hence the lint exception. TypeScript 7 is the native compiler: its API is an IPC client that
// spawns it (`typescript/unstable/async`; the sync client needs raw pipe descriptors Deno's
// `node:child_process` doesn't expose), pinned to 7.0.x until that API settles.
// deno-lint-ignore no-import-prefix
import * as ts from "npm:typescript@~7.0.2/unstable/async";
// deno-lint-ignore no-import-prefix
import { SyntaxKind } from "npm:typescript@~7.0.2/unstable/ast";
import { CATALOG, REAL_PACKAGES } from "./spec.ts";
import { type CallSig, isInternalName, type Surface, type SurfaceSymbol } from "./types.ts";

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
async function callSig(sig: ts.Signature): Promise<CallSig> {
  const params = await Promise.all((await sig.getParameters()).map(paramShape));
  const restParam = params.some((p) => p.rest);
  // Required arity: the leading run of non-optional, non-rest params.
  const firstOptional = params.findIndex((p) => p.optional || p.rest);
  const requiredArity = firstOptional === -1 ? params.length : firstOptional;
  return { arity: params.length, requiredArity, restParam };
}

/** A parameter declaration's `?`, initializer and `...` (from its AST node). */
interface ParameterNode {
  readonly kind: SyntaxKind;
  readonly questionToken?: unknown;
  readonly initializer?: unknown;
  readonly dotDotDotToken?: unknown;
}

async function paramShape(p: ts.Symbol): Promise<{ optional: boolean; rest: boolean }> {
  const decl = await p.valueDeclaration?.resolve() as ParameterNode | undefined;
  if (!decl || decl.kind !== SyntaxKind.Parameter) return { optional: false, rest: false };
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
async function membersOf(
  checker: ts.Checker,
  type: ts.Type | undefined,
  callable: boolean,
): Promise<string[] | undefined> {
  if (callable || !type) return undefined;
  const names = (await checker.getPropertiesOfType(type)).map((p) => p.name).filter((n) =>
    !isInternalName(n)
  );
  return names.length ? names.sort() : undefined;
}

/** An export specifier's node (`isTypeOnly`, and its `export type { … }` clause's). */
interface ExportSpecifierNode {
  readonly kind: SyntaxKind;
  readonly isTypeOnly?: boolean;
  readonly parent?: { readonly parent?: { readonly isTypeOnly?: boolean } };
}

/** Whether an export alias is type-only: `export type { X } from …` or `export { type X }`. */
async function isTypeOnlyAlias(sym: ts.Symbol): Promise<boolean> {
  for (const handle of sym.declarations) {
    const d = await handle.resolve() as ExportSpecifierNode | undefined;
    if (
      d?.kind === SyntaxKind.ExportSpecifier && (!!d.isTypeOnly || !!d.parent?.parent?.isTypeOnly)
    ) return true;
  }
  return false;
}

/**
 * The flags that classify an export, and whether it is type-only. A re-export
 * (`export { X } from …`) is an alias whose own flags say nothing about what it names, so it
 * takes its target's.
 */
async function exportFlags(
  checker: ts.Checker,
  sym: ts.Symbol,
): Promise<{ flags: number; typeOnly: boolean }> {
  const flags = sym.flags;
  if (!(flags & ts.SymbolFlags.Alias)) return { flags, typeOnly: false };
  return {
    flags: (await checker.getAliasedSymbol(sym)).flags,
    typeOnly: await isTypeOnlyAlias(sym),
  };
}

/** The first call signature's type-parameter count; undefined for a non-callable. */
async function typeParamCountOf(cs: readonly ts.Signature[]): Promise<number | undefined> {
  if (cs.length === 0) return undefined;
  return (await cs[0].getTypeParameters()).length;
}

/** Normalize one exported member symbol. */
async function normalize(checker: ts.Checker, sym: ts.Symbol): Promise<SurfaceSymbol> {
  const { flags, typeOnly } = await exportFlags(checker, sym);
  // A type-only export is not importable at runtime: its value side (calls, members) is moot.
  const isValue = !typeOnly && !!(flags & ts.SymbolFlags.Value);
  const type = await checker.getTypeOfSymbol(sym);
  const cs = isValue && type ? await checker.getSignaturesOfType(type, ts.SignatureKind.Call) : [];
  const callable = cs.length > 0;
  return {
    name: sym.name,
    kind: kindOf(flags, callable),
    isValue,
    isType: typeOnly || TYPE_FLAGS.some((f) => flags & f),
    callSignatures: callable ? await Promise.all(cs.map(callSig)) : undefined,
    typeParamCount: await typeParamCountOf(cs),
    members: isValue ? await membersOf(checker, type, callable) : undefined,
  };
}

/**
 * Extract the real surface for every catalog specifier.
 *
 * @param workDir A directory whose `node_modules` has react/react-dom/next/next-intl
 *   (+ their `@types`) and `typescript` installed.
 * @returns One {@link Surface} per specifier (unresolved specifiers have `resolved:false`).
 */
export function extractRealSurfaces(workDir: string): Promise<Surface[]> {
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
export async function extractRealSurfacesFor(
  workDir: string,
  targets: readonly RealTarget[],
): Promise<Surface[]> {
  // Bundler, not Node10: Node10 ignores package.json `exports`, so a package that publishes its
  // types only through an exports map (expo-quick-actions) would resolve to nothing and never be
  // compared. Bundler reads `exports` (the `types` condition) and still falls back to
  // `types`/`typesVersions` and bare file lookup for packages without one (next's
  // `next/navigation.d.ts`). TypeScript 7 always has esModuleInterop.
  const entry = `${workDir}/__parity_entry__.ts`;
  const config = `${workDir}/__parity_tsconfig__.json`;
  Deno.writeTextFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        module: "esnext",
        target: "esnext",
        moduleResolution: "bundler",
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      files: [entry],
    }),
  );
  try {
    // Pre-resolve each specifier so an upstream-removed subpath (e.g. react-dom/test-utils on
    // React 19) becomes `resolved:false` instead of a crash: an import the compiler can't
    // resolve is a TS2307 on its line of an entry that imports them all.
    const all = targets.map((e) => e.real);
    const unresolved = await withProject(
      workDir,
      config,
      entry,
      entrySource(all),
      async (project) => {
        const text = entrySource(all);
        const lineOf = (pos: number) => text.slice(0, pos).split("\n").length - 1;
        return new Set(
          (await project.program.getSemanticDiagnostics(entry))
            .filter((d) => d.code === 2307)
            .map((d) => all[lineOf(d.pos)]),
        );
      },
    );
    const resolvedSpecs = targets.map((e) => ({ entry: e, ok: !unresolved.has(e.real) }));
    const importable = resolvedSpecs.filter((r) => r.ok).map((r) => r.entry.real);
    const source = entrySource(importable);
    return await withProject(workDir, config, entry, source, async (project) => {
      const checker = project.checker;
      const nsTypes = await namespaceTypes(checker, entry, source, importable);
      const surfaces: Surface[] = [];
      for (const { entry: e, ok } of resolvedSpecs) {
        surfaces.push(
          ok
            ? {
              specifier: e.specifier,
              resolved: true,
              symbols: await surfaceSymbols(checker, nsTypes.get(e.real)),
            }
            : { specifier: e.specifier, resolved: false, symbols: {} },
        );
      }
      return surfaces;
    });
  } finally {
    for (const f of [entry, config]) {
      try {
        Deno.removeSync(f);
      } catch { /* best effort */ }
    }
  }
}

/** Write `source` to `entry`, open the project `config` in a compiler session, run `fn`. */
async function withProject<T>(
  workDir: string,
  config: string,
  entry: string,
  source: string,
  fn: (project: ts.Project) => Promise<T>,
): Promise<T> {
  Deno.writeTextFileSync(entry, source);
  const api = new ts.API({ cwd: workDir });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    if (!project) throw new Error(`typescript did not open ${config}`);
    return await fn(project);
  } finally {
    await api.close();
  }
}

/** `import * as N<i> from "<real>"` per importable specifier (one per line), exporting them all. */
function entrySource(importable: string[]): string {
  return importable.map((real, i) => `import * as N${i} from ${JSON.stringify(real)};`).join("\n") +
    "\nexport const __ns = [" + importable.map((_, i) => `N${i}`).join(", ") + "];\n";
}

/** Map each import namespace back to its specifier: the symbol at each `N<i>` binding. */
async function namespaceTypes(
  checker: ts.Checker,
  entry: string,
  source: string,
  importable: string[],
): Promise<Map<string, ts.Type>> {
  const nsTypes = new Map<string, ts.Type>();
  for (const [i, real] of importable.entries()) {
    const pos = source.indexOf(`import * as N${i} from `) + "import * as ".length;
    const nsSym = await checker.getSymbolAtPosition(entry, pos);
    const type = nsSym && await checker.getTypeOfSymbol(nsSym);
    if (type) nsTypes.set(real, type);
  }
  return nsTypes;
}

/** Every public property of a namespace type, normalized. */
async function surfaceSymbols(
  checker: ts.Checker,
  type: ts.Type | undefined,
): Promise<Record<string, SurfaceSymbol>> {
  const symbols: Record<string, SurfaceSymbol> = {};
  for (const prop of type ? await checker.getPropertiesOfType(type) : []) {
    const name = prop.name;
    if (!name.startsWith("__")) symbols[name] = await normalize(checker, prop);
  }
  return symbols;
}
