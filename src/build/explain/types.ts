// The shared shapes of the diagnostics explainer: what a rule receives and what it returns.

import type { SourceDiagnostic } from "./parse.ts";

/** How the explainer reaches the project's files. Every hook is optional. */
export interface ExplainContext {
  /** Paths are shown relative to this directory. */
  rootDir?: string;
  /** Read a source file (absolute path); `undefined` when it can't be read. */
  readSource?: (path: string) => string | undefined;
  /** List the file names in a directory (absolute path), for "did you mean" on a missing module. */
  listDir?: (dir: string) => string[];
}

/** A plain-language explanation of one diagnostic. */
export interface Explanation {
  /** The diagnostic it explains (its `raw` text is the original, kept verbatim). */
  diagnostic: SourceDiagnostic;
  /** One line: what is wrong. */
  title: string;
  /** Why it happens, in plain language. */
  why: string;
  /** A concrete fix. May span lines (a code suggestion). */
  fix: string;
  /** `path:line:col`, relative to the root. */
  location?: string;
  /** The source lines around the error, with a caret under the span. */
  codeframe?: string;
}

/** The part of an {@linkcode Explanation} a rule writes; the explainer adds the rest. */
export type RuleResult = Pick<Explanation, "title" | "why" | "fix">;

/** What a rule sees: the diagnostic plus its source, read once. */
export interface RuleInput {
  /** The diagnostic. */
  d: SourceDiagnostic;
  /** The whole file the diagnostic points into, when readable. */
  source?: string;
  /** The text under the reported span on its line (`""` when unknown). */
  span: string;
  /** The explainer context (for reading other files or listing a directory). */
  ctx: ExplainContext;
  /** A path shown relative to the root. */
  display(path: string, line?: number, column?: number): string;
}

/** One explanation rule: a result when it recognises the diagnostic, else `null`. */
export type Rule = (input: RuleInput) => RuleResult | null;
