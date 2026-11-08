/**
 * `desktop.secureStore` and the Deno permissions the `secureStore` capability needs, shared by the
 * packaging side (the `--allow-*` the package scripts and `denext desktop run` / `dev` bake, see
 * `src/build/desktop-capabilities.ts`) and the runtime side (the capability's declared method
 * permissions, see `./caps/secure-store.ts`), so the two can never drift.
 *
 * Import-free: read by build code and by the desktop runtime alike.
 *
 * @module
 */

/** The OS spelling (`Deno.build.os`) the permissions are given for. */
export type SecureStoreOs = "darwin" | "windows" | "linux";

/** What decides the `secureStore` permissions besides the OS. */
export interface SecureStorePermissionContext {
  /**
   * `desktop.secureStore.legacy` (see {@linkcode secureStoreLegacy}): macOS keeps
   * `/usr/bin/security` to move the items an older denext wrote through it.
   */
  readonly legacy: boolean;
  /**
   * The Deno Desktop runtime gates `Deno.desktop.secureStore` on the capability list baked into
   * `.deno-desktop/app.json` (`supportsDesktopBakedCapabilities`), so it needs no `--allow-sys`.
   */
  readonly bakedCapabilities: boolean;
  /**
   * The runtime has its own macOS secure store (`supportsMacSecureStore`); without it (an older or
   * the stock runtime) macOS stores through `/usr/bin/security`, which the capability uses only
   * while {@linkcode SecureStorePermissionContext.legacy} is on. Kept for reporting: it does not
   * change the permissions (`security` is baked exactly while `legacy` is on).
   */
  readonly macRuntimeStore: boolean;
}

/**
 * `desktop.secureStore.legacy`: `true` unless the config sets it `false`. Apps that shipped the
 * `security` path keep moving their items by default; `denext desktop add secure-store` writes
 * `legacy: false` for an app that enables the capability for the first time (it never shipped that
 * path).
 *
 * @param desktop The config's `desktop` section (or anything: an unset or invalid value reads as
 *   the default).
 * @returns Whether the legacy move is on.
 */
export function secureStoreLegacy(desktop: unknown): boolean {
  const block = typeof desktop === "object" && desktop !== null
    ? (desktop as { secureStore?: unknown }).secureStore
    : undefined;
  if (typeof block !== "object" || block === null) return true;
  return (block as { legacy?: unknown }).legacy !== false;
}

/**
 * The problem with a `desktop.secureStore` value, as `[field, message]`, or `null` when it is
 * valid (unset, or `{ legacy?: boolean }`).
 *
 * @param value The `desktop.secureStore` value.
 * @returns The problem, or `null`.
 */
export function secureStoreConfigProblem(value: unknown): [string, string] | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["desktop.secureStore", "must be { legacy?: boolean }"];
  }
  for (const [key, v] of Object.entries(value)) {
    if (key !== "legacy") {
      return [`desktop.secureStore.${key}`, "is not a key of desktop.secureStore (legacy)"];
    }
    if (typeof v !== "boolean") return ["desktop.secureStore.legacy", "must be a boolean"];
  }
  return null;
}

/**
 * The Deno permissions the `secureStore` capability needs on `os`:
 *
 * - `sys: ["*"]` (Linux, macOS) only while the runtime does not gate its store on the baked
 *   capability list: an older runtime's `Deno.desktop.secureStore` needs an unscoped `--allow-sys`.
 * - macOS `run: ["security"]` only while the legacy move is on (whatever the runtime): with
 *   `legacy: false` the capability never runs `security`, so it is never baked.
 * - Windows: `powershell.exe` (WinRT PasswordVault), unchanged.
 *
 * @param os The target OS.
 * @param ctx The config and runtime facts.
 * @returns The permission set (each kind present only when non-empty).
 */
export function secureStorePermissionSet(
  os: SecureStoreOs,
  ctx: SecureStorePermissionContext,
): { run?: string[]; sys?: string[] } {
  if (os === "windows") return { run: ["powershell.exe"] };
  const sys = ctx.bakedCapabilities ? {} : { sys: ["*"] };
  if (os === "linux") return sys;
  const security = ctx.legacy ? { run: ["security"] } : {};
  return { ...security, ...sys };
}
