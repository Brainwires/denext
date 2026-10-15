/**
 * The denext lint plugin — Deno-native lint rules for denext/React-style code,
 * running under `deno lint` with no ESLint/npm dependency.
 *
 * Enable it in `deno.json`:
 * ```json
 * { "lint": { "plugins": ["jsr:@denext/denext/lint-plugin"] } }
 * ```
 *
 * Rules:
 * - `denext/rules-of-hooks` — hooks must run unconditionally at the top level of
 *   a component or custom hook (not in ifs, loops, or nested callbacks, and not
 *   after a conditional early return that could skip them).
 * - `denext/hooks-in-component` — hooks must be called from a Capitalized
 *   component or a `useX` custom hook.
 * - `denext/no-hooks-in-async` — async (server) components can't hydrate, so
 *   hooks in them have no client effect.
 * - `denext/no-handlers-in-async` — a JSX `on*` handler in an async (server)
 *   component is a function that never reaches the browser: it is dropped at the
 *   server→client boundary and the element does nothing.
 * - `denext/directive-placement` — a `"use client"` / `"use server"` directive
 *   must be the module's leading statement, and a module may not declare both.
 *
 * Two more rules are **opt-in** — not in this default plugin, because they flag code that is
 * correct by design in many apps. Enable them by pointing `lint.plugins` at a module of your
 * own that exports {@linkcode denextLintPlugin}`(options)`:
 * - `denext/exhaustive-switch` — a `switch` whose cases are all literals must handle every
 *   member of the discriminant's union, or end in `default:` (ideally
 *   `default: assertNever(x)` from `denext/result`, which makes the compiler check it).
 * - `denext/no-throw` — no `throw` statements in the directories you list; return
 *   `err(...)` from `denext/result` instead.
 *
 * These are **correctness** rules: they surface bugs, not style. All but one are
 * **report-only** — `deno lint --fix` / `deno fmt` can't resolve them because the
 * fix is a semantic change only a human should make (moving a hook, redesigning an
 * async component, choosing which directive a module keeps). The single mechanical
 * exception is a **redundant duplicate** `"use client"`/`"use server"` (one already
 * leads the module): that dead copy is removed by `--fix`. See CONTRIBUTING.md for
 * how to resolve each report-only rule by hand.
 *
 * @module
 */

// deno-lint-ignore-file no-explicit-any -- ESTree nodes are loosely typed here.

/**
 * Is a call a hook call? Matches a directly-invoked `useX(...)`.
 *
 * Member calls like `dispatcher().useState()` or `x.useState()` are deliberately
 * NOT matched: denext users import hooks as bare identifiers, and matching member
 * calls would flag the framework's own dispatcher indirection.
 */
function hookName(node: any): string | null {
  const callee = node.callee;
  if (callee?.type === "Identifier" && /^use[A-Z0-9]/.test(callee.name)) {
    return callee.name;
  }
  return null;
}

/** Best-effort name of a function node (declaration, or assigned variable). */
function functionName(node: any): string | null {
  if (node.id?.name) return node.id.name;
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return parent.id.name;
  }
  if (
    parent?.type === "AssignmentExpression" &&
    parent.left?.type === "Identifier"
  ) {
    return parent.left.name;
  }
  if (parent?.type === "Property" && parent.key?.type === "Identifier") {
    return parent.key.name;
  }
  return null;
}

function isComponentOrHook(name: string | null): boolean {
  return !!name && (/^[A-Z]/.test(name) || /^use[A-Z0-9]/.test(name));
}

const CONTROL_NODES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "SwitchCase",
  "ConditionalExpression",
  "LogicalExpression",
  "TryStatement",
  "CatchClause",
]);

const FUNCTION_NODES = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
] as const;

interface FrameInfo {
  node: any;
  name: string | null;
  isAsync: boolean;
  entryControlDepth: number;
  /** A conditional `return` has been seen earlier in this function body. */
  sawConditionalReturn: boolean;
}

/**
 * Minimal shape of a Deno lint plugin. Declared locally because the `Deno.lint`
 * ambient types are not guaranteed to be present at type-check time across Deno
 * versions.
 */
export interface LintPlugin {
  /** The plugin name; rules are reported as `<name>/<rule>`. */
  name: string;
  /** Map of rule name to a rule with a `create(context)` visitor factory. */
  rules: Record<string, { create(context: any): Record<string, unknown> }>;
}

/** Is an ESTree node a string-literal expression? */
function isStringLiteral(node: any): boolean {
  return node?.type === "Literal" && typeof node.value === "string";
}

