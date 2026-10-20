// The diagnostics explainer: turn a TypeScript / Deno / denext-lint diagnostic into a short,
// plain-language explanation with a concrete fix and a codeframe — the original kept beside it.
// Used by `denext check` / `lint` / `build` / `dev` (terminal), the dev overlay and the
// `denext_explain_error` MCP tool. Dev/CLI only: nothing here reaches a client bundle.

import { relative } from "@std/path";
import { codeframe } from "../dev-codeframe.ts";
import { formatExplanation, type FormatOptions } from "./format.ts";
import { parseDiagnostics, type SourceDiagnostic, stripAnsi } from "./parse.ts";
import { lineText } from "./source.ts";
import { assignabilityRule, excessPropertyRule, literalArgumentRule } from "./rules-assign.ts";
import { lintRule } from "./rules-lint.ts";
import {
  bareSpecifierRule,
  esmSyntaxRule,
  importSourceRule,
  missingNameRule,
  moduleNotFoundRule,
} from "./rules-modules.ts";
import {
  jsxRuntimeRule,
  jsxTypesRule,
  pathsTargetRule,
  removedOptionRule,
} from "./rules-config.ts";
import { nullishRule } from "./rules-nullish.ts";
import { missingReturnRule, neverCheckRule } from "./rules-switch.ts";
import type { ExplainContext, Explanation, Rule, RuleInput } from "./types.ts";

export type { ExplainContext, Explanation } from "./types.ts";
export type { SourceDiagnostic, StructuredDiagnostic } from "./parse.ts";
export { fromStructured, parseDiagnostics } from "./parse.ts";
export { formatExplanation } from "./format.ts";

/** The rules, most specific first; the first that recognises a diagnostic explains it. */
const RULES: readonly Rule[] = [
  lintRule,
  importSourceRule,
  bareSpecifierRule,
  moduleNotFoundRule,
  missingNameRule,
  esmSyntaxRule,
  removedOptionRule,
  pathsTargetRule,
  jsxRuntimeRule,
  jsxTypesRule,
  neverCheckRule,
  missingReturnRule,
  nullishRule,
  literalArgumentRule,
  excessPropertyRule,
  assignabilityRule,
];

/** Read a file through the context, never throwing. */
function readVia(ctx: ExplainContext, path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return ctx.readSource?.(path);
  } catch {
    return undefined;
  }
}

/** A path for display: relative to the root when inside it. */
function displayer(ctx: ExplainContext) {
  return (path: string, line?: number, column?: number): string => {
    let shown = path;
    if (ctx.rootDir) {
      const rel = relative(ctx.rootDir, path);
      if (!rel.startsWith("..")) shown = rel || ".";
    }
    return line ? `${shown}:${line}${column ? `:${column}` : ""}` : shown;
  };
}

/** The input a rule sees for `d`. */
function ruleInput(d: SourceDiagnostic, ctx: ExplainContext): RuleInput {
  const source = readVia(ctx, d.file);
  const line = source && d.line ? lineText(source, d.line) : "";
  const start = (d.column ?? 1) - 1;
  // No squiggle: take the identifier or string literal that starts at the column.
  const span = line.slice(start, start + (d.length ?? 0)) ||
    (/^(?:[\w$]+|"[^"]*"|'[^']*')/.exec(line.slice(start))?.[0] ?? "");
  return { d, source, span, ctx, display: displayer(ctx) };
}

/**
 * Explain one diagnostic.
 *
 * @param d A parsed diagnostic ({@linkcode parseDiagnostics} / {@linkcode fromStructured}).
 * @param ctx How to read the project's files.
 * @returns The explanation, or `null` when no rule recognises the diagnostic (show it as is).
 */
export function explainDiagnostic(
  d: SourceDiagnostic,
  ctx: ExplainContext = {},
): Explanation | null {
  const input = ruleInput(d, ctx);
  for (const rule of RULES) {
    const result = rule(input);
    if (!result) continue;
    const explanation: Explanation = { diagnostic: d, ...result };
    if (d.file) explanation.location = input.display(d.file, d.line, d.column);
    if (input.source && d.line && d.column) {
      const frame = codeframe(input.source, d.line, d.column, 1, d.length ?? input.span.length);
      if (frame) explanation.codeframe = frame;
    }
    return explanation;
  }
  return null;
}

/** The result of explaining a tool's whole output. */
export interface ExplainedOutput {
  /** The output with each recognised diagnostic replaced by its explanation (original kept). */
  text: string;
  /** Every diagnostic found. */
  diagnostics: SourceDiagnostic[];
  /** The explanations, in output order (only the recognised diagnostics). */
  explanations: Explanation[];
}

/**
 * Explain every diagnostic in a tool's output, keeping everything else exactly where it was.
 *
 * @param output The text `deno check` / `deno lint` / Deno / esbuild printed.
 * @param ctx How to read the project's files (`rootDir` also resolves `deno lint`'s relative paths).
 * @param opts Formatting (colour; the original is always appended to each explanation here).
 * @returns The rewritten text and the parsed pieces.
 */
export function explainDiagnosticsText(
  output: string,
  ctx: ExplainContext = {},
  opts: Pick<FormatOptions, "color"> = {},
): ExplainedOutput {
  const plain = stripAnsi(output);
  const diagnostics = parseDiagnostics(plain, ctx.rootDir);
  const explanations: Explanation[] = [];
  let text = "";
  let cursor = 0;
  for (const d of diagnostics) {
    const at = plain.indexOf(d.raw, cursor);
    const e = explainDiagnostic(d, ctx);
    if (at < 0 || !e) continue;
    explanations.push(e);
    text += plain.slice(cursor, at) + formatExplanation(e, { color: opts.color, original: true });
    cursor = at + d.raw.length;
  }
  text += plain.slice(cursor);
  return { text: explanations.length ? text : output, diagnostics, explanations };
}

/** The text of every explanation without the originals (the overlay shows those apart). */
export function explanationsSummary(explanations: readonly Explanation[]): string {
  return explanations.map((e) => formatExplanation(e, { original: false })).join("\n\n");
}

/** The env var that turns explanations off everywhere (the original output, unchanged). */
export const RAW_DIAGNOSTICS_ENV = "DENEXT_RAW_DIAGNOSTICS";

/** Whether explanations are off ({@linkcode RAW_DIAGNOSTICS_ENV} set to anything but `0`). */
export function rawDiagnostics(): boolean {
  try {
    const v = Deno.env.get(RAW_DIAGNOSTICS_ENV);
    return v !== undefined && v !== "" && v !== "0";
  } catch {
    return false;
  }
}

/** An {@linkcode ExplainContext} over the real filesystem, rooted at `rootDir`. */
export function fsExplainContext(rootDir: string): ExplainContext {
  return {
    rootDir,
    readSource: (path) => Deno.readTextFileSync(path),
    listDir: (dir) => [...Deno.readDirSync(dir)].filter((e) => e.isFile).map((e) => e.name),
  };
}
