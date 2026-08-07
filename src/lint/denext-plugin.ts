// denext lint plugin — Deno-native lint rules for denext/React-style code.
//
// Runs under `deno lint` with no npm/ESLint dependency. Wire it up via deno.json:
//   { "lint": { "plugins": ["<denext>/src/lint/denext-plugin.ts"] } }
//
// Rules:
//   denext/rules-of-hooks        Hooks must run unconditionally at the top level
//                                of a component or custom hook (not in ifs,
//                                loops, or nested callbacks).
//   denext/hooks-in-component    Hooks must be called from a Capitalized
//                                component or a `useX` custom hook.
//   denext/no-hooks-in-async     Async (server) components can't hydrate, so
//                                hooks in them have no client effect.

// deno-lint-ignore-file no-explicit-any -- ESTree nodes are loosely typed here.

/** Is a call a hook call? Matches `useX(...)` and `X.useX(...)`. */
function hookName(node: any): string | null {
  const callee = node.callee;
  if (!callee) return null;
  if (callee.type === "Identifier") {
    return /^use[A-Z0-9]/.test(callee.name) ? callee.name : null;
  }
  if (callee.type === "MemberExpression" && callee.property?.type === "Identifier") {
    return /^use[A-Z0-9]/.test(callee.property.name) ? callee.property.name : null;
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

/** Minimal shape of a Deno lint plugin (the `Deno.lint` ambient types are not
 * guaranteed to be present at type-check time across Deno versions). */
interface LintPlugin {
  name: string;
  rules: Record<string, { create(context: any): Record<string, unknown> }>;
}

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
                message:
                  `\`${hook}\` must be called inside a component (Capitalized) ` +
                  `or a custom hook (useX). [denext/hooks-in-component]`,
              });
              return;
            }
            if (controlDepth > frame.entryControlDepth) {
              context.report({
                node,
                message:
                  `\`${hook}\` is called conditionally. Hooks must run in the ` +
                  `same order on every render — call it at the top level. ` +
                  `[denext/rules-of-hooks]`,
              });
            }
            if (frame.isAsync && frame.name && /^[A-Z]/.test(frame.name)) {
              context.report({
                node,
                message:
                  `\`${hook}\` is used in async component \`${frame.name}\`. ` +
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
