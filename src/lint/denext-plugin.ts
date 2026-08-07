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
 *   a component or custom hook (not in ifs, loops, or nested callbacks).
 * - `denext/hooks-in-component` — hooks must be called from a Capitalized
 *   component or a `useX` custom hook.
 * - `denext/no-hooks-in-async` — async (server) components can't hydrate, so
 *   hooks in them have no client effect.
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

/** The denext lint plugin instance. Referenced by `deno.json`'s `lint.plugins`. */
const plugin: LintPlugin = {
  name: "denext",
  rules: {
    "rules-of-hooks": {
      create(context) {
        const funcStack: FrameInfo[] = [];
        let controlDepth = 0;

        const enterFunction = (node: any) => {
          funcStack.push({
            node,
            name: functionName(node),
            isAsync: !!node.async,
            entryControlDepth: controlDepth,
          });
        };
        const exitFunction = () => void funcStack.pop();

        const visitor: Record<string, (node: any) => void> = {
          CallExpression(node) {
            const hook = hookName(node);
            if (!hook) return;
            const frame = funcStack[funcStack.length - 1];

            if (!frame || !isComponentOrHook(frame.name)) {
              context.report({
                node,
                message: `\`${hook}\` must be called inside a component (Capitalized) ` +
                  `or a custom hook (useX). [denext/hooks-in-component]`,
              });
              return;
            }
            if (controlDepth > frame.entryControlDepth) {
              context.report({
                node,
                message: `\`${hook}\` is called conditionally. Hooks must run in the ` +
                  `same order on every render — call it at the top level. ` +
                  `[denext/rules-of-hooks]`,
              });
            }
            if (frame.isAsync && frame.name && /^[A-Z]/.test(frame.name)) {
              context.report({
                node,
                message: `\`${hook}\` is used in async component \`${frame.name}\`. ` +
                  `Async components render only on the server and never hydrate, ` +
                  `so the hook has no client effect. [denext/no-hooks-in-async]`,
              });
            }
          },
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
      },
    },
  },
};

export default plugin;
