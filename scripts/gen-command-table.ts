// Generate src/cli/command-table.generated.ts: the data half of every first-party verb in
// `buildRegistry()` (src/cli/register.ts) plus an `import()` of the module that defines it, which
// the `denext` entrypoint dispatches from so a verb's implementation loads only when it runs.
//
//   deno task gen:command-table
//
// It also writes src/cli/lazy-modules.generated.ts (every module the entrypoint imports on demand,
// for `deno compile --include`) and src/cli/offline-modules.generated.ts (those plus every module a
// verb loads by URL: what `denext toolchain install` caches for a CLI installed from JSR).
//
// tests/cli-startup-graph.test.ts fails when the committed table differs from what this writes.

import { fromFileUrl, join, relative } from "@std/path";
import { denoFmt } from "./lib/deno-fmt.ts";
import { CommandRegistry, type CommandSpec } from "../src/cli/command.ts";
import { buildRegistry } from "../src/cli/register.ts";
import {
  COMMAND_FUNCTION_KEYS,
  COMMAND_META_KEYS,
  type CommandMeta,
} from "../src/cli/lazy-command.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const CLI_DIR = join(ROOT, "src", "cli");
const COMMANDS_DIR = join(CLI_DIR, "commands");

/** Where the generated table is written. */
export const TABLE_OUT: string = join(CLI_DIR, "command-table.generated.ts");

/** Where the list of lazily imported CLI modules (for `deno compile --include`) is written. */
export const MODULES_OUT: string = join(CLI_DIR, "lazy-modules.generated.ts");

/** Where the offline module list (`deno cache`d by src/cli/cli-cache.ts) is written. */
export const OFFLINE_OUT: string = join(CLI_DIR, "offline-modules.generated.ts");

/**
 * The CLI modules cli.ts itself imports on demand (through `importCliModule`), beside the verbs'
 * own: the run half of the entrypoint, project-verb discovery, and the Deno passthrough.
 */
export const ENTRY_LAZY_MODULES: readonly string[] = [
  "./run-verb.ts",
  "./plugin-commands.ts",
  "./commands/deno-toolchain.ts",
];

/** How a verb's full spec is reached: an exported spec, or a factory over the registry. */
interface Source {
  module: string;
  exportName: string;
  factory: boolean;
}

/** The command modules under src/cli/commands, as `./commands/<file>` (sorted). */
function commandModules(): string[] {
  return [...Deno.readDirSync(COMMANDS_DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".ts"))
    .map((e) => `./commands/${e.name}`)
    .sort();
}

/** A `make…Command` export, as found in a command module. */
interface FactoryExport {
  module: string;
  exportName: string;
  make: unknown;
}

/** The verb a factory builds over a fresh registry, or null for a factory over something else. */
function factoryVerb(make: unknown): string | null {
  try {
    return (make as (reg: CommandRegistry) => CommandSpec)(new CommandRegistry()).name ?? null;
  } catch {
    return null;
  }
}

/** Sort one module's exports into the specs `eager` registers and the `make…Command` factories. */
function classify(
  module: string,
  exports: Record<string, unknown>,
  eager: CommandRegistry,
  byName: Map<string, Source>,
  factories: FactoryExport[],
): void {
  for (const [exportName, value] of Object.entries(exports)) {
    const name = (value as { name?: unknown } | null)?.name;
    if (typeof name === "string" && eager.get(name) === value) {
      byName.set(name, { module, exportName, factory: false });
    } else if (typeof value === "function" && /^make\w*Command$/.test(exportName)) {
      factories.push({ module, exportName, make: value });
    }
  }
}

/** Every exported spec and spec factory under src/cli/commands, by verb name. */
async function commandSources(eager: CommandRegistry): Promise<Map<string, Source>> {
  const byName = new Map<string, Source>();
  const factories: FactoryExport[] = [];
  for (const module of commandModules()) {
    const url = new URL(`../src/cli/${module.slice(2)}`, import.meta.url).href;
    classify(module, await import(url), eager, byName, factories);
  }
  // A verb bound to the registry it enumerates (`commands`, `completions`) is registered as
  // `make…Command(reg)`; only a verb no exported spec defines is looked for among the factories.
  for (const { module, exportName, make } of factories) {
    const name = factoryVerb(make);
    if (name !== null && eager.get(name) && !byName.has(name)) {
      byName.set(name, { module, exportName, factory: true });
    }
  }
  return byName;
}

