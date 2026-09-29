// A deno.json's `links` (Deno 2's local-package overrides; `patch` before 2.2) name directories
// RELATIVE to the config file. denext writes generated copies of the app's config elsewhere
// (the `deno bundle` temp dir, `.denext/module-config.json`, `.denext/css-config.json`), so the
// entries have to be re-based for the copy's location or they resolve against the wrong
// directory ("Could not find link member …"). An absolute entry would not do: Deno rejects a
// Windows drive path there ("Could not convert URL to file path").

import { isAbsolute, relative, resolve } from "@std/path";

/**
 * The `links` entries of a config at `fromDir`, re-based for a copy written to `toDir`.
 *
 * @param links The config's `links` (or legacy `patch`) value.
 * @param fromDir The original config's directory.
 * @param toDir The directory the copy is written to.
 * @returns The re-based entries (`/`-separated), or `undefined` when there are none.
 */
export function rebaseLinks(links: unknown, fromDir: string, toDir: string): string[] | undefined {
  if (!Array.isArray(links)) return undefined;
  const out: string[] = [];
  for (const entry of links) {
    if (typeof entry !== "string") continue;
    const abs = isAbsolute(entry) ? entry : resolve(fromDir, entry);
    const rel = relative(toDir, abs);
    // Another Windows drive has no relative form: keep the absolute path (Deno's own limit).
    out.push(isAbsolute(rel) ? abs : rel.replaceAll("\\", "/"));
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Copy the app config's `links` / `patch` onto a generated config written to `toDir`.
 *
 * @param target The generated config object (mutated).
 * @param appCfg The app's parsed config.
 * @param fromDir The app config's directory.
 * @param toDir The generated config's directory.
 */
export function carryLinks(
  target: Record<string, unknown>,
  appCfg: { links?: unknown; patch?: unknown } | null | undefined,
  fromDir: string,
  toDir: string,
): void {
  for (const key of ["links", "patch"] as const) {
    const rebased = rebaseLinks(appCfg?.[key], fromDir, toDir);
    if (rebased) target[key] = rebased;
    else delete target[key];
  }
}
