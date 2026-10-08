// denext plugin contract — the narrow, semver-stable surface a plugin extends.
//
// A plugin is a named unit that hooks three seams denext already has:
//   1. route synthesis — contribute/adjust routes in every scanned manifest
//      (runs inside `scanRoutes`, so it applies to dev, build, prod, and export);
//   2. request handling — claim a request the core App Router didn't match and
//      serve it with a distinct render path (e.g. a Pages Router with its own
//      `_app`/`_document`/`getServerSideProps` pipeline);
//   3. build steps — emit the plugin's own client bundles/assets at build and export time
//      (`emitFile` publishes a generated file at the site root, like Vite's `this.emitFile`).
//
// Everything a plugin renders it does with denext's PUBLIC exports (JSX runtime,
// `react-dom/server`, `denext/client`, `renderDocument`) — the core only routes
// requests to it. Keep this surface minimal: it becomes public API the moment a
// third party writes against it.

import type { DenextConfig } from "../server/config.ts";
import type { ModuleLoader } from "../server/types.ts";
import type { RouteSynthesizer } from "../router/manifest.ts";
import { registerRouteSynthesizer } from "../router/manifest.ts";
import type { CommandSpec } from "../cli/command.ts";
import { dirname, globToRegExp, isAbsolute, join, SEPARATOR, SEPARATOR_PATTERN } from "@std/path";

/** Where denext is running when a plugin's {@linkcode DenextPlugin.setup} fires. */
export type PluginMode = "dev" | "build" | "prod" | "export";

/**
 * Claim and handle a request the core router did not match. Return a
 * {@linkcode Response} to serve it, or `null`/`undefined` to pass (letting denext
 * fall through to static assets and the 404). Runs AFTER App-Router page/API
 * matching, so core routes always win.
 */
export type PluginRequestHandler = (
  request: Request,
) => Response | null | undefined | Promise<Response | null | undefined>;

/**
 * A build-time step that emits the plugin's client bundles/assets into `outDir`, and publishes
 * generated files at the site root with {@linkcode PluginBuildContext.emitFile}. Runs at
 * `denext build` and at `denext export` (App Router, SPA and Pages Router alike).
 */
export type PluginBuildStep = (context: PluginBuildContext) => void | Promise<void>;

/**
 * A step that prepares generated inputs (typed accessors, a data artifact) BEFORE the app is
 * bundled or served — the seam a plugin uses to generate code the app then imports. Unlike a
 * {@linkcode PluginBuildStep} (which runs only at `denext build` / `export`), a prepare step runs in **both**
 * lifecycles: once at `denext build` and once at `denext dev` startup, and again during dev whenever
 * a file under its {@linkcode PrepareStepOptions.watch} globs changes — so its generated output stays
 * live as you edit. Its {@linkcode PluginPrepareContext} is a build step's context without the
 * emit seam: a prepare step generates inputs, not published output.
 */
export type PluginPrepareStep = (context: PluginPrepareContext) => void | Promise<void>;

/** Options for {@linkcode PluginContext.addPrepareStep}. */
export interface PrepareStepOptions {
  /**
   * Glob patterns (relative to `projectRoot`, or absolute) whose changes re-run this step under
   * `denext dev`. Omit to run only at startup/build (no dev re-run on file changes).
   */
  readonly watch?: readonly string[];
}

/**
 * A disposer that releases resources a plugin opened in {@linkcode DenextPlugin.setup}
 * (watchers, connections, timers). Registered with {@linkcode PluginContext.addTeardown}
 * and run — most-recently-registered first — when the server drains.
 */
export type PluginTeardown = () => void | Promise<void>;

/** Context passed to a {@linkcode PluginPrepareStep} (and the base of a build step's). */
export interface PluginPrepareContext {
  /** Absolute project root (the dir holding `denext.config.*`). */
  readonly projectRoot: string;
  /** Absolute App Router scan root (`app/` or `src/app/`) — avoid colliding with it. */
  readonly appDir: string;
  /** Absolute build output directory the step should write assets into. */
  readonly outDir: string;
  /** The resolved project config. */
  readonly config: DenextConfig;
}

