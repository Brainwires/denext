/**
 * Resolve the enabled Deno Desktop capabilities from `denext.config.ts` into the objects the
 * bridge dispatcher serves. The generated `desktop.ts` entry calls {@link
 * resolveDesktopCapabilities} and spreads the result into {@link runDesktop} — so the single
 * source of truth for what the page may reach is `desktop.capabilities` (default deny: an absent
 * key stays unavailable and the page uses its web fallback).
 *
 * Built-ins live beside this module (`device`, `fs`, `sqlite`, the `echo` diagnostic); user
 * extensions are the `desktop.capabilities.extensions` module paths (each a
 * {@link defineDesktopExtension} default export), imported relative to the entry.
 *
 * Runtime-only (imported by the desktop entry via `runDesktop`, never a client bundle).
 *
 * @module
 */

import type {
  DenextConfig,
  DesktopCapabilitiesConfig,
  DesktopShellConfig,
} from "../../server/config.ts";
import type { DesktopCapability } from "../extension.ts";
import { desktopAppDirs } from "../app-dirs.ts";
import { echoCapability } from "./echo.ts";
import { deviceCapability } from "./device.ts";
import { fsCapability } from "./fs.ts";
import { sqliteCapability } from "./sqlite.ts";
import { shellCapability, type ShellCapabilityConfig } from "./shell.ts";
import { keepAwakeCapability } from "./keep-awake.ts";
import { secureStoreCapability } from "./secure-store.ts";
import { PickedPaths } from "../picked-paths.ts";
import { dialogsCapability } from "./dialogs.ts";

/** The app-support subdirectory name when the config gives no identifier (matches the updater). */
const DEFAULT_APP_ID = "denext-desktop";

/** The `fs` roots enabled by default (`fs: true`) — the app-support and cache folders. */
const DEFAULT_FS_TOKENS = ["$APPDATA", "$CACHE"];

/** Options for {@link resolveDesktopCapabilities}. */
export interface ResolveDesktopOptions {
  /** The app identifier for the OS storage dirs; defaults to `desktop.app.identifier`, then a const. */
  readonly appId?: string;
  /** `import.meta.url` of the entry, so extension module paths resolve relative to the app. */
  readonly base?: string;
}

/** What {@link resolveDesktopCapabilities} returns — spread straight into {@link runDesktop}. */
export interface ResolvedDesktop {
  /** The enabled capabilities (the compiled allowlist the bridge serves). */
  readonly capabilities: DesktopCapability[];
  /** The app-support (data) directory handed to capability handlers and used by `fs`/`sqlite`. */
  readonly appSupportDir: string;
}

/** The default URL schemes `shell.openExternal` allows when enabled with `shell: true`. */
const DEFAULT_SHELL_SCHEMES = ["https:", "mailto:"];

/** Resolve `shell`: `true` enables every action with the default schemes; an object is taken as-is
 * (unset booleans default off — least privilege). */
function resolveShell(value: boolean | DesktopShellConfig): ShellCapabilityConfig {
  if (value === true) {
    return { openExternal: DEFAULT_SHELL_SCHEMES, openPath: true, reveal: true, trash: true };
  }
  const cfg = value as DesktopShellConfig;
  return {
    openExternal: cfg.openExternal ?? [],
    openPath: cfg.openPath === true,
    reveal: cfg.reveal === true,
    trash: cfg.trash === true,
  };
}

/** The `$…` scope tokens for `fs`: `true`/absent arrays → the defaults, an array → itself. */
function fsTokens(value: boolean | { read?: string[]; write?: string[] } | undefined): {
  read: Set<string>;
  write: Set<string>;
} {
  if (typeof value !== "object" || value === null) {
    return { read: new Set(DEFAULT_FS_TOKENS), write: new Set(DEFAULT_FS_TOKENS) };
  }
  return {
    read: new Set(value.read ?? DEFAULT_FS_TOKENS),
    write: new Set(value.write ?? DEFAULT_FS_TOKENS),
  };
}

/** Load one extension module (relative to `base`) and return its `defineDesktopExtension` default. */
async function loadExtension(spec: string, base: string | undefined): Promise<DesktopCapability> {
  // A relative spec (`./ext.ts`, `../ext.ts`) resolves against the entry; a scheme (`file:`,
  // `jsr:`, `npm:`, `https:`) or bare specifier is imported as written.
  const relative = spec.startsWith("./") || spec.startsWith("../");
  const href = base && relative ? new URL(spec, base).href : spec;
  let mod: { default?: unknown };
  try {
    mod = await import(href);
  } catch (err) {
    throw new Error(
      `desktop: cannot load extension "${spec}": ${err instanceof Error ? err.message : err}`,
    );
  }
  const cap = mod.default;
  if (!cap || typeof cap !== "object" || typeof (cap as DesktopCapability).name !== "string") {
    throw new Error(
      `desktop: extension "${spec}" must \`export default defineDesktopExtension(...)\``,
    );
  }
  return cap as DesktopCapability;
}

/**
 * Resolve `config.desktop.capabilities` into the capability objects the bridge serves, plus the
 * app-support directory the runtime hands to handlers.
 *
 * Only the currently implemented built-ins are mapped (`device`, `fs`, `sqlite`, `echo`); a
 * configured key without a built-in yet is left unavailable (the page falls back), never an error.
 * A bad extension path IS an error (fail fast at launch).
 *
 * @param config The project config (or its `desktop` block via the whole config); `undefined`
 * yields no capabilities.
 * @param options The app id (for storage dirs) and the entry's `import.meta.url` (for extensions).
 * @returns The enabled capabilities and the app-support directory.
 */
export async function resolveDesktopCapabilities(
  config: DenextConfig | undefined,
  options: ResolveDesktopOptions = {},
): Promise<ResolvedDesktop> {
  const desktop = config?.desktop;
  const caps: DesktopCapabilitiesConfig | undefined = desktop?.capabilities;
  const appId = options.appId ??
    (desktop as { app?: { identifier?: string } } | undefined)?.app?.identifier ?? DEFAULT_APP_ID;
  const dirs = desktopAppDirs(appId);
  const capabilities: DesktopCapability[] = [];

  if (!caps) return { capabilities, appSupportDir: dirs.data };

  // One per-launch picked-path set, shared by dialogs (adds picks) and fs/shell (consult handles).
  const picked = new PickedPaths();

  if (caps.echo === true) capabilities.push(echoCapability);
  if (caps.device) capabilities.push(deviceCapability);
  if (caps.fs) {
    const { read, write } = fsTokens(caps.fs);
    capabilities.push(fsCapability({ dirs, read, write, picked }));
  }
  if (caps.sqlite) capabilities.push(sqliteCapability(dirs.data));
  if (caps.shell) {
    capabilities.push(shellCapability({ dirs, config: resolveShell(caps.shell), picked }));
  }
  if (caps.dialogs) capabilities.push(dialogsCapability({ picked }));
  if (caps.keepAwake) capabilities.push(keepAwakeCapability());
  if (caps.secureStore) capabilities.push(secureStoreCapability({ service: appId }));

  for (const spec of caps.extensions ?? []) {
    capabilities.push(await loadExtension(spec, options.base));
  }

  return { capabilities, appSupportDir: dirs.data };
}