/** The boundary directives this plugin governs. */
function isBoundaryDirective(value: unknown): value is "use client" | "use server" {
  return value === "use client" || value === "use server";
}

/** The three independently-toggleable hook-lint findings. */
type HookRule = "hooks-in-component" | "rules-of-hooks" | "no-hooks-in-async";

/**
 * Build the shared hook-lint AST visitor. It performs one traversal, tracking the
 * function stack and control-flow depth, and calls `emit(rule, node, message)` for each
 * finding. Each of the three registered rules reuses this with an `emit` that forwards
 * only its own `rule` kind, so `hooks-in-component` / `rules-of-hooks` /
 * `no-hooks-in-async` can each be enabled, disabled, or `deno-lint-ignore`d on their own
 * while sharing identical detection logic (and its short-circuiting).
 */
function createHookVisitor(
  emit: (rule: HookRule, node: any, message: string) => void,
): Record<string, (node: any) => void> {
  const funcStack: FrameInfo[] = [];
  let controlDepth = 0;

  const enterFunction = (node: any) => {
    funcStack.push({
      node,
      name: functionName(node),
      isAsync: !!node.async,
      entryControlDepth: controlDepth,
      sawConditionalReturn: false,
    });
  };
  const exitFunction = () => void funcStack.pop();

  const visitor: Record<string, (node: any) => void> = {
    CallExpression(node) {
      const hook = hookName(node);
      if (!hook) return;
      const frame = funcStack[funcStack.length - 1];
      for (const [rule, message] of hookCallFindings(hook, frame, controlDepth)) {
        emit(rule, node, message);
      }
    },
  };

  // A conditional return (nested in any control structure) marks the frame:
  // hooks lexically after it may be skipped on some renders.
  visitor.ReturnStatement = (_node) => {
    const frame = funcStack[funcStack.length - 1];
    if (frame && controlDepth > frame.entryControlDepth) {
      frame.sawConditionalReturn = true;
    }
  };

  for (const fn of FUNCTION_NODES) {
    visitor[fn] = enterFunction;
    visitor[`${fn}:exit`] = exitFunction;
  }
  for (const c of CONTROL_NODES) {
    visitor[c] = () => void controlDepth++;
    visitor[`${c}:exit`] = () => void controlDepth--;
  }

  return visitor;
}

/**
 * The findings for one hook call: outside a component/custom hook (short-circuits),
 * conditional or after a conditional return, and inside an async component.
 */
function hookCallFindings(
  hook: string,
  frame: FrameInfo | undefined,
  controlDepth: number,
): Array<[HookRule, string]> {
  if (!frame || !isComponentOrHook(frame.name)) {
    return [[
      "hooks-in-component",
      `\`${hook}\` must be called inside a component (Capitalized) ` +
      `or a custom hook (useX). [denext/hooks-in-component]`,
    ]];
  }
  const out: Array<[HookRule, string]> = [];
  if (controlDepth > frame.entryControlDepth) {
    out.push([
      "rules-of-hooks",
      `\`${hook}\` is called conditionally. Hooks must run in the ` +
      `same order on every render — call it at the top level. ` +
      `[denext/rules-of-hooks]`,
    ]);
  } else if (frame.sawConditionalReturn) {
    // The hook is lexically top-level, but an earlier conditional return
    // can skip it — so it does not run in the same order every render.
    out.push([
      "rules-of-hooks",
      `\`${hook}\` is called after a conditional return, so it may ` +
      `be skipped on some renders. Call all hooks before any early ` +
      `return. [denext/rules-of-hooks]`,
    ]);
  }
  if (frame.isAsync && frame.name && /^[A-Z]/.test(frame.name)) {
    out.push([
      "no-hooks-in-async",
      `\`${hook}\` is used in async component \`${frame.name}\`. ` +
      `Async components render only on the server and never hydrate, ` +
      `so the hook has no client effect. [denext/no-hooks-in-async]`,
    ]);
  }
  return out;
}

/** Does a function body open with a `"use server"` directive (an inline server action)? */
function isInlineServerAction(fn: any): boolean {
  const first = fn?.body?.type === "BlockStatement" ? fn.body.body?.[0] : undefined;
  return first?.type === "ExpressionStatement" && isStringLiteral(first.expression) &&
    first.expression.value === "use server";
}

