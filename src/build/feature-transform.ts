// Build-time fold of `feature("KEY")` calls (from `denext/feature`) to boolean literals,
// so both bundlers dead-code-eliminate the untaken branch — denext's answer to Bun's
// `feature()` from `bun:bundle`. A sibling of the auto-memo compiler and the AsyncContext
// pass (src/build/async-context-transform.ts): a build-time swc rewrite, since denext owns
// no transpile hook.
//
// Only a `feature(...)` call with a STRING-LITERAL argument whose key is listed in
// `experimental.features` is folded; a non-literal argument or an unlisted key is left as a
// runtime call (it reads the seeded flag map — src/runtime/feature-flags.ts). Correctness
// over coverage: an unparseable module is returned unchanged.
//
// On the native App Router path the fold runs LAST over each module's already-transformed
// source (see build-pipeline/transforms.ts), so it never clobbers auto-memo/qrl/async-context
// and the folded module is relocated with its relative imports absolutized. On the SPA path it
// runs as an esbuild `onLoad` transform (chained after auto-memo), in place.

import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  absolutizeSpecifiers,
  applyEdits,
  collectPatternNames,
  type Edit,
  endOf,
  type Node,
  parseModule,
  startOf,
  walkAst,
  writeTransformedModules,
} from "./swc-ast.ts";

/** The import specifier authors use for the feature helper. */
const FEATURE_SPECIFIER = "denext/feature";

/** The result of folding one module's `feature(...)` calls. */
export interface FeatureFoldResult {
  /** The rewritten source (unchanged when `changed` is false). */
  code: string;
  /** Whether any `feature(...)` call was folded. */
  changed: boolean;
}

/** Local names bound to the `feature` export of `denext/feature` in this module. */
function featureBindings(body: Node[]): Set<string> {
  const names = new Set<string>();
  for (const item of body) {
    if (item.type !== "ImportDeclaration" || item.source?.value !== FEATURE_SPECIFIER) continue;
    for (const s of item.specifiers ?? []) {
      if (s.type === "ImportSpecifier" && (s.imported?.value ?? s.local?.value) === "feature") {
        names.add(s.local.value);
      }
    }
  }
  return names;
}

/**
 * Names re-bound anywhere in the module by a param, variable, function, class, or catch clause.
 * A top-level redeclaration of an import is a syntax error, so any binding found here is an INNER
 * shadow — a `feature` param, say — whose calls must NOT be folded (they aren't the import). The
 * walk is not scope-precise, so a name shadowed in one scope is dropped from folding everywhere in
 * the module (conservative — the un-folded call reads the seeded value, which is correct).
 */
function shadowedNames(body: Node[], importNames: Set<string>): Set<string> {
  const bound = new Set<string>();
  const note = (pat: Node | undefined) => pat && collectPatternNames(pat, bound);
  for (const item of body) {
    walkAst(item, (n) => {
      if (Array.isArray(n.params)) { for (const p of n.params) note(p.pat ?? p); }
      if (n.type === "VariableDeclarator") note(n.id);
      if (n.type === "CatchClause") note(n.param);
      if (
        (n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") && n.identifier
      ) bound.add(n.identifier.value);
    });
  }
  return new Set([...importNames].filter((name) => bound.has(name)));
}

/** The single string-literal key of a `feature("KEY")` call bound to a known name, else null. */
function foldableKey(node: Node, names: Set<string>): string | null {
  if (node.type !== "CallExpression") return null;
  const callee = node.callee;
  if (!callee || callee.type !== "Identifier" || !names.has(callee.value)) return null;
  const args = node.arguments ?? [];
  if (args.length !== 1) return null;
  const arg = args[0]?.expression ?? args[0];
  return arg?.type === "StringLiteral" ? (arg.value as string) : null;
}

/**
 * Fold every `feature("KEY")` call whose KEY is present in `features` to its boolean literal.
 * When `opts.moduleUrl` is given AND a fold happens, the module's relative import specifiers
 * are absolutized too (the folded module is written to a temp dir on the native path, so its
 * relative imports would otherwise break); a module with no folds is returned unchanged and
 * stays where it is.
 *
 * @param source The module source.
 * @param features The configured flags (`experimental.features`).
 * @param opts.moduleUrl The module's own URL — pass it only when the caller relocates folded output.
 */
export async function transformFeatures(
  source: string,
  features: Record<string, boolean>,
  opts: { moduleUrl?: string } = {},
): Promise<FeatureFoldResult> {
  const identity: FeatureFoldResult = { code: source, changed: false };
  // Cheap pre-filter: no `feature` token anywhere → nothing imported, nothing to fold.
  if (!source.includes("feature")) return identity;
  const parsed = await parseModule(source);
  if (!parsed) return identity;
  const { ctx, body } = parsed;
  const names = featureBindings(body);
  if (names.size === 0) return identity;
  // Drop any import name re-bound by an inner scope (a `feature` param) so we never fold a call
  // that isn't the imported helper.
  for (const shadowed of shadowedNames(body, names)) names.delete(shadowed);
  if (names.size === 0) return identity;
  const edits: Edit[] = [];
  for (const item of body) {
    walkAst(item, (n) => {
      const key = foldableKey(n, names);
      if (key === null || !(key in features)) return; // unconfigured key → runtime shim
      edits.push({
        start: startOf(ctx, n),
        end: endOf(ctx, n),
        text: features[key] ? "true" : "false",
      });
    });
  }
  if (edits.length === 0) return identity; // imported but nothing foldable → leave in place
  // Only now (a real fold) do we relocate → absolutize its relative imports.
  if (opts.moduleUrl) absolutizeSpecifiers(ctx, body, opts.moduleUrl, edits);
  return { code: applyEdits(ctx.bytes, edits), changed: true };
}

/**
 * Fold `feature(...)` calls in each client module and return an import-map of
 * `original file URL → folded file URL` to merge into the native bundle's redirects. Runs
 * over each module's already-transformed source (`prior[url]` when a prior pass rewrote it,
 * else the original file), so the fold composes with auto-memo/qrl/async-context rather than
 * clobbering them. Unchanged modules are omitted.
 *
 * @param files Absolute paths of candidate client source modules.
 * @param prior The merged rewrite map from the earlier client transforms (`url → file url`).
 * @param opts.outDir The build output directory; opts.features the configured flags.
 */
export function compileFeatureModules(
  files: string[],
  prior: Record<string, string>,
  opts: { outDir: string; features: Record<string, boolean> },
): Promise<Record<string, string>> {
  if (Object.keys(opts.features).length === 0) return Promise.resolve({});
  return writeTransformedModules(
    files,
    join(opts.outDir, "features"),
    (source, url) => transformFeatures(source, opts.features, { moduleUrl: url }),
    // Read each module's already-transformed output when a prior pass rewrote it (so the fold
    // composes with auto-memo/qrl/async-context), else the original file. The map stays keyed
    // by the ORIGINAL URL, which is also the `url` passed to transformFeatures for absolutizing.
    (file) => {
      const transformed = prior[toFileUrl(file).href];
      return transformed ? fromFileUrl(transformed) : file;
    },
  );
}
