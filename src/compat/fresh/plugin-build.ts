/**
 * `denext/fresh/plugins` — `freshPlugins()`, the denext plugin a migrated Fresh 1.x app lists in
 * `denext.config.ts` (`plugins: [freshPlugins()]`) so its `fresh.config.ts` plugins' client
 * entrypoints run in the browser, as Fresh bundles and loads them. At `denext dev` startup, on
 * `denext build` and `denext export`, it imports `fresh.config.ts`, and bundles each plugin's
 * `entrypoints` (a module path, URL or `data:` URL whose default export takes a state) into
 * `public/_fresh-plugins/<plugin>-<entrypoint>.js`. A page whose render hook returned
 * `scripts: [{ entrypoint, state }]` loads that file, which calls the export once per state.
 *
 * @module
 */

import { dirname, join, toFileUrl } from "@std/path";
import type { DenextPlugin, PluginContext } from "../../plugin/mod.ts";
import { PLUGIN_SCRIPT_DIR, pluginScriptFile, pluginStateAttr } from "./plugins.ts";

/** Options of {@link freshPlugins}. */
export interface FreshPluginsOptions {
  /** The Fresh config module, relative to the project (default `fresh.config.ts`). */
  config?: string;
}

/** The module source that runs a plugin entrypoint once per state the page carries. */
export function entrypointRunner(specifier: string, plugin: string, entrypoint: string): string {
  const attr = JSON.stringify(pluginStateAttr(plugin, entrypoint));
  return `import run from ${JSON.stringify(specifier)};
for (const el of document.querySelectorAll(\`script[data-fresh-plugin-state=\${JSON.stringify(${attr})}]\`)) {
  run(JSON.parse(el.textContent || "null"));
}
`;
}

/** A plugin's name and its client entrypoints, as the config module reports them. */
interface PluginEntrypoints {
  name: string;
  entrypoints: Record<string, string>;
}

/** The module a child Deno runs to report a Fresh config's plugins' entrypoints, as JSON. */
function reportModule(configUrl: string): string {
  return `const mod = await import(${JSON.stringify(configUrl)});
const plugins = mod.default?.plugins ?? [];
console.log(JSON.stringify(plugins.map((p) => ({ name: p?.name ?? "", entrypoints: p?.entrypoints ?? {} }))));
Deno.exit(0);
`;
}

/** The deno.json beside the Fresh config (its import map, `unstable` and other settings). */
async function projectConfigArgs(projectRoot: string): Promise<string[]> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(projectRoot, name);
    if (await Deno.stat(path).then(() => true, () => false)) return ["--config", path];
  }
  return [];
}

/**
 * The plugins a Fresh config module default-exports (`defineConfig({ plugins })`), with their
 * entrypoints. The config imports the app's own modules (a plugin's session store opening Deno
 * KV), so it is read in a child Deno run with the app's own `deno.json`, not in this process.
 */
async function configPlugins(projectRoot: string, path: string): Promise<PluginEntrypoints[]> {
  const report = join(dirname(path), `.denext-fresh-plugins-${crypto.randomUUID()}.ts`);
  await Deno.writeTextFile(report, reportModule(toFileUrl(path).href));
  const { denoExecutable } = await import("../../build/deno-executable.ts");
  try {
    const out = await new Deno.Command(denoExecutable(), {
      args: ["run", "-A", ...await projectConfigArgs(projectRoot), report],
      cwd: projectRoot,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(120_000),
    }).output();
    const text = new TextDecoder().decode(out.stdout).trim().split("\n").pop() ?? "";
    if (!out.success) {
      throw new Error(`reading ${path} failed:\n${new TextDecoder().decode(out.stderr)}`);
    }
    return JSON.parse(text) as PluginEntrypoints[];
  } finally {
    await Deno.remove(report).catch(() => {});
  }
}

/** Bundle one entrypoint into `outFile` with `deno bundle` (a browser ES module). */
async function bundleEntrypoint(projectRoot: string, runner: string, outFile: string) {
  await Deno.mkdir(dirname(outFile), { recursive: true });
  const entry = `${outFile}.entry.ts`;
  await Deno.writeTextFile(entry, runner);
  // Loaded here, not at the top: `denext.config.ts` imports this module wherever it is read.
  const { denoExecutable } = await import("../../build/deno-executable.ts");
  const { runToExit } = await import("../../build/exited-output.ts");
  try {
    const { code, stderr } = await runToExit(denoExecutable(), {
      args: ["bundle", "--platform=browser", "--format=esm", "-o", outFile, entry],
      cwd: projectRoot,
      stdout: "null",
      stderr: "piped",
    });
    if (code !== 0) {
      throw new Error(`deno bundle exited with ${code}: ${new TextDecoder().decode(stderr)}`);
    }
  } finally {
    await Deno.remove(entry).catch(() => {});
  }
}

/**
 * Bundle every plugin entrypoint of the Fresh config at `configPath` into `public/`.
 *
 * @param projectRoot The project directory.
 * @param configPath The Fresh config module (absolute).
 * @returns The files written (absolute).
 */
export async function bundlePluginEntrypoints(
  projectRoot: string,
  configPath: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const plugin of await configPlugins(projectRoot, configPath)) {
    for (const [name, specifier] of Object.entries(plugin.entrypoints ?? {})) {
      const resolved = /^[a-z][a-z0-9+.-]*:/i.test(specifier)
        ? specifier
        : toFileUrl(join(dirname(configPath), specifier)).href;
      const outFile = join(
        projectRoot,
        "public",
        PLUGIN_SCRIPT_DIR,
        pluginScriptFile(plugin.name, name),
      );
      await bundleEntrypoint(projectRoot, entrypointRunner(resolved, plugin.name, name), outFile);
      written.push(outFile);
    }
  }
  return written;
}

/**
 * The denext plugin that bundles a Fresh 1.x app's plugin entrypoints (see the module doc).
 *
 * @param options Where the Fresh config is.
 * @returns The plugin.
 */
export function freshPlugins(options: FreshPluginsOptions = {}): DenextPlugin {
  const config = options.config ?? "fresh.config.ts";
  return {
    name: "denext:fresh-plugins",
    setup(ctx: PluginContext) {
      ctx.addPrepareStep(async ({ projectRoot }) => {
        const files = await bundlePluginEntrypoints(projectRoot, join(projectRoot, config));
        if (files.length) {
          console.log(`denext fresh: bundled ${files.length} plugin entrypoint(s) into public/`);
        }
      }, { watch: [config] });
    },
  };
}