/** The data half of `spec`; throws on a key the table does not know how to carry. */
export function metaOf(spec: CommandSpec): CommandMeta {
  for (const key of Object.keys(spec)) {
    if (!COMMAND_FUNCTION_KEYS.includes(key) && !(COMMAND_META_KEYS as string[]).includes(key)) {
      throw new Error(
        `gen-command-table: "${spec.name}" has a "${key}" field the command table does not ` +
          "carry; add it to COMMAND_META_KEYS (data) or COMMAND_FUNCTION_KEYS (src/cli/lazy-command.ts)",
      );
    }
  }
  const meta: Record<string, unknown> = {};
  for (const key of COMMAND_META_KEYS) {
    if (spec[key] !== undefined) meta[key] = spec[key];
  }
  return meta as unknown as CommandMeta;
}

/** Both generated modules' sources. */
export async function generate(): Promise<{ table: string; modules: string; offline: string }> {
  const eager = buildRegistry();
  const sources = await commandSources(eager);
  const metas: CommandMeta[] = [];
  const loads = eager.list().map((spec) => {
    const source = sources.get(spec.name);
    if (!source) {
      throw new Error(`gen-command-table: no export under src/cli/commands defines "${spec.name}"`);
    }
    metas.push(metaOf(spec));
    return `  ${source.factory ? "factory" : "spec"}("${source.module}", "${source.exportName}"),`;
  });
  // The descriptions are one JSON string (parsed once at startup, cheaper than an object literal
  // and a third of the size `deno fmt` would make of one); the loaders stay code.
  const table = await denoFmt(
    `// Generated by scripts/gen-command-table.ts from buildRegistry() (src/cli/register.ts).
// Do not edit: run \`deno task gen:command-table\`. Each row is a verb's description and the
// import of the module that implements it (src/cli/lazy-command.ts).

import type { CommandRegistry, CommandSpec } from "./command.ts";
import { type CommandLoader, type CommandMeta, importCliModule } from "./lazy-command.ts";

/** A verb's spec, exported as \`name\` by \`module\`. */
const spec = (module: string, name: string): CommandLoader => () =>
  importCliModule(module).then((m) => m[name] as CommandSpec);

/** A verb built over the registry it enumerates (\`commands\`, \`completions\`). */
const factory = (module: string, name: string): CommandLoader => (registry) =>
  importCliModule(module).then((m) =>
    (m[name] as (registry: CommandRegistry) => CommandSpec)(registry)
  );

/** Every first-party verb's description, in registry order (JSON: see the generator). */
const META: readonly CommandMeta[] = JSON.parse(
  ${JSON.stringify(JSON.stringify(metas))},
);

/** How to load each verb in {@linkcode META}, in the same order. */
const LOADERS: readonly CommandLoader[] = [
${loads.join("\n")}
];

/** Every first-party verb: its description, and how to load its implementation. */
export const COMMAND_TABLE: readonly (readonly [CommandMeta, CommandLoader])[] = META.map((
  meta,
  i,
) => [meta, LOADERS[i]] as const);
`,
    ROOT,
  );
  const modules = lazyModules(eager, sources);
  const modulesSource = await denoFmt(
    `// Generated by scripts/gen-command-table.ts. Do not edit: run \`deno task gen:command-table\`.
//
// Every CLI module the \`denext\` entrypoint imports on demand (src/cli/lazy-command.ts's
// \`importCliModule\`), imported statically here so \`deno compile --include\` of this file embeds
// them in a binary. Nothing imports this module at run time.

${modules.map((m) => `import "${m}";`).join("\n")}
`,
    ROOT,
  );
  const offline = await denoFmt(offlineModulesSource(await offlineModules()), ROOT);
  return { table, modules: modulesSource, offline };
}

/** The source of src/cli/offline-modules.generated.ts over `modules` (`src/cli/`-relative). */
function offlineModulesSource(modules: readonly string[]): string {
  return `// Generated by scripts/gen-command-table.ts. Do not edit: run \`deno task gen:command-table\`.
//
// Every module a \`denext\` verb can load: the on-demand CLI modules (./lazy-modules.generated.ts),
// the framework's \`exports\` (a build or a server loads them by URL: the client runtime, the
// compat layers) and the modules src/ reaches through a computed URL (a worker, a bundler run in
// a child, a module a transform injects). \`denext toolchain install\` and a remote CLI's first run
// \`deno cache\` this file (src/cli/cli-cache.ts), so a CLI installed from JSR works offline.
// Nothing imports it at run time.

import "./lazy-modules.generated.ts";
${modules.map((m) => `import "${m}";`).join("\n")}
`;
}

