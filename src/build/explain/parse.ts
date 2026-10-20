// Parse the diagnostics the toolchain prints — `deno check` (TypeScript), `deno lint` (with
// denext's lint plugin), Deno's own `error: …` resolution errors and esbuild's
// `file:line:col: ERROR: …` lines — into one structured shape the explainer reads. Every
// diagnostic keeps its exact original text (`raw`), so nothing the tool said is ever lost.
//
// Dev/CLI only: nothing here reaches a client bundle.

import { fromFileUrl, isAbsolute, resolve } from "@std/path";

/** Where a diagnostic came from. */
export type DiagnosticSource = "ts" | "lint" | "deno" | "esbuild";

/** A secondary location a diagnostic points at (TypeScript's "related information"). */
export interface RelatedLocation {
  /** The related message (e.g. "The expected type comes from property 'x' …"). */
  message: string;
  /** Absolute path of the related file, when known. */
  file?: string;
  /** 1-based line. */
  line?: number;
  /** 1-based column. */
  column?: number;
}

/** One parsed diagnostic. */
export interface SourceDiagnostic {
  /** The tool that reported it. */
  source: DiagnosticSource;
  /** `TS2322`, `denext/rules-of-hooks`, `module-not-found`, … */
  code: string;
  /** The headline message. */
  message: string;
  /** The rest of TypeScript's message chain, outermost first, dedented. Hints included. */
  chain: string[];
  /** Absolute path of the file, when known. */
  file?: string;
  /** 1-based line. */
  line?: number;
  /** 1-based column. */
  column?: number;
  /** Width of the reported span on its line (the squiggle), when known. */
  length?: number;
  /** TypeScript's related locations. */
  related: RelatedLocation[];
  /** The diagnostic exactly as printed. */
  raw: string;
}

/** A TypeScript message chain as the TypeScript API / LSP shapes it. */
export interface MessageChain {
  /** This level's text. */
  messageText: string;
  /** The nested levels. */
  next?: MessageChain[];
}

// deno-lint-ignore no-control-regex -- matching the ESC byte is the point.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Drop ANSI colour codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

const TS_HEADER = /^(TS\d+) \[(?:ERROR|WARN|WARNING)\]: (.*)$/;
const LINT_HEADER = /^(?:error|warning)\[([\w@/-]+)\]: (.*)$/;
const DENO_ERROR = /^error: (.*)$/;
const AT_LINE = /^\s+at (\S+?):(\d+):(\d+)\s*$/;
const LINT_AT = /^\s*-->\s*(\S+?):(\d+):(\d+)\s*$/;
const ESBUILD_LINE = /^(?:✘ \[ERROR\] |)(\S+?):(\d+):(\d+): ERROR: (.*)$/;
// `~~~` under a span, `^` under a one-character one (both checkers render it so).
const SQUIGGLE = /^\s*(?:~+|\^)\s*$/;

/** A path as printed (`file:///x`, `/x`, or relative to `cwd`) → an absolute path. */
export function toPath(printed: string, cwd?: string): string {
  if (printed.startsWith("file://")) {
    try {
      return fromFileUrl(printed);
    } catch {
      return printed;
    }
  }
  if (isAbsolute(printed) || !cwd) return printed;
  return resolve(cwd, printed);
}

/** Count of leading spaces. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The lines of a TS block from its header to the next header / summary line (exclusive). */
function blockEnd(lines: string[], start: number): number {
  let i = start + 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (TS_HEADER.test(l) || LINT_HEADER.test(l) || DENO_ERROR.test(l)) break;
    if (/^Found \d+ (?:errors?|problems?)\.?$/.test(l) || /^Checked \d+ files?$/.test(l)) break;
  }
  while (i > start + 1 && lines[i - 1].trim() === "") i--;
  return i;
}