/** The nearest enclosing component frame (a Capitalized function), or undefined. */
function nearestComponent(
  stack: Array<{ name: string | null; isAsync: boolean }>,
): { name: string; isAsync: boolean } | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i];
    if (f.name && /^[A-Z]/.test(f.name)) return { name: f.name, isAsync: f.isAsync };
  }
  return undefined;
}

/** A JSX `on*` attribute whose value is a function expression or an identifier, else null. */
function handlerAttribute(node: any): { attr: string; expr: any } | null {
  const attr = node.name?.type === "JSXIdentifier" ? node.name.name : null;
  if (!attr || !/^on[A-Z]/.test(attr)) return null;
  const expr = node.value?.type === "JSXExpressionContainer" ? node.value.expression : null;
  return expr && FUNCTION_VALUE_NODES.has(expr.type) ? { attr, expr } : null;
}

/** JSX attribute values the handler rule reads as "a function". */
const FUNCTION_VALUE_NODES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "Identifier",
]);

function handlerMessage(attr: string, component: string): string {
  return `\`${attr}\` receives a function in async component \`${component}\`. An async ` +
    `component is a Server Component: its functions never reach the browser, so the handler ` +
    `is dropped and the element does nothing. Pass a Server Action ("use server") or move ` +
    `the handler into a "use client" component. [denext/no-handlers-in-async]`;
}

/**
 * Build the handler-lint visitor: a JSX `on*` attribute given a function inside an `async`
 * component — the server→client boundary Next reports as "Event handlers cannot be passed
 * to Client Component props", which denext turns into an element that does nothing. An
 * inline arrow/function reports at once (unless its body opens with `"use server"` — an
 * inline server action, which crosses as a reference). An identifier is resolved at
 * `Program:exit` (a function declaration hoists): one bound to a module-local function or
 * arrow without that directive reports; an imported name or an unresolved binding is left
 * alone, since it may be a server action from a `"use server"` module.
 */
function createHandlerVisitor(context: any): Record<string, (node: any) => void> {
  const funcStack: Array<{ name: string | null; isAsync: boolean }> = [];
  /** Module-local function bindings → whether the body is an inline server action. */
  const localFns = new Map<string, boolean>();
  const imported = new Set<string>();
  const pending: Array<{ node: any; attr: string; component: string; ident: string }> = [];

  const visitor: Record<string, (node: any) => void> = {
    ImportDeclaration(node) {
      for (const spec of node.specifiers ?? []) if (spec.local?.name) imported.add(spec.local.name);
    },
    JSXAttribute(node) {
      const handler = handlerAttribute(node);
      const component = nearestComponent(funcStack);
      if (!handler || !component?.isAsync) return;
      if (handler.expr.type === "Identifier") {
        pending.push({
          node,
          attr: handler.attr,
          component: component.name,
          ident: handler.expr.name,
        });
      } else if (!isInlineServerAction(handler.expr)) {
        context.report({ node, message: handlerMessage(handler.attr, component.name) });
      }
    },
    "Program:exit"() {
      for (const p of pending) {
        if (imported.has(p.ident) || localFns.get(p.ident) !== false) continue;
        context.report({ node: p.node, message: handlerMessage(p.attr, p.component) });
      }
    },
  };
  for (const fn of FUNCTION_NODES) {
    visitor[fn] = (node) => {
      const name = functionName(node);
      if (name) localFns.set(name, isInlineServerAction(node));
      funcStack.push({ name, isAsync: !!node.async });
    };
    visitor[`${fn}:exit`] = () => void funcStack.pop();
  }
  return visitor;
}

/** A hook rule that reports only findings of its own `rule` kind (shared traversal). */
function hookRule(rule: HookRule): { create(context: any): Record<string, unknown> } {
  return {
    create(context) {
      return createHookVisitor((kind, node, message) => {
        if (kind === rule) context.report({ node, message });
      });
    },
  };
}

/**
 * The leading directive prologue: the run of string-literal ExpressionStatements at the
 * very top of the module, and which boundary directives it declares.
 */
function leadingPrologue(body: any[]): { leading: Set<any>; leadingKinds: Set<string> } {
  const leading = new Set<any>();
  const leadingKinds = new Set<string>();
  for (const stmt of body) {
    if (stmt.type !== "ExpressionStatement" || !isStringLiteral(stmt.expression)) break;
    leading.add(stmt);
    if (isBoundaryDirective(stmt.expression.value)) leadingKinds.add(stmt.expression.value);
  }
  return { leading, leadingKinds };
}

