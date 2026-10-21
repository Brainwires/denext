// Compiler configuration: an option TypeScript 7 removed (TypeScript 6 deprecated it), and a JSX
// runtime that doesn't resolve (`compilerOptions.jsxImportSource`) with the JSX types it takes.

import type { RuleInput, RuleResult } from "./types.ts";

/** TS5101 / TS5107 (deprecated in TypeScript 6), TS5102 / TS5108 (removed in TypeScript 7). */
const OPTION_CODES = new Set(["TS5101", "TS5102", "TS5107", "TS5108"]);

/** What to do about each removed option, by name (and value, lowercased, where it matters). */
function optionFix(name: string, value: string | undefined): string {
  switch (name) {
    case "baseUrl":
      return "Delete `baseUrl` from tsconfig.json and start each `paths` target with `./` " +
        "(relative to tsconfig.json). A bare import that only `baseUrl` resolved needs an " +
        "entry in deno.json `imports`.";
    case "moduleResolution":
      return 'Set `"moduleResolution": "bundler"`, or delete it.';
    case "target":
      return 'Delete `target`, or set `"ES2017"` or later.';
    case "module":
      return 'Delete `module`, or set `"esnext"`.';
    case "esModuleInterop":
    case "allowSyntheticDefaultImports":
    case "alwaysStrict":
      return `Delete \`${name}\` (it can no longer be \`false\`).`;
    default:
      return `Delete \`${name}${value ? `: ${value}` : ""}\` from tsconfig.json.`;
  }
}

/**
 * An option TypeScript 7 removed: TS5102 / TS5108 stop the whole check (no type error is reported
 * until the option goes), and TypeScript 6 warns of them as TS5101 / TS5107.
 */
export function removedOptionRule({ d }: RuleInput): RuleResult | null {
  if (!OPTION_CODES.has(d.code)) return null;
  const m = /^Option '([\w.]+)(?:=([^']+))?' (?:has been removed|is deprecated)/.exec(d.message);
  if (!m) return null;
  const [, name, value] = m;
  const removed = d.code === "TS5102" || d.code === "TS5108";
  const shown = value ? `${name}: ${value}` : name;
  return {
    title: `\`${shown}\` ${removed ? "was removed in" : "goes away in"} TypeScript 7`,
    why: removed
      ? "The native TypeScript 7 type checker refuses this option, and stops the whole check " +
        "until it is gone (no type error is reported meanwhile)."
      : "TypeScript 6 deprecated this option, and TypeScript 7 (the native type checker) " +
        "refuses it.",
    fix: optionFix(name, value?.toLowerCase()),
  };
}

/** The JSX runtime a TS2875 names (`denext/jsx-runtime`). */
function runtimeOf(message: string): string | null {
  return /module path '([^']+)' to exist/.exec(message)?.[1] ?? null;
}

/** TS2875: the JSX runtime of `compilerOptions.jsxImportSource` doesn't resolve. */
export function jsxRuntimeRule({ d }: RuleInput): RuleResult | null {
  if (d.code !== "TS2875") return null;
  const runtime = runtimeOf(d.message);
  if (!runtime) return null;
  const source = runtime.replace(/\/jsx-(?:dev-)?runtime$/, "");
  return {
    title: `The JSX runtime "${runtime}" doesn't resolve`,
    why: `\`compilerOptions.jsxImportSource\` is "${source}", so every JSX tag imports ` +
      `"${runtime}", and nothing maps it.`,
    fix: source === "denext"
      ? 'Map denext in deno.json `imports`: `"denext": "jsr:@denext/denext@^4"` and ' +
        '`"denext/": "jsr:/@denext/denext@^4/"` (`denext migrate` writes both).'
      : `Add "${source}" to deno.json \`imports\` (\`denext add npm:${source}\`), or set ` +
        '`"jsxImportSource": "denext"`.',
  };
}

/** TS7026: no `JSX.IntrinsicElements`, which the JSX runtime's types declare. */
export function jsxTypesRule({ d }: RuleInput): RuleResult | null {
  if (d.code !== "TS7026") return null;
  return {
    title: "No JSX types",
    why: "The JSX runtime's types (its `JSX` namespace) didn't load: the runtime doesn't " +
      "resolve (see TS2875), or `compilerOptions.jsxImportSource` is not set.",
    fix: 'Set `"jsx": "react-jsx"` and `"jsxImportSource": "denext"` in deno.json ' +
      "`compilerOptions`, and map the runtime in `imports`.",
  };
}

/** TS5090: a `paths` target that doesn't start with `./` (TypeScript 7 has no `baseUrl`). */
export function pathsTargetRule({ d }: RuleInput): RuleResult | null {
  if (d.code !== "TS5090") return null;
  return {
    title: "A `paths` target must start with `./`",
    why: "Without `baseUrl` (which TypeScript 7 removed) a `paths` target is relative to " +
      "tsconfig.json and must say so.",
    fix: 'Write each target as `"./src/*"` rather than `"src/*"` in tsconfig.json `paths`.',
  };
}
