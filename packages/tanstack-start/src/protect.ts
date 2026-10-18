// The bundles' guard, run once esbuild has built one: TanStack Start's import protection on both
// sides, and denext's own server-only scan on the browser's, over the modules the bundle kept
// (esbuild's metafile, after TanStack's compiler removed what only the other side used).
//
// - **Start's import protection**, its rules and options as `@tanstack/start-plugin-core`
//   declares them (`importProtection` in Start's plugin options) and its build-mode semantics:
//   - in the browser, `@tanstack/<framework>-start/server`, a `*.server.*` file and a module
//     marked server-only (`import "@tanstack/react-start/server-only"`) are denied;
//   - on the server, a `*.client.*` file and a module marked client-only
//     (`import "@tanstack/react-start/client-only"`) are denied. `createClientOnlyFn` is the safe
//     boundary: Start's compiler replaces its body on the server, so an import only it used is
//     gone before the check, as `createServerFn().handler` is in the browser;
//   - the app's `importProtection` rules apply on top: `client.specifiers` adds to Start's own,
//     the rest (`client.files`, `server.*`, `excludeFiles`) replace them; `include`, `exclude` and
//     `ignoreImporters` choose the importers that are checked (by default, those under the source
//     directory); `onViolation` returning `false` waives one; `enabled: false` turns it off;
//   - a violation counts only when the import survived tree-shaking (the denied module, or for a
//     marker the marked module, is in the bundle), and each is reported in Start's own words.
// - **denext's server-only scan** (`findServerOnlyLeaks`, browser only): an app module the bundle
//   ships may not import a `node:` built-in, carry the `server-only` marker or use the `Deno`
//   global. A module the plugin compiled is scanned as compiled, so a server function's handler
//   (gone from the browser build) does not count.
//
// Either fails the build.

import { globToRegExp, isAbsolute, relative, resolve, SEPARATOR } from "@std/path";
import { findServerOnlyLeaks, type ServerOnlySignal } from "@denext/denext/build/next-compat";

/** The slice of an esbuild metafile the guard reads. */
export interface Metafile {
  inputs: Record<string, { imports: Array<{ path: string; original?: string }> }>;
  outputs: Record<
    string,
    { entryPoint?: string; inputs: Record<string, { bytesInOutput: number }> }
  >;
}

/** The environment a rule applies to (Start's `envType`). */
export type ProtectionEnv = "client" | "server";

/** A pattern: a glob over a root-relative path (or a specifier), or a regular expression. */
export type Pattern = string | RegExp;

/** One environment's rules (Start's `ImportProtectionEnvRules`). */
export interface ImportProtectionEnvRules {
  /** Import specifiers the environment may not import (matched as written). */
  specifiers?: Pattern[];
  /** Files (root-relative paths) the environment may not import. */
  files?: Pattern[];
  /** Files exempt from `files` (default: everything under a `node_modules` directory). */
  excludeFiles?: Pattern[];
}

/** One step of a violation's trace, entry first. */
export interface TraceStep {
  /** The module (absolute). */
  file: string;
  /** The specifier it imports the next step by. */
  specifier?: string;
}

/** A violation, in the shape Start hands to `onViolation` (its `ViolationInfo`). */
export interface ImportProtectionViolation {
  /** The build environment's name (`client` or `server`). */
  env: string;
  /** The environment the rule protects (`client` or `server`). */
  envType: ProtectionEnv;
  /** Which rule denied it. */
  type: "specifier" | "file" | "marker";
  /** What the violation does: fail the build (`"error"`), or a warning and a mock (`"mock"`). */
  behavior: ImportProtectionBehavior;
  /** The pattern that matched (a specifier or file rule). */
  pattern?: Pattern;
  /** The import as written (for a marker: the marker's specifier). */
  specifier: string;
  /** The importing module (for a marker: the marked module), absolute. */
  importer: string;
  /** The denied file, absolute (a file rule). */
  resolved?: string;
  /** The app modules from an entry to the importer. */
  trace: TraceStep[];
}

/**
 * The `importProtection` options of TanStack Start's plugin (`tanstackStart({ importProtection })`
 * from `@tanstack/react-start/plugin/vite`), as far as a denext build applies them.
 */
