// Gleam interop: a Gleam project compiled to JavaScript, imported from TypeScript.
//
// Gleam's JavaScript target emits ES modules (`build/dev/javascript/<package>/<module>.mjs`) and,
// with `[javascript] typescript_declarations = true`, a `.d.mts` beside each one that the `.mjs`
// names in a `/// <reference types>` directive — so Deno type-checks a Gleam module imported by
// path. Two files of every build lack that directive (the shared `prelude.mjs` and each package's
// `gleam.mjs` re-export of it), which leaves Gleam's `List` / `Result` untyped and its declarations
// colliding with themselves under Deno; `patchGleamTypeRefs` adds it after each build.
//
// The import map maps `@gleam/` onto the build, so app code imports
// `@gleam/<package>/<module>.mjs`. `denext add gleam:<package>` sets all of this up (a `gleam/`
// project, the package, a build, the import map entry); the optional `gleam()` plugin
// (`denext/gleam`) recompiles at dev startup, on `.gleam` changes and at build, and skips cleanly
// when `gleam` is not installed. Nothing here runs at request time.

import { dirname, join, relative } from "@std/path";
import { appendGitignore } from "./gitignore.ts";
import type { DenextPlugin, PluginContext } from "../plugin/mod.ts";

/** The import-map prefix Gleam packages are imported under (`@gleam/<package>/<module>.mjs`). */
const GLEAM_IMPORT_PREFIX = "@gleam/";

/** Where `denext add gleam:` creates a Gleam project when the app has none. */
const DEFAULT_GLEAM_DIR = "gleam";

/** Options shared by the plugin and `denext add gleam:`. */
export interface GleamOptions {
  /**
   * The Gleam project directory (the one holding `gleam.toml`), relative to the app root.
   * Default: the root itself when it holds a `gleam.toml`, else `gleam/`.
   */
  dir?: string;
  /** The `gleam` executable (default `gleam` on `PATH`). */
  gleam?: string;
}

/** Runs a command; the seam tests replace. */
export type GleamRunner = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ success: boolean; output: string }>;

/** The default {@link GleamRunner}: a child process, its output collected. */
const runCommand: GleamRunner = async (cmd, args, cwd) => {
  try {
    const out = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" })
      .output();
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    return { success: out.success, output: text };
  } catch (err) {
    // Not installed (NotFound) or not runnable: the caller reports it.
    return { success: false, output: err instanceof Deno.errors.NotFound ? "" : String(err) };
  }
};

/** What {@link buildGleam} did. */
export type GleamBuildResult =
  | { status: "no-project"; dir: string }
  | { status: "missing"; dir: string }
  | { status: "failed"; dir: string; output: string }
  | { status: "built"; dir: string; version: string; patched: number };

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

/**
 * The Gleam project directory of `root` (absolute): `options.dir`, else the root when it holds a
 * `gleam.toml`, else `gleam/`.
 *
 * @param root The app root.
 * @param options The plugin / CLI options.
 * @returns The directory (it may not exist yet).
 */
async function gleamProjectDir(root: string, options: GleamOptions = {}): Promise<string> {
  if (options.dir !== undefined) return join(root, options.dir);
  return await exists(join(root, "gleam.toml")) ? root : join(root, DEFAULT_GLEAM_DIR);
}

/**
 * Compile the Gleam project to JavaScript (`gleam build --target javascript`) and make its output
 * type-check under Deno ({@link patchGleamTypeRefs}). A project-less app and a machine without
 * `gleam` are reported, not thrown: the plugin skips them.
 *
 * @param root The app root.
 * @param options The project dir and the `gleam` executable.
 * @param run The command runner (tests).
 * @returns What happened.
 */
export async function buildGleam(
  root: string,
  options: GleamOptions = {},
  run: GleamRunner = runCommand,
): Promise<GleamBuildResult> {
  const dir = await gleamProjectDir(root, options);
  if (!await exists(join(dir, "gleam.toml"))) return { status: "no-project", dir };
  const bin = options.gleam ?? "gleam";
  const version = await run(bin, ["--version"], dir);
  if (!version.success) return { status: "missing", dir };
  const built = await run(bin, ["build", "--target", "javascript"], dir);
  if (!built.success) return { status: "failed", dir, output: built.output.trim() };
  const patched = await patchGleamTypeRefs(join(dir, "build", "dev", "javascript"));
  return { status: "built", dir, version: version.output.trim(), patched };
}

/** A `/// <reference types>` directive naming `file`. */
const reference = (file: string) => `/// <reference types="./${file}" />\n`;

/**
 * Add the `/// <reference types>` directive Gleam leaves off `prelude.mjs` and every package's
 * `gleam.mjs`, so Deno types them from their `.d.mts` (Gleam's `List`, `Result`, custom-type base
 * class) rather than inferring them from the JavaScript. Idempotent.
 *
 * @param jsDir The JavaScript build directory (`build/dev/javascript`).
 * @returns How many files it patched.
 */
export async function patchGleamTypeRefs(jsDir: string): Promise<number> {
  const targets = [join(jsDir, "prelude.mjs")];
  try {
    for await (const e of Deno.readDir(jsDir)) {
      if (e.isDirectory) targets.push(join(jsDir, e.name, "gleam.mjs"));
    }
  } catch {
    return 0;
  }
  let patched = 0;
  for (const file of targets) {
    const types = file.replace(/\.mjs$/, ".d.mts");
    if (!await exists(file) || !await exists(types)) continue;
    const text = await Deno.readTextFile(file);
    if (text.startsWith("/// <reference types=")) continue;
    await Deno.writeTextFile(file, reference(types.slice(dirname(types).length + 1)) + text);
    patched++;
  }
  return patched;
}

