// React Native mode: warn at build time where app code uses a native module method's result
// as if the call were synchronous.
//
// On denext a native module (a TurboModule / `NativeModules.X` / Expo's `requireNativeModule`)
// is served over Capacitor's (or the desktop runtime's) asynchronous bridge: every method
// returns a Promise, and there is no JSI to serve a synchronous one. A call site written for a
// synchronous method (`const n = NativeCalc.add(1, 2); setTotal(n + 1)`) builds and runs, but
// computes with a Promise. This pass finds those call sites in the app's own source (not
// node_modules) and reports each as an esbuild warning with its file:line.
//
// What counts as a native module reference, per module:
//   - a binding initialised from `TurboModuleRegistry.get(…)` / `getEnforcing(…)`,
//     `requireNativeModule(…)` / `requireOptionalNativeModule(…)` or `NativeModules.X`, or
//     destructured from `NativeModules` (`const { X } = NativeModules`);
//   - the default import of a module named `Native<Name>` (the codegen spec convention:
//     `import NativeCalc from "./NativeCalc"`);
//   - `NativeModules.X` and `TurboModuleRegistry.getEnforcing(…)` used inline.
// A call `ref.method(…)` (or `ref?.method(…)`) is fine when it is awaited, returned, chained
// with `.then` / `.catch` / `.finally`, a statement of its own (fire and forget), `void`-ed,
// yielded, an element of an array passed to `Promise.all` / `allSettled` / `race` / `any`, an
// argument of `Promise.resolve` / React's `use`, or assigned to a variable that is later used
// one of those ways. Anything else (arithmetic, a property read, a condition, JSX, a
// non-Promise argument) is reported. `addListener` / `removeListeners` are never reported.
//
// The pass never changes a module: its esbuild `onLoad` returns only warnings (no contents), so
// the next loader still runs. A module it cannot parse is skipped.

import { SEPARATOR } from "@std/path";
import type * as esbuild from "esbuild";
import { lineIndex, type Node, positionAt, txt } from "./swc-ast.ts";
import { parseModuleForPath } from "./swc-parse.ts";

/** A module the pass looks at: it names one of the native module entry points. */
const NATIVE_SCAN_GATE =
  /TurboModuleRegistry|NativeModules|requireNativeModule|requireOptionalNativeModule|["'][^"'\n]*\bNative[A-Z]\w*(?:\.[cm]?[jt]sx?)?["']/;

/** One reported call site. */
export interface NativeSyncUse {
  /** 1-based line. */
  readonly line: number;
  /** 1-based column (UTF-16 units). */
  readonly column: number;
  /** The source line. */
  readonly lineText: string;
  /** The warning. */
  readonly text: string;
}

/** Expressions a value passes through unchanged. */
const TRANSPARENT: ReadonlySet<string> = new Set([
  "ParenthesisExpression",
  "TsAsExpression",
  "TsNonNullExpression",
  "TsSatisfiesExpression",
  "TsTypeAssertion",
  "TsConstAssertion",
  "OptionalChainingExpression",
]);

/** Members of a native module that are never calls into native code. */
const NOT_NATIVE_CALLS: ReadonlySet<string> = new Set(["addListener", "removeListeners"]);

/** `Promise.<m>` statics that take promises. */
const PROMISE_COMBINATORS: ReadonlySet<string> = new Set([
  "all",
  "allSettled",
  "race",
  "any",
  "resolve",
]);

/** Strip {@linkcode TRANSPARENT} wrappers. */
function unwrap(node: Node): Node {
  let n = node;
  while (n && TRANSPARENT.has(n.type)) n = n.expression ?? n.base;
  return n;
}

/** `obj.prop` with an identifier object and property: `[obj, prop]`, else undefined. */
function memberNames(node: Node): [string, string] | undefined {
  const n = unwrap(node);
  if (n?.type !== "MemberExpression") return undefined;
  const obj = unwrap(n.object);
  if (obj?.type !== "Identifier" || n.property?.type !== "Identifier") return undefined;
  return [obj.value, n.property.value];
}

/** Whether `node` is a call that yields a native module (`getEnforcing('X')` …). */
function isModuleLookup(node: Node): boolean {
  const n = unwrap(node);
  if (n?.type !== "CallExpression") return false;
  const callee = unwrap(n.callee);
  if (callee?.type === "Identifier") {
    return callee.value === "requireNativeModule" || callee.value === "requireOptionalNativeModule";
  }
  const names = memberNames(callee);
  return names !== undefined && names[0] === "TurboModuleRegistry" &&
    (names[1] === "get" || names[1] === "getEnforcing");
}

/** Whether `node` is `NativeModules.X`. */
function isNativeModulesMember(node: Node): boolean {
  return memberNames(node)?.[0] === "NativeModules";
}