/** A module cannot be both a client and a server module. */
function reportConflictingDirectives(
  context: any,
  body: any[],
  leading: Set<any>,
  leadingKinds: Set<string>,
): void {
  if (!leadingKinds.has("use client") || !leadingKinds.has("use server")) return;
  const second = body.find((s) =>
    leading.has(s) && isBoundaryDirective(s.expression.value) &&
    s.expression.value === "use server"
  );
  if (second) {
    context.report({
      node: second,
      message: `A module cannot declare both "use client" and "use server". ` +
        `[denext/directive-placement]`,
    });
  }
}

/** A boundary directive outside the leading prologue (silently ignored at runtime). */
function isMisplacedDirective(stmt: any, leading: Set<any>): boolean {
  return stmt.type === "ExpressionStatement" && isStringLiteral(stmt.expression) &&
    isBoundaryDirective(stmt.expression.value) && !leading.has(stmt);
}

/**
 * Flag a misplaced directive so it is not mistaken for effective. When the same
 * directive already leads the module and is in effect, this one is dead code — removing
 * it is behavior-preserving, which is the bar for an auto-fix (`--fix` applies it). A
 * lone misplaced directive stays report-only: hoisting it (changes the module's
 * client/server boundary) and removing it (drops the author's intent) BOTH change
 * behavior, so a human must decide.
 */
function reportMisplacedDirective(context: any, stmt: any, leadingKinds: Set<string>): void {
  const value = stmt.expression.value;
  if (leadingKinds.has(value)) {
    context.report({
      node: stmt,
      message: `Redundant "${value}" — the module's leading directive ` +
        `already applies; remove this one. [denext/directive-placement]`,
      fix(fixer: any) {
        return fixer.remove(stmt);
      },
    });
  } else {
    context.report({
      node: stmt,
      message: `"${value}" must be the module's leading statement to ` +
        `take effect. [denext/directive-placement]`,
    });
  }
}

// ── exhaustive-switch ────────────────────────────────────────────────────────

/** The comparable key of a literal value (`"string:a"`, `"number:1"`, `"null"`). */
function literalKey(value: unknown): string {
  return value === null ? "null" : `${typeof value}:${String(value)}`;
}

/** A readable form of a literal key for a message (`"a"`, `1`, `null`). */
function showKey(key: string): string {
  const at = key.indexOf(":");
  if (at < 0) return key;
  const [kind, raw] = [key.slice(0, at), key.slice(at + 1)];
  return kind === "string" ? JSON.stringify(raw) : raw;
}

/** The name of an `Identifier` node, else null. */
function identName(node: any): string | null {
  return node && node.type === "Identifier" ? node.name : null;
}

/** Map every item to its keys, or null as soon as one maps to null. */
function flatAll(items: readonly any[], keysOf: (item: any) => string[] | null): string[] | null {
  const out: string[] = [];
  for (const item of items) {
    const keys = keysOf(item);
    if (!keys) return null;
    out.push(...keys);
  }
  return out;
}

/** A plain literal's key (`"a"`, `1`, `true`, `null`), else null (a regex or bigint). */
function plainLiteralKey(node: any): string | null {
  const plain = node.type === "Literal" && !node.regex && typeof node.value !== "bigint";
  return plain ? literalKey(node.value) : null;
}

/** The literal key of a `case` test, or null when it is not a plain literal. */
function caseKey(test: any): string | null {
  if (!test) return null;
  if (identName(test) === "undefined") return "undefined";
  if (test.type === "TemplateLiteral" && test.expressions.length === 0) {
    return literalKey(test.quasis[0].value.cooked);
  }
  return plainLiteralKey(test);
}

/** What the file declares that the switch rule can resolve: type aliases and annotated names. */
interface TypeIndex {
  aliases: Map<string, any>;
  /** Name → its type annotation, or `null` when the name is annotated more than once. */
  annotations: Map<string, any | null>;
}

const KEYWORD_MEMBERS: Record<string, string[]> = {
  TSNullKeyword: ["null"],
  TSUndefinedKeyword: ["undefined"],
  TSBooleanKeyword: ["boolean:true", "boolean:false"],
};

/** The local, non-generic alias a type reference names, or null. */
function aliasTarget(ref: any, index: TypeIndex): any {
  const name = identName(ref.typeName);
  if (!name || ref.typeArguments) return null;
  return index.aliases.get(name) ?? null;
}

/** Follow local type alias references (bounded, so a cyclic alias can't loop). */
function derefAlias(type: any, index: TypeIndex): any {
  let t = type;
  for (let hops = 0; t && t.type === "TSTypeReference"; hops++) {
    if (hops === 8) return null;
    t = aliasTarget(t, index);
  }
  return t ?? null;
}

