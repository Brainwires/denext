/**
 * `desktop.permissions`: how narrow a packaged app's baked read and environment grants are
 * (`"default"` | `"strict"` | `{ mode, env? }`). Pure, no imports: the config validator and the
 * package scripts' flag derivation share it.
 *
 * @module
 */

/** The resolved `desktop.permissions`. */
export interface DesktopPermissionsMode {
  /** Scope `--allow-read` / `--allow-env` (`"strict"`). */
  readonly strict: boolean;
  /** The app's own environment variables (`desktop.permissions.env`). */
  readonly env: readonly string[];
}

/** One environment variable name: what `--allow-env=<a>,<b>` can hold as one value. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The problem with a `desktop.permissions` value, as `[field, message]` (the field relative to
 * `desktop.`), else `null`.
 *
 * @param value The configured value.
 * @returns The problem, or `null`.
 */
export function desktopPermissionsProblem(value: unknown): [string, string] | null {
  if (value === undefined || value === "default" || value === "strict") return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["permissions", 'must be "default", "strict" or { mode, env? }'];
  }
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (key !== "mode" && key !== "env") {
      return [`permissions.${key}`, "is not a key of desktop.permissions (mode, env)"];
    }
  }
  if (v.mode !== "default" && v.mode !== "strict") {
    return ["permissions.mode", 'must be "default" or "strict"'];
  }
  if (v.env === undefined) return null;
  if (!Array.isArray(v.env)) return ["permissions.env", "must be an array of variable names"];
  const bad = v.env.find((n) => typeof n !== "string" || !ENV_NAME.test(n));
  if (bad !== undefined) {
    return [
      "permissions.env",
      `has ${JSON.stringify(bad)}: one variable name per entry (letters, digits, _)`,
    ];
  }
  return null;
}

/**
 * The mode a `desktop.permissions` value asks for (an invalid value reads as the default; the
 * config validator reports it, and the package scripts refuse it first).
 *
 * @param value The configured value.
 * @returns The mode.
 */
export function desktopPermissionsMode(value: unknown): DesktopPermissionsMode {
  if (value === "strict") return { strict: true, env: [] };
  if (typeof value !== "object" || value === null || desktopPermissionsProblem(value)) {
    return { strict: false, env: [] };
  }
  const v = value as { mode: string; env?: string[] };
  return { strict: v.mode === "strict", env: v.env ?? [] };
}

/**
 * Why strict mode cannot be used with these `desktop.sidecars`, else `null`: a program sidecar
 * (`run.exec`) is started with the app's whole environment, and so is the login shell
 * `loginShellEnv` runs, so both need the unscoped `--allow-env` (`Deno.env.toObject()`).
 *
 * @param sidecars The configured sidecars.
 * @returns The message, or `null`.
 */
export function strictPermissionsSidecarError(sidecars: unknown): string | null {
  if (!Array.isArray(sidecars)) return null;
  for (const d of sidecars) {
    if (typeof d !== "object" || d === null) continue;
    const s = d as { name?: unknown; run?: { exec?: unknown }; loginShellEnv?: unknown };
    const why = typeof s.run?.exec === "string"
      ? "is a program sidecar (run.exec), started with the app's whole environment"
      : s.loginShellEnv !== undefined && s.loginShellEnv !== false
      ? "uses loginShellEnv, which reads the whole environment"
      : undefined;
    if (why) {
      return `"strict" cannot scope --allow-env: sidecar ${JSON.stringify(s.name)} ${why}. ` +
        'Use permissions: "default", or a module sidecar (run.module) without loginShellEnv';
    }
  }
  return null;
}