/** Whether `node` (a callee's object) refers to a native module, given the bound names. */
function isModuleRef(node: Node, bound: ReadonlySet<string>): boolean {
  const n = unwrap(node);
  if (n?.type === "Identifier") return bound.has(n.value);
  return isNativeModulesMember(n) || isModuleLookup(n);
}

/** The `Native<Name>` basename convention of a codegen spec module. */
function isSpecModule(source: string): boolean {
  const base = source.split("/").pop() ?? "";
  return /^Native[A-Z]\w*(?:\.[cm]?[jt]sx?)?$/.test(base);
}

/** Visit every typed node with its typed ancestors (nearest last). */
function walk(node: Node, ancestors: Node[], visit: (n: Node, ancestors: Node[]) => void): void {
  if (!node || typeof node !== "object") return;
  const typed = typeof node.type === "string";
  if (typed) visit(node, ancestors);
  if (typed) ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === "span") continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) walk(c, ancestors, visit); }
    else if (v && typeof v === "object") walk(v, ancestors, visit);
  }
  if (typed) ancestors.pop();
}

/** The names bound to native modules in the module. */
function boundModules(body: Node[]): Set<string> {
  const bound = new Set<string>();
  for (const item of body) {
    if (item.type === "ImportDeclaration" && isSpecModule(item.source?.value ?? "")) {
      for (const spec of item.specifiers ?? []) {
        if (spec.type === "ImportDefaultSpecifier") bound.add(spec.local.value);
      }
    }
  }
  walk({ body }, [], (n) => {
    if (n.type !== "VariableDeclarator" || !n.init) return;
    if (n.id?.type === "Identifier" && (isModuleLookup(n.init) || isNativeModulesMember(n.init))) {
      bound.add(n.id.value);
    } else if (
      n.id?.type === "ObjectPattern" && unwrap(n.init)?.type === "Identifier" &&
      unwrap(n.init).value === "NativeModules"
    ) {
      for (const p of n.id.properties) {
        if (p.type === "AssignmentPatternProperty") bound.add(p.key.value);
        else if (p.type === "KeyValuePatternProperty" && p.value?.type === "Identifier") {
          bound.add(p.value.value);
        }
      }
    }
  });
  return bound;
}

/** Whether `callee` is `Promise.<combinator>` or React's `use`. */
function takesPromises(callee: Node): boolean {
  const c = unwrap(callee);
  if (c?.type === "Identifier") return c.value === "use";
  const names = memberNames(c);
  return names !== undefined && names[0] === "Promise" && PROMISE_COMBINATORS.has(names[1]);
}

/** How a Promise-valued expression is used. */
type Use = "async" | "sync" | { variable: string };

/** Whether `node` is an argument of the call `call`. */
function isArgumentOf(call: Node, node: Node): boolean {
  return (call.type === "CallExpression" || call.type === "NewExpression") &&
    (call.arguments ?? []).some((a: Node) => a?.expression === node);
}

/** A rule's answer: a use, or `"up"` to keep climbing (the value passes through `parent`). */
type Step = Use | "up";

/** How a parent of a given type uses its child `child` (`grand` is the parent's own parent). */
type Rule = (parent: Node, child: Node, grand: Node | undefined) => Step;

const asyncUse: Rule = () => "async";

/** `.then` / `.catch` / `.finally` read off the Promise. */
const PROMISE_CHAIN: ReadonlySet<string> = new Set(["then", "catch", "finally"]);

/** The parent types {@linkcode classify} knows; any other parent is a synchronous use. */
const RULES: Readonly<Record<string, Rule>> = {
  AwaitExpression: asyncUse,
  ReturnStatement: asyncUse,
  ExpressionStatement: asyncUse,
  YieldExpression: asyncUse,
  UnaryExpression: (p) => p.operator === "void" ? "async" : "sync",
  ArrowFunctionExpression: (p, c) => p.body === c ? "async" : "sync",
  MemberExpression: (p, c) =>
    p.object === c && p.property?.type === "Identifier" && PROMISE_CHAIN.has(p.property.value)
      ? "async"
      : "sync",
  ConditionalExpression: (p, c) => p.test === c ? "sync" : "up",
  LogicalExpression: (p, c) => p.right === c ? "up" : "sync",
  SequenceExpression: (p, c) => p.expressions[p.expressions.length - 1] === c ? "up" : "async",
  ArrayExpression: (p, _c, g) =>
    g && isArgumentOf(g, p) && takesPromises(g.callee) ? "async" : "sync",
  CallExpression: (p, c) => isArgumentOf(p, c) && takesPromises(p.callee) ? "async" : "sync",
  NewExpression: (p, c) => isArgumentOf(p, c) && takesPromises(p.callee) ? "async" : "sync",
  VariableDeclarator: (p, c) =>
    p.init === c && p.id?.type === "Identifier" ? { variable: p.id.value } : "sync",
};

