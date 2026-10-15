// The `denext_explain_error` MCP tool: a TypeScript / Deno / denext-lint diagnostic (pasted
// tool output, or one structured diagnostic) explained in plain language with a fix and a
// codeframe, read against the project's own files. The original always comes back too.

import {
  type ExplainContext,
  explainDiagnostic,
  formatExplanation,
  fromStructured,
  fsExplainContext,
  parseDiagnostics,
  type SourceDiagnostic,
  type StructuredDiagnostic,
} from "../build/explain/mod.ts";
import { realPathOfNearestSync, within } from "../ui/security.ts";

/**
 * The filesystem context, confined to the project: a diagnostic that names a file outside
 * `dir` gets no codeframe rather than a peek at that file.
 */
export function projectExplainContext(dir: string): ExplainContext {
  const fs = fsExplainContext(dir);
  const root = realPathOfNearestSync(dir);
  const inside = (path: string) => within(realPathOfNearestSync(path), root);
  return {
    rootDir: dir,
    readSource: (path) => inside(path) ? fs.readSource?.(path) : undefined,
    listDir: (path) => inside(path) ? fs.listDir?.(path) ?? [] : [],
  };
}

/** The diagnostics a tool call names: parsed `output`, or the one structured `diagnostic`. */
function diagnosticsOf(args: Record<string, unknown>, dir: string): SourceDiagnostic[] {
  if (typeof args.output === "string" && args.output.trim()) {
    return parseDiagnostics(args.output, dir);
  }
  const d = args.diagnostic;
  if (d && typeof d === "object" && "code" in d && "message" in d) {
    return [fromStructured(d as StructuredDiagnostic)];
  }
  return [];
}

/**
 * Run `denext_explain_error`.
 *
 * @param args The tool arguments: `output` or `diagnostic`, and the project directory `dir`.
 * @param dir The resolved project directory (source files are read from it).
 * @param ctx The explainer context (default: the real filesystem under `dir`).
 * @returns The tool's text, and whether the input held no diagnostic at all.
 */
export function explainErrorTool(
  args: Record<string, unknown>,
  dir: string,
  ctx: ExplainContext = projectExplainContext(dir),
): { text: string; isError?: boolean } {
  const diagnostics = diagnosticsOf(args, dir);
  if (diagnostics.length === 0) {
    return {
      text:
        "No diagnostic found. Pass `output` (what `deno check`, `deno lint`, `denext build` or " +
        "the dev overlay printed) or `diagnostic` ({ code, message, file, line, column }).",
      isError: true,
    };
  }
  const explanations = diagnostics.map((d) => explainDiagnostic(d, ctx));
  const blocks = diagnostics.map((d, i) => {
    const e = explanations[i];
    return e
      ? formatExplanation(e)
      : `${d.code}: no specific explanation — the original diagnostic:\n${d.raw}`;
  });
  const explained = explanations.filter((e) => e !== null).length;
  const head = `${diagnostics.length} diagnostic(s), ${explained} explained.`;
  return { text: [head, ...blocks].join("\n\n") };
}