export interface ImportProtectionOptions {
  /** `false` turns Start's import protection off (denext's server-only scan still runs). */
  enabled?: boolean;
  /** Rules for the browser build (`specifiers` add to Start's; the other lists replace them). */
  client?: ImportProtectionEnvRules;
  /** Rules for the server build (each list replaces Start's). */
  server?: ImportProtectionEnvRules;
  /** When set, only importers matching one of these (root-relative) are checked. */
  include?: Pattern[];
  /** Importers matching these are not checked. */
  exclude?: Pattern[];
  /** Importers matching these are not checked. */
  ignoreImporters?: Pattern[];
  /** Called for each violation; returning `false` waives it. */
  onViolation?: (
    violation: ImportProtectionViolation,
  ) => boolean | void | Promise<boolean | void>;
  /**
   * Start's violation behavior: `"error"`, `"mock"` (both commands), or one per command
   * (`{ dev, build }`). Unset, or a command the object leaves out, takes Start's default:
   * `"mock"` in `denext dev`, `"error"` in a build (`build`, `start`, `export`). A `"mock"` is
   * Start's: a denied import resolves to Start's mock module, a denied file is replaced by one,
   * and the violation is a warning; an `"error"` fails the build (in dev, the request that builds).
   */
  behavior?: ImportProtectionBehavior | {
    dev?: ImportProtectionBehavior;
    build?: ImportProtectionBehavior;
  };
  /**
   * Start's runtime diagnostics for a mocked import in the browser (dev `"mock"` only): using the
   * mock logs Start's `[import-protection] Mocked import used in dev client` with
   * `console.error` (`"error"`, the default) or `console.warn` (`"warn"`), or nothing (`"off"`).
   */
  mockAccess?: "error" | "warn" | "off";
  /** How many importers a violation's trace walks up at most (default 20, as in Start). */
  maxTraceDepth?: number;
  /**
   * Start's repetition of its warnings: `"once"` (default) warns about each mocked violation once
   * per process, `"always"` on every build. A violation that fails the build is reported on every
   * build either way.
   */
  log?: "once" | "always";
}

/** Start's import-protection behavior. */
export type ImportProtectionBehavior = "error" | "mock";

const FRAMEWORKS = ["react", "solid", "vue"];

/** Start's default rules (`getDefaultImportProtectionRules`). */
const DEFAULT_RULES: Record<ProtectionEnv, Required<ImportProtectionEnvRules>> = {
  client: {
    specifiers: FRAMEWORKS.map((fw) => `@tanstack/${fw}-start/server`),
    files: ["**/*.server.*"],
    excludeFiles: ["**/node_modules/**"],
  },
  server: { specifiers: [], files: ["**/*.client.*"], excludeFiles: ["**/node_modules/**"] },
};

/** Start's environment markers (`getMarkerSpecifiers`); the group is the environment. */
const MARKER_SPECIFIER = /^@tanstack\/(?:react|solid|vue)-start\/(server|client)-only$/;

/** A compiled pattern. */
interface Matcher {
  pattern: Pattern;
  test(value: string): boolean;
}

const GLOB_LIKE = /[*?![\]{}()]/;

/** A pattern as a test: a RegExp as is, a literal by equality, a glob as a regular expression. */
function compileMatcher(pattern: Pattern): Matcher {
  if (pattern instanceof RegExp) {
    return {
      pattern,
      test: (value) => {
        pattern.lastIndex = 0;
        return pattern.test(value);
      },
    };
  }
  if (!GLOB_LIKE.test(pattern)) return { pattern, test: (value) => value === pattern };
  const re = globToRegExp(pattern, { extended: true, globstar: true });
  return { pattern, test: (value) => re.test(value) };
}

