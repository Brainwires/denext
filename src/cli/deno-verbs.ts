// The Deno subcommands denext forwards: every verb Deno's own CLI has, so `denext compile`,
// `denext run`, `denext x`, `denext bench` (…) run denext's Deno toolchain exactly like
// `denext deno <verb>`. A denext built-in verb with the same name keeps denext's meaning
// (`test`, `fmt`, `upgrade`, `desktop`, …) and a project's own verb comes next; only a name
// neither of them claims reaches Deno.
//
// The list is static, for the Deno version the toolchain pins (src/build/deno-toolchain-pin.json
// `deno`), so help, completions and did-you-mean never have to start a `deno` process.
// tests/cli-deno-verbs.test.ts compares it with what that Deno's `--help` prints, so a Deno bump
// cannot drift from it silently.
//
import { isAbsolute, join } from "@std/path";

// Pure data and string checks — no I/O beyond the one `Deno.statSync` in
// {@linkcode isScriptTarget} — so the command framework and completions can import it freely.

/** One Deno subcommand: its name and the summary Deno's own `--help` gives it. */
export interface DenoVerb {
  /** The subcommand, as in `deno <name>`. */
  readonly name: string;
  /** Deno's one-line summary. */
  readonly summary: string;
}

/**
 * Every subcommand `deno --help` lists for the pinned Deno (2.9.7), in Deno's order. `help` is
 * Deno's too, but `denext help` is denext's own (see {@linkcode FORWARDABLE_EXCLUDED}).
 */
export const DENO_VERBS: readonly DenoVerb[] = [
  ["run", "Run a JavaScript or TypeScript program, or a task"],
  [
    "watch",
    "Run a JavaScript or TypeScript program, watching for file changes and hot-replacing modules",
  ],
  ["serve", "Run a server"],
  ["eval", "Evaluate a script from the command line"],
  ["fmt", "Format source files"],
  ["lint", "Lint source files"],
  ["test", "Run tests"],
  ["upgrade", "Upgrade deno executable to given version"],
  ["cache", "Cache the dependencies"],
  ["check", "Type-check the dependencies"],
  ["info", "Show info about cache or info related to source file"],
  ["doc", "Generate and show documentation for a module or built-ins"],
  ["task", "Run a task defined in the configuration file"],
  ["bench", "Run benchmarks"],
  ["compile", "Compile the script into a self contained executable"],
  ["coverage", "Print coverage reports"],
  ["repl", "Start an interactive Read-Eval-Print Loop (REPL) for Deno"],
  [
    "install",
    "Installs dependencies either in the local project or globally to a bin directory",
  ],
  [
    "uninstall",
    "Uninstalls a dependency or an executable script in the installation root's bin directory",
  ],
  ["types", "Print runtime TypeScript declarations"],
  ["completions", "Generate shell completions"],
  ["init", "Initialize a new project"],
  ["create", "Create a project from a template"],
  ["jupyter", "Deno kernel for Jupyter notebooks"],
  ["publish", "Publish the current working directory's package or workspace"],
  ["add", "Add dependencies"],
  ["remove", "Remove dependencies"],
  ["outdated", "Find outdated dependencies"],
  ["update", "Update outdated dependencies"],
  ["deploy", "Deploy to Deno Deploy"],
  ["sandbox", "Run in sandbox mode"],
  ["clean", "Remove the cache directory"],
  ["list", "List the dependencies declared in deno.json / package.json"],
  ["link", "Link a local JSR package into the current project for development"],
  ["unlink", "Remove a linked local package from the current project"],
  ["approve-scripts", "Approve npm lifecycle scripts"],
  ["lsp", "Start the language server"],
  [
    "sync-types",
    "Generate a tsconfig.json and type mappings so stock TypeScript tooling can type-check the project",
  ],
  ["vendor", "`deno vendor` was removed in Deno 2."],
  ["bundle", "Output a single JavaScript file with all dependencies"],
  ["audit", "Audit currently installed dependencies"],
  ["why", "Show why a package is installed"],
  ["transpile", "Transpile TypeScript/JSX/TSX files to JavaScript"],
  ["bump-version", "Update version in the configuration file"],
  ["ci", "Install dependencies from a lockfile in a frozen state"],
  ["desktop", "Compile a script into a desktop application"],
  ["pack", "Create a tarball of the package"],
  ["x", "Execute a binary from npm or jsr, like npx"],
  ["help", "Show help for a command"],
].map(([name, summary]) => ({ name, summary }));

/** Deno verbs denext never forwards: `denext help` is denext's own help. */
const FORWARDABLE_EXCLUDED: ReadonlySet<string> = new Set(["help"]);

const BY_NAME: ReadonlyMap<string, DenoVerb> = new Map(DENO_VERBS.map((v) => [v.name, v]));