/** Classify the use of the Promise `node` (whose typed ancestors are `ancestors`). */
function classify(node: Node, ancestors: readonly Node[]): Use {
  let child = node;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i];
    const rule = TRANSPARENT.has(parent.type) ? () => "up" as const : RULES[parent.type];
    const step = rule ? rule(parent, child, ancestors[i - 1]) : "sync";
    if (step !== "up") return step;
    child = parent;
  }
  return "sync";
}

/** A reported native call: the call node and its `Name.method` label. */
interface NativeCall {
  readonly node: Node;
  readonly label: string;
  readonly use: Use;
}

/** `ref.method` as a label (`NativeCalc.add`, `NativeModules.Calc.add`). */
function labelOf(member: Node, ctxText: (n: Node) => string): string {
  const obj = unwrap(member.object);
  const head = obj?.type === "Identifier" ? obj.value : ctxText(obj).replace(/\s+/g, "");
  return `${head}.${member.property.value}`;
}

/**
 * The native module calls in `source` whose result is used as if the call were synchronous.
 *
 * @param source The module source.
 * @param path Its path (the dialect comes from the extension).
 * @returns One diagnostic per reported call, in source order.
 */
export async function scanNativeModuleSyncUse(
  source: string,
  path: string,
): Promise<NativeSyncUse[]> {
  if (!NATIVE_SCAN_GATE.test(source)) return [];
  const parsed = await parseModuleForPath(path, source);
  if (!parsed) return [];
  const { bytes, base } = parsed.ctx;
  const items = parsed.body;
  const text = (n: Node) => txt(parsed.ctx, n);
  const bound = boundModules(items);
  const calls: NativeCall[] = [];
  const variableUses = new Map<string, Use[]>();
  walk({ body: items }, [], (n, ancestors) => {
    if (n.type === "Identifier") {
      const parent = ancestors[ancestors.length - 1];
      // A reference (not a declaration or a property key) to a variable holding a call result.
      if (parent && !(parent.type === "VariableDeclarator" && parent.id === n)) {
        if (!(parent.type === "MemberExpression" && parent.property === n)) {
          const list = variableUses.get(n.value) ?? [];
          list.push(classify(n, ancestors));
          variableUses.set(n.value, list);
        }
      }
      return;
    }
    if (n.type !== "CallExpression") return;
    const callee = unwrap(n.callee);
    if (callee?.type !== "MemberExpression" || callee.property?.type !== "Identifier") return;
    if (NOT_NATIVE_CALLS.has(callee.property.value)) return;
    if (!isModuleRef(callee.object, bound)) return;
    calls.push({ node: n, label: labelOf(callee, text), use: classify(n, ancestors) });
  });
  const index = lineIndex(bytes);
  const out: NativeSyncUse[] = [];
  for (const call of calls) {
    let sync = call.use === "sync";
    if (typeof call.use === "object") {
      const uses = variableUses.get(call.use.variable) ?? [];
      sync = uses.length > 0 && uses.every((u) => u === "sync");
    }
    if (!sync) continue;
    const at = call.node.span.start - base;
    const { line, column } = positionAt(bytes, index, at);
    const start = index[line - 1];
    const end = line < index.length ? index[line] - 1 : bytes.length;
    out.push({
      line,
      column,
      lineText: new TextDecoder().decode(bytes.subarray(start, end)).replace(/\r$/, ""),
      text: `denext reactNative: ${call.label}() calls into native code, which is asynchronous ` +
        "on denext (a Capacitor plugin or desktop extension; there is no JSI), so it returns a " +
        "Promise, but its result is used here as a value. Await it (`await " + call.label +
        "(…)`) or chain `.then`.",
    });
  }
  return out;
}

/** App modules the pass reads. */
const MODULE_FILTER = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Whether `path` is inside `dir`. */
function inside(path: string, dir: string): boolean {
  return path.startsWith(dir.endsWith(SEPARATOR) ? dir : dir + SEPARATOR);
}

/**
 * The esbuild plugin that reports {@linkcode scanNativeModuleSyncUse}'s findings for the app's
 * own modules (under `projectDir`, outside node_modules) as build warnings. It returns no
 * contents, so every module still loads through the loaders after it.
 *
 * @param projectDir The app root.
 * @returns The plugin.
 */
export function nativeModuleScanPlugin(projectDir: string): esbuild.Plugin {
  return {
    name: "denext-native-module-scan",
    setup(build) {
      build.onLoad({ filter: MODULE_FILTER, namespace: "file" }, async (args) => {
        if (args.path.includes(`${SEPARATOR}node_modules${SEPARATOR}`)) return undefined;
        if (!inside(args.path, projectDir)) return undefined;
        let source: string;
        try {
          source = await Deno.readTextFile(args.path);
        } catch {
          return undefined;
        }
        const found = await scanNativeModuleSyncUse(source, args.path);
        if (found.length === 0) return undefined;
        return {
          warnings: found.map((d) => ({
            text: d.text,
            location: { file: args.path, line: d.line, column: d.column - 1, lineText: d.lineText },
          })),
        };
      });
    },
  };
}