function compileAll(patterns: Pattern[]): Matcher[] {
  const seen = new Set<string>();
  return patterns.filter((p) => {
    const key = typeof p === "string" ? `s:${p}` : `r:${p}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(compileMatcher);
}

const matchesAny = (value: string, matchers: Matcher[]) => matchers.find((m) => m.test(value));

/** One environment's compiled rules. */
interface EnvMatchers {
  specifiers: Matcher[];
  files: Matcher[];
  excludeFiles: Matcher[];
}

/** Start's import protection for one app, compiled. */
export interface ImportProtection {
  readonly enabled: boolean;
  /** The project root (paths are matched relative to it). */
  readonly root: string;
  /** The environment's rules. */
  rules(env: ProtectionEnv): EnvMatchers;
  /** Whether an importer is checked (`include` / `exclude` / `ignoreImporters` / the source dir). */
  checksImporter(importer: string): boolean;
  /** The app's `onViolation` hook. */
  readonly onViolation?: ImportProtectionOptions["onViolation"];
  /** How many importers a trace walks up at most. */
  readonly maxTraceDepth: number;
  /** The command the builds are for: it picks Start's dev or build mocks. */
  readonly command: ProtectionCommand;
  /** What a violation does in this command: `"mock"` (Start's mocks, a warning) or `"error"`. */
  readonly behavior: ImportProtectionBehavior;
  /** Start's `mockAccess`: the browser mock's runtime diagnostics. */
  readonly mockAccess: "error" | "warn" | "off";
  /**
   * Whether a mocked violation is to be reported now (per `log`: once per process, or every
   * build). Marks it reported.
   */
  reportsMocked(key: string): boolean;
}

/** Which command a build is for: `denext dev`, or a build (`build`, `export`, `start`). */
export type ProtectionCommand = "dev" | "build";

/**
 * Start's behavior for a command: `importProtection.behavior` resolved as Start's plugin resolves
 * it (a string for both; else `behavior?.dev ?? "mock"` in dev, `behavior?.build ?? "error"` in a
 * build).
 *
 * @param options The app's `importProtection` options.
 * @param command The command the build is for.
 */
export function effectiveBehavior(
  options: ImportProtectionOptions | undefined,
  command: ProtectionCommand,
): ImportProtectionBehavior {
  const behavior = options?.behavior;
  if (typeof behavior === "string") return behavior;
  return command === "dev" ? behavior?.dev ?? "mock" : behavior?.build ?? "error";
}

/** Start's default `maxTraceDepth`. */
const DEFAULT_MAX_TRACE_DEPTH = 20;

/**
 * Start's import protection for an app: its default rules merged with the app's
 * `importProtection` options the way Start's plugin merges them.
 *
 * @param options The app's `importProtection` options.
 * @param root The project root.
 * @param srcDirectory The source directory (absolute): by default only importers under it are
 *   checked.
 * @param command The command the build is for (default `"build"`): it resolves `behavior`.
 */
export function compileImportProtection(
  options: ImportProtectionOptions | undefined,
  root: string,
  srcDirectory: string,
  command: ProtectionCommand = "build",
): ImportProtection {
  const pick = (user: Pattern[] | undefined, fallback: Pattern[]) => [...(user ?? fallback)];
  const env = (name: ProtectionEnv): EnvMatchers => {
    const user = options?.[name];
    const defaults = DEFAULT_RULES[name];
    return {
      // The browser's denied specifiers always keep Start's own.
      specifiers: compileAll(
        name === "client"
          ? [...defaults.specifiers, ...(user?.specifiers ?? [])]
          : pick(user?.specifiers, defaults.specifiers),
      ),
      files: compileAll(pick(user?.files, defaults.files)),
      excludeFiles: compileAll(pick(user?.excludeFiles, defaults.excludeFiles)),
    };
  };
  const rules = { client: env("client"), server: env("server") };
  const reported = new Set<string>();
  const include = compileAll(options?.include ?? []);
  const exclude = compileAll([...(options?.exclude ?? []), ...(options?.ignoreImporters ?? [])]);
  return {
    enabled: options?.enabled !== false,
    root,
    rules: (name) => rules[name],
    checksImporter(importer) {
      if (!isAbsolute(importer)) return false;
      const rel = relativePath(importer, root);
      if (matchesAny(rel, exclude)) return false;
      if (include.length > 0) return !!matchesAny(rel, include);
      return importer.startsWith(srcDirectory + SEPARATOR);
    },
    onViolation: options?.onViolation,
    maxTraceDepth: options?.maxTraceDepth ?? DEFAULT_MAX_TRACE_DEPTH,
    command,
    behavior: options?.enabled === false ? "error" : effectiveBehavior(options, command),
    mockAccess: options?.mockAccess ?? "error",
    reportsMocked(key) {
      if (reported.has(key) && options?.log !== "always") return false;
      reported.add(key);
      return true;
    },
  };
}

/** A path relative to `root`, `/`-separated (kept as is outside it). */
function relativePath(path: string, root: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return path.replace(/\\/g, "/");
  return rel.replace(/\\/g, "/");
}

/** An import the build recorded as it resolved: a denied specifier. */
export interface DeniedImport {
  importer: string;
  specifier: string;
  /** The specifier rule that denied it. */
  pattern: Pattern;
  /** The metafile id of the module it resolved to (default: {@link deniedModulePath}). */
  module?: string;
}

/** What one build recorded while it resolved. */
export interface ResolveRecord {
  /** Specifier-rule denials (each resolved to an empty module, {@link deniedModulePath}). */
  denied: DeniedImport[];
  /** Start's environment markers, by the module that imports one. */
  markers: Map<string, { kind: ProtectionEnv; specifier: string }>;
}

/** A fresh {@link ResolveRecord}. */
export const newResolveRecord = (): ResolveRecord => ({ denied: [], markers: new Map() });

/** The namespace a denied import resolves into (an empty module; the build then fails). */
export const DENIED_NS = "denext-tss-denied";

/** The metafile id of a denied specifier's empty module. */
export const deniedModulePath = (specifier: string) => `${DENIED_NS}:${specifier}`;

/**
 * Record an import as the build resolves it and say what to do with it: `"mock"` resolves it to
 * an empty module (a denied specifier, and in the browser Start's server-only marker — Start's
 * server entry does not even resolve there), `"pass"` resolves it as usual.
 *
 * @param protection The app's import protection.
 * @param env The build's environment.
 * @param record Where the build records what it saw.
 * @param specifier The import as written.
 * @param importer The importing module (absolute).
 * @throws When one module imports both markers (Start's error).
 */
export function recordImport(
  protection: ImportProtection,
  env: ProtectionEnv,
  record: ResolveRecord,
  specifier: string,
  importer: string,
): "mock" | "pass" {
  if (!protection.enabled || !importer || !isAbsolute(importer)) return "pass";
  const marker = MARKER_SPECIFIER.exec(specifier);
  if (marker) {
    const kind = marker[1] as ProtectionEnv;
    const existing = record.markers.get(importer);
    if (existing && existing.kind !== kind) {
      throw new Error(
        `[import-protection] File "${
          relativePath(importer, protection.root)
        }" has both server-only and client-only markers. This is not allowed.`,
      );
    }
    record.markers.set(importer, { kind, specifier });
    return env === "client" && kind === "server" ? "mock" : "pass";
  }
  if (!protection.checksImporter(importer)) return "pass";
  const match = matchesAny(specifier, protection.rules(env).specifiers);
  if (!match) return "pass";
  record.denied.push({ importer, specifier, pattern: match.pattern });
  return "mock";
}

