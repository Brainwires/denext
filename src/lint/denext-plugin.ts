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
 * - `denext/directive-placement` — a `"use client"` / `"use server"` directive
 *   must be the module's leading statement, and a module may not declare both.
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

      if (!frame || !isComponentOrHook(frame.name)) {
        emit(
          "hooks-in-component",
          node,
          `\`${hook}\` must be called inside a component (Capitalized) ` +
            `or a custom hook (useX). [denext/hooks-in-component]`,
        );
        return;
      }
      if (controlDepth > frame.entryControlDepth) {
        emit(
          "rules-of-hooks",
          node,
          `\`${hook}\` is called conditionally. Hooks must run in the ` +
            `same order on every render — call it at the top level. ` +
            `[denext/rules-of-hooks]`,
        );
      } else if (frame.sawConditionalReturn) {
        // The hook is lexically top-level, but an earlier conditional return
        // can skip it — so it does not run in the same order every render.
        emit(
          "rules-of-hooks",
          node,
          `\`${hook}\` is called after a conditional return, so it may ` +
            `be skipped on some renders. Call all hooks before any early ` +
            `return. [denext/rules-of-hooks]`,
        );
      }
      if (frame.isAsync && frame.name && /^[A-Z]/.test(frame.name)) {
        emit(
          "no-hooks-in-async",
          node,
          `\`${hook}\` is used in async component \`${frame.name}\`. ` +
            `Async components render only on the server and never hydrate, ` +
            `so the hook has no client effect. [denext/no-hooks-in-async]`,
        );
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

/** The denext lint plugin instance. Referenced by `deno.json`'s `lint.plugins`. */
const plugin: LintPlugin = {
  name: "denext",
  rules: {
    "directive-placement": {
      create(context) {
        return {
          Program(node: any) {
            const body: any[] = node.body ?? [];

            // The leading directive prologue: the run of string-literal
            // ExpressionStatements at the very top of the module.
            const leading = new Set<any>();
            const leadingKinds = new Set<string>();
            for (const stmt of body) {
              if (stmt.type === "ExpressionStatement" && isStringLiteral(stmt.expression)) {
                leading.add(stmt);
                if (isBoundaryDirective(stmt.expression.value)) {
                  leadingKinds.add(stmt.expression.value);
                }
              } else {
                break;
              }
            }

            // A module cannot be both a client and a server module.
            if (leadingKinds.has("use client") && leadingKinds.has("use server")) {
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

            // A boundary directive not in the leading prologue is silently
            // ignored at runtime — flag it so it is not mistaken for effective.
            for (const stmt of body) {
              if (
                stmt.type === "ExpressionStatement" &&
                isStringLiteral(stmt.expression) &&
                isBoundaryDirective(stmt.expression.value) &&
                !leading.has(stmt)
              ) {
                const value = stmt.expression.value;
                if (leadingKinds.has(value)) {
                  // The same directive already leads the module and is in effect,
                  // so this one is dead code — removing it is behavior-preserving,
                  // which is the bar for an auto-fix. `--fix` can apply it.
                  context.report({
                    node: stmt,
                    message: `Redundant "${value}" — the module's leading directive ` +
                      `already applies; remove this one. [denext/directive-placement]`,
                    fix(fixer: any) {
                      return fixer.remove(stmt);
                    },
                  });
                } else {
                  // A lone misplaced directive is silently ignored at runtime.
                  // Hoisting it (changes the module's client/server boundary) and
                  // removing it (drops the author's intent) BOTH change behavior,
                  // so this stays report-only — a human must decide.
                  context.report({
                    node: stmt,
                    message: `"${value}" must be the module's leading statement to ` +
                      `take effect. [denext/directive-placement]`,
                  });
                }
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
  },
};

export default plugin;
