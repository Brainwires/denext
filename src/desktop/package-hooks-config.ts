/**
 * `desktop.packageHooks`'s shape check, shared by the config validator and the package scripts'
 * `runDesktopPackageMain` (which reads the config unvalidated).
 *
 * Pure; nothing runs at import.
 *
 * @module
 */

/** The module extensions a hook may have. */
const HOOK_EXTENSIONS = /\.(m?ts|m?js)$/;

/**
 * What is wrong with `desktop.packageHooks`, as `[path, message]`, or `null`: it must be an object
 * with only `pre` / `post`, each a project-relative module path (no absolute path, no `..`
 * component) ending in `.ts`, `.mts`, `.js` or `.mjs`.
 *
 * @param value `desktop.packageHooks`.
 * @returns The problem, or `null` (also when it is not set).
 */
export function desktopPackageHooksProblem(value: unknown): [string, string] | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["desktop.packageHooks", "must be { pre?, post? }"];
  }
  for (const [key, path] of Object.entries(value)) {
    const at = `desktop.packageHooks.${key}`;
    if (key !== "pre" && key !== "post") return [at, "is not a hook (pre or post)"];
    if (path === undefined) continue;
    if (typeof path !== "string" || !HOOK_EXTENSIONS.test(path)) {
      return [at, "must be a module path ending in .ts, .mts, .js or .mjs"];
    }
    if (/^([\\/]|[A-Za-z]:)/.test(path) || path.split(/[\\/]/).includes("..")) {
      return [at, 'must be a path inside the project (relative, no "..")'];
    }
  }
  return null;
}