/** A module file under the repository (`.ts`, `.tsx`, `.js`, `.mjs`). */
const MODULE_FILE = /\.(?:ts|tsx|js|mjs)$/;

/**
 * Every module {@linkcode OFFLINE_OUT} imports beside the lazy ones, as specifiers relative to
 * `src/cli/`, sorted: the `exports` of deno.json, and every module src/ names in a computed URL
 * ({@linkcode computedModuleUrls}).
 */
export async function offlineModules(): Promise<string[]> {
  const { exports } = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json"))) as {
    exports: Record<string, string>;
  };
  const files = new Set<string>();
  for (const target of Object.values(exports)) {
    if (MODULE_FILE.test(target)) files.add(join(ROOT, target));
  }
  for (const file of await computedModuleUrls()) files.add(file);
  return [...files].map((file) => {
    const rel = relative(CLI_DIR, file).replaceAll("\\", "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  }).sort();
}

/** `new URL("<rel>", import.meta.url)` naming a module. */
const URL_LITERAL = /new URL\(\s*"(\.{1,2}\/[^"]+)"\s*,\s*import\.meta\.url\s*\)/g;
/** `new URL(NAME, import.meta.url)`: a module named by a constant of the same file. */
const URL_CONSTANT = /new URL\(\s*([A-Z][A-Z0-9_]*)\s*,\s*import\.meta\.url\s*\)/g;
/** `frameworkFileUrl("<path>")`: a module under the framework root. */
const FRAMEWORK_FILE = /frameworkFileUrl\(\s*"([^"]+)"\s*\)/g;

/**
 * The absolute paths of the modules src/ loads through a computed URL, which no static import
 * reaches: `new URL("./x.ts", import.meta.url)` (directly or through a `const X = "./x.ts"`) and
 * `frameworkFileUrl("src/x.ts")`. Comment lines are skipped; a path that names no file is not a
 * module (an example in a doc string) and is left out.
 */
export async function computedModuleUrls(): Promise<string[]> {
  const found = new Set<string>();
  for await (const path of sourceFiles(join(ROOT, "src"))) {
    const code = (await Deno.readTextFile(path)).split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    const dir = join(path, "..");
    const consts = new Map(
      [...code.matchAll(/const ([A-Z][A-Z0-9_]*)(?:: string)? = "(\.{1,2}\/[^"]+)"/g)]
        .map((m) => [m[1], m[2]]),
    );
    const candidates = [
      ...[...code.matchAll(URL_LITERAL)].map((m) => join(dir, m[1])),
      ...[...code.matchAll(URL_CONSTANT)].flatMap((m) => {
        const rel = consts.get(m[1]);
        return rel ? [join(dir, rel)] : [];
      }),
      ...[...code.matchAll(FRAMEWORK_FILE)].map((m) => join(ROOT, m[1])),
    ];
    for (const file of candidates) {
      if (MODULE_FILE.test(file) && await isFile(file)) found.add(file);
    }
  }
  return [...found].sort();
}

/** Every `.ts` / `.tsx` file under `dir`, the native templates' sources excepted (not published). */
async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name !== "native-templates") yield* sourceFiles(path);
    } else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}

/** Whether `path` is a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** The table's verb modules and the entrypoint's own lazy modules, sorted. */
function lazyModules(eager: CommandRegistry, sources: Map<string, Source>): string[] {
  const verbs = eager.list().map((spec) => sources.get(spec.name)!.module);
  return [...new Set([...verbs, ...ENTRY_LAZY_MODULES])].sort();
}

if (import.meta.main) {
  const { table, modules, offline } = await generate();
  await Deno.writeTextFile(TABLE_OUT, table);
  await Deno.writeTextFile(MODULES_OUT, modules);
  await Deno.writeTextFile(OFFLINE_OUT, offline);
  console.log(
    `wrote ${relative(ROOT, TABLE_OUT)}, ${relative(ROOT, MODULES_OUT)} and ` +
      relative(ROOT, OFFLINE_OUT),
  );
}