/**
 * The esbuild `onResolve` filter for the imports the build must see: the markers and the
 * environment's denied specifiers (every import once one of those is a glob or a RegExp).
 *
 * @param protection The app's import protection.
 * @param env The build's environment.
 */
export function resolveFilter(protection: ImportProtection, env: ProtectionEnv): RegExp {
  const patterns = protection.rules(env).specifiers.map((m) => m.pattern);
  if (patterns.some((p) => typeof p !== "string" || GLOB_LIKE.test(p))) return /.*/;
  const literals = (patterns as string[]).map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  return new RegExp(`^(?:${[MARKER_SPECIFIER.source.slice(1, -1), ...literals].join("|")})$`);
}

/** A metafile path (relative to the build's working dir, or `namespace:id`) → a module id. */
function moduleId(path: string, cwd: string): string {
  // A namespace prefix is longer than a Windows drive letter.
  if (/^[a-z][\w-]+:/i.test(path) && !isAbsolute(path)) return path;
  return resolve(cwd, path);
}

const inNodeModules = (path: string) => /[\\/]node_modules[\\/]/.test(path);

/** Whether `path` is one of the app's own modules (a file under `cwd`, not a package). */
export function isAppModule(path: string, cwd: string): boolean {
  return isAbsolute(path) && path.startsWith(cwd + SEPARATOR) && !inNodeModules(path);
}

/** A module the plugin generates (`.denext/`), left out of traces. */
const isGenerated = (path: string, cwd: string) => /^\.denext[\\/]/.test(relative(cwd, path));

/** A bundle's import graph: each module's imports, its importers, and what the bundle kept. */
export interface BundleGraph {
  imports: Map<string, Array<{ to: string; specifier: string }>>;
  importers: Map<string, Array<{ from: string; specifier: string }>>;
  /** The modules with code in an output (what tree-shaking kept). */
  kept: Set<string>;
}

/**
 * The import graph of a bundle's metafile, module ids absolute (or `namespace:id`).
 *
 * @param meta The build's metafile.
 * @param cwd The build's working directory.
 */
