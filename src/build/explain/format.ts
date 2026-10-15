// Render an explanation as text: the title and location, a codeframe, the plain-language
// why, the fix — and the original diagnostic, verbatim, below it.

import type { Explanation } from "./types.ts";

/** Formatting options. */
export interface FormatOptions {
  /** ANSI colour (terminal). Default false. */
  color?: boolean;
  /** Append the original diagnostic, indented (default true). The overlay shows it apart. */
  original?: boolean;
}

const paint = (on: boolean, code: string) => (s: string) => on ? `\x1b[${code}m${s}\x1b[0m` : s;

/** Indent every line of `text` by `pad`. */
function indent(text: string, pad: string): string {
  return text.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

/** The label for the tool that printed the original. */
function toolOf(e: Explanation): string {
  switch (e.diagnostic.source) {
    case "lint":
      return "deno lint";
    case "esbuild":
      return "esbuild";
    case "deno":
      return "deno";
    default:
      return "deno check";
  }
}

/**
 * One explanation as text.
 *
 * @param e The explanation.
 * @param opts Colour, and whether to append the original diagnostic.
 * @returns The rendered block (no trailing newline).
 */
export function formatExplanation(e: Explanation, opts: FormatOptions = {}): string {
  const color = opts.color === true;
  const red = paint(color, "1;31");
  const green = paint(color, "32");
  const dim = paint(color, "2");
  const cyan = paint(color, "36");
  const out = [`${red(`${e.diagnostic.code}:`)} ${paint(color, "1")(e.title)}`];
  if (e.location) out.push(`  ${cyan(`at ${e.location}`)}`);
  if (e.codeframe) out.push("", indent(e.codeframe, "  "));
  out.push("", indent(e.why, "  "));
  out.push("", indent(`${green("Fix:")} ${e.fix}`, "  "));
  if (opts.original !== false) {
    out.push("", `  ${dim(`Original (${toolOf(e)}):`)}`, dim(indent(e.diagnostic.raw, "  │ ")));
  }
  return out.join("\n");
}