/** A generated file a build step publishes with {@linkcode PluginBuildContext.emitFile}. */
export interface EmittedAsset {
  /**
   * Where the file is served, relative to the site root, `/`-separated:
   * `"third-party-licenses.json"` is served at `/third-party-licenses.json`, `"meta/build.json"`
   * at `/meta/build.json`. An absolute path, a `..` segment or a backslash is refused.
   */
  readonly fileName: string;
  /** The file's contents: text (written as UTF-8) or bytes. */
  readonly source: string | Uint8Array;
}

/** Context passed to a {@linkcode PluginBuildStep}. */
export interface PluginBuildContext extends PluginPrepareContext {
  /**
   * Publish a generated file at the site root: the build-time analogue of a Vite plugin's
   * `this.emitFile({ type: "asset", fileName, source })` from `generateBundle`. In
   * `denext export` the file lands in the export directory (next to `public/`'s files, after
   * them, so an emitted file replaces a same-named public one); in `denext build` it lands in
   * `<outDir>/emitted/`, which `denext start` serves at the same URL, ahead of `public/`.
   * Resolves once the file is written. Rejects a path outside the site root and one the build
   * publishes itself: `index.html`, anything under `_denext/` and the `spa.assetsDir` directory.
   */
  emitFile(asset: EmittedAsset): Promise<void>;
  /**
   * The modules bundled into the client output, as absolute paths (a module esbuild loaded from
   * a virtual namespace keeps its `namespace:path` id), when this build knows them: a SPA built
   * on the esbuild path (npm React, `compatibilityMode`, React Native mode) collects them while
   * plugins are configured. `undefined` everywhere else — read it as "unknown", not "none".
   */
  readonly clientModules?: readonly string[];
}

/** Where `denext build` writes emitted files, under the build output dir; `start` serves it. */
export const EMITTED_DIR = "emitted";

/** The seams a plugin's {@linkcode DenextPlugin.setup} may extend. */
export interface PluginContext {
  /** Absolute project root (the dir holding `denext.config.*`). */
  readonly projectRoot: string;
  /** Absolute App Router scan root (`app/` or `src/app/`). */
  readonly appDir: string;
  /** The resolved project config. */
  readonly config: DenextConfig;
  /** Which pipeline is running: `dev`, `build`, `prod`, or `export`. */
  readonly mode: PluginMode;
  /** Load a module by absolute file path (dev: source; prod: built output). */
  readonly load: ModuleLoader;
  /** Contribute a hook that adds/adjusts routes in every scanned manifest. */
  addRouteSynthesizer(fn: RouteSynthesizer): void;
  /** Contribute a request handler that can claim unmatched requests. */
  addRequestHandler(handler: PluginRequestHandler): void;
  /** Contribute a build-time step (run during `denext build`). */
  addBuildStep(step: PluginBuildStep): void;
  /**
   * Contribute a prepare step that generates inputs the app imports — run at `denext build` AND at
   * `denext dev` startup, plus on every change under its `watch` globs during dev (so generated types
   * and data stay live as you edit). Use this (not {@linkcode addBuildStep}) for codegen.
   */
  addPrepareStep(step: PluginPrepareStep, opts?: PrepareStepOptions): void;
  /**
   * Contribute a first-class CLI verb (a {@linkcode CommandSpec}), so a plugin can
   * extend `denext <command>` — not only the request/route/build seams. The command
   * is discovered when the CLI encounters an unknown verb in a project whose config
   * lists this plugin, and eagerly (under a time budget) when the CLI has to
   * enumerate every verb — `denext --help`, `denext completions <shell>`. A name that
   * collides with a built-in verb is ignored (core verbs always win). The stored spec
   * is a copy stamped with `source: "plugin"`, which groups it under "Project
   * commands" in the help table.
   */
  addCommand(command: CommandSpec): void;
  /**
   * Register a disposer to run when the server drains — the symmetric shutdown
   * for anything {@linkcode DenextPlugin.setup} opened (a file watcher, a
   * connection, a timer). Disposers run most-recently-registered first. Per-plugin
   * state itself needs no special seam: a handler/step/teardown registered inside
   * `setup` closes over `setup`'s scope, so they already share state.
   */
  addTeardown(teardown: PluginTeardown): void;
}

