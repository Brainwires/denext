// Imports: a `react` / `next/*` import in new code (point at the denext import map), a bare
// specifier nothing maps, a module that doesn't exist (did-you-mean over its directory), a name
// used without importing it, and CommonJS `import x = require()` / `export =` in an ES module.

import { builtinModules } from "node:module";
import { basename, dirname, extname, isAbsolute, toFileUrl } from "@std/path";
import { suggest } from "../../cli/command.ts";
import { lookupImport } from "../../mcp/next-denext-map.ts";
import { lineText } from "./source.ts";
import { toPath } from "./parse.ts";
import type { RuleInput, RuleResult } from "./types.ts";

/** The messages that name an unresolvable module (`deno check`, Deno, esbuild). */
const SPECIFIER_MESSAGES: readonly RegExp[] = [
  /^Import "([^"]+)" not a dependency/,
  /^Cannot find module '([^']+)'/,
  /^Module not found "([^"]+)"/,
  /^Could not resolve "([^"]+)"/,
  /^Relative import path "([^"]+)" not prefixed/,
];

/** The specifier a module diagnostic names, as written. */
function specifierOf(message: string): string | null {
  for (const re of SPECIFIER_MESSAGES) {
    const m = re.exec(message);
    if (m) return m[1];
  }
  return null;
}

/** `import X from "spec"` → `import { X } from "to"` for a default-import Next component. */
function rewriteImport(line: string, spec: string, to: string): string {
  const escaped = spec.replace(/[/]/g, "\\/");
  const def = new RegExp(`^(\\s*)import\\s+([\\w$]+)\\s+from\\s+(["'])${escaped}\\3`).exec(line);
  if (def) {
    const canonical = basename(spec).replace(/^\w/, (c) => c.toUpperCase());
    const binding = def[2] === canonical ? canonical : `${canonical} as ${def[2]}`;
    return `${def[1]}import { ${binding} } from ${def[3]}${to}${def[3]}${
      line.slice(def[0].length)
    }`;
  }
  return line.replace(new RegExp(`(["'])${escaped}\\1`), `"${to}"`);
}

/** `react` / `next/*` (and friends) in a denext app: name the denext module to import from. */
export function importSourceRule({ d, source }: RuleInput): RuleResult | null {
  if (d.code !== "TS2307" && d.code !== "module-not-found" && d.source !== "deno") return null;
  const spec = specifierOf(d.message);
  if (!spec) return null;
  const { rule } = lookupImport(spec);
  if (!rule) return null;
  const line = source && d.line ? lineText(source, d.line) : "";
  const note = rule.note ? ` ${rule.note}` : "";
  const rewritten = line ? rewriteImport(line, spec, rule.to) : "";
  return {
    title: `Import from "${rule.to}", not "${spec}"`,
    why: `"${spec}" is not a dependency of a denext app: denext provides that API itself.` +
      `${note} The full mapping is the "Next.js → denext import map" in ` +
      `AGENTS.md (also the \`denext_import_map\` tool of \`denext mcp\`).`,
    fix: rewritten && rewritten !== line
      ? `Change the import:\n${line.trim()}\n→ ${rewritten.trim()}`
      : `Import from "${rule.to}" instead.`,
  };
}

/** Node's built-in modules (`fs`, `path`, …), which Deno imports with the `node:` prefix. */
const NODE_BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.filter((m) => !m.startsWith("_")).map((m) => m.replace(/^node:/, "")),
);

/** Whether `spec` is a bare specifier: no relative or absolute path, no scheme, no `#` import. */
function isBare(spec: string): boolean {
  return !/^(?:\.{0,2}\/|#|[a-z][a-z0-9+.-]*:)/i.test(spec);
}

/** The package a bare specifier names (`lodash/fp` → `lodash`, `@scope/pkg/x` → `@scope/pkg`). */
function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * TS2307 / TS2792 on a bare specifier that nothing maps. The in-process checker says `Import "x"
 * not a dependency` (with a `deno add` hint), the native TypeScript 7 one `Cannot find module 'x'
 * or its corresponding type declarations`: the same fix either way.
 */
export function bareSpecifierRule({ d }: RuleInput): RuleResult | null {
  if (d.code !== "TS2307" && d.code !== "TS2792") return null;
  const spec = specifierOf(d.message);
  if (!spec || !isBare(spec)) return null;
  const pkg = packageOf(spec);
  if (NODE_BUILTINS.has(pkg)) {
    return {
      title: `Import Node's \`${pkg}\` as "node:${spec}"`,
      why: `"${spec}" is one of Node's built-in modules, which Deno imports with the \`node:\` ` +
        `prefix; without it, it is looked up as a package.`,
      fix: `Change the import to "node:${spec}".`,
    };
  }
  return {
    title: `"${pkg}" is not a dependency`,
    why: `A bare import resolves through the import map (deno.json \`imports\`) or package.json ` +
      `\`dependencies\`, and neither lists "${pkg}".`,
    // A JSR package name is always scoped (`@std/path`); an npm one may be either.
    fix: `Add it: ${
      pkg.startsWith("@")
        ? `\`denext add jsr:${pkg}\` for a JSR package, \`denext add npm:${pkg}\` for an npm one`
        : `\`denext add npm:${pkg}\``
    }, or map "${pkg}" in deno.json \`imports\`.`,
  };
}

