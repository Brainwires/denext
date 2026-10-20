// Compile the denext CLI into one executable — the ONE place the repo spells out that
// `deno compile`, so the task, the workflows and the tests embed the same files and cannot drift.
//
//   deno run -A scripts/compile-cli.ts [--target <triple>] [--output <path>]
//
// `deno compile` embeds the module graph it can see from cli.ts. Two kinds of file it cannot:
// - the verbs, loaded on demand through computed imports (src/cli/lazy-command.ts):
//   src/cli/lazy-modules.generated.ts imports each of them so the binary embeds them;
// - framework files read at run time rather than imported ({@linkcode CLI_RUNTIME_FILES}).
// A file missing from the binary is not found at run time (`readFrameworkJson` names it), so
// tests/integration/cli-binary-smoke.test.ts runs the verbs that read these from a real binary.

/** Modules the CLI imports through computed specifiers (embedded as modules). */
export const CLI_LAZY_MODULES: readonly string[] = ["src/cli/lazy-modules.generated.ts"];

/**
 * Framework files the CLI reads as data at run time, in its own process, from a compiled binary:
 * - `deno.json`: the framework's `exports` (`migrate` lists the `next/*` subpaths it maps) and
 *   import map (`frameworkImports()`); the version is the `VERSION` constant, never read here;
 * - `AGENTS.md`: the MCP server's `denext://guide` resource.
 *
 * Build-time reads (the CSS config, `deno.lock`, the runtime sources a bundle loads) are not
 * listed: a binary never builds in its own process — module verbs run on the denext the
 * project pins (src/cli/run-verb.ts).
 */
export const CLI_RUNTIME_FILES: readonly string[] = ["deno.json", "AGENTS.md"];

/** Every `--include` the CLI's `deno compile` passes, relative to the repository root. */
export const CLI_COMPILE_INCLUDES: readonly string[] = [...CLI_LAZY_MODULES, ...CLI_RUNTIME_FILES];

/** Options of {@linkcode compileCliArgs}. */
export interface CompileCliOptions {
  /** The executable to write (default `denext`, in the working directory). */
  readonly output?: string;
  /** A `deno compile --target` triple, to cross-compile. */
  readonly target?: string;
}

/**
 * The `deno compile` arguments (after `deno`) that build the CLI, run from the repository root.
 *
 * @param options Where to write it and for which target.
 * @returns The argv.
 */
export function compileCliArgs(options: CompileCliOptions = {}): string[] {
  return [
    "compile",
    "-A",
    ...(options.target ? ["--target", options.target] : []),
    ...CLI_COMPILE_INCLUDES.flatMap((file) => ["--include", file]),
    "--output",
    options.output ?? "denext",
    "cli.ts",
  ];
}

/** Read `--name value` / `--name=value` from `args`. */
function flag(args: readonly string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url);
  const cwd = Deno.cwd();
  // A relative `--output` is the caller's (a workflow step's working directory), not the root's.
  const output = flag(Deno.args, "output");
  const absolute = output === undefined
    ? undefined
    : /^([a-zA-Z]:)?[\\/]/.test(output)
    ? output
    : `${cwd}${cwd.endsWith("/") || cwd.endsWith("\\") ? "" : "/"}${output}`;
  const args = compileCliArgs({ output: absolute, target: flag(Deno.args, "target") });
  console.error(`deno ${args.join(" ")}`);
  const { code } = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(code);
}
