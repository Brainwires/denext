// denext's own lint rules (src/lint/denext-plugin.ts), explained: the client/server boundary
// mistakes behind `directive-placement`, `rules-of-hooks`, `hooks-in-component`,
// `no-hooks-in-async` and `no-handlers-in-async`, plus the opt-in `exhaustive-switch` and
// `no-throw` that `denextLintPlugin(options)` adds.

import type { RuleInput, RuleResult } from "./types.ts";

/** The first `` `name` `` the lint message quotes (a hook, an attribute). */
function quoted(message: string, index = 0): string {
  return [...message.matchAll(/`([^`]+)`/g)][index]?.[1] ?? "";
}

/** `PageClient` → `page-client`. */
function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** The client-component split every async-component rule recommends. */
function clientSplit(component: string): string {
  const client = `${component || "Page"}Client`;
  return `Move the interactive part into its own file that starts with "use client" and render ` +
    `it from \`${component || "the page"}\`:\n` +
    `// ${kebab(client)}.tsx\n"use client";\n` +
    `export function ${client}(props: { data: string }) {\n  // hooks and handlers live here\n}\n` +
    `Data loading stays in the async Server Component, which passes it down as props.`;
}

function directivePlacement(message: string): RuleResult {
  const directive = /"(use client|use server)"/.exec(message)?.[1] ?? "use client";
  if (/both/.test(message)) {
    return {
      title: `A module can't be both "use client" and "use server"`,
      why: `"use client" makes the module run in the browser; "use server" makes its exports ` +
        `server functions. One file can't be both.`,
      fix: `Split it: keep the components in a "use client" file and move the server ` +
        `functions to a "use server" file they import.`,
    };
  }
  if (/Redundant/.test(message)) {
    return {
      title: `Duplicate "${directive}"`,
      why: `The module already opens with "${directive}"; this second copy does nothing.`,
      fix: `Delete it (\`deno lint --fix\` removes it for you).`,
    };
  }
  return {
    title: `"${directive}" is ignored where it is`,
    why: `A directive only counts as the module's first statement (comments may come before ` +
      `it). Below an import it is just a string expression, so the module silently stays ` +
      `${directive === "use client" ? "a Server Component module" : "a plain module"}.`,
    fix: `Move \`"${directive}";\` to the top of the file, above every import.`,
  };
}

function rulesOfHooks(message: string): RuleResult {
  const hook = quoted(message) || "the hook";
  const afterReturn = /after a conditional return/.test(message);
  return {
    title: afterReturn
      ? `\`${hook}\` can be skipped by an early return`
      : `\`${hook}\` is called conditionally`,
    why: `denext matches each hook to its state by call order: the third hook call on every ` +
      `render reads the third slot. A hook ${
        afterReturn ? "after an early return" : "inside an `if`, a loop or a callback"
      } runs on some renders and not others, which shifts every later hook onto the wrong state.`,
    fix: afterReturn
      ? `Move \`${hook}\` (and every other hook) above the early return.`
      : `Call \`${hook}\` unconditionally at the top level and put the condition inside it, e.g.\n` +
        `${hook}(() => {\n  if (!condition) return;\n  // …\n}, [condition]);`,
  };
}

function hooksInComponent(message: string): RuleResult {
  const hook = quoted(message) || "the hook";
  return {
    title: `\`${hook}\` is called outside a component or custom hook`,
    why: `Hooks keep state per component instance, so they only work while a component (a ` +
      `Capitalized function) or a custom hook (\`useSomething\`) renders.`,
    fix: `Call it from a component, or rename the enclosing function to \`useSomething\` if ` +
      `it is a custom hook (or to a Capitalized name if it is a component).`,
  };
}

function noHooksInAsync(message: string): RuleResult {
  const hook = quoted(message) || "the hook";
  const component = quoted(message, 1);
  return {
    title: `\`${hook}\` in an async Server Component`,
    why: `An \`async\` component is a Server Component: it renders once on the server and never ` +
      `hydrates, so state and effects in it never run in the browser.`,
    fix: clientSplit(component),
  };
}

function noHandlersInAsync(message: string): RuleResult {
  const attr = quoted(message) || "the handler";
  const component = quoted(message, 1);
  return {
    title: `\`${attr}\` in an async Server Component does nothing`,
    why: `An \`async\` component renders on the server; functions can't cross to the browser, ` +
      `so the handler is dropped and the element stays inert.`,
    fix: `${clientSplit(component)}\nOr, for a form, pass a Server Action ("use server") as its ` +
      `\`action\`.`,
  };
}

function exhaustiveSwitch(message: string): RuleResult {
  const subject = quoted(message) || "value";
  const missing = /does not handle (.+?)\. Add/.exec(message)?.[1];
  const guard =
    `default:\n  return assertNever(${subject}); // import { assertNever } from "denext/result"`;
  if (missing) {
    return {
      title: `This switch over \`${subject}\` misses ${missing}`,
      why: `\`${subject}\` is a union this file declares, and no \`case\` handles ${missing}. ` +
        `Without a \`default\`, those values fall through the switch silently.`,
      fix: `Add a \`case\` for ${missing}. To have the compiler catch the next missing case, ` +
        `end the switch with\n${guard}`,
    };
  }
  return {
    title: `This switch over \`${subject}\` may not handle every case`,
    why: `Every \`case\` is a literal and there is no \`default\`. Lint rules can't see the ` +
      `type of \`${subject}\` (it is imported or inferred), so they can't tell whether every ` +
      `member is handled.`,
    fix: `If \`${subject}\` is a union, end the switch with\n${guard}\nso a missing case becomes ` +
      `a compile error. Otherwise add a \`default\` that handles the other values.`,
  };
}

function noThrow(_message: string): RuleResult {
  return {
    title: "`throw` in a directory where failures are values",
    why: "This directory is listed in the `no-throw` option of `denextLintPlugin`, so its " +
      "functions report expected failures in their return type instead of throwing.",
    fix: 'Return `err("code")` from denext/result (with `Result<T, E>` as the return type), ' +
      "or wrap a throwing dependency in `tryAsync(() => call(), mapError)`.",
  };
}

const LINT_RULES: Readonly<Record<string, (message: string) => RuleResult>> = {
  "denext/directive-placement": directivePlacement,
  "denext/rules-of-hooks": rulesOfHooks,
  "denext/hooks-in-component": hooksInComponent,
  "denext/no-hooks-in-async": noHooksInAsync,
  "denext/no-handlers-in-async": noHandlersInAsync,
  "denext/exhaustive-switch": exhaustiveSwitch,
  "denext/no-throw": noThrow,
};

/** A denext lint rule's report, explained. */
export function lintRule({ d }: RuleInput): RuleResult | null {
  if (d.source !== "lint") return null;
  return LINT_RULES[d.code]?.(d.message) ?? null;
}
