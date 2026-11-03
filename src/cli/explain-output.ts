// The CLI side of the diagnostics explainer (src/build/explain): explained `deno check` /
// `deno lint` output, the explanation appended to a failed build, and the `--raw` opt-out.

import {
  explainDiagnosticsText,
  explanationsSummary,
  fsExplainContext,
  RAW_DIAGNOSTICS_ENV,
  rawDiagnostics,
} from "../build/explain/mod.ts";
import type { CommandContext } from "./command.ts";

/** `--raw` given: switch explanations off for this whole process (dev server included). */
export function applyRawFlag(ctx: CommandContext): void {
  if (ctx.flags.raw !== true) return;
  try {
    Deno.env.set(RAW_DIAGNOSTICS_ENV, "1");
  } catch { /* no env write permission: the flag still holds for this call's own output */ }
}

/** Colour for the terminal: stderr is a TTY and `NO_COLOR` is unset. */
function stderrColor(): boolean {
  try {
    return Deno.stderr.isTerminal() && !Deno.noColor;
  } catch {
    return false;
  }
}

/**
 * Tool output with every recognised diagnostic explained (the original kept under each), or
 * unchanged when explanations are off.
 *
 * @param output What `deno check` / `deno lint` printed.
 * @param cwd The directory the tool ran in (relative paths resolve against it).
 * @returns The text to print.
 */
export function explainedToolOutput(output: string, cwd: string): string {
  if (rawDiagnostics()) return output;
  try {
    return explainDiagnosticsText(output, fsExplainContext(cwd), { color: stderrColor() }).text;
  } catch {
    return output;
  }
}

/**
 * The explanation appended to a failed build's message (`""` when nothing is recognised or
 * explanations are off). The message itself, the original, is printed first.
 *
 * @param detail The build error's message.
 * @param cwd The directory paths are shown relative to (default: the process cwd).
 * @returns `"\n\n<explanations>"` or `""`.
 */
export function explainBuildFailure(detail: string, cwd: string = Deno.cwd()): string {
  if (rawDiagnostics()) return "";
  try {
    const { explanations } = explainDiagnosticsText(detail, fsExplainContext(cwd));
    return explanations.length ? `\n\n${explanationsSummary(explanations)}` : "";
  } catch {
    return "";
  }
}