export function bundleGraph(meta: Metafile, cwd: string): BundleGraph {
  const imports = new Map<string, Array<{ to: string; specifier: string }>>();
  const importers = new Map<string, Array<{ from: string; specifier: string }>>();
  for (const [from, input] of Object.entries(meta.inputs)) {
    const id = moduleId(from, cwd);
    const edges = input.imports.map((imp) => ({
      to: moduleId(imp.path, cwd),
      specifier: imp.original ?? imp.path,
    }));
    imports.set(id, edges);
    for (const { to, specifier } of edges) {
      const list = importers.get(to) ?? [];
      list.push({ from: id, specifier });
      importers.set(to, list);
    }
  }
  const kept = new Set<string>();
  for (const output of Object.values(meta.outputs)) {
    for (const [path, { bytesInOutput }] of Object.entries(output.inputs)) {
      if (bytesInOutput > 0) kept.add(moduleId(path, cwd));
    }
  }
  return { imports, importers, kept };
}

/** Where each module was reached from, walking up from a violation's importer. */
type Down = Map<string, { next: string; specifier: string }>;

/** The breadth-first walk up from a violation's importer. */
interface Walk {
  target: string;
  down: Down;
  depth: Map<string, number>;
  queue: string[];
  maxDepth: number;
}

/** Queue the importers of `node` not reached yet; `node` itself when it is an entry. */
function stepUp(graph: BundleGraph, node: string, walk: Walk) {
  const from = graph.importers.get(node) ?? [];
  if (node !== walk.target && from.length === 0) return node;
  const depth = walk.depth.get(node) ?? 0;
  if (depth >= walk.maxDepth) return null; // Start's maxTraceDepth: no further up from here
  for (const edge of from) {
    if (edge.from === walk.target || walk.down.has(edge.from)) continue;
    walk.down.set(edge.from, { next: node, specifier: edge.specifier });
    walk.depth.set(edge.from, depth + 1);
    walk.queue.push(edge.from);
  }
  return null;
}

/**
 * The shortest import path from an entry (a module nothing imports) to `target`, each step with
 * the specifier it imports the next one by, walking at most `maxDepth` importers up (Start's
 * `buildTrace`: with no entry within reach, the trace is `target` alone).
 */
function shortestImportPath(graph: BundleGraph, target: string, maxDepth: number): TraceStep[] {
  const down: Down = new Map();
  const walk: Walk = { target, down, depth: new Map([[target, 0]]), queue: [target], maxDepth };
  let root: string | null = null;
  for (let i = 0; i < walk.queue.length && !root; i++) {
    root = stepUp(graph, walk.queue[i], walk);
  }
  const path: TraceStep[] = [];
  for (let at = root ?? target;;) {
    const link = down.get(at);
    path.push({ file: at, specifier: link?.specifier });
    if (at === target || !link) return path;
    at = link.next;
  }
}

/** The app modules (not packages, nor the plugin's generated entries) on the way to `target`. */
function traceTo(
  graph: BundleGraph,
  target: string,
  cwd: string,
  maxDepth = DEFAULT_MAX_TRACE_DEPTH,
): TraceStep[] {
  return shortestImportPath(graph, target, maxDepth).filter((s) =>
    s.file === target || (isAppModule(s.file, cwd) && !isGenerated(s.file, cwd))
  );
}

/** A violation before its environment and trace are filled in. */
type Found = Omit<ImportProtectionViolation, "env" | "envType" | "behavior" | "trace">;

/** The recorded specifier denials whose importer and stand-in module the bundle kept. */
function specifierViolations(graph: BundleGraph, record: ResolveRecord): Found[] {
  return record.denied
    .filter((d) =>
      graph.kept.has(d.importer) && graph.kept.has(d.module ?? deniedModulePath(d.specifier))
    )
    .map(({ importer, specifier, pattern }) => ({
      type: "specifier" as const,
      pattern,
      specifier,
      importer,
    }));
}

/** The `files` rule that denies `file` (absolute) unless `excludeFiles` exempts it. */
function fileRuleMatch(rules: EnvMatchers, file: string, root: string): Matcher | undefined {
  const rel = relativePath(file, root);
  return matchesAny(rel, rules.excludeFiles) ? undefined : matchesAny(rel, rules.files);
}