/**
 * A denext plugin. Declared in `denext.config.ts` as `plugins: [myPlugin()]`; its
 * {@linkcode setup} runs once per process, before the first route scan.
 */
export interface DenextPlugin {
  /** Unique plugin name (used to de-duplicate registration across a process). */
  readonly name: string;
  /** Wire the plugin into denext's seams. Runs once, before routes are scanned. */
  setup(context: PluginContext): void | Promise<void>;
}

// Module-global registries. `setup()` accumulates handlers/steps here; a process
// runs exactly one pipeline (dev OR build OR prod OR export), so single-mode
// accumulation is correct, and `applied` makes registration idempotent across the
// repeated scans a dev server performs.
const requestHandlers: PluginRequestHandler[] = [];
const buildSteps: PluginBuildStep[] = [];
/** Prepare steps with their watch globs (see {@linkcode PluginContext.addPrepareStep}). */
const prepareSteps: Array<{ step: PluginPrepareStep; watch: readonly string[] }> = [];
const pluginCommands: CommandSpec[] = [];
const teardowns: PluginTeardown[] = [];
// Disposers that unregister the route synthesizers this layer added, so
// `resetPlugins()` clears plugin-registered synthesizers (their registry is
// process-global and otherwise leaks across in-process runs).
const synthDisposers: (() => void)[] = [];
const applied = new Set<string>();
/**
 * Bumped by {@linkcode resetPlugins}. An `applyPlugins` run that started under an older
 * generation abandons itself instead of marking names or storing verbs: a discovery that
 * was cut off by a time budget must not be able to make the NEXT discovery skip a plugin
 * whose `setup` it never finished.
 */
let generation = 0;

/** The per-pipeline facts a {@linkcode PluginContext} is built from. */
export interface ApplyPluginsBase {
  /** Absolute project root (the dir holding `denext.config.*`). */
  projectRoot: string;
  /** Absolute App Router scan root (`app/` or `src/app/`). */
  appDir: string;
  /** The resolved project config (its `plugins` are set up). */
  config: DenextConfig;
  /** Which pipeline is running. */
  mode: PluginMode;
  /** Module loader exposed to each plugin. */
  load: ModuleLoader;
}

/**
 * Run each plugin's {@linkcode DenextPlugin.setup} once. Idempotent by plugin name,
 * so calling it before every scan (as a dev server does) registers each plugin a
 * single time. A no-op when `config.plugins` is empty/absent — apps that use no
 * plugins pay nothing.
 *
 * @param base The pipeline facts to expose to each plugin.
 */
export async function applyPlugins(base: ApplyPluginsBase): Promise<void> {
  const plugins = base.config.plugins ?? [];
  const startedUnder = generation;
  for (const plugin of plugins) {
    if (startedUnder !== generation) return; // superseded by a resetPlugins() — stale run
    if (applied.has(plugin.name)) continue;
    applied.add(plugin.name);
    const context: PluginContext = {
      projectRoot: base.projectRoot,
      appDir: base.appDir,
      config: base.config,
      mode: base.mode,
      load: base.load,
      addRouteSynthesizer: (fn) => synthDisposers.push(registerRouteSynthesizer(fn)),
      addRequestHandler: (handler) => requestHandlers.push(handler),
      addBuildStep: (step) => buildSteps.push(step),
      addPrepareStep: (step, opts) => prepareSteps.push({ step, watch: opts?.watch ?? [] }),
      // Stamped (on a copy — never mutate the plugin's own object) so the CLI can list
      // plugin verbs under "Project commands" instead of among the built-ins.
      addCommand: (command) => {
        if (startedUnder === generation) pluginCommands.push({ ...command, source: "plugin" });
      },
      addTeardown: (teardown) => teardowns.push(teardown),
    };
    await plugin.setup(context);
  }
}