/** The `(message, snippet, squiggle)` part before an `at` line: the chain and the span width. */
function splitChain(body: string[]): { chain: string[]; length?: number } {
  let end = body.length;
  let length: number | undefined;
  if (end >= 2 && SQUIGGLE.test(body[end - 1])) {
    length = body[end - 1].trim().length;
    end -= 2; // the source line + the squiggle line
  }
  const lines = body.slice(0, end).filter((l) => l.trim() !== "");
  return { chain: lines.map((l) => l.trim()), length };
}

/** Related-information entries after the primary `at` line. */
function parseRelated(lines: string[], cwd?: string): RelatedLocation[] {
  const out: RelatedLocation[] = [];
  let cur: RelatedLocation | null = null;
  for (const l of lines) {
    if (l.trim() === "") continue;
    const at = AT_LINE.exec(l);
    if (at && cur) {
      Object.assign(cur, { file: toPath(at[1], cwd), line: +at[2], column: +at[3] });
      cur = null;
      continue;
    }
    if (indentOf(l) === 4 && !SQUIGGLE.test(l)) {
      cur = { message: l.trim() };
      out.push(cur);
    }
  }
  return out;
}

/** One `TSxxxx [ERROR]: …` block. */
function parseTsBlock(lines: string[], cwd?: string): SourceDiagnostic {
  const [, code, message] = TS_HEADER.exec(lines[0])!;
  const atIdx = lines.findIndex((l, i) => i > 0 && AT_LINE.test(l) && indentOf(l) === 4);
  const body = lines.slice(1, atIdx < 0 ? lines.length : atIdx);
  const { chain, length } = splitChain(body);
  const diag: SourceDiagnostic = {
    source: "ts",
    code,
    message,
    chain,
    related: [],
    raw: lines.join("\n"),
    ...(length !== undefined ? { length } : {}),
  };
  if (atIdx >= 0) {
    const at = AT_LINE.exec(lines[atIdx])!;
    Object.assign(diag, { file: toPath(at[1], cwd), line: +at[2], column: +at[3] });
    diag.related = parseRelated(lines.slice(atIdx + 1), cwd);
  }
  return diag;
}

/** One `error[denext/rule]: …` block from `deno lint`. */
function parseLintBlock(lines: string[], cwd?: string): SourceDiagnostic {
  const [, code, message] = LINT_HEADER.exec(lines[0])!;
  const diag: SourceDiagnostic = {
    source: "lint",
    code,
    message: message.replace(/\s*\[[\w@/-]+\]\s*$/, ""),
    chain: [],
    related: [],
    raw: lines.join("\n"),
  };
  for (const l of lines.slice(1)) {
    const at = LINT_AT.exec(l);
    if (at) {
      Object.assign(diag, { file: toPath(at[1], cwd), line: +at[2], column: +at[3] });
      break;
    }
  }
  const caret = lines.find((l) => /^\s*\|\s*\^+/.test(l));
  if (caret) diag.length = (/\^+/.exec(caret)?.[0].length) ?? 1;
  return diag;
}

/** One `error: …` block from Deno (module resolution and the like). */
function parseDenoBlock(lines: string[], cwd?: string): SourceDiagnostic | null {
  const [, message] = DENO_ERROR.exec(lines[0])!;
  if (/^Type checking failed\.?$/.test(message) || /^Found \d+/.test(message)) return null;
  const diag: SourceDiagnostic = {
    source: "deno",
    code: /^Module not found/.test(message) ? "module-not-found" : "deno",
    message,
    chain: lines.slice(1).filter((l) => l.trim() && !AT_LINE.test(l)).map((l) => l.trim()),
    related: [],
    raw: lines.join("\n"),
  };
  const at = lines.map((l) => AT_LINE.exec(l)).find((m) => m);
  if (at) Object.assign(diag, { file: toPath(at[1], cwd), line: +at[2], column: +at[3] });
  return diag;
}

