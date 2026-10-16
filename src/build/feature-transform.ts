// Build-time fold of `feature("KEY")` calls (from `denext/feature`) to boolean literals,
// so both bundlers dead-code-eliminate the untaken branch — denext's answer to Bun's
// `feature()` from `bun:bundle`. A sibling of the auto-memo compiler and the AsyncContext
// pass (src/build/async-context-transform.ts): a build-time swc rewrite, since denext owns
// no transpile hook.
//
// Only a `feature(...)` call with a STRING-LITERAL argument whose key is listed in
// `features` is folded; a non-literal argument or an unlisted key is left as a
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
  type Ctx,
  type Edit,
  endOf,
  type Node,
  parseModule,
  startOf,
  walkAst,
  writeTransformedModules,
} from "./swc-ast.ts";
import type { Platform } from "../platform.ts";

/** The import specifier authors use for the feature helper. */
const FEATURE_SPECIFIER = "denext/feature";

/** The import specifier of the build-target constant (`import { platform } from …`). */
export const PLATFORM_SPECIFIER = "denext/platform";

/** The build-time constants a module is folded against. */
export interface BuildConstants {
  /** The configured `features` (`feature("KEY")` → its boolean). Empty or absent: none folded. */
  features?: Record<string, boolean>;
  /** The build target (`platform` → its name). Absent: `platform` is not folded. */
  platform?: Platform;
}

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
export function shadowedNames(body: Node[], importNames: Set<string>): Set<string> {
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
 * @param features The configured flags (`features`).
 * @param opts.moduleUrl The module's own URL — pass it only when the caller relocates folded output.
 */
export function transformFeatures(
  source: string,
  features: Record<string, boolean>,
  opts: { moduleUrl?: string } = {},
): Promise<FeatureFoldResult> {
  return foldBuildConstants(source, { features }, opts);
}

/** Whether `source` may hold something {@linkcode foldBuildConstants} folds (a cheap pre-filter). */
function mayFoldBuildConstants(source: string, constants: BuildConstants): boolean {
  const features = constants.features && Object.keys(constants.features).length > 0;
  return (!!features && source.includes("feature")) ||
    (constants.platform !== undefined && source.includes(PLATFORM_SPECIFIER));
}

/**
 * Fold a module's build-time constants: each `feature("KEY")` call whose KEY is configured
 * (see {@linkcode transformFeatures}), and — with `constants.platform` — each read of the
 * `platform` constant from `denext/platform` to the target's name, and each comparison of it
 * with a string literal (`platform === "ios"`, `platform != "web"`) to a boolean literal, so the
 * bundler drops the other targets' branches. A namespace import's `ns.platform` folds the same
 * way. `opts.moduleUrl` absolutizes relative imports of a folded module (a relocated copy).
 *
 * @param source The module source.
 * @param constants The configured flags and the build target.
 * @param opts.moduleUrl The module's own URL — pass it only when the caller relocates folded output.
 */
export async function foldBuildConstants(
  source: string,
  constants: BuildConstants,
  opts: { moduleUrl?: string } = {},
): Promise<FeatureFoldResult> {
  const identity: FeatureFoldResult = { code: source, changed: false };
  if (!mayFoldBuildConstants(source, constants)) return identity;
  const parsed = await parseModule(source);
  if (!parsed) return identity;
  const { ctx, body } = parsed;
  const edits: Edit[] = [];
  const features = constants.features ?? {};
  const names = featureBindings(body);
  for (const shadowed of shadowedNames(body, names)) names.delete(shadowed);
  if (names.size > 0) {
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
  }
  if (constants.platform !== undefined) {
    edits.push(...platformEdits(ctx, body, constants.platform));
  }
  if (edits.length === 0) return identity; // imported but nothing foldable → leave in place
  // Only now (a real fold) do we relocate → absolutize its relative imports.
  if (opts.moduleUrl) absolutizeSpecifiers(ctx, body, opts.moduleUrl, edits);
  return { code: applyEdits(ctx.bytes, edits), changed: true };
}

/** Whether `item` is a value import of `denext/platform`. */
function isPlatformImport(item: Node): boolean {
  return item.type === "ImportDeclaration" && item.source?.value === PLATFORM_SPECIFIER &&
    !item.typeOnly;
}

/** The `platform` constant's local bindings: named imports and namespace imports. */
interface PlatformBindings {
  readonly names: Set<string>;
  readonly namespaces: Set<string>;
}

/** Record one specifier of a `denext/platform` import into `out`. */
function addPlatformSpecifier(s: Node, out: PlatformBindings): void {
  if (s.type === "ImportNamespaceSpecifier") {
    out.namespaces.add(s.local.value);
    return;
  }
  if (s.type !== "ImportSpecifier" || s.isTypeOnly) return;
  if ((s.imported?.value ?? s.local?.value) === "platform") out.names.add(s.local.value);
}

/** The local names bound to `platform` from `denext/platform`, and its namespace imports. */
function platformBindings(body: Node[]): PlatformBindings {
  const out: PlatformBindings = { names: new Set(), namespaces: new Set() };
  for (const item of body.filter(isPlatformImport)) {
    for (const s of item.specifiers ?? []) addPlatformSpecifier(s, out);
  }
  for (const set of [out.names, out.namespaces]) {
    for (const shadowed of shadowedNames(body, set)) set.delete(shadowed);
  }
  return out;
}

/** Comparison operators a `platform` read folds through. */
const EQUALITY: Record<string, boolean> = { "===": true, "==": true, "!==": false, "!=": false };

/**
 * Collects the edits folding `platform` reads to one target: a comparison with a string literal
 * to a boolean, any other expression read to the target's name. Skips what is not an expression
 * read: types, property keys and non-computed member names, JSX tag names, labels, and the
 * module's import / export declarations. A shorthand property `{ platform }` becomes
 * `{ platform: "ios" }`.
 */
class PlatformFold {
  readonly edits: Edit[] = [];
  readonly #literal: string;

  constructor(
    private readonly ctx: Ctx,
    private readonly bindings: PlatformBindings,
    private readonly target: Platform,
  ) {
    this.#literal = JSON.stringify(target);
  }

  /** Whether `n` reads the constant: a bound name, or `ns.platform` on a namespace import. */
  #isRead(n: Node): boolean {
    if (n?.type === "Identifier") return this.bindings.names.has(n.value);
    if (n?.type !== "MemberExpression" || n.object?.type !== "Identifier") return false;
    return this.bindings.namespaces.has(n.object.value) && n.property?.value === "platform" &&
      n.property.type === "Identifier";
  }

  #replace(n: Node, text: string): void {
    this.edits.push({ start: startOf(this.ctx, n), end: endOf(this.ctx, n), text });
  }

  /** Fold `platform === "…"` (either side, any equality operator); false when `n` is not one. */
  #foldComparison(n: Node): boolean {
    if (n.type !== "BinaryExpression" || !(n.operator in EQUALITY)) return false;
    const [ref, other] = this.#isRead(n.left) ? [n.left, n.right] : [n.right, n.left];
    if (!this.#isRead(ref) || other?.type !== "StringLiteral") return false;
    const equal = other.value === this.target;
    this.#replace(n, String(EQUALITY[n.operator] ? equal : !equal));
    return true;
  }

  /** An object literal: a shorthand `{ platform }` keeps its key. */
  #visitObject(n: Node): void {
    for (const p of n.properties ?? []) {
      if (p?.type === "Identifier" && this.bindings.names.has(p.value)) {
        this.#replace(p, `${p.value}: ${this.#literal}`);
      } else this.visit(p);
    }
  }

  /** Visit a node (or an array of them). */
  visit(n: Node): void {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) this.visit(c);
      return;
    }
    if (typeof n.type === "string" && SKIPPED_NODES.test(n.type)) return;
    if (this.#foldComparison(n)) return;
    if (this.#isRead(n)) return this.#replace(n, this.#literal);
    if (n.type === "ObjectExpression") return this.#visitObject(n);
    for (const key of Object.keys(n)) if (!skippedKey(n, key)) this.visit(n[key]);
  }
}