/**
 * A combined request handler over every plugin-registered handler (first non-null
 * wins), or `undefined` when no plugin registered one — so a server only wires
 * `matchExternal` when a plugin actually handles requests.
 */
export function getPluginRequestHandler():
  | ((request: Request) => Promise<Response | null>)
  | undefined {
  if (requestHandlers.length === 0) return undefined;
  return async (request: Request): Promise<Response | null> => {
    for (const handler of requestHandlers) {
      const response = await handler(request);
      if (response) return response;
    }
    return null;
  };
}

/** Options for {@linkcode runPluginBuildSteps}: where emitted files go, and what the build knows. */
export interface RunBuildStepsOptions {
  /**
   * The published root {@linkcode PluginBuildContext.emitFile} writes under: an export's staging
   * dir. Default `<outDir>/emitted` (a `denext build`, served by `denext start`).
   */
  readonly emitDir?: string;
  /** The client bundle's modules, when the build collected them. */
  readonly clientModules?: readonly string[];
}

/** Whether any plugin registered a build step (so a build can skip work only steps need). */
export function hasPluginBuildSteps(): boolean {
  return buildSteps.length > 0;
}

/**
 * True when `fileName` is a path the build publishes itself, which a build step may not replace:
 * the HTML shell (`index.html`), denext's client output and files (`_denext/…`) and a SPA's
 * `spa.assetsDir` client directory. Compared without case (a case-insensitive file system
 * would write over them).
 */
function reservedEmitPath(fileName: string, config: DenextConfig): boolean {
  const name = fileName.toLowerCase();
  if (name === "index.html" || name.startsWith("_denext/")) return true;
  const assetsDir = config.spa?.assetsDir?.replace(/^\/+|\/+$/g, "").toLowerCase();
  return !!assetsDir && name.startsWith(`${assetsDir}/`);
}

/**
 * The absolute path `fileName` is written to under `root`, refusing anything that could leave it
 * (an absolute path, a `..` segment, a backslash, an empty name) or replace the build's own
 * output ({@link reservedEmitPath}).
 */
function emittedPath(root: string, fileName: string, config: DenextConfig): string {
  const segments = fileName.split("/");
  if (
    fileName.length === 0 || fileName.includes("\\") || fileName.startsWith("/") ||
    /^[A-Za-z]:/.test(fileName) ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(
      `denext: emitFile refused ${JSON.stringify(fileName)}: a fileName is a relative, ` +
        "/-separated path inside the site root (no leading /, no . or .. segments, no backslash)",
    );
  }
  if (reservedEmitPath(fileName, config)) {
    throw new Error(
      `denext: emitFile refused ${JSON.stringify(fileName)}: the build publishes it itself ` +
        "(the HTML shell index.html, _denext/ and the spa.assetsDir client directory)",
    );
  }
  return join(root, ...segments);
}

/**
 * Run every plugin-registered build step in registration order, each with an
 * {@linkcode PluginBuildContext.emitFile} that publishes into `options.emitDir`.
 */
export async function runPluginBuildSteps(
  context: PluginPrepareContext,
  options: RunBuildStepsOptions = {},
): Promise<void> {
  if (buildSteps.length === 0) return;
  const emitDir = options.emitDir ?? join(context.outDir, EMITTED_DIR);
  const full: PluginBuildContext = {
    ...context,
    clientModules: options.clientModules,
    emitFile: async ({ fileName, source }) => {
      const dest = emittedPath(emitDir, fileName, context.config);
      await Deno.mkdir(dirname(dest), { recursive: true });
      if (typeof source === "string") await Deno.writeTextFile(dest, source);
      else await Deno.writeFile(dest, source);
    },
  };
  for (const step of buildSteps) await step(full);
}

/**
 * Run every plugin-registered prepare step in registration order — called once at `denext build` and
 * once at `denext dev` startup. A step that throws is caught and logged so one plugin's codegen
 * failure can't abort the build or the dev boot.
 */