/** One esbuild `file:line:col: ERROR: message` line. */
function parseEsbuildLine(line: string, cwd?: string): SourceDiagnostic {
  const [, file, ln, col, message] = ESBUILD_LINE.exec(line)!;
  return {
    source: "esbuild",
    code: /^Could not resolve/.test(message) ? "module-not-found" : "esbuild",
    message,
    chain: [],
    file: toPath(file, cwd),
    line: +ln,
    column: +col + 1, // esbuild columns are 0-based
    related: [],
    raw: line,
  };
}

/** Parse one block starting at `lines[i]`; `[diagnostic | null, next index]`. */
function parseAt(lines: string[], i: number, cwd?: string): [SourceDiagnostic | null, number] {
  const l = lines[i];
  if (ESBUILD_LINE.test(l)) return [parseEsbuildLine(l, cwd), i + 1];
  if (!TS_HEADER.test(l) && !LINT_HEADER.test(l) && !DENO_ERROR.test(l)) return [null, i + 1];
  const end = blockEnd(lines, i);
  const block = lines.slice(i, end);
  if (TS_HEADER.test(l)) return [parseTsBlock(block, cwd), end];
  if (LINT_HEADER.test(l)) return [parseLintBlock(block, cwd), end];
  return [parseDenoBlock(block, cwd), end];
}

/**
 * Parse tool output into diagnostics. Lines that belong to no diagnostic (summaries,
 * banners) are skipped here; callers that print keep the original text alongside.
 *
 * @param text The output of `deno check`, `deno lint`, a Deno error, or an esbuild failure.
 * @param cwd The directory relative paths are resolved against (`deno lint` prints them so).
 * @returns The diagnostics in output order.
 */
export function parseDiagnostics(text: string, cwd?: string): SourceDiagnostic[] {
  const lines = stripAnsi(text).replace(/\r\n/g, "\n").split("\n");
  const out: SourceDiagnostic[] = [];
  for (let i = 0; i < lines.length;) {
    const [diag, next] = parseAt(lines, i, cwd);
    if (diag) out.push(diag);
    i = next;
  }
  return out;
}

/** Flatten a TypeScript message chain into lines, outermost first. */
function flattenChain(chain: MessageChain, out: string[] = []): string[] {
  out.push(chain.messageText);
  for (const next of chain.next ?? []) flattenChain(next, out);
  return out;
}

/** A structured diagnostic as an LSP / the TypeScript API reports it. */
export interface StructuredDiagnostic {
  /** The TypeScript code (`2322`, `"TS2322"`) or a lint rule id (`denext/rules-of-hooks`). */
  code: number | string;
  /** The message: a plain string or TypeScript's chain. */
  message: string | MessageChain;
  /** File path or `file://` URL. */
  file?: string;
  /** 1-based line. */
  line?: number;
  /** 1-based column. */
  column?: number;
  /** Width of the span. */
  length?: number;
}

/**
 * Normalise a structured diagnostic (from an editor, an LSP or the TypeScript API) into the
 * shape the explainer reads.
 *
 * @param d The diagnostic.
 * @returns The parsed form; `raw` is a `deno check`-style rendering of it.
 */
export function fromStructured(d: StructuredDiagnostic): SourceDiagnostic {
  const lines = typeof d.message === "string" ? d.message.split("\n") : flattenChain(d.message);
  const isLint = typeof d.code === "string" && d.code.includes("/");
  const code = isLint ? String(d.code) : `TS${String(d.code).replace(/^TS/i, "")}`;
  const at = d.file && d.line ? `\n    at ${d.file}:${d.line}:${d.column ?? 1}` : "";
  return {
    source: isLint ? "lint" : "ts",
    code,
    message: lines[0] ?? "",
    chain: lines.slice(1).map((l) => l.trim()).filter(Boolean),
    ...(d.file ? { file: toPath(d.file) } : {}),
    ...(d.line ? { line: d.line, column: d.column ?? 1 } : {}),
    ...(d.length ? { length: d.length } : {}),
    related: [],
    raw: `${isLint ? `error[${code}]` : `${code} [ERROR]`}: ${lines.join("\n  ")}${at}`,
  };
}