/**
 * The `files` pattern that denies the environment `file` (absolute), or `undefined`: Start's
 * self-denial check, which with a `"mock"` behavior replaces the file with a mock.
 *
 * @param protection The app's import protection.
 * @param env The build's environment.
 * @param file The module.
 */
export function deniedFilePattern(
  protection: ImportProtection,
  env: ProtectionEnv,
  file: string,
): Pattern | undefined {
  if (!protection.enabled) return undefined;
  return fileRuleMatch(protection.rules(env), file, protection.root)?.pattern;
}

/** The kept imports, from a checked importer, of a file the environment's `files` deny. */
function fileViolations(graph: BundleGraph, protection: ImportProtection, rules: EnvMatchers) {
  const found: Found[] = [];
  const denial = (to: string) =>
    isAbsolute(to) && graph.kept.has(to) ? fileRuleMatch(rules, to, protection.root) : undefined;
  for (const [from, edges] of graph.imports) {
    if (!graph.kept.has(from) || !protection.checksImporter(from)) continue;
    for (const { to, specifier } of edges) {
      const match = denial(to);
      if (match) {
        found.push({
          type: "file",
          pattern: match.pattern,
          specifier,
          importer: from,
          resolved: to,
        });
      }
    }
  }
  return found;
}

/** The kept modules marked for the other environment. */
function markerViolations(graph: BundleGraph, record: ResolveRecord, env: ProtectionEnv) {
  return [...record.markers]
    .filter(([module, { kind }]) => kind !== env && graph.kept.has(module))
    .map(([module, { specifier }]): Found => ({ type: "marker", specifier, importer: module }));
}

/**
 * Start's import-protection violations in a bundle: each recorded denial, file-rule import and
 * marked module that tree-shaking kept, after the app's `onViolation`.
 *
 * @param meta The build's metafile.
 * @param cwd The build's working directory (the metafile's paths are relative to it).
 * @param protection The app's import protection.
 * @param env The build's environment.
 * @param record What the build recorded while it resolved.
 */
export async function importProtectionViolations(
  meta: Metafile,
  cwd: string,
  protection: ImportProtection,
  env: ProtectionEnv,
  record: ResolveRecord = newResolveRecord(),
): Promise<ImportProtectionViolation[]> {
  if (!protection.enabled) return [];
  const graph = bundleGraph(meta, cwd);
  const found = new Map<string, ImportProtectionViolation>();
  for (
    const v of [
      ...specifierViolations(graph, record),
      ...fileViolations(graph, protection, protection.rules(env)),
      ...markerViolations(graph, record, env),
    ]
  ) {
    const key = `${v.type}|${v.importer}|${v.resolved ?? v.specifier}`;
    if (found.has(key)) continue;
    found.set(key, {
      env,
      envType: env,
      behavior: protection.behavior,
      ...v,
      trace: traceTo(graph, v.importer, cwd, protection.maxTraceDepth),
    });
  }
  const violations: ImportProtectionViolation[] = [];
  for (const v of found.values()) {
    if (protection.onViolation && (await protection.onViolation(v)) === false) continue;
    violations.push(v);
  }
  return violations;
}

/** Start's suggestions for server code reaching the browser (`CLIENT_ENV_SUGGESTIONS`). */
const CLIENT_ENV_SUGGESTIONS = [
  "Use createServerFn().handler(() => ...) to keep the logic on the server and call it from the client via an RPC bridge",
  "Use createServerOnlyFn(() => ...) to mark it as server-only (it will throw if accidentally called from the client)",
  "Use createIsomorphicFn().client(() => ...).server(() => ...) to provide separate client and server implementations",
  "Move the server-only import out of this file into a separate .server.ts module that is not imported by any client code",
];

/** Start's suggestions for browser code reaching the server (`SERVER_ENV_SUGGESTIONS`). */
const SERVER_ENV_SUGGESTIONS = [
  "Use createClientOnlyFn(() => ...) to mark it as client-only (returns undefined on the server)",
  "Use createIsomorphicFn().client(() => ...).server(() => ...) to provide separate client and server implementations",
  "Move the client-only import out of this file into a separate .client.ts module that is not imported by any server code",
];

/**
 * One violation in Start's words (its `formatViolation`).
 *
 * @param v The violation.
 * @param root The directory paths are shown relative to.
 */
