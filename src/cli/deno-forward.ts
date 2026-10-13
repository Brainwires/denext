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

/** What the tokens before the verb amount to, sorted by where Deno accepts each. */
interface Leading {
  /** Tokens that go right after the Deno subcommand (`--config <v>`, `--json`, `-A`, …). */
  readonly after: string[];
  /** The directory `--cwd` named (else the process's). */
  readonly cwd: string;
}

/** denext's own global flags that Deno has no meaning for; dropped when forwarding. */
const DENEXT_ONLY_FLAGS: ReadonlySet<string> = new Set(["--verbose"]);

/**
 * The tokens before the verb. `--cwd <dir>` / `--cwd=<dir>` picks the directory; a denext-only flag
 * (`--verbose`) is dropped; everything else (`--config <v>`, `--json`, `-q`, `-A`, …) is kept to be
 * placed AFTER the Deno subcommand, the only place Deno accepts most of them (`deno --config x
 * task` is an error; `deno task --config x` is not). With `json: false`, `--json` is dropped too
 * (`deno run` has no `--json`).
 */
function leadingOf(tokens: readonly string[], cwd: string, json = true): Leading {
  const after: string[] = [];
  let dir = cwd;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const cwdValue = valueOf(tokens, i, "--cwd");
    if (cwdValue !== undefined) {
      dir = resolve(cwd, cwdValue);
      if (!tok.includes("=")) i++;
      continue;
    }
    if (dropped(tok, json)) continue;
    after.push(tok);
    // `--config <v>` keeps its value with it.
    if (tok === "--config" && i + 1 < tokens.length) after.push(tokens[++i]);
  }
  return { after, cwd: dir };
}

/** The value of `--name <v>` / `--name=<v>` at `i`, or undefined when `tokens[i]` is not it. */
function valueOf(tokens: readonly string[], i: number, name: string): string | undefined {
  const tok = tokens[i];
  if (tok.startsWith(`${name}=`)) return tok.slice(name.length + 1);
  return tok === name && i + 1 < tokens.length ? tokens[i + 1] : undefined;
}

/** Whether a leading token is left out of the Deno invocation. */
function dropped(tok: string, json: boolean): boolean {
  return DENEXT_ONLY_FLAGS.has(tok) || (!json && tok === "--json");
}

/**
 * The Deno invocation for an argv whose verb (at `index`) nothing in denext claims, or null when
 * the verb is not Deno's either (then it is an unknown command). Every token from the verb on is
 * passed verbatim — a flag denext also has (`--config`, `--quiet`, `--json`) means Deno's here.
 * Tokens before the verb go after the Deno subcommand (`denext --config c.json compile x.ts` →
 * `deno compile --config c.json x.ts`; `denext -A main.ts` → `deno run -A main.ts`), except
 * `--cwd` (the directory) and `--verbose` (denext's alone).
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
  const leading = leadingOf(argv.slice(0, verb.index), cwd, false);
  if (isScriptTarget(verb.name, leading.cwd)) {
    return { args: ["run", ...leading.after, ...argv.slice(verb.index)], cwd: leading.cwd };
  }
  return null;
}

/**
 * The Deno invocation for a verb denext hands to Deno whole — a forwarded Deno verb, `denext task
 * …` — with every token from the verb on verbatim (a task's own arguments may be anything,
 * `--quiet` and `--config` included) and the tokens before it placed right after it.
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
  return { args: [argv[index], ...leading.after, ...argv.slice(index + 1)], cwd: leading.cwd };
}

/**
 * The Deno invocation for `denext [globals…] deno <args…>`: the arguments after `deno` verbatim,
 * with the tokens before `deno` placed after Deno's subcommand (the first argument), and `--cwd`
 * picking the directory. `denext --cwd app deno fmt --quiet` → `deno fmt --quiet` in `app`.
 *
 * @param argv The CLI's arguments.
 * @param index The index of `deno` in `argv`.
 * @param cwd The process's directory.
 * @returns The forwarded invocation.
 */
export function denoVerbArgs(
  argv: readonly string[],
  index: number,
  cwd: string = Deno.cwd(),
): DenoForward {
  const leading = leadingOf(argv.slice(0, index), cwd);
  const rest = argv.slice(index + 1);
  if (rest.length === 0 || rest[0].startsWith("-")) {
    return { args: [...rest, ...leading.after], cwd: leading.cwd };
  }
  return { args: [rest[0], ...leading.after, ...rest.slice(1)], cwd: leading.cwd };
}