/** A Gleam package name from an app name (`my-app` → `my_app`; Gleam's `[a-z][a-z0-9_]*`). */
function gleamName(name: string | undefined): string {
  const clean = (name ?? "").toLowerCase().replace(/^@[^/]*\//, "").replace(/[^a-z0-9_]/g, "_")
    .replace(/^[^a-z]+/, "");
  return clean || "app";
}

/** A new Gleam project's `gleam.toml`: JavaScript target, TypeScript declarations on. */
function gleamToml(name: string): string {
  return `name = "${name}"
version = "1.0.0"
target = "javascript"

[dependencies]

[javascript]
typescript_declarations = true
`;
}

/** What {@link addGleamPackages} reports to the user. */
export interface GleamIo {
  /** Progress and results. */
  log(line: string): void;
  /** Problems. */
  error(line: string): void;
}

/**
 * `denext add gleam:<package>…`: make sure the app has a Gleam project (creating `gleam/` with a
 * JavaScript-target `gleam.toml` when it has none), `gleam add` the packages, compile, and map
 * `@gleam/` onto the build in `deno.json`.
 *
 * @param root The app root.
 * @param packages Hex package names (`gleam_json`, `lustre@4`, …).
 * @param options The project dir and the `gleam` executable.
 * @param io Output.
 * @param run The command runner (tests).
 * @returns Whether every step succeeded.
 */
export async function addGleamPackages(
  root: string,
  packages: readonly string[],
  options: GleamOptions = {},
  io: GleamIo = { log: console.log, error: console.error },
  run: GleamRunner = runCommand,
): Promise<boolean> {
  const dir = await gleamProjectDir(root, options);
  const bin = options.gleam ?? "gleam";
  if (!(await run(bin, ["--version"], root)).success) {
    io.error("denext add gleam: `gleam` is not installed (https://gleam.run/getting-started/).");
    return false;
  }
  if (!await exists(join(dir, "gleam.toml"))) {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "gleam.toml"), gleamToml(gleamName(await appName(root))));
    io.log(`denext add gleam: created ${relative(root, dir) || "."}/gleam.toml`);
  }
  const added = await run(bin, ["add", ...packages], dir);
  if (!added.success) {
    io.error(`denext add gleam: gleam add failed\n${added.output.trim()}`);
    return false;
  }
  const built = await buildGleam(root, options, run);
  if (built.status !== "built") {
    io.error(`denext add gleam: the build failed${"output" in built ? `\n${built.output}` : ""}`);
    return false;
  }
  const mapped = await mapGleamImports(root, dir);
  const rel = relative(root, dir) || ".";
  await appendGitignore(root, [`${rel === "." ? "" : `${rel}/`}build/`]);
  io.log(
    `denext add gleam: added ${packages.join(", ")}; import them as ` +
      `"${GLEAM_IMPORT_PREFIX}<package>/<module>.mjs"` +
      (mapped ? "" : ` (add "${GLEAM_IMPORT_PREFIX}": "${importTarget(root, dir)}" to deno.json)`),
  );
  return true;
}

/** The app's name from `deno.json`, if it has one. */
async function appName(root: string): Promise<string | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(join(root, "deno.json"))).name;
  } catch {
    return undefined;
  }
}

/** The import-map target of `@gleam/` for the project at `dir`. */
function importTarget(root: string, dir: string): string {
  const rel = relative(root, join(dir, "build", "dev", "javascript")).replaceAll("\\", "/");
  return `./${rel}/`;
}

/**
 * Map `@gleam/` onto the project's JavaScript build in `deno.json`'s import map. A `deno.json`
 * that is not plain JSON (comments) is left alone: the caller prints the entry to add instead.
 *
 * @param root The app root.
 * @param dir The Gleam project directory.
 * @returns Whether the entry is in place.
 */
async function mapGleamImports(root: string, dir: string): Promise<boolean> {
  const path = join(root, "deno.json");
  let config: { imports?: Record<string, string> };
  try {
    config = JSON.parse(await Deno.readTextFile(path).catch(() => "{}"));
  } catch {
    return false;
  }
  const target = importTarget(root, dir);
  if (config.imports?.[GLEAM_IMPORT_PREFIX] === target) return true;
  config.imports = { ...config.imports, [GLEAM_IMPORT_PREFIX]: target };
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n");
  return true;
}

/**
 * The `gleam()` plugin (`denext/gleam`), with a command runner for tests: a prepare step that
 * compiles the project, warns once and skips when `gleam` is missing, and fails on a compile error.
 *
 * @param options The project directory and the `gleam` executable.
 * @param run The command runner.
 * @returns The plugin.
 */
export function gleamPlugin(options: GleamOptions, run: GleamRunner = runCommand): DenextPlugin {
  let warned = false;
  return {
    name: "denext:gleam",
    setup(ctx: PluginContext) {
      const base = options.dir === undefined ? "" : `${options.dir.replace(/\/+$/, "")}/`;
      const watch = [`${base}**/*.gleam`, `${base}**/gleam.toml`];
      ctx.addPrepareStep(async ({ projectRoot }) => {
        const result = await buildGleam(projectRoot, options, run);
        const where = relative(projectRoot, result.dir) || ".";
        if (result.status === "missing" && !warned) {
          warned = true;
          console.warn(
            `denext gleam: \`${options.gleam ?? "gleam"}\` is not installed — skipping the ` +
              `Gleam build of ${where}/ (https://gleam.run/getting-started/)`,
          );
        } else if (result.status === "failed") {
          throw new Error(`denext gleam: the Gleam build of ${where}/ failed\n${result.output}`);
        } else if (result.status === "built") {
          console.log(`denext gleam: compiled ${where}/ to JavaScript (${result.version})`);
        }
      }, { watch });
    },
  };
}
