// Generate src/cli/command-table.generated.ts: the data half of every first-party verb in
// `buildRegistry()` (src/cli/register.ts) plus an `import()` of the module that defines it, which
// the `denext` entrypoint dispatches from so a verb's implementation loads only when it runs.
//
//   deno task gen:command-table
//
// tests/cli-startup-graph.test.ts fails when the committed table differs from what this writes.

import { fromFileUrl, join, relative } from "@std/path";
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

/** Format TypeScript source with `deno fmt` (the repo's settings). */
async function fmt(source: string): Promise<string> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--ext", "ts", "-"],
    cwd: ROOT,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(source));
  await writer.close();
  const out = await child.output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

/** Both generated modules' sources. */
export async function generate(): Promise<{ table: string; modules: string }> {
  const eager = buildRegistry();
  const sources = await commandSources(eager);
  const rows = eager.list().map((spec) => {
    const source = sources.get(spec.name);
    if (!source) {
      throw new Error(`gen-command-table: no export under src/cli/commands defines "${spec.name}"`);
    }
    const load = source.factory
      ? `(registry) => importCliModule("${source.module}").then((m) => (m.${source.exportName} as Factory)(registry))`
      : `() => importCliModule("${source.module}").then((m) => m.${source.exportName} as CommandSpec)`;
    return `  [${JSON.stringify(metaOf(spec))}, ${load}],`;
  });
  const table = await fmt(
    `// fallow-ignore-file code-duplication -- generated: verbs share flag sets by design
// Generated by scripts/gen-command-table.ts from buildRegistry() (src/cli/register.ts).
// Do not edit: run \`deno task gen:command-table\`. Each row is a verb's description and the
// import of the module that implements it (src/cli/lazy-command.ts).

import type { CommandRegistry, CommandSpec } from "./command.ts";
import { type CommandLoader, type CommandMeta, importCliModule } from "./lazy-command.ts";

/** A verb built over the registry it enumerates (\`commands\`, \`completions\`). */
type Factory = (registry: CommandRegistry) => CommandSpec;

/** Every first-party verb: its description, and how to load its implementation. */
export const COMMAND_TABLE: readonly (readonly [CommandMeta, CommandLoader])[] = [
${rows.join("\n")}
];
`,
  );
  const modules = lazyModules(eager, sources);
  const modulesSource = await fmt(
    `// Generated by scripts/gen-command-table.ts. Do not edit: run \`deno task gen:command-table\`.
//
// Every CLI module the \`denext\` entrypoint imports on demand (src/cli/lazy-command.ts's
// \`importCliModule\`), imported statically here so \`deno compile --include\` of this file embeds
// them in a binary. Nothing imports this module at run time.

${modules.map((m) => `import "${m}";`).join("\n")}
`,
  );
  return { table, modules: modulesSource };
}

/** The table's verb modules and the entrypoint's own lazy modules, sorted. */
function lazyModules(eager: CommandRegistry, sources: Map<string, Source>): string[] {
  const verbs = eager.list().map((spec) => sources.get(spec.name)!.module);
  return [...new Set([...verbs, ...ENTRY_LAZY_MODULES])].sort();
}

if (import.meta.main) {
  const { table, modules } = await generate();
  await Deno.writeTextFile(TABLE_OUT, table);
  await Deno.writeTextFile(MODULES_OUT, modules);
  console.log(`wrote ${relative(ROOT, TABLE_OUT)} and ${relative(ROOT, MODULES_OUT)}`);
}