/** The members of a literal union type node, or null when it isn't one the file spells out. */
function literalMembers(type: any, index: TypeIndex, depth = 0): string[] | null {
  const t = derefAlias(type, index);
  if (!t || depth > 8) return null;
  if (t.type === "TSLiteralType") {
    const key = plainLiteralKey(t.literal);
    return key ? [key] : null;
  }
  if (t.type === "TSUnionType") {
    return flatAll(t.types, (member) => literalMembers(member, index, depth + 1));
  }
  return KEYWORD_MEMBERS[t.type] ?? null;
}

/** The type of property `prop` declared in an object type literal, or null. */
function propertyType(obj: any, prop: string): any {
  if (!obj || obj.type !== "TSTypeLiteral") return null;
  const sig = obj.members.find((m: any) =>
    m.type === "TSPropertySignature" && identName(m.key) === prop
  );
  return sig?.typeAnnotation?.typeAnnotation ?? null;
}

/** The literal members of property `prop` across an object-union type node. */
function propertyMembers(type: any, prop: string, index: TypeIndex): string[] | null {
  const t = derefAlias(type, index);
  if (!t) return null;
  const objects = t.type === "TSUnionType" ? t.types : [t];
  return flatAll(objects, (raw) => {
    const propType = propertyType(derefAlias(raw, index), prop);
    return propType ? literalMembers(propType, index) : null;
  });
}

/** The literal members a switch discriminant can take, when the file declares them. */
function discriminantMembers(disc: any, index: TypeIndex): string[] | null {
  const name = identName(disc);
  if (name) {
    const ann = index.annotations.get(name);
    return ann ? literalMembers(ann, index) : null;
  }
  if (disc.type !== "MemberExpression" || disc.computed) return null;
  const object = identName(disc.object);
  const prop = identName(disc.property);
  const ann = object && prop ? index.annotations.get(object) : null;
  return ann ? propertyMembers(ann, prop!, index) : null;
}

/** The source text of a short discriminant (`s`, `shape.kind`) for a message. */
function discriminantText(disc: any): string {
  if (disc?.type === "Identifier") return disc.name;
  if (disc?.type === "MemberExpression" && !disc.computed) {
    return `${discriminantText(disc.object)}.${disc.property?.name ?? "?"}`;
  }
  return "value";
}

/** Report a literal-case switch with no `default` that misses (or may miss) a member. */
function checkSwitch(context: any, node: any, index: TypeIndex): void {
  const cases: any[] = node.cases ?? [];
  if (cases.length === 0 || cases.some((c) => c.test === null)) return;
  const covered = cases.map((c) => caseKey(c.test));
  if (covered.some((k) => k === null)) return;
  const text = discriminantText(node.discriminant);
  const members = discriminantMembers(node.discriminant, index);
  if (members) {
    const missing = [...new Set(members)].filter((m) => !covered.includes(m));
    if (missing.length === 0) return;
    context.report({
      node,
      message: `This switch over \`${text}\` does not handle ${missing.map(showKey).join(", ")}. ` +
        `Add the missing case(s), or \`default: assertNever(${text})\` (denext/result) so the ` +
        `compiler checks it. [denext/exhaustive-switch]`,
    });
    return;
  }
  context.report({
    node,
    message: `This switch over \`${text}\` has only literal cases and no \`default\`. ` +
      `If \`${text}\` is a union, end it with \`default: assertNever(${text})\` (denext/result) ` +
      `so a missing case is a compile error; otherwise add a \`default\`. ` +
      `[denext/exhaustive-switch]`,
  });
}

/**
 * The exhaustive-switch visitor. Deno's lint plugins see syntax only (no type checker), so
 * the members of a discriminant are known only when this FILE spells them out: an
 * identifier or `x.prop` whose annotation is a literal union, or a local type alias of one
 * (object members with a literal `prop`). Then a missing member is named. Anything else
 * (an imported type, an inferred one, an enum) falls back to requiring a `default`, where
 * `assertNever(x)` hands the real check to the compiler.
 */
