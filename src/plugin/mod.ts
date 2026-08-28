// denext plugin contract — the narrow, semver-stable surface a plugin extends.
//
// A plugin is a named unit that hooks three seams denext already has:
//   1. route synthesis — contribute/adjust routes in every scanned manifest
//      (runs inside `scanRoutes`, so it applies to dev, build, prod, and export);
//   2. request handling — claim a request the core App Router didn't match and
//      serve it with a distinct render path (e.g. a Pages Router with its own
//      `_app`/`_document`/`getServerSideProps` pipeline);
//   3. build steps — emit the plugin's own client bundles/assets at build time.
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

/** A build-time step that emits the plugin's client bundles/assets into `outDir`. */
export type PluginBuildStep = (context: PluginBuildContext) => void | Promise<void>;

/**
 * A disposer that releases resources a plugin opened in {@linkcode DenextPlugin.setup}
 * (watchers, connections, timers). Registered with {@linkcode PluginContext.addTeardown}
 * and run — most-recently-registered first — when the server drains.
 */
export type PluginTeardown = () => void | Promise<void>;

/** Context passed to a {@linkcode PluginBuildStep}. */
export interface PluginBuildContext {
  /** Absolute project root (the dir holding `denext.config.*`). */
  readonly projectRoot: string;
  /** Absolute App Router scan root (`app/` or `src/app/`) — avoid colliding with it. */
  readonly appDir: string;
  /** Absolute build output directory the step should write assets into. */
  readonly outDir: string;
  /** The resolved project config. */
  readonly config: DenextConfig;
}

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
   * Contribute a first-class CLI verb (a {@linkcode CommandSpec}), so a plugin can
   * extend `denext <command>` — not only the request/route/build seams. The command
   * is discovered when the CLI encounters an unknown verb in a project whose config
   * lists this plugin; a name that collides with a built-in verb is ignored (core
   * verbs always win).
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
const pluginCommands: CommandSpec[] = [];
const teardowns: PluginTeardown[] = [];
// Disposers that unregister the route synthesizers this layer added, so
// `resetPlugins()` clears plugin-registered synthesizers (their registry is
// process-global and otherwise leaks across in-process runs).
const synthDisposers: (() => void)[] = [];
const applied = new Set<string>();

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
  for (const plugin of plugins) {
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
      addCommand: (command) => pluginCommands.push(command),
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

/** Run every plugin-registered build step in registration order. */
export async function runPluginBuildSteps(context: PluginBuildContext): Promise<void> {
  for (const step of buildSteps) await step(context);
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

/** Clear all plugin registrations. For tests that register plugins in-process. */
export function resetPlugins(): void {
  requestHandlers.length = 0;
  buildSteps.length = 0;
  pluginCommands.length = 0;
  teardowns.length = 0;
  for (const dispose of synthDisposers) dispose();
  synthDisposers.length = 0;
  applied.clear();
}
