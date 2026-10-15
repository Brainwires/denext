// "Possibly undefined / null" (TS18047, TS18048, TS18049, TS2531, TS2532, TS2533): say why the
// value can be missing and suggest the narrowing that fits the line it is used on.

import { initializerOf, lineText, offsetOf } from "./source.ts";
import type { RuleInput, RuleResult } from "./types.ts";

const NULLISH_CODES = new Set(["TS18047", "TS18048", "TS18049", "TS2531", "TS2532", "TS2533"]);

/** Known APIs that return a missing value, and when. */
const SOURCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.find(?:Last)?\(/, "`Array.find` returns `undefined` when no element matches"],
  [/\.(?:querySelector|closest)\(/, "`querySelector` returns `null` when nothing matches"],
  [/\.getElementById\(/, "`getElementById` returns `null` when no element has that id"],
  [/\.get\(/, "`Map.get` / `URLSearchParams.get` return a missing value for an absent key"],
  [/\.(?:match|exec)\(/, "a regular-expression match is `null` when the pattern doesn't match"],
  [/\.at\(|\.pop\(\)|\.shift\(\)/, "reading past the end of an array gives `undefined`"],
  [/Deno\.env\.get\(/, "`Deno.env.get` returns `undefined` when the variable isn't set"],
];

/** The missing kind TypeScript named: `null`, `undefined`, or both. */
function missingKind(message: string): string {
  if (/'null' or 'undefined'/.test(message) || /null or undefined/.test(message)) {
    return "`null` or `undefined`";
  }
  return /'null'|\bnull\b/.test(message) ? "`null`" : "`undefined`";
}

/** Why the expression can be missing, from its initializer (or that it's a call). */
function reasonFor(name: string, init: string | null): string {
  for (const [re, why] of SOURCES) if (init && re.test(init)) return `${why}.`;
  if (/\)$/.test(name)) return `\`${name}\`'s return type includes it.`;
  if (init) return `its type, from \`${init.split("\n")[0]}\`, includes it.`;
  return "its declared type includes it.";
}

/** The source line with `?.` inserted after the name at `column` (0-based in the line). */
function optionalChained(line: string, column: number, name: string): string | null {
  const after = column + name.length;
  if (line.slice(column, after) !== name) return null;
  const next = line[after];
  if (next === ".") return `${line.slice(0, after)}?${line.slice(after)}`;
  if (next === "[" || next === "(") return `${line.slice(0, after)}?.${line.slice(after)}`;
  return null;
}

/** The comparison that rules the missing kind out (`=== undefined`, `=== null`, `== null`). */
function missingTest(kind: string): string {
  if (kind.includes(" or ")) return "== null";
  return kind.includes("null") ? "=== null" : "=== undefined";
}

/** A guard that narrows a named value before the line. */
function guardFor(name: string, kind: string, indent: string): string {
  return `${indent}if (${name} ${missingTest(kind)}) {\n` +
    `${indent}  throw new Error("${
      name.replace(/"/g, "'")
    } is missing"); // or return a fallback\n` +
    `${indent}}`;
}

/**
 * Explain a "possibly null/undefined" error: where the missing value comes from, then a guard
 * (or a stored-and-checked call) and the optional-chaining form of the very line.
 */
export function nullishRule({ d, source, span }: RuleInput): RuleResult | null {
  if (!NULLISH_CODES.has(d.code)) return null;
  const named = /^'(.+)' is possibly/.exec(d.message)?.[1];
  const name = named ?? (span || "this value");
  const kind = missingKind(d.message);
  const line = source && d.line ? lineText(source, d.line) : "";
  const at = source && d.line && d.column ? offsetOf(source, d.line, d.column) : -1;
  const init = source && named ? initializerOf(source, named, at) : null;
  const chained = d.column ? optionalChained(line, d.column - 1, name) : null;
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const isCall = /\)$/.test(name);
  const guard = isCall
    ? `Store it and check it once:\n${indent}const value = ${name};\n${
      guardFor("value", kind, indent)
    }\n${line.replace(name, "value")}`
    : `Narrow it first:\n${guardFor(name, kind, indent)}\n${line}`;
  const chain = chained
    ? `\nOr, when a missing value may flow on as \`undefined\`:\n${chained.trimStart()}`
    : "";
  return {
    title: `\`${name}\` may be ${kind}`,
    why: `\`${name}\` can be ${kind} here — ${reasonFor(name, init)} TypeScript won't let ` +
      `you read from it until the code rules that out.`,
    fix: `${guard}${chain}`,
  };
}