function createExhaustiveSwitchVisitor(context: any): Record<string, (node: any) => void> {
  const index: TypeIndex = { aliases: new Map(), annotations: new Map() };
  const switches: any[] = [];
  return {
    TSTypeAliasDeclaration(node) {
      if (node.id?.name && !node.typeParameters) {
        index.aliases.set(node.id.name, node.typeAnnotation);
      }
    },
    Identifier(node) {
      const ann = node.typeAnnotation?.typeAnnotation;
      if (!ann || !node.name) return;
      index.annotations.set(node.name, index.annotations.has(node.name) ? null : ann);
    },
    SwitchStatement(node) {
      switches.push(node);
    },
    "Program:exit"() {
      for (const node of switches) checkSwitch(context, node, index);
    },
  };
}

// ── no-throw ─────────────────────────────────────────────────────────────────

/** Options for `denext/no-throw`. */
export interface NoThrowOptions {
  /**
   * The directories (path segments relative to the project, like `"lib/domain"` or
   * `"app/api"`) whose files may not `throw`. A file is checked when its path contains the
   * segment sequence; no glob syntax.
   */
  include: string[];
}

/** Normalize a path for segment matching: forward slashes, wrapped in `/…/`. */
function segmentPath(path: string): string {
  return `/${path.replaceAll("\\", "/").replace(/^\.?\/+|\/+$/g, "")}/`;
}

/** Does `filename` sit under one of the `include` directories? */
function inIncludedDir(filename: string, include: readonly string[]): boolean {
  const file = segmentPath(filename);
  return include.some((dir) => file.includes(segmentPath(dir)));
}

/** The no-throw visitor: every `throw` statement in an included directory. */
function createNoThrowVisitor(
  context: any,
  options: NoThrowOptions,
): Record<string, (node: any) => void> {
  if (!inIncludedDir(String(context.filename ?? ""), options.include)) return {};
  return {
    ThrowStatement(node) {
      context.report({
        node,
        message: "`throw` in a no-throw directory. Return a failure instead — `err(...)` from " +
          "denext/result (or `tryAsync` around a throwing call). [denext/no-throw]",
      });
    },
  };
}

/** Options for {@linkcode denextLintPlugin}: the opt-in rules to add to the default set. */
export interface DenextLintOptions {
  /** Add `denext/exhaustive-switch`. */
  exhaustiveSwitch?: boolean;
  /** Add `denext/no-throw` for the listed directories. */
  noThrow?: NoThrowOptions;
}

/** The denext lint plugin instance. Referenced by `deno.json`'s `lint.plugins`. */
const plugin: LintPlugin = {
  name: "denext",
  rules: {
    "directive-placement": {
      create(context) {
        return {
          Program(node: any) {
            const body: any[] = node.body ?? [];
            const { leading, leadingKinds } = leadingPrologue(body);
            reportConflictingDirectives(context, body, leading, leadingKinds);
            for (const stmt of body) {
              if (isMisplacedDirective(stmt, leading)) {
                reportMisplacedDirective(context, stmt, leadingKinds);
              }
            }
          },
        };
      },
    },
    // Three independent hook rules over one shared traversal, so each can be enabled,
    // disabled, or `deno-lint-ignore`d on its own.
    "rules-of-hooks": hookRule("rules-of-hooks"),
    "hooks-in-component": hookRule("hooks-in-component"),
    "no-hooks-in-async": hookRule("no-hooks-in-async"),
    // The handler twin of no-hooks-in-async: a function given to a JSX `on*` prop never
    // leaves an async (server) component.
    "no-handlers-in-async": { create: createHandlerVisitor },
  },
};

/**
 * The denext lint plugin with opt-in rules added. Export it from a module of your own and list
 * that module in `deno.json`'s `lint.plugins` (instead of the plain plugin):
 *
 * ```ts
 * // lint/denext.ts
 * import { denextLintPlugin } from "jsr:@denext/denext/lint-plugin";
 * export default denextLintPlugin({
 *   exhaustiveSwitch: true,
 *   noThrow: { include: ["lib/domain", "app/api"] },
 * });
 * ```
 *
 * @param options Which opt-in rules to add.
 * @returns A plugin named `denext` with the default rules plus the chosen ones.
 */
export function denextLintPlugin(options: DenextLintOptions = {}): LintPlugin {
  const rules: LintPlugin["rules"] = { ...plugin.rules };
  if (options.exhaustiveSwitch) {
    rules["exhaustive-switch"] = { create: createExhaustiveSwitchVisitor };
  }
  const noThrow = options.noThrow;
  if (noThrow && noThrow.include.length > 0) {
    rules["no-throw"] = { create: (context) => createNoThrowVisitor(context, noThrow) };
  }
  return { name: plugin.name, rules };
}

export default plugin;
