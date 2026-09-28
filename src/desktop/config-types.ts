/**
 * The canonical `desktop.capabilities` key list, drift-tested against the `denext desktop add`
 * catalog. The `desktop` config TYPES themselves live in {@link ../server/config.ts} (so
 * `deno task gen:config-schema` resolves them into a real object schema for the `denext ui` form,
 * the same way it does `MobileConfig`) — import `DesktopConfig` etc. from there.
 *
 * Nothing runs at import beyond the const; safe to reference anywhere.
 *
 * @module
 */

/**
 * The capability keys `denext desktop add <name>` writes — the canonical list, kept in lockstep
 * with the catalog in {@link ../build/desktop-capabilities.ts} by a drift test. `echo` (a built-in
 * diagnostic) and `extensions` (user-extension module paths) are NOT `desktop add` capabilities and
 * are intentionally absent. When the catalog gains a capability, add it here AND to
 * `DesktopCapabilitiesConfig` in `../server/config.ts`, or the drift test fails.
 */
export const DESKTOP_ADD_CAPABILITY_KEYS = [
  "secureStore",
  "fs",
  "sqlite",
  "contextMenu",
  "shell",
  "dialogs",
  "notifications",
  "keepAwake",
  "clipboard",
  "device",
] as const;
