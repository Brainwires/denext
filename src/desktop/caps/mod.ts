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
  SpaProxyConfig,
} from "../../server/config.ts";
import type { DesktopCapability } from "../extension.ts";
import { type DesktopAppDirs, desktopAppDirs } from "../app-dirs.ts";
import { echoCapability } from "./echo.ts";
import { deviceCapability } from "./device.ts";
import { fsCapability } from "./fs.ts";
import { sqliteCapability } from "./sqlite.ts";
import { shellCapability, type ShellCapabilityConfig } from "./shell.ts";
import { keepAwakeCapability } from "./keep-awake.ts";
import { secureStoreCapability } from "./secure-store.ts";
import { PickedPaths } from "../picked-paths.ts";
import { type DesktopWindowSettings, resolveDesktopWindowSettings } from "../window-config.ts";
import { dialogsCapability } from "./dialogs.ts";
import { passkeysCapability } from "./passkeys.ts";
import { clipboardCapability } from "./clipboard.ts";
import { notificationsCapability } from "./notifications.ts";
import { contextMenuCapability } from "./context-menu.ts";
import { shortcutsCapability } from "./shortcuts.ts";
import { launchAtLoginCapability } from "./launch-at-login.ts";
import {
  desktopAppIdentifierError,
  normalizeDesktopDeepLinks,
  originWithoutIdentifierMessage,
  parseDesktopAppOrigin,
} from "../app-origin.ts";

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
  /** Whether the `auth-session` capability is enabled — gates the loopback OAuth endpoint
   * (`openAuthSession`), which is default-deny (answers `unavailable`) unless this is true. It is
   * not a bridge capability, so it is surfaced here rather than in {@link ResolvedDesktop.capabilities}. */
  readonly authSessionEnabled: boolean;
  /**
   * The configured `desktop.app.origin`, normalized, when one is set. `runDesktop` compares it with
   * the origin the runtime publishes (a mismatch means a stale package); the gates trust the latter.
   */
  readonly appOrigin?: string;
  /**
   * The deep-link schemes from `desktop.app.deepLinks`, lower-case. `runDesktop` delivers links
   * with these schemes to `onDeepLink` and accepts them as `openAuthSession` callback schemes.
   */
  readonly deepLinks: string[];
  /**
   * The per-launch picked-path set the `dialogs`, `fs` and `shell` capabilities share; `runDesktop`
   * adds files the OS opens with the app to it (read-only handles for `onOpenFile`).
   */
  readonly pickedPaths: PickedPaths;
  /**
   * The initial-window settings (`desktop.window`, `desktop.titleBar`, `desktop.backdrop`,
   * `desktop.minSize`, `desktop.maxSize`) `runDesktop` applies to the window it adopts.
   */
  readonly window: DesktopWindowSettings;
  /** The app's own folders (data, cache, documents): files there may be dragged out of the window. */
  readonly appDirs: DesktopAppDirs;
  /**
   * `desktop.update.autoConfirm`: whether `runDesktop` confirms a full-app update on its trial
   * launch once the window has loaded (`false` only when the config turns it off).
   */
  readonly autoConfirmAppUpdate: boolean;
  /** `spa.proxy`: the backend reverse proxy `runDesktop` serves, when the config sets one. */
  readonly proxy?: SpaProxyConfig;
}

/**
 * What {@link resolveDesktopCapabilities} reads: the project config, or the JSON slice of it the
 * desktop sync writes to `.deno-desktop/config.json` (`{ desktop, spa: { proxy } }`), which the
 * generated `desktop.ts` imports so `denext.config.ts` (and every plugin it imports) stays out of
 * the packaged app. Typed loosely so a JSON module's inferred type is accepted as it is.
 */