export async function runPluginPrepareSteps(context: PluginPrepareContext): Promise<void> {
  for (const { step } of prepareSteps) {
    try {
      await step(context);
    } catch (error) {
      console.error(`denext: a plugin prepare step failed:`, error);
    }
  }
}

/** Resolve a watch glob (relative to `projectRoot`, or absolute) to an absolute glob. */
function resolveGlob(projectRoot: string, glob: string): string {
  return isAbsolute(glob) ? glob : join(projectRoot, glob);
}

/**
 * The literal prefix a glob watches: every segment up to its first wildcard. `content/**` → the
 * `content` dir; a wildcard-free glob is a single path (a file), which `Deno.watchFs` watches fine.
 */
function globBaseDir(absGlob: string): string {
  const base: string[] = [];
  // The platform's separators: a glob joined onto a Windows root reads `C:\app\content\**`.
  for (const s of absGlob.split(SEPARATOR_PATTERN)) {
    if (/[*?[\]{}]/.test(s)) break;
    base.push(s);
  }
  return base.join(SEPARATOR) || SEPARATOR;
}

/**
 * The existing directories the dev watcher must observe for prepare-step `watch` globs — each glob's
 * literal prefix dir, de-duplicated. Non-existent dirs are dropped (the caller also filters).
 */
export function getPluginPrepareWatchDirs(projectRoot: string): string[] {
  const dirs = new Set<string>();
  for (const { watch } of prepareSteps) {
    for (const g of watch) {
      const base = globBaseDir(resolveGlob(projectRoot, g));
      // A dir base ends without a wildcard; if the glob had no wildcard at all it points at a file,
      // so watch its parent directory instead.
      dirs.add(base);
    }
  }
  return [...dirs];
}

/**
 * Re-run each prepare step whose `watch` globs match one of `changedPaths` (absolute). Returns true
 * if any step ran — the dev server uses that to trigger a reload after regeneration. A step with no
 * `watch` globs never re-runs here (it only ran at startup).
 */
export async function runMatchingPrepareSteps(
  context: PluginPrepareContext,
  changedPaths: readonly string[],
): Promise<boolean> {
  let ran = false;
  for (const { step, watch } of prepareSteps) {
    if (watch.length === 0) continue;
    const patterns = watch.map((g) =>
      globToRegExp(resolveGlob(context.projectRoot, g), { globstar: true })
    );
    if (!changedPaths.some((p) => patterns.some((re) => re.test(p)))) continue;
    ran = true;
    try {
      await step(context);
    } catch (error) {
      console.error(`denext: a plugin prepare step failed:`, error);
    }
  }
  return ran;
}

/** Every plugin-contributed CLI command (for the CLI to merge into its registry). */
export function getPluginCommands(): readonly CommandSpec[] {
  return pluginCommands;
}

/**
 * Run every plugin-registered teardown, most-recently-registered first (LIFO, so
 * dependencies unwind in reverse). A teardown that throws is caught and logged so
 * one failing plugin can't strand the others. Called when the server drains.
 */
export async function runPluginTeardown(): Promise<void> {
  for (let i = teardowns.length - 1; i >= 0; i--) {
    try {
      await teardowns[i]();
    } catch (error) {
      console.error(`denext: a plugin teardown failed:`, error);
    }
  }
  teardowns.length = 0;
}

/**
 * The current plugin-registry generation — bumped by every {@linkcode resetPlugins}. A caller
 * that resets, then does slow work before {@linkcode applyPlugins} (e.g. importing the
 * project's config under a time budget) compares this value before and after that work, so a
 * run another reset has superseded never reaches `applyPlugins` at all.
 *
 * @returns The generation counter as of now.
 */
export function pluginGeneration(): number {
  return generation;
}

/** Clear all plugin registrations (and bump the generation). For tests that register plugins in-process. */
export function resetPlugins(): void {
  requestHandlers.length = 0;
  buildSteps.length = 0;
  prepareSteps.length = 0;
  pluginCommands.length = 0;
  teardowns.length = 0;
  for (const dispose of synthDisposers) dispose();
  synthDisposers.length = 0;
  applied.clear();
  generation++;
}
