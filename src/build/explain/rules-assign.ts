// Assignability (TS2322 / TS2345), excess properties (TS2353 / TS2561) and the typed API
// client's unknown paths: collapse TypeScript's long generic chains — `defineApi`'s handler
// type, the client's `RequestOf<InferEndpoint<…>>` — to the one property path that mismatches.

import { suggest } from "../../cli/command.ts";
import { apiCallAt, keyPathAt, offsetOf } from "./source.ts";
import {
  assignablePair,
  chainPath,
  missingProperty,
  objectKeys,
  shortType,
  stringLiteral,
  stringLiteralUnion,
} from "./ts-text.ts";
import type { RuleInput, RuleResult } from "./types.ts";

const ASSIGN_CODES = new Set(["TS2322", "TS2345"]);

/** Where the expected type came from, for the prose. */
type Origin =
  | { kind: "request"; call: { path: string; method: string } | null }
  | { kind: "response" }
  | { kind: "plain" };

/** The span's 0-based offset in the source, or -1. */
function spanOffset({ d, source }: RuleInput): number {
  return source && d.line && d.column ? offsetOf(source, d.line, d.column) : -1;
}

/** Is the expected type the typed API client's request, or a `defineApi` handler's result? */
function originOf(input: RuleInput, lines: readonly string[]): Origin {
  const text = [...lines, ...input.d.related.map((r) => r.message)].join("\n");
  const at = spanOffset(input);
  const call = input.source && at >= 0 ? apiCallAt(input.source, at) : null;
  if (call || /\bRequestOf</.test(text) || /\bInferEndpoint</.test(text)) {
    return { kind: "request", call };
  }
  const fromDefineApi = input.d.related.some((r) =>
    /return type of this signature/.test(r.message) && /define-api\.ts$/.test(r.file ?? "")
  );
  if (fromDefineApi || /\bApiHandlerResult</.test(text)) return { kind: "response" };
  return { kind: "plain" };
}

/** The full property path: the object-literal keys around the span, then the chain's path. */
function propertyPath(input: RuleInput, lines: readonly string[]): string[] {
  const at = spanOffset(input);
  const lexical = input.source && at >= 0 ? keyPathAt(input.source, at, input.span) : [];
  const chain = chainPath(lines);
  // A related "comes from property 'x'" names the leaf when the chain doesn't.
  if (chain.length === 0 && lexical.length === 0) {
    const prop = input.d.related.map((r) => /from property '([^']+)'/.exec(r.message)?.[1])
      .find(Boolean);
    if (prop) return [prop];
  }
  return [...lexical, ...chain];
}

/** "`a.b`", or "this value" when there's no path. */
function subject(path: readonly string[]): string {
  return path.length ? `\`${path.join(".")}\`` : "this value";
}

/** Where the expected type was declared, when TypeScript said so. */
function declaredAt(input: RuleInput): string {
  const r = input.d.related.find((r) => /declared here/.test(r.message) && r.file && r.line);
  return r ? ` (declared at ${input.display(r.file!, r.line, r.column)})` : "";
}

/** The fix line for a leaf mismatch, phrased for where the expected type came from. */
function mismatchFix(
  input: RuleInput,
  origin: Origin,
  what: string,
  pair: { actual: string; expected: string },
): string {
  const expected = shortType(pair.expected);
  const literals = stringLiteralUnion(pair.expected);
  const actualLit = stringLiteral(pair.actual);
  if (literals && actualLit !== null) {
    const near = suggest(actualLit, literals);
    return `Use one of ${literals.map((l) => `"${l}"`).join(", ")}` +
      (near ? ` — did you mean "${near}"?` : ".");
  }
  if (origin.kind === "response") {
    return `Return ${what} as \`${expected}\` — or, if \`${
      shortType(pair.actual)
    }\` is right, change the \`response\` schema.`;
  }
  if (origin.kind === "request") {
    return `Pass ${what} as \`${expected}\` — or change the route's schema if \`${
      shortType(pair.actual)
    }\` is intended.`;
  }
  return `Make ${what} a \`${expected}\`, or widen its declared type${declaredAt(input)}.`;
}

/** The sentence that says where the expectation comes from. */
function whySentence(origin: Origin, what: string, pair: { actual: string; expected: string }) {
  const actual = `\`${shortType(pair.actual)}\``;
  const expected = `\`${shortType(pair.expected)}\``;
  if (origin.kind === "response") {
    return `This \`defineApi\` handler returns ${what} as ${actual}, but the route's \`response\` ` +
      `schema says ${expected}. The handler's return value must match the schema it declares.`;
  }
  if (origin.kind === "request") {
    const route = origin.call ? ` \`${origin.call.method} ${origin.call.path}\`` : "";
    return `The typed API client checks every request against the route's own types: the` +
      `${route} route expects ${what} to be ${expected}, but this passes ${actual}.`;
  }
  return `${what[0].toUpperCase()}${what.slice(1)} is ${actual} here, but its type expects ` +
    `${expected}.`;
}