/** `import x = require("m")` → `import * as x from "m"` on the line, when it has that shape. */
function esmImport(line: string): string | null {
  const m = /^(\s*)import\s+([\w$]+)\s*=\s*require\(\s*(["'])([^"']+)\3\s*\)\s*;?/.exec(line);
  return m ? `${m[1]}import * as ${m[2]} from ${m[3]}${m[4]}${m[3]};` : null;
}

/**
 * TS1202 / TS1203: `import x = require()` / `export =` (CommonJS forms) in an ES module, which
 * every module of a denext app is. TypeScript 7 reports `import = require()` too, where the
 * in-process checker let it through.
 */
export function esmSyntaxRule({ d, source }: RuleInput): RuleResult | null {
  if (d.code !== "TS1202" && d.code !== "TS1203") return null;
  const line = source && d.line ? lineText(source, d.line) : "";
  if (d.code === "TS1202") {
    const rewritten = esmImport(line);
    return {
      title: "`import … = require()` in an ES module",
      why: "This file is an ES module, which imports with `import`; `import x = require()` is " +
        "TypeScript's CommonJS form.",
      fix: rewritten
        ? `Change the import:\n${line.trim()}\n→ ${rewritten.trim()}`
        : 'Use `import * as x from "mod"` (or a named / default import) instead.',
    };
  }
  const value = /^\s*export\s*=\s*(.+?);?\s*$/.exec(line)?.[1];
  return {
    title: "`export =` in an ES module",
    why: "This file is an ES module, which exports with `export`; `export =` is TypeScript's " +
      "CommonJS form.",
    fix: value
      ? `Change the export:\n${line.trim()}\n→ export default ${value};`
      : "Use `export default` (or named exports) instead.",
  };
}

/** The file names in `dir` close to `want` (the typo'd name), best first. */
function nearFiles(input: RuleInput, dir: string, want: string): string | undefined {
  let names: string[] = [];
  try {
    names = input.ctx.listDir?.(dir) ?? [];
  } catch {
    return undefined;
  }
  const exact = names.find((n) => n.toLowerCase() === want.toLowerCase());
  if (exact) return exact;
  const stem = want.slice(0, want.length - extname(want).length);
  const sameStem = names.find((n) => n.slice(0, n.length - extname(n).length) === stem);
  return sameStem ?? suggest(want, names);
}

/** The specifier rewritten to point at `name` in the same directory. */
function respell(spec: string, name: string): string {
  const slash = spec.lastIndexOf("/");
  return slash < 0 ? name : `${spec.slice(0, slash + 1)}${name}`;
}

/** Where a relative specifier resolves from the importing file. */
function resolvedTarget(input: RuleInput, spec: string): string | null {
  if (spec.startsWith("file://")) return toPath(spec);
  if (!input.d.file || !/^\.{1,2}\//.test(spec)) return null;
  // A path, not a URL: `file://` + `C:\\app\\x.ts` is no file URL (Windows).
  const base = isAbsolute(input.d.file) ? toFileUrl(input.d.file).href : `file://${input.d.file}`;
  return toPath(new URL(spec, base).href);
}

/** The specifier as the source wrote it, on the reported line (for a resolved `file://` one). */
function writtenSpecifier(input: RuleInput, target: string): string {
  const line = input.source && input.d.line ? lineText(input.source, input.d.line) : "";
  const m = /(["'])(\.{1,2}\/[^"']+)\1/.exec(line);
  return m && target.endsWith(m[2].replace(/^\.{1,2}\//, "")) ? m[2] : `./${basename(target)}`;
}

/** A local module that doesn't exist: suggest the nearest file in its directory. */
export function moduleNotFoundRule(input: RuleInput): RuleResult | null {
  const { d } = input;
  if (d.code !== "TS2307" && d.code !== "module-not-found") return null;
  const spec = specifierOf(d.message);
  const target = spec ? resolvedTarget(input, spec) : null;
  if (!spec || !target) return null;
  const written = spec.startsWith("file://") ? writtenSpecifier(input, target) : spec;
  const near = nearFiles(input, dirname(target), basename(target));
  const dir = input.display(dirname(target));
  const where = dir === "." ? "this directory" : `${dir}/`;
  if (near && near !== basename(target)) {
    const fixed = respell(written, near);
    return {
      title: `Module "${written}" not found — did you mean "${fixed}"?`,
      why: `Nothing named \`${basename(target)}\` exists in ${where}, but \`${near}\` does.`,
      fix: `Change the import to "${fixed}".`,
    };
  }
  const extHint = extname(target) ? "" : " Deno needs the file extension (`./utils.ts`).";
  return {
    title: `Module "${written}" not found`,
    why: `No file \`${basename(target)}\` exists in ${where}.${extHint}`,
    fix: `Check the path, or create the module.`,
  };
}

/** Names denext exports, by the module new code imports them from. */
const DENEXT_NAMES: Readonly<Record<string, readonly string[]>> = {
  denext: [
    "useState",
    "useEffect",
    "useLayoutEffect",
    "useMemo",
    "useCallback",
    "useRef",
    "useReducer",
    "useContext",
    "createContext",
    "useId",
    "useTransition",
    "useDeferredValue",
    "useSyncExternalStore",
    "useOptimistic",
    "useActionState",
    "use",
    "Suspense",
    "Fragment",
    "memo",
    "forwardRef",
    "lazy",
    "Link",
    "Image",
    "useRouter",
    "usePathname",
    "useSearchParams",
    "useParams",
    "redirect",
    "notFound",
    "createApiClient",
    "useApi",
  ],
  "denext/server": [
    "cookies",
    "headers",
    "defineApi",
    "createApi",
    "defineAction",
    "getSession",
    "redirectResponse",
    "revalidatePath",
    "revalidateTag",
    "unstable_cache",
    "defineJob",
  ],
};

/** The denext module that exports `name`, if it is a known export. */
function denextModuleFor(name: string): string | undefined {
  return Object.entries(DENEXT_NAMES).find(([, names]) => names.includes(name))?.[0];
}

/** Every `[module, name]` pair the missing-name rule knows (for the drift test). */
export function knownDenextNames(): Array<[string, string]> {
  return Object.entries(DENEXT_NAMES).flatMap(([m, names]) =>
    names.map((n): [string, string] => [m, n])
  );
}

/** An existing `import { … } from "mod"` line in the source, to extend instead of adding one. */
function existingImport(source: string | undefined, mod: string): string | undefined {
  if (!source) return undefined;
  const re = new RegExp(
    `^import\\s*\\{[^}]*\\}\\s*from\\s*["']${mod.replace("/", "\\/")}["'];?`,
    "m",
  );
  return re.exec(source)?.[0];
}

/** TS2304 / TS2552: a name used but never imported — name the module that exports it. */
export function missingNameRule({ d, source }: RuleInput): RuleResult | null {
  if (d.code !== "TS2304" && d.code !== "TS2552") return null;
  const m = /^Cannot find name '([^']+)'\.(?: Did you mean '([^']+)'\?)?/.exec(d.message);
  if (!m) return null;
  const [, name, tsHint] = m;
  const mod = denextModuleFor(name);
  if (!mod) {
    return {
      title: `\`${name}\` is not defined`,
      why: `Nothing named \`${name}\` is declared or imported in this file.`,
      fix: tsHint
        ? `Did you mean \`${tsHint}\`? Otherwise declare or import \`${name}\`.`
        : `Declare \`${name}\`, or import it from the module that exports it.`,
    };
  }
  const existing = existingImport(source, mod);
  const fix = existing
    ? `Add it to the existing import:\n${existing}\n→ ${existing.replace(/\s*\}/, `, ${name} }`)}`
    : `Add the import at the top of the file:\nimport { ${name} } from "${mod}";`;
  return {
    title: `\`${name}\` is used but not imported`,
    why: `\`${name}\` comes from "${mod}", but this file doesn't import it.`,
    fix,
  };
}