export function formatViolation(v: ImportProtectionViolation, root: string): string {
  const rel = (p: string) => relativePath(p, root);
  const lines = ["", `[import-protection] Import denied in ${v.envType} environment`, ""];
  if (v.type === "specifier") lines.push(`  Denied by specifier pattern: ${String(v.pattern)}`);
  else if (v.type === "file") lines.push(`  Denied by file pattern: ${String(v.pattern)}`);
  else lines.push("  Denied by marker: module is restricted to the opposite environment");
  lines.push(`  Importer: ${rel(v.importer)}`, `  Import: "${rel(v.specifier)}"`);
  if (v.resolved) lines.push(`  Resolved: ${rel(v.resolved)}`);
  if (v.trace.length > 0) {
    lines.push("", "  Trace:");
    v.trace.forEach((step, i) => {
      const tag = i === 0 ? " (entry)" : "";
      const last = i === v.trace.length - 1;
      const spec = step.specifier && !last ? ` (import "${rel(step.specifier)}")` : "";
      lines.push(`    ${i + 1}. ${rel(step.file)}${tag}${spec}`);
    });
  }
  lines.push("", "  Suggestions:");
  const suggestions = v.envType === "client" ? CLIENT_ENV_SUGGESTIONS : SERVER_ENV_SUGGESTIONS;
  for (const s of suggestions) lines.push(`    - ${s}`);
  lines.push("");
  return lines.join("\n");
}

/** One module the browser bundle may not ship (denext's server-only scan). */
export interface Leak {
  /** Why: the denext server-only signals it carries. */
  rule: string;
  /** The module (absolute). */
  module: string;
  /** The app modules that reached it, entry first, the module last (absolute). */
  chain: string[];
}

/** A one-phrase reading of each denext server-only signal. */
const SIGNAL_TEXT: Record<ServerOnlySignal, string> = {
  "node-import": "imports a node: built-in",
  "server-only-marker": 'is marked server-only (import "server-only")',
  "deno-global": "uses the Deno global",
};

/**
 * denext's server-only leaks among the app modules the bundle shipped (what survived
 * tree-shaking), each read as the bundle compiled it.
 *
 * @param meta The client build's metafile.
 * @param cwd The build's working directory.
 * @param read A shipped module's source as it went into the bundle.
 */
export async function serverOnlyLeaks(
  meta: Metafile,
  cwd: string,
  read: (path: string) => Promise<string>,
): Promise<Leak[]> {
  const graph = bundleGraph(meta, cwd);
  const shipped = [...graph.kept].filter((id) => isAppModule(id, cwd));
  // The scan compares real paths (a symlinked checkout); report the paths the build used.
  const byReal = new Map<string, string>();
  for (const path of shipped) byReal.set(await Deno.realPath(path).catch(() => path), path);
  const leaks = await findServerOnlyLeaks(byReal.keys(), cwd, (real) => read(byReal.get(real)!));
  return leaks.map((leak) => {
    const module = byReal.get(leak.module) ?? leak.module;
    return {
      rule: leak.signals.map((s) => SIGNAL_TEXT[s]).join("; "),
      module,
      chain: traceTo(graph, module, cwd).map((s) => s.file),
    };
  });
}

/**
 * The build error for a bundle's violations and leaks, or `null` when there are none: Start's
 * report for each import-protection violation, then denext's for the server-only leaks.
 *
 * @param violations What {@link importProtectionViolations} found.
 * @param leaks What {@link serverOnlyLeaks} found (browser only).
 * @param cwd The directory paths are shown relative to.
 */
export function formatGuardError(
  violations: ImportProtectionViolation[],
  leaks: Leak[],
  cwd: string,
): string | null {
  if (violations.length === 0 && leaks.length === 0) return null;
  const parts = violations.map((v) => formatViolation(v, cwd));
  if (leaks.length > 0) {
    const show = (p: string) => relativePath(p, cwd);
    const lines = leaks.map((l) =>
      `  ${show(l.module)} — ${l.rule}\n    imported through ${l.chain.map(show).join(" → ")}`
    );
    parts.push(
      `@denext/tanstack-start: server-only code would ship to the browser.\n\n` +
        `${lines.join("\n")}\n\n` +
        `Every route module is bundled for the browser, with what it imports. Keep server code ` +
        `in a createServerFn handler (the browser gets an RPC stub) or a createServerOnlyFn ` +
        `body, give the browser its own implementation with createIsomorphicFn, or move the ` +
        `import into a module only server code imports.`,
    );
  }
  return parts.join("\n");
}