/** A missing required property somewhere in the chain. */
function missingResult(input: RuleInput, lines: readonly string[], prop: string): RuleResult {
  const path = [...propertyPath(input, lines), prop];
  return {
    title: `Missing property ${subject(path)}`,
    why: `${subject(path)} is required by the expected type, but the value given has no ` +
      `\`${prop}\`.`,
    fix: `Add \`${prop}\` to the object${declaredAt(input)}.`,
  };
}

/**
 * TS2322 / TS2345: name the single property path that mismatches and the two leaf types,
 * dropping the generic wrappers TypeScript prints on the way down.
 */
export function assignabilityRule(input: RuleInput): RuleResult | null {
  const { d } = input;
  if (!ASSIGN_CODES.has(d.code)) return null;
  const lines = [d.message, ...d.chain];
  const missing = lines.map(missingProperty).find((p) => p !== null);
  if (missing) return missingResult(input, lines, missing);
  const pair = [...lines].reverse().map(assignablePair).find((p) => p !== null);
  if (!pair || pair.expected === "never") return null;
  const origin = originOf(input, lines);
  const path = propertyPath(input, lines);
  const what = subject(path);
  return {
    title: path.length ? `Type mismatch at ${what}` : "Type mismatch",
    why: whySentence(origin, what, pair),
    fix: mismatchFix(input, origin, what, pair),
  };
}

/** The route paths a known-paths union lists (every member a string literal starting with /). */
function routeUnion(expected: string): string[] | null {
  const lits = stringLiteralUnion(expected);
  return lits && lits.every((l) => l.startsWith("/")) ? lits : null;
}

/**
 * TS2345 on a string literal against a union of string literals: a typo in a typed API
 * client path or method (or any literal union) — suggest the closest member.
 */
export function literalArgumentRule({ d }: RuleInput): RuleResult | null {
  if (d.code !== "TS2345") return null;
  const pair = assignablePair(d.message);
  const actual = pair && stringLiteral(pair.actual);
  if (!pair || actual === null) return null;
  const allowed = stringLiteralUnion(pair.expected);
  if (!allowed) return null;
  const near = suggest(actual, allowed);
  const list = allowed.slice(0, 12).map((l) => `"${l}"`).join(", ") +
    (allowed.length > 12 ? `, … (${allowed.length} in all)` : "");
  if (routeUnion(pair.expected)) {
    return {
      title: near
        ? `No API route "${actual}" — did you mean "${near}"?`
        : `No API route "${actual}"`,
      why: `The typed API client only accepts paths of routes that exist under app/ (from the ` +
        `generated .denext/api.ts). "${actual}" is not one of them.`,
      fix: near ? `Use "${near}". Known routes: ${list}.` : `Known routes: ${list}.`,
    };
  }
  return {
    title: near
      ? `"${actual}" is not allowed here — did you mean "${near}"?`
      : `"${actual}" is not allowed here`,
    why: `This parameter accepts only ${list}.`,
    fix: near ? `Use "${near}".` : `Use one of ${list}.`,
  };
}

/** TS2353 / TS2561: a key the target type doesn't have — suggest the nearest real one. */
export function excessPropertyRule(input: RuleInput): RuleResult | null {
  const { d } = input;
  if (d.code !== "TS2353" && d.code !== "TS2561") return null;
  const m = /'([^']+)' does not exist in type '(.*)'\.(?: Did you mean to write '([^']+)'\?)?$/
    .exec(d.message);
  if (!m) return null;
  const [, key, type, tsHint] = m;
  const keys = objectKeys(type);
  const near = tsHint ?? suggest(key, keys);
  const inParams = d.related.some((r) => /property 'params'/.test(r.message));
  const known = keys.length ? keys.map((k) => `\`${k}\``).join(", ") : `\`${shortType(type)}\``;
  const what = inParams ? "This route's params are" : "The expected type has";
  return {
    title: near
      ? `Unknown property \`${key}\` — did you mean \`${near}\`?`
      : `Unknown property \`${key}\``,
    why: `${what} ${known}; \`${key}\` is not one of them, and an object literal may only ` +
      `name known properties.`,
    fix: near ? `Rename \`${key}\` to \`${near}\`.` : `Remove \`${key}\`, or add it to the type.`,
  };
}