/**
 * Whether `name` is a Deno subcommand (`help` included).
 *
 * @param name A verb.
 * @returns Whether Deno's CLI has it.
 */
export function isDenoVerb(name: string): boolean {
  return BY_NAME.has(name);
}

/**
 * The Deno verbs denext forwards, given the names something else already claims (denext's
 * built-ins, the project's own verbs): Deno's list minus those, minus `help`.
 *
 * @param claimed Whether a name is taken before Deno's turn.
 * @returns The forwarded verbs, in Deno's order.
 */
export function forwardedDenoVerbs(claimed: (name: string) => boolean): DenoVerb[] {
  return DENO_VERBS.filter((v) => !FORWARDABLE_EXCLUDED.has(v.name) && !claimed(v.name));
}

/**
 * Whether `name` is a verb denext would forward to Deno when nothing else claims it.
 *
 * @param name A verb.
 * @returns Whether it is a forwardable Deno verb.
 */
export function isForwardableDenoVerb(name: string): boolean {
  return BY_NAME.has(name) && !FORWARDABLE_EXCLUDED.has(name);
}

/** The extensions Deno runs as a script (`deno main.ts`). */
const SCRIPT_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

/** The specifier schemes `deno run` accepts as an entrypoint. */
const SCRIPT_SCHEMES = /^(?:https?|file|jsr|npm|data):/i;

/** A token written as a path (`./x`, `../x`, `/x`, `.\x`, `C:\x`). */
const PATH_LIKE = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/;

/** Whether `path` is an existing regular file (a probe; any failure means no). */
function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/**
 * Whether a leading token is a script for `deno run`, as `deno main.ts` / `deno
 * https://…/x.ts` accept it: a name with a script extension (`.ts .tsx .js .jsx .mjs .cjs .mts
 * .cts`), a URL or `jsr:` / `npm:` specifier, or a path-shaped token (`./tool`, `/usr/…`) naming an
 * existing file (a shebang script without an extension). Deno itself runs ANY unknown word; denext
 * keeps "unknown command" and its did-you-mean for everything else, so a typo is never executed.
 *
 * @param token The token in verb position.
 * @param cwd The directory a relative path resolves against.
 * @returns Whether `denext <token> …` means `deno run <token> …`.
 */
export function isScriptTarget(token: string, cwd: string = Deno.cwd()): boolean {
  if (token === "" || token.startsWith("-")) return false;
  if (SCRIPT_SCHEMES.test(token)) return true;
  if (SCRIPT_EXTENSIONS.test(token)) return true;
  if (!PATH_LIKE.test(token)) return false;
  return isFile(isAbsolute(token) ? token : join(cwd, token));
}

/**
 * The stderr line printed when a project's own verb runs under a name Deno also has.
 *
 * @param name The verb.
 * @returns The one-line notice.
 */
export function shadowNotice(name: string): string {
  return `denext: running this project's "${name}" verb, which shadows Deno's \`deno ${name}\` ` +
    `(\`denext deno ${name}\` runs Deno's).`;
}

/**
 * Deno verbs a project's own verb may never take: each runs, serves, compiles, installs or
 * upgrades code, so `denext <name>` must always mean Deno's. A `commands:` entry or a plugin
 * `addCommand` under one of these names is refused when it is defined.
 */
const RESERVED_DENO_VERBS: ReadonlySet<string> = new Set([
  "run",
  "x",
  "eval",
  "serve",
  "compile",
  "install",
  "uninstall",
  "upgrade",
  "task",
]);

/**
 * Whether a project verb may not take `name` (see {@linkcode reservedVerbError}).
 *
 * @param name A verb name.
 * @returns Whether it is one of Deno's code-running verbs.
 */
export function isReservedDenoVerb(name: string): boolean {
  return RESERVED_DENO_VERBS.has(name);
}

/**
 * Why a project verb named `name` is refused.
 *
 * @param name The reserved name.
 * @returns The one-line reason.
 */
export function reservedVerbError(name: string): string {
  return `"${name}" is reserved: a project verb may not take the name of Deno's \`deno ${name}\`, ` +
    `which runs or installs code, so \`denext ${name}\` always means Deno's (or denext's own). ` +
    "Pick another name.";
}

/**
 * The stderr line printed when `denext <name>` ran Deno's verb in a project whose verb listing
 * is missing or stale, so a project verb of that name (if there is one) was not considered.
 *
 * @param name The Deno verb that ran.
 * @returns The one-line hint.
 */
export function unlistedVerbHint(name: string): string {
  return `denext: ran Deno's \`deno ${name}\`. If this project defines its own "${name}" verb, ` +
    "run `denext commands` once to list it; until then a name Deno also has runs Deno's.";
}
