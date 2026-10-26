// The Preact layer `denext migrate` shares between its Fresh and Preact paths: the import-map
// entries that point Preact, its hooks / compat / JSX runtime and Preact Signals at denext, the
// Vite `resolveAlias` entries that do the same for npm packages, and the source patterns that do
// not migrate (with the reason for each).

import { join } from "@std/path";
import { mfs } from "@denext/denext/internal/migrate-host";

/** Something the migration leaves to the user. */
export interface PreactFinding {
  /** What it concerns: a file, an API. */
  item: string;
  /** Why, and what to do. */
  reason: string;
}

/** The Preact specifiers denext provides, and the `denext/*` subpath each maps to. */
export const PREACT_ALIASES: Readonly<Record<string, string>> = {
  "preact": "preact",
  "preact/hooks": "preact/hooks",
  "preact/compat": "preact/compat",
  "preact/jsx-runtime": "preact/jsx-runtime",
  "preact/jsx-dev-runtime": "preact/jsx-runtime",
  "preact-render-to-string": "preact/render-to-string",
  "preact-render-to-string/stream": "preact/render-to-string",
  "@preact/signals": "signals",
  "@preact/signals/utils": "signals",
  "@preact/signals-core": "signals",
};

/**
 * The import-map entries pointing Preact and Preact Signals at denext (`denext/preact`,
 * `denext/preact/hooks`, `denext/preact/compat`, the JSX runtime, `denext/signals`).
 *
 * @param sub Resolves a `denext/<sub>` entry (`R.sub`).
 * @returns The entries.
 */
export function preactAliasImports(sub: (s: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [spec, target] of Object.entries(PREACT_ALIASES)) {
    out[spec] = sub(target);
    // The `denext/*` target itself, which `resolveAlias` points npm packages at.
    out[`denext/${target}`] = sub(target);
  }
  return out;
}

/** Whether an import-map / dependency key is one of Preact's own packages (dropped by a merge). */
export function isPreactPackage(key: string): boolean {
  return /^preact(?:\/|$)/.test(key) || /^preact-render-to-string(?:\/|$)/.test(key) ||
    /^@preact\/signals(?:-core)?(?:\/|$)/.test(key) || /^@prefresh\//.test(key);
}

/** A source pattern that does not migrate (or needs a look), with the reason. */
export interface SourceRule {
  /** Matches the source. */
  re: RegExp;
  /** The finding's item. */
  item: string;
  /** The reason. */
  reason: string;
  /** It does not migrate (else it needs a review). */
  wont?: boolean;
}

/** The Preact patterns denext does not run as Preact does (shared by both migrators). */
export const PREACT_SOURCE_RULES: readonly SourceRule[] = [
  {
    re: /["']preact-render-to-string\/(?:jsx|stream-node)["']/,
    item: "preact-render-to-string/jsx, /stream-node",
    wont: true,
    reason: "not mapped; render with renderToString / renderToReadableStream from " +
      "denext/preact/render-to-string",
  },
  {
    re: /\buseSignalRef\b|\bcreateModel\b/,
    item: "@preact/signals extras",
    wont: true,
    reason: "useSignalRef / createModel are not in denext/signals",
  },
  {
    re:
      /\boptions\s*\.\s*(?:diffed|unmount|debounceRendering|requestAnimationFrame|__[a-z]|_[a-z])/,
    item: "preact options hooks",
    wont: true,
    reason: "denext calls Preact's options.vnode / options.event / options.useDebugValue, " +
      "never options.diffed / unmount / debounceRendering / requestAnimationFrame or the " +
      "internal (mangled) hooks",
  },
];

/**
 * Scan `files` (relative to `dir`) for `rules`: one finding per rule, naming the files.
 *
 * @param dir The project directory.
 * @param files The source files to read.
 * @param rules The patterns.
 * @param applies Whether a rule applies to a file (default: every file).
 * @returns The won't-migrate and review findings.
 */
export async function scanSourceRules(
  dir: string,
  files: string[],
  rules: readonly SourceRule[],
  applies: (rule: SourceRule, file: string) => boolean = () => true,
): Promise<{ wont: PreactFinding[]; review: PreactFinding[] }> {
  const hits = new Map<SourceRule, string[]>();
  for (const rel of files) {
    const source = await mfs.readTextFile(join(dir, rel)).catch(() => "");
    for (const rule of rules) {
      if (applies(rule, rel) && rule.re.test(source)) {
        hits.set(rule, [...(hits.get(rule) ?? []), rel]);
      }
    }
  }
  const out = { wont: [] as PreactFinding[], review: [] as PreactFinding[] };
  for (const [rule, where] of hits) {
    const finding = { item: rule.item, reason: `${rule.reason} (${where.join(", ")})` };
    (rule.wont ? out.wont : out.review).push(finding);
  }
  return out;
}