/** Whether `n[key]` holds no expression read: a name, a type, a non-computed member or key. */
function skippedKey(n: Node, key: string): boolean {
  if (key === "span") return true;
  const computed = n[key]?.type === "Computed"; // `{ [platform]: … }`, `x[platform]` are reads
  if (NAME_KEYS.has(key) || key === "property") return !computed;
  return key === "name" && typeof n.type === "string" && n.type.startsWith("JSX");
}

/** The edits that fold `platform` reads in `body` to `target` (see {@linkcode PlatformFold}). */
function platformEdits(ctx: Ctx, body: Node[], target: Platform): Edit[] {
  const bindings = platformBindings(body);
  if (bindings.names.size === 0 && bindings.namespaces.size === 0) return [];
  const fold = new PlatformFold(ctx, bindings, target);
  for (const item of body) fold.visit(item);
  return fold.edits;
}

/**
 * Nodes whose subtree holds no expression read of the constant: TypeScript types (not the
 * expression wrappers `x as T`, `x!`, `x satisfies T`, `<T>x`, `x<T>`), the module's own
 * import / re-export lists, a JSX member tag name, and a bare `break` / `continue` label.
 */
const SKIPPED_NODES =
  /^(?:Ts(?!AsExpression$|NonNullExpression$|SatisfiesExpression$|TypeAssertion$|ConstAssertion$|Instantiation$)|ImportDeclaration$|ExportNamedDeclaration$|ExportAllDeclaration$|JSXMemberExpression$|JSXNamespacedName$|BreakStatement$|ContinueStatement$)/;