export interface DesktopRuntimeConfig {
  /** The config's `desktop` section (`DenextConfig["desktop"]`). */
  readonly desktop?: unknown;
  /** The config's `spa` section; only `spa.proxy` is read. */
  readonly spa?: unknown;
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
    openPathAllowExtensions: cfg.openPathAllowExtensions ?? [],
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
 * The built-in bridge capabilities are mapped (`device`, `fs`, `sqlite`, `shell`, `keepAwake`,
 * `secureStore`, `dialogs`, `clipboard`, `passkeys`, `notifications`, `contextMenu`,
 * `globalShortcuts`, `launchAtLogin`, and the `echo` diagnostic), plus any `extensions` module
 * paths; `auth-session` is a runtime endpoint (not a bridge cap) so it only sets
 * `authSessionEnabled`. A capability the running Deno Desktop runtime cannot serve answers
 * `unavailable` per call (the page uses its web path), never an error. A bad extension path IS an
 * error, and so is enabling a data-storing cap (`secureStore`/`fs`/`sqlite`) without a
 * `desktop.app.identifier` — both fail fast at launch.
 *
 * @param runtimeConfig The project config, or `.deno-desktop/config.json` (its runtime slice, see
 * {@link DesktopRuntimeConfig}); `undefined` yields no capabilities.
 * @param options The app id (for storage dirs) and the entry's `import.meta.url` (for extensions).
 * @returns The enabled capabilities, the app-support directory, whether auth-session is enabled,
 * and `spa.proxy`.
 */
export async function resolveDesktopCapabilities(
  runtimeConfig: DesktopRuntimeConfig | undefined,
  options: ResolveDesktopOptions = {},
): Promise<ResolvedDesktop> {
  const config = runtimeConfig as DenextConfig | undefined;
  const desktop = config?.desktop;
  const caps: DesktopCapabilitiesConfig | undefined = desktop?.capabilities;
  // The app identity keys the storage dirs AND the secureStore keychain SERVICE. It MUST be
  // explicit (options.appId, or `desktop.app.identifier` in the config) — the default is shared, so
  // falling back to it for a data-storing cap would collide storage and secrets across every denext
  // desktop app. So `explicitId` is tracked separately from the fallback used only for dir paths.
  const explicitId = options.appId ??
    (desktop as { app?: { identifier?: string } } | undefined)?.app?.identifier;
  const appId = explicitId ?? DEFAULT_APP_ID;
  const dirs = desktopAppDirs(appId);
  // `auth-session` is a runtime endpoint, not a bridge capability, so it never becomes a
  // `DesktopCapability`; the flag only gates the loopback OAuth endpoint in `runDesktop`.
  const authSessionEnabled = (caps as { authSession?: unknown } | undefined)?.authSession === true;
  const appOrigin = resolveAppOrigin(
    (desktop as { app?: { origin?: unknown } } | undefined)?.app?.origin,
    explicitId,
  );
  const origin = appOrigin === undefined ? {} : { appOrigin };
  const deepLinks = launchDeepLinks(
    (desktop as { app?: { deepLinks?: unknown } })?.app?.deepLinks,
  );
  // One per-launch picked-path set, shared by dialogs (adds picks), fs/shell (consult handles) and
  // the files the OS opens with the app.
  const pickedPaths = new PickedPaths();
  const base = {
    appSupportDir: dirs.data,
    authSessionEnabled,
    deepLinks,
    pickedPaths,
    window: resolveDesktopWindowSettings(desktop),
    appDirs: dirs,
    autoConfirmAppUpdate:
      (desktop as { update?: { autoConfirm?: unknown } } | undefined)?.update?.autoConfirm !==
        false,
    ...origin,
    ...(config?.spa?.proxy ? { proxy: config.spa.proxy } : {}),
  };

  if (!caps) return { capabilities: [], ...base };
  assertAppIdentity(Boolean(explicitId), caps);
  const capabilities = await buildBuiltinCaps(caps, {
    dirs,
    appId,
    base: options.base,
    picked: pickedPaths,
  });
  return { capabilities, ...base };
}

/**
 * The configured `desktop.app.origin`, normalized, or `undefined` when unset. The desktop entry
 * imports the config's JSON slice directly (the config loader's validation never ran), so the runtime's
 * rules are enforced here too: an invalid origin, or an origin without a valid identifier, fails
 * fast at launch.
 */
function resolveAppOrigin(raw: unknown, identifier: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("desktop: `desktop.app.origin` must be a string");
  const parsed = parseDesktopAppOrigin(raw);
  if (!parsed.ok) throw new Error(`desktop: invalid desktop.app.origin "${raw}": ${parsed.error}`);
  if (identifier === undefined) throw new Error(`desktop: ${originWithoutIdentifierMessage(raw)}`);
  const idError = desktopAppIdentifierError(identifier);
  if (idError) throw new Error(`desktop: invalid desktop.app.identifier: ${idError}`);
  return parsed.value.origin;
}

/** `desktop.app.deepLinks` for the runtime: the shared validation, failing fast at launch. */
function launchDeepLinks(raw: unknown): string[] {
  try {
    return normalizeDesktopDeepLinks(raw);
  } catch (err) {
    throw new Error(`desktop: ${(err as Error).message}`);
  }
}

/**
 * Fail closed on the cross-app collision (CV-3): the caps that PERSIST data (`secureStore`'s
 * keychain service, `fs`/`sqlite`'s app-support files) require a unique identifier — without one
 * they would share the default folder and keychain service with every other denext desktop app.
 */
function assertAppIdentity(hasExplicitId: boolean, caps: DesktopCapabilitiesConfig): void {
  if (!hasExplicitId && (caps.secureStore || caps.fs || caps.sqlite)) {
    throw new Error(
      "desktop: set `desktop.app.identifier` in denext.config.ts (a unique reverse-DNS id) — " +
        "secureStore/fs/sqlite key their storage and keychain service by it, and without it every " +
        "desktop app shares one data folder and one keychain (an app could read another's secrets).",
    );
  }
}

/** What the built-in factories need. */
interface BuiltinCtx {
  readonly dirs: DesktopAppDirs;
  readonly appId: string;
  readonly base: string | undefined;
  readonly picked: PickedPaths;
}

/** The enabled built-ins that keep data on disk or in the keychain (`fs`, `sqlite`, `secureStore`). */
function dataCaps(caps: DesktopCapabilitiesConfig, ctx: BuiltinCtx): DesktopCapability[] {
  const out: DesktopCapability[] = [];
  if (caps.fs) {
    const { read, write } = fsTokens(caps.fs);
    out.push(fsCapability({ dirs: ctx.dirs, read, write, picked: ctx.picked }));
  }
  if (caps.sqlite) out.push(sqliteCapability(ctx.dirs.data));
  if (caps.secureStore) out.push(secureStoreCapability({ service: ctx.appId }));
  return out;
}

/** The enabled built-ins over the pinned runtime's app APIs (notifications, menus, shortcuts, login). */
function appCaps(caps: DesktopCapabilitiesConfig): DesktopCapability[] {
  return [
    ...(caps.notifications ? [notificationsCapability()] : []),
    ...(caps.contextMenu ? [contextMenuCapability()] : []),
    ...(caps.globalShortcuts ? [shortcutsCapability()] : []),
    ...(caps.launchAtLogin ? [launchAtLoginCapability()] : []),
  ];
}

/** The enabled built-ins that reach the OS (shell, dialogs, keep-awake, clipboard, passkeys). */
function systemCaps(caps: DesktopCapabilitiesConfig, ctx: BuiltinCtx): DesktopCapability[] {
  const out: DesktopCapability[] = [];
  if (caps.shell) {
    out.push(
      shellCapability({ dirs: ctx.dirs, config: resolveShell(caps.shell), picked: ctx.picked }),
    );
  }
  if (caps.dialogs) out.push(dialogsCapability({ picked: ctx.picked }));
  if (caps.keepAwake) out.push(keepAwakeCapability());
  if (caps.clipboard) out.push(clipboardCapability());
  if (caps.passkeys) {
    // Fail closed: no `rpIds` (a bare `true`, which config validation rejects) pins nothing, so
    // every ceremony answers `invalid_rp`.
    const rpIds = typeof caps.passkeys === "object" && Array.isArray(caps.passkeys.rpIds)
      ? caps.passkeys.rpIds
      : [];
    out.push(passkeysCapability({ rpIds }));
  }
  return out;
}

/** Map the enabled `caps` to the bridge capability objects (built-ins + loaded extensions). */
async function buildBuiltinCaps(
  caps: DesktopCapabilitiesConfig,
  ctx: BuiltinCtx,
): Promise<DesktopCapability[]> {
  const capabilities: DesktopCapability[] = [
    ...(caps.echo === true ? [echoCapability] : []),
    ...(caps.device ? [deviceCapability] : []),
    ...dataCaps(caps, ctx),
    ...systemCaps(caps, ctx),
    ...appCaps(caps),
  ];
  for (const spec of caps.extensions ?? []) capabilities.push(await loadExtension(spec, ctx.base));
  return capabilities;
}
