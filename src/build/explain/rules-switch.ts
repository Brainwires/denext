// Non-exhaustive switches over a union: the `never` guard that fails (TS2322 to `never`) and
// a function whose switch falls off the end (TS2366). Both list the members no `case` handles.

import { blockAfter, offsetOf, statementFrom } from "./source.ts";
import { assignablePair, unionMembers } from "./ts-text.ts";
import type { RuleInput, RuleResult } from "./types.ts";

/** `case "a":` stubs for the missing members. */
function caseStubs(members: readonly string[]): string {
  return members.map((m) => `  case ${m}:\n    // …`).join("\n");
}

/** TS2322 into `never`: the exhaustive-check variable caught the members still possible. */
export function neverCheckRule({ d, source }: RuleInput): RuleResult | null {
  if (d.code !== "TS2322") return null;
  const pair = assignablePair(d.message);
  if (!pair || pair.expected !== "never") return null;
  const missing = unionMembers(pair.actual);
  const value = source && d.line ? /=\s*([\w$.]+)\s*;/.exec(sourceLine(source, d.line))?.[1] : "";
  const list = missing.join(", ");
  return {
    title: `Switch is not exhaustive — unhandled: ${list}`,
    why: `The \`never\` check only compiles once every member of the union has a \`case\`. ` +
      `${value ? `\`${value}\`` : "The value"} can still be ${list} when it reaches it, so ` +
      `those cases are missing.`,
    fix: `Add a case for each missing member above the \`default\`:\n${caseStubs(missing)}`,
  };
}

/** A 1-based line of the source. */
function sourceLine(source: string, line: number): string {
  return source.split("\n")[line - 1] ?? "";
}

/** The `switch (expr)` in `body` and the literal labels of its cases. */
function switchIn(body: string): { expr: string; cases: string[] } | null {
  const sw = /\bswitch\s*\(\s*([\w$.]+)\s*\)/.exec(body);
  if (!sw) return null;
  const block = blockAfter(body, sw.index + sw[0].length);
  if (/\bdefault\s*:/.test(block)) return null;
  const cases = [...block.matchAll(/\bcase\s+("(?:[^"\\]|\\.)*"|'[^']*'|[\w$.]+)\s*:/g)]
    .map((m) => m[1].replace(/^'(.*)'$/, '"$1"'));
  return { expr: sw[1], cases };
}

/** The literal members a union type alias declares in this file, for `expr` (`x` or `x.kind`). */
function declaredMembers(source: string, fnHeader: string, expr: string): string[] | null {
  const [base, prop] = expr.split(".");
  const typeName = new RegExp(`\\b${base}\\s*:\\s*([A-Z][\\w$]*)`).exec(fnHeader)?.[1];
  if (!typeName) return null;
  const decl = new RegExp(`\\btype\\s+${typeName}\\s*=`).exec(source);
  if (!decl) return null;
  const text = statementFrom(source, decl.index + decl[0].length);
  const re = prop
    ? new RegExp(`\\b${prop}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`, "g")
    : /("(?:[^"\\]|\\.)*")/g;
  const members = [...text.matchAll(re)].map((m) => m[1]);
  return members.length ? [...new Set(members)] : null;
}

/**
 * TS2366 ("Function lacks ending return statement"): when the function ends in a `switch` with
 * no `default`, the cases don't cover the union. Lists the uncovered members when the union is
 * a type alias in the same file.
 */
export function missingReturnRule({ d, source }: RuleInput): RuleResult | null {
  if (d.code !== "TS2366" || !source || !d.line || !d.column) return null;
  const at = offsetOf(source, d.line, d.column);
  const header = source.slice(source.lastIndexOf("\n", at) + 1, source.indexOf("{", at));
  const sw = switchIn(blockAfter(source, at));
  if (!sw) return null;
  const all = declaredMembers(source, header, sw.expr);
  const missing = all?.filter((m) => !sw.cases.includes(m)) ?? [];
  const covered = sw.cases.join(", ");
  if (missing.length === 0) {
    return {
      title: "The switch can fall through without returning",
      why: `\`switch (${sw.expr})\` handles ${covered || "no cases"} and has no \`default\`, so ` +
        `any other value reaches the end of the function, which returns nothing.`,
      fix: `Add the missing cases, or end the switch with an exhaustive default:\n` +
        `  default: {\n    const unhandled: never = ${sw.expr};\n    throw new Error(\`unhandled: \${unhandled}\`);\n  }`,
    };
  }
  const list = missing.join(", ");
  return {
    title: `Switch is not exhaustive — unhandled: ${list}`,
    why: `\`switch (${sw.expr})\` handles ${covered}, but the union also has ${list}. For ` +
      `those the function runs past the switch and returns nothing.`,
    fix: `Add a case for each missing member:\n${caseStubs(missing)}`,
  };
}