/** Keys that hold a name or a type, never an expression read (property keys, labels, JSX names). */
const NAME_KEYS = new Set(["key", "label", "typeAnnotation", "typeParameters", "typeArguments"]);

/**
 * Fold the build-time constants (`feature(...)` calls, and with `opts.platform` the `platform`
 * constant) in each client module and return an import-map of
 * `original file URL → folded file URL` to merge into the native bundle's redirects. Runs
 * over each module's already-transformed source (`prior[url]` when a prior pass rewrote it,
 * else the original file), so the fold composes with auto-memo/qrl/async-context rather than
 * clobbering them. Unchanged modules are omitted.
 *
 * @param files Absolute paths of candidate client source modules.
 * @param prior The merged rewrite map from the earlier client transforms (`url → file url`).
 * @param opts.outDir The build output directory; opts.features the configured flags;
 *   opts.platform the build target (omit to leave `platform` reads alone).
 */
export function compileFeatureModules(
  files: string[],
  prior: Record<string, string>,
  opts: { outDir: string; features: Record<string, boolean>; platform?: Platform },
): Promise<Record<string, string>> {
  const constants: BuildConstants = { features: opts.features, platform: opts.platform };
  if (Object.keys(opts.features).length === 0 && opts.platform === undefined) {
    return Promise.resolve({});
  }
  return writeTransformedModules(
    files,
    join(opts.outDir, "features"),
    (source, url) => foldBuildConstants(source, constants, { moduleUrl: url }),
    // Read each module's already-transformed output when a prior pass rewrote it (so the fold
    // composes with auto-memo/qrl/async-context), else the original file. The map stays keyed
    // by the ORIGINAL URL, which is also the `url` passed to foldBuildConstants for absolutizing.
    (file) => {
      const transformed = prior[toFileUrl(file).href];
      return transformed ? fromFileUrl(transformed) : file;
    },
  );
}
