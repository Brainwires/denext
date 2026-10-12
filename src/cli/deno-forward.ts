// What `denext <verb> …` hands to Deno when the verb is neither a denext built-in nor one of the
// project's own: a Deno subcommand (`denext compile …` → `deno compile …`) or a script
// (`denext main.ts …` → `deno run main.ts …`). The CLI runs the result through the same path as
// `denext deno …` (src/cli/commands/deno-toolchain.ts `runDenoPassthrough`), so the toolchain
// choice, `DENEXT_DENO`, stdio, exit code and signals are all that verb's.

import { resolve } from "@std/path";
import { isForwardableDenoVerb, isScriptTarget } from "./deno-verbs.ts";

/** A forwarded invocation: `deno <args…>` run in `cwd`. */
export interface DenoForward {
  /** The arguments for `deno`, verbatim from the CLI's argv (plus `run` for a script). */
  readonly args: string[];
  /** The directory to run in (`--cwd`, else the process cwd). */
  readonly cwd: string;
}

/**
 * The tokens before the verb, minus denext's `--cwd <dir>` / `--cwd=<dir>` (which picks the
 * directory instead), and the directory it named.
 */
function leadingOf(tokens: readonly string[], cwd: string): { kept: string[]; cwd: string } {
  const kept: string[] = [];
  let dir = cwd;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--cwd" && i + 1 < tokens.length) dir = resolve(cwd, tokens[++i]);
    else if (tok.startsWith("--cwd=")) dir = resolve(cwd, tok.slice("--cwd=".length));
    else kept.push(tok);
  }
  return { kept, cwd: dir };
}

/**
 * The Deno invocation for an argv whose verb (at `index`) nothing in denext claims, or null when
 * the verb is not Deno's either (then it is an unknown command). Every token from the verb on is
 * passed verbatim — a flag denext also has (`--config`, `--quiet`, `--json`) means Deno's here;
 * tokens before the verb are kept too (`denext -q compile` → `deno -q compile`) except `--cwd`.
 *
 * @param argv The CLI's arguments.
 * @param verb The unknown verb and its index in `argv`.
 * @param cwd The process's directory.
 * @returns The forwarded invocation, or null.
 */
export function denoForwardFor(
  argv: readonly string[],
  verb: { readonly name: string; readonly index: number },
  cwd: string = Deno.cwd(),
): DenoForward | null {
  if (isForwardableDenoVerb(verb.name)) return verbatimFrom(argv, verb.index, cwd);
  const leading = leadingOf(argv.slice(0, verb.index), cwd);
  if (isScriptTarget(verb.name, leading.cwd)) {
    return { args: [...leading.kept, "run", ...argv.slice(verb.index)], cwd: leading.cwd };
  }
  return null;
}

/**
 * The Deno invocation for a verb denext hands to Deno whole — `denext task …` — with every token
 * from the verb on verbatim (a task's own arguments may be anything, `--quiet` and `--config`
 * included) and `--cwd` before it picking the directory.
 *
 * @param argv The CLI's arguments.
 * @param index The verb's index in `argv`.
 * @param cwd The process's directory.
 * @returns The forwarded invocation.
 */
export function verbatimFrom(
  argv: readonly string[],
  index: number,
  cwd: string = Deno.cwd(),
): DenoForward {
  const leading = leadingOf(argv.slice(0, index), cwd);
  return { args: [...leading.kept, ...argv.slice(index)], cwd: leading.cwd };
}
