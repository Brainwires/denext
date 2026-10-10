// `denext desktop add <capability...>`: enable the Deno Desktop capabilities behind
// denext/mobile's functions (secureStore, readFile, openSqlite, showContextMenu, …) in a project.
// The desktop twin of `mobile add` (./mobile-capabilities.ts), with a different mechanism: a
// desktop app's "native side" is the Deno process `denext/desktop` runs, so enabling a
// capability installs nothing. It writes the capability into `desktop.capabilities` in
// denext.config.ts, which is the single source of truth for both the runtime's allowlist (a call
// to a capability that is not listed is refused `unavailable`) and the least-privilege Deno flags
// the package scripts derive (each capability declares the `--allow-*` it needs, per OS).
//
// The config edit is the comment-preserving splice `denext ui` uses (./config-edit.ts): only the
// `desktop.capabilities.<key>` value is written; everything else keeps its bytes. A key already
// present is left as the user wrote it.

import { basename, fromFileUrl, isAbsolute, join } from "@std/path";
import { CONFIG_FILES } from "./paths.ts";
import { readConfigModel, setConfigValue } from "./config-edit.ts";
import { createUnifiedDiff } from "./patch-diff.ts";
import { desktopImportMapArgsFor } from "./desktop-import-map.ts";
import type { SidecarDefinition } from "../desktop/sidecar.ts";

/** The operating systems a Deno Desktop app ships for (`Deno.build.os` spelling). */
export type DesktopOs = "darwin" | "windows" | "linux";

/** Every desktop OS, in table order. */
const DESKTOP_OSES: readonly DesktopOs[] = ["darwin", "windows", "linux"];

/**
 * The Deno permissions a capability needs, as `--allow-<kind>=<values>`. `"*"` alone means the
 * flag without a list (unscoped: the whole filesystem, every program, …).
 */
export interface DesktopPermissionSet {
  /** `--allow-ffi`: libraries loaded with `Deno.dlopen` (full trust: native code). */
  readonly ffi?: readonly string[];
  /** `--allow-run`: programs spawned with `Deno.Command` (full trust over each program). */
  readonly run?: readonly string[];
  /** `--allow-read`: paths (`$APPDATA`, `$CACHE`, `$DOCUMENTS` are resolved at packaging). */
  readonly read?: readonly string[];
  /** `--allow-write`: paths. */
  readonly write?: readonly string[];
  /** `--allow-net`: hosts. */
  readonly net?: readonly string[];
  /** `--allow-env`: variables. */
  readonly env?: readonly string[];
  /** `--allow-sys`: system-information APIs. */
  readonly sys?: readonly string[];
}

/**
 * How much trust a capability adds beyond the baseline (`--allow-net=127.0.0.1`, read of the
 * bundle and the app-support folder, write of the app-support folder):
 *
 * - `none`: no new permission.
 * - `scoped`: permissions limited to named paths / APIs.
 * - `broad`: an unscoped permission. An unscoped read or write (paths the user picks at run time
 *   cannot be listed at build time, and Deno Desktop bakes permissions at build time), so the
 *   runtime's per-session picked-path allowlist is the only thing narrowing it; or an unscoped
 *   `--allow-sys` (every system-information API), which the pinned runtime requires for the
 *   clipboard reads, global shortcuts, launch at login and OS notifications.
 * - `full`: a spawned program or a native library, which can do anything the user can.
 */
export type DesktopTrust = "none" | "scoped" | "broad" | "full";

/** One desktop capability: what it enables and what it costs. */
export interface DesktopCapabilityEntry {
  /** The `desktop.capabilities` key it writes. */
  readonly key: string;
  /** The value written when the key is absent. */
  readonly value: unknown;
  /** The page APIs it backs (from `denext/mobile` unless noted). */
  readonly api: readonly string[];
  /** The permissions it needs on every OS. */
  readonly all?: DesktopPermissionSet;
  /** The permissions it needs per OS, on top of {@linkcode DesktopCapabilityEntry.all}. */
  readonly os?: Partial<Readonly<Record<DesktopOs, DesktopPermissionSet>>>;
  /** The trust it adds (see {@linkcode DesktopTrust}). */
  readonly trust: DesktopTrust;
  /** A one-line note printed with the table and the plan. */
  readonly notes: string;
  /** Steps `denext desktop add` cannot do, printed after the run. */
  readonly manual?: readonly string[];
}

/** The app's folders the `fs` capability may use by default. */
const APP_FOLDERS = ["$APPDATA", "$CACHE"];

/**
 * The capability table: `denext desktop add <name>`. Names mirror `denext mobile add` where
 * the capability exists on both.
 */
export const DESKTOP_CAPABILITIES: Readonly<Record<string, DesktopCapabilityEntry>> = {
  "secure-store": {
    key: "secureStore",
    value: true,
    api: ["secureStore"],
    os: {
      // Linux and macOS: the runtime's own store (the Secret Service through libsecret; the
      // Keychain, items only the app may read), which needs an unscoped --allow-sys. macOS keeps
      // `security` for runtimes without that store and to move older items over. Windows: WinRT
      // PasswordVault via `powershell.exe` (argv/stdin, no shell).
      darwin: { run: ["security"], sys: ["*"] },
      linux: { sys: ["*"] },
      windows: { run: ["powershell.exe"] },
    },
    trust: "full",
    notes:
      "OS keychain (the runtime's Keychain store on macOS / libsecret on Linux / Windows PasswordVault)",
    manual: [
      "secure-store: Linux needs a Secret Service provider (GNOME Keyring, or KWallet with its Secret Service enabled) that can be unlocked; the pinned runtime reaches it through libsecret (`libsecret-1.so.0`, loaded at run time: the .deb depends on libsecret-1-0, the .rpm on libsecret). Without one, or under the stock runtime, every call fails `backend_unavailable` with the reason, never a plain file.",
      "secure-store: Windows uses WinRT PasswordVault via Windows PowerShell (verified by the Windows CI round-trip).",
    ],
  },
  fs: {
    key: "fs",
    value: { read: APP_FOLDERS, write: APP_FOLDERS },
    api: ["readFile", "writeFile", "deleteFile", "listDir", "downloadToFile"],
    all: { read: APP_FOLDERS, write: APP_FOLDERS },
    // BROAD, not scoped: a per-user app-support path can't be baked at build time, so the packaged
    // binary gets a broad --allow-write (and read is broad in the baseline). The RUNTIME cap layer
    // confines the page to the app dirs; the process-level grant is broad.
    trust: "broad",
    notes:
      "app files under the OS app-support / cache folders (survive relaunch); broad --allow-write baked",
    manual: [
      'fs: `directory: "documents"` needs "$DOCUMENTS" in desktop.capabilities.fs.read/write (it maps to ~/Documents/<app>); add it by hand if you use it.',
      "fs: the packaged binary bakes a broad --allow-write (the per-user app-support path can't be baked); the runtime cap layer confines writes to the app's folders. downloadToFile fetches in the Deno process, so each download host needs net in desktop.extraPermissions (beyond the loopback baseline).",
    ],
  },
  sqlite: {
    key: "sqlite",
    value: true,
    api: ["openSqlite", "deleteSqlite"],
    all: { read: ["$APPDATA"], write: ["$APPDATA"] },
    // BROAD for the same reason as `fs`: the app-support path can't be baked, so --allow-write is broad.
    trust: "broad",
    notes: "node:sqlite database files in the app-support folder (broad --allow-write baked)",
  },
  "context-menu": {
    key: "contextMenu",
    value: true,
    api: ["showContextMenu", "useContextMenu"],
    // A runtime API (BrowserWindow.showContextMenu with the dismissed event of denext's pinned
    // runtime), no --allow-* of its own. Under the stock runtime the page keeps its in-page menu.
    trust: "none",
    notes:
      "native OS context menu with submenus and dismissal (pinned runtime; in-page menu otherwise)",
  },
  shell: {
    key: "shell",
    value: { openExternal: ["https:", "mailto:"], openPath: true, reveal: true, trash: true },
    api: ["openExternal", "openPath", "revealInFileManager", "moveToTrash"],
    os: {
      darwin: { run: ["open", "osascript"] },
      windows: { run: ["explorer.exe", "rundll32.exe", "powershell.exe"] },
      linux: { run: ["xdg-open", "gio", "dbus-send"] },
    },
    trust: "full",
    notes: "system browser, open with the default app, reveal, trash",
    manual: [
      "shell: --allow-run of the OS opener (open / explorer / xdg-open) can start any app the user can; the runtime only passes URLs of the listed schemes and paths inside the fs scope or picked this session.",
    ],
  },
  "auth-session": {
    key: "authSession",
    value: true,
    api: ["openAuthSession"],
    // The system-browser opener (same per-OS launcher as shell.openExternal). Deno Desktop's
    // loopback OAuth endpoint is DEFAULT-DENY: it answers `unavailable` unless this capability is
    // enabled, and `openAuthSession` then falls back to its web path — so the opener's run
    // permission is only baked when the app opts in.
    os: {
      darwin: { run: ["open"] },
      windows: { run: ["rundll32.exe"] },
      linux: { run: ["xdg-open"] },
    },
    trust: "full",
    notes:
      "OAuth sign-in (openAuthSession): the OS auth session on macOS for a custom-scheme callback, else the system browser with a Cancel overlay",
    manual: [
      "auth-session: --allow-run of the system browser opener (open / rundll32 / xdg-open) can start any app the user can; the runtime only hands it the provider auth URL you pass, and the loopback endpoint is default-deny unless this capability is enabled.",
    ],
  },
  dialogs: {
    key: "dialogs",
    value: true,
    api: ["pickDocument", "saveFile", "pickFolder"],
    all: { read: ["*"], write: ["*"] },
    os: {
      // Without the runtime's own panels, macOS and Windows drive them as subprocesses (osascript /
      // PowerShell), not FFI — the same argv-only pattern the other caps use. Linux uses only the
      // runtime's (xdg-desktop-portal's FileChooser, else GTK's): nothing to run.
      darwin: { run: ["osascript"] },
      windows: { run: ["powershell.exe"] },
    },
    // FULL, not broad: `--allow-run=osascript` / `powershell.exe` are script interpreters, so any
    // code in the Deno process can run arbitrary commands through them.
    trust: "full",
    notes: "native open / save / folder panels returning paths",
    manual: [
      "dialogs: --allow-run of osascript (macOS) / powershell.exe (Windows) lets any code in the Deno process run arbitrary scripts through them; the runtime itself passes only fixed scripts.",
      "dialogs: a path the user picks is only known at run time, but Deno Desktop bakes permissions at build time, so reading or writing it needs an unscoped --allow-read / --allow-write. The runtime narrows it to the paths picked this session; any other code in the Deno process is not narrowed.",
      "dialogs: on Linux the dialogs are the runtime's: the desktop's own (xdg-desktop-portal's FileChooser) wherever the portal offers one, GTK's otherwise (`platformFeatures().fileChooser` says which); without denext's pinned runtime they answer `unavailable` and the page keeps <input type=\"file\">.",
    ],
  },
  notifications: {
    key: "notifications",
    value: true,
    api: [
      "scheduleNotification",
      "cancelNotification",
      "pendingNotifications",
      "setNotificationCategories",
      "onLocalNotificationTapped",
      'requestPermission("notifications")',
      "requestPushPermission",
    ],
    // A runtime API (Deno.desktop.notifications of denext's pinned runtime): `new Notification()`
    // and scheduling it need --allow-sys, unscoped. Under the stock runtime the page keeps the
    // WebView's Notification API (immediate only).
    // denext's pinned runtime requires an UNSCOPED --allow-sys for it (`Deno.errors.NotCapable`
    // otherwise; a partial `--allow-sys=<names>` does not satisfy it): an app that can read the
    // clipboard, take global keys, start at login or post OS notifications may also read every
    // system-information API.
    all: { sys: ["*"] },
    trust: "broad",
    notes:
      "OS notifications: scheduled, repeating, actions, click routing (pinned runtime; WebView otherwise)",
    manual: [
      'notifications: ask first with requestPermission("notifications"): macOS shows its prompt once (only from an app bundle, not an unbundled process), and a refusal can be changed only in System Settings › Notifications.',
      "notifications: Linux has no OS scheduler — a scheduled notification is delivered by the app while it runs and re-armed at its next launch (one whose time passed meanwhile shows then); a click on a notification of a closed app does not start it there.",
      "notifications: a repeating notification is scheduled for its next 16 occurrences; each launch tops the series up, so an app not opened for longer than that stops showing it until it runs again.",
    ],
  },
  "keep-awake": {
    key: "keepAwake",
    value: true,
    api: ["useKeepAwake"],
    os: {
      darwin: { run: ["caffeinate"] },
      windows: { ffi: ["kernel32.dll"] },
      linux: { run: ["systemd-inhibit"] },
    },
    trust: "full",
    notes:
      "keep the display and machine awake (caffeinate / SetThreadExecutionState / systemd-inhibit)",
  },
  clipboard: {
    key: "clipboard",
    value: true,
    api: ["readClipboard", "writeClipboard", "clipboardFormats"],
    // A runtime API (Deno.desktop.clipboard in denext's pinned runtime): reading it and its change
    // listener need --allow-sys, unscoped (writing needs nothing). Under the stock runtime the cap
    // answers `unavailable` and the page keeps the WebView's navigator.clipboard.
    // denext's pinned runtime requires an UNSCOPED --allow-sys for it (`Deno.errors.NotCapable`
    // otherwise; a partial `--allow-sys=<names>` does not satisfy it): an app that can read the
    // clipboard, take global keys, start at login or post OS notifications may also read every
    // system-information API.
    all: { sys: ["*"] },
    trust: "broad",
    notes:
      "native clipboard: text, HTML and PNG images (pinned runtime; WebView navigator.clipboard otherwise)",
  },
  device: {
    key: "device",
    value: true,
    api: ["deviceInfo"],
    all: { sys: ["osRelease"] },
    trust: "scoped",
    notes: "OS name and release",
  },
  "global-shortcuts": {
    key: "globalShortcuts",
    value: true,
    api: ["registerShortcut (denext/desktop/app)", "unregisterShortcut", "listShortcuts"],
    // A runtime API (Deno.desktop.shortcuts): registering needs --allow-sys, unscoped. It adds
    // trust beyond the window: the app reacts to the registered key combinations while any app has
    // the focus.
    // denext's pinned runtime requires an UNSCOPED --allow-sys for it (`Deno.errors.NotCapable`
    // otherwise; a partial `--allow-sys=<names>` does not satisfy it): an app that can read the
    // clipboard, take global keys, start at login or post OS notifications may also read every
    // system-information API.
    all: { sys: ["*"] },
    trust: "broad",
    notes: "system-wide keyboard shortcuts (pinned runtime)",
    manual: [
      "global-shortcuts: a registered combination reaches the app while ANY app has the keyboard focus, and the other app no longer sees it — register only the shortcuts the user asked for, and let them change or turn them off.",
      "global-shortcuts: on Wayland the XDG GlobalShortcuts portal asks the user to approve each shortcut (and may bind another trigger); without the portal registration rejects `unsupported`.",
    ],
  },
  "launch-at-login": {
    key: "launchAtLogin",
    value: true,
    api: ["getLaunchAtLogin (denext/desktop/app)", "setLaunchAtLogin"],
    // A runtime API (Deno.desktop.launchAtLogin): `set` needs --allow-sys, unscoped (`get` needs
    // nothing); it writes an OS login entry named after desktop.app.identifier.
    // denext's pinned runtime requires an UNSCOPED --allow-sys for it (`Deno.errors.NotCapable`
    // otherwise; a partial `--allow-sys=<names>` does not satisfy it): an app that can read the
    // clipboard, take global keys, start at login or post OS notifications may also read every
    // system-information API.
    all: { sys: ["*"] },
    trust: "broad",
    notes:
      "start the app at login: macOS login item / Windows Run value / Linux autostart (pinned runtime)",
    manual: [
      "launch-at-login: turn it on only when the user asks (a settings toggle): it makes the app start with every login. macOS 13+ may answer `requires-approval` until the user allows it in System Settings › Login Items; it needs a signed app bundle.",
    ],
  },
  passkeys: {
    key: "passkeys",
    // Fail closed: an empty pin allows no relying party until the project lists its own.
    value: { rpIds: [] },
    api: ["installClerkDesktopBridge (denext/desktop/clerk)"],
    // A runtime API (Deno.desktop.passkeys), no --allow-* of its own.
    trust: "none",
    notes: "native passkeys: macOS Touch ID / iCloud Keychain, Windows Hello (pinned runtime)",
    manual: [
      "passkeys: macOS needs the associated-domains entitlement (webcredentials:<rp-id>) with a provisioning profile — set desktop.macos = { provisioningProfile, entitlements } — and the RP's apple-app-site-association must list <TeamID>.<bundle id>; otherwise every request is invalid_rp.",
      "passkeys: list your relying parties in desktop.capabilities.passkeys = { rpIds: [...] } — it is written empty, and until it names one every request is invalid_rp (on Windows nothing else ties the RP ID to the app). Linux has no native passkeys.",
    ],
  },
};

/** A capability name as typed (`secure-store`, or its config key `secureStore`) → its table name. */
function canonicalName(name: string): string | undefined {
  if (Object.hasOwn(DESKTOP_CAPABILITIES, name)) return name;
  return Object.keys(DESKTOP_CAPABILITIES).find((n) => DESKTOP_CAPABILITIES[n].key === name);
}

/** The permission kinds, in flag order. */
const PERMISSION_KINDS = ["read", "write", "net", "env", "sys", "run", "ffi"] as const;

/**
 * The union of the permissions `names` need on `os`, as `--allow-*` flags (the capabilities'
 * share only; the runtime adds its baseline).
 *
 * @param names Table names (see {@linkcode DESKTOP_CAPABILITIES}).
 * @param os The target OS.
 * @returns The flags, e.g. `["--allow-run=caffeinate,osascript"]`.
 */
export function desktopPermissionFlags(names: readonly string[], os: DesktopOs): string[] {
  const union = new Map<string, Set<string>>();
  for (const name of names) {
    const cap = DESKTOP_CAPABILITIES[canonicalName(name) ?? ""];
    if (!cap) continue;
    for (const set of [cap.all, cap.os?.[os]]) {
      for (const kind of PERMISSION_KINDS) {
        for (const v of set?.[kind] ?? []) {
          const values = union.get(kind) ?? new Set<string>();
          values.add(v);
          union.set(kind, values);
        }
      }
    }
  }
  return PERMISSION_KINDS.filter((k) => union.has(k)).map((kind) => {
    const values = [...union.get(kind)!].sort();
    return values.includes("*") ? `--allow-${kind}` : `--allow-${kind}=${values.join(",")}`;
  });
}

/**
 * The permissions every packaged desktop binary needs regardless of capabilities, and which the
 * per-capability flags widen rather than replace:
 * - `--allow-net=127.0.0.1,localhost`: `runDesktop` binds loopback and any `spa.proxy` targets a
 *   loopback backend, so the distributed binary can't reach the wider network.
 * - `--allow-read` (broad): serve the embedded `out/` AND the per-user OS app-support directory —
 *   a path only known on the end-user's machine, so it can't be baked; the runtime's fs/sqlite
 *   caps confine what the page can actually reach.
 * - `--allow-env` (broad): `PORT` plus the app's own environment.
 *
 * This mirrors the flags a migrated SPA's `deno task desktop` already bakes (see `src/build/migrate.ts`).
 */
export const DESKTOP_BASELINE_FLAGS: readonly string[] = [
  "--allow-net=127.0.0.1,localhost",
  "--allow-read",
  "--allow-env",
];

/** The capability keys enabled in a `desktop.capabilities` object (truthy; `extensions` is a
 * module list, not a capability, and a `false` value disables one). */
function enabledCapabilityKeys(capabilities: unknown): string[] {
  if (typeof capabilities !== "object" || capabilities === null) return [];
  return Object.entries(capabilities as Record<string, unknown>)
    .filter(([key, value]) => key !== "extensions" && value !== false && value != null)
    .map(([key]) => key);
}

/** The relevant slice of `denext.config.ts` for flag derivation. */
interface DesktopFlagConfig {
  readonly desktop?: {
    readonly capabilities?: unknown;
    /** Extra `--allow-*` merged into the baked flags (for the updater's feed host + data dir, an
     * extension's own permissions, or any need the catalog can't see); `--regenerate-scripts`
     * preserves it because it lives in the config. */
    readonly extraPermissions?: DesktopPermissionSet;
    /** Full-app self-update: its manifest host and extra hosts need `--allow-net`. */
    readonly update?: { readonly manifestUrl?: unknown; readonly hosts?: unknown };
    /** Deep-link schemes: claiming one back (`registerScheme({ force })`) needs `--allow-sys`. */
    readonly app?: { readonly deepLinks?: unknown };
    /** Sidecars: their own `permissions`, and what running them takes. */
    readonly sidecars?: unknown;
  };
  readonly spa?: {
    readonly proxy?: { readonly target?: unknown; readonly allowNonLoopback?: unknown };
  };
}

/** The non-loopback host of a `spa.proxy` target (only when `allowNonLoopback` opts in), else
 * `undefined` — a loopback target is already covered by the baseline. */
function proxyNetHost(
  proxy: { target?: unknown; allowNonLoopback?: unknown } | undefined,
): string | undefined {
  if (!proxy || proxy.allowNonLoopback !== true || typeof proxy.target !== "string") {
    return undefined;
  }
  try {
    return new URL(proxy.target).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** The hosts full-app self-update fetches from: the manifest URL's host plus `update.hosts`. */
function updateNetHosts(
  update: { manifestUrl?: unknown; hosts?: unknown } | undefined,
): string[] {
  const hosts: string[] = [];
  if (typeof update?.manifestUrl === "string") {
    try {
      const host = new URL(update.manifestUrl).hostname;
      if (host) hosts.push(host);
    } catch { /* an invalid URL is the config validator's to report */ }
  }
  if (Array.isArray(update?.hosts)) {
    for (const h of update.hosts) if (typeof h === "string" && h) hosts.push(h);
  }
  return hosts;
}

const kindOfFlag = (flag: string): string => flag.split("=", 1)[0];
/** A flag's values; an unscoped flag (no `=`) is `["*"]`, the whole kind. */
function valuesOfFlag(flag: string): string[] {
  const eq = flag.indexOf("=");
  return eq < 0 ? ["*"] : flag.slice(eq + 1).split(",");
}

/** The `run` / `ffi` / `sys` values from the capabilities' flags, unioned with extraPermissions'. */
function bakeableSets(
  capFlags: readonly string[],
  extra: DesktopPermissionSet,
): { run: Set<string>; ffi: Set<string>; sys: Set<string> } {
  const run = new Set(extra.run ?? []);
  const ffi = new Set(extra.ffi ?? []);
  const sys = new Set(extra.sys ?? []);
  const byKind: Record<string, Set<string> | undefined> = {
    "--allow-run": run,
    "--allow-ffi": ffi,
    "--allow-sys": sys,
  };
  for (const f of capFlags) {
    const set = byKind[kindOfFlag(f)];
    if (set) { for (const v of valuesOfFlag(f)) set.add(v); }
  }
  return { run, ffi, sys };
}

/** The `desktop.sidecars` entries of a config (an invalid value reads as none). */
function configSidecars(cfg: DesktopFlagConfig): SidecarDefinition[] {
  const raw = cfg.desktop?.sidecars;
  return Array.isArray(raw) ? raw.filter((d) => typeof d === "object" && d !== null) : [];
}

/** Whether a program path is one of the project's files (relative, with a folder part). */
function isProjectProgram(exec: string): boolean {
  return /[\\/]/.test(exec) && !isAbsolute(exec);
}

/**
 * What the sidecars need baked in, as one permission set: each one's own `permissions`; a program
 * (`run.exec`) its `--allow-run` (unscoped for one of the project's files: the packaged app runs
 * it from a copy in the app's cache folder, which also needs `--allow-write`); a log file
 * `--allow-write`.
 *
 * @param sidecars The sidecars.
 * @returns The permissions, merged like `desktop.extraPermissions`.
 */
export function sidecarPermissionSet(sidecars: readonly SidecarDefinition[]): DesktopPermissionSet {
  const out: Record<string, Set<string>> = {};
  for (const d of sidecars) {
    for (const [kind, values] of sidecarNeeds(d)) {
      const set = out[kind] ??= new Set();
      for (const v of values) set.add(v);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/** One sidecar's needs as `[kind, values]`: its `permissions`, its program, its log file. */
function sidecarNeeds(d: SidecarDefinition): Array<[string, readonly string[]]> {
  const needs = Object.entries(d.permissions ?? {}).filter(
    (e): e is [string, readonly string[]] => Array.isArray(e[1]),
  );
  const exec = (d.run as { exec?: unknown } | undefined)?.exec;
  if (typeof exec === "string") {
    const embedded = isProjectProgram(exec);
    needs.push(["run", [embedded ? "*" : exec]]);
    if (embedded) needs.push(["write", ["$CACHE"]]);
  }
  if (d.logs === "file" || d.logs === "both") needs.push(["write", ["$APPDATA"]]);
  return needs;
}

/** Two permission sets as one (each kind's values unioned). */
function mergePermissionSets(
  a: DesktopPermissionSet,
  b: DesktopPermissionSet,
): DesktopPermissionSet {
  const out: Record<string, string[]> = {};
  for (const kind of PERMISSION_KINDS) {
    const values = [...new Set([...(a[kind] ?? []), ...(b[kind] ?? [])])];
    if (values.length > 0) out[kind] = values;
  }
  return out;
}

/**
 * The full `--allow-*` flag list to bake into the `deno desktop` binary for `os` — the
 * least-privilege replacement for `-A` in the package scripts — derived from the WHOLE project
 * config, not just `desktop.capabilities` (deriving from capabilities alone would starve the
 * non-capability runtime features: an audit found the updater, `openAuthSession` and a non-loopback
 * proxy all broke). On top of {@linkcode DESKTOP_BASELINE_FLAGS} it adds:
 * - the enabled capabilities' `run` / `ffi` / `sys` exactly (the real least-privilege wins), and a
 *   single broad `--allow-write` when any capability writes (a per-user path can't be baked; the
 *   runtime cap layer confines it); an unscoped `--allow-sys` when a capability needs it
 *   (clipboard, global shortcuts, launch at login, notifications) or `desktop.app.deepLinks`
 *   declares a scheme (claiming it back needs it): the pinned runtime refuses those with
 *   `NotCapable` under a partial `--allow-sys=<names>`;
 * - a non-loopback `spa.proxy` target's host, MERGED into the single `--allow-net` (Deno keeps only
 *   the last `--allow-net`, so every host is one flag), and so are full-app self-update's hosts
 *   (`desktop.update.manifestUrl`'s and `desktop.update.hosts`);
 * - `desktop.extraPermissions` — the escape hatch for what the catalog can't see: the updater's
 *   feed host (`net`) and data dir (`write`), an extension's own `run`/`ffi`, etc. It is UNIONED
 *   in, and `--regenerate-scripts` preserves it because it lives in the config, not the script.
 * A capability's `read`/`env` is dropped (already broad in the baseline); a capability's `net`
 * (only `downloadToFile`'s `*`) is dropped too — per-host download access is an `extraPermissions`
 * grant, never `*` baked in.
 *
 * @param config The project config (`denext.config.ts` default export), or `undefined` — baseline only.
 * @param os The target OS.
 * @returns The flags, ready to splice into the `deno desktop` argv (never `-A`).
 */
export function desktopBuildFlags(config: unknown, os: DesktopOs): string[] {
  const cfg = (typeof config === "object" && config !== null ? config : {}) as DesktopFlagConfig;
  // `desktop.extraPermissions` and what the sidecars need, baked the same way.
  const extra = mergePermissionSets(
    cfg.desktop?.extraPermissions ?? {},
    sidecarPermissionSet(configSidecars(cfg)),
  );
  const capFlags = desktopPermissionFlags(enabledCapabilityKeys(cfg.desktop?.capabilities), os);

  // net: baseline loopback + a non-loopback spa.proxy host + extraPermissions.net, as ONE flag.
  const net = new Set<string>(["127.0.0.1", "localhost", ...(extra.net ?? [])]);
  const proxyHost = proxyNetHost(cfg.spa?.proxy);
  if (proxyHost) net.add(proxyHost);
  for (const host of updateNetHosts(cfg.desktop?.update)) net.add(host);

  const { run, ffi, sys } = bakeableSets(capFlags, extra);
  // Deep links: the pinned runtime lets the app claim a declared scheme back from another handler
  // (`registerScheme({ force: true })`, `claimDeepLinkScheme` on a user action) only with an
  // unscoped --allow-sys.
  if (Array.isArray(cfg.desktop?.app?.deepLinks) && cfg.desktop.app.deepLinks.length > 0) {
    sys.add("*");
  }
  // write: broad when a capability writes or extraPermissions asks (per-user paths can't be baked).
  const needsWrite = capFlags.some((f) => kindOfFlag(f) === "--allow-write") ||
    (extra.write?.length ?? 0) > 0;
  // `"*"` grants the whole kind (an unscoped `--allow-ffi`): a Node-API addon extracted from the
  // compiled app's virtual file system has no path that can be named at package time.
  const listFlag = (kind: string, set: Set<string>): string[] =>
    set.has("*")
      ? [`--allow-${kind}`]
      : set.size > 0
      ? [`--allow-${kind}=${[...set].sort().join(",")}`]
      : [];

  return [
    // `"*"` (a sidecar or `extraPermissions` that talks to any host) is the unscoped flag.
    net.has("*") ? "--allow-net" : `--allow-net=${[...net].sort().join(",")}`,
    "--allow-read",
    "--allow-env",
    ...(needsWrite ? ["--allow-write"] : []),
    ...listFlag("sys", sys),
    ...listFlag("run", run),
    ...listFlag("ffi", ffi),
  ];
}

/**
 * The `deno desktop` `--allow-*` flags for a scaffolded packaging script: read the project's
 * `denext.config.ts` (next to `entryUrl` — a packaging script lives in `scripts/`, so the config
 * is `../denext.config.ts`) and derive the least-privilege flags for `os` via {@linkcode
 * desktopBuildFlags}. A project without a config (or one that exports none) gets the baseline. The
 * config is imported dynamically at run time from a caller-supplied URL, so it is never part of
 * this module's own dependency graph (nor a build-time import of user code).
 *
 * @param entryUrl The packaging script's `import.meta.url`.
 * @param os The target OS.
 * @returns The `--allow-*` flags, ready to splice into the `deno desktop` argv.
 */
export async function desktopPackageFlags(entryUrl: string, os: DesktopOs): Promise<string[]> {
  let config: unknown;
  try {
    const mod = await import(new URL("../denext.config.ts", entryUrl).href);
    config = (mod as { default?: unknown }).default;
  } catch {
    // no denext.config.ts (or it exports no config) → baseline only
  }
  return desktopBuildFlags(config, os);
}

/** The `desktop.capabilities.extensions` module paths from a config object (each a project-relative
 * path a packaging build must embed), else `[]`. */
function configExtensionPaths(config: unknown): string[] {
  const cfg = (typeof config === "object" && config !== null ? config : {}) as DesktopFlagConfig;
  const caps = cfg.desktop?.capabilities;
  const exts = (typeof caps === "object" && caps !== null)
    ? (caps as { extensions?: unknown }).extensions
    : undefined;
  return Array.isArray(exts) ? exts.filter((p): p is string => typeof p === "string") : [];
}

/**
 * The extra args a scaffolded packaging script must add so the packaged binary embeds every module
 * the app loads at runtime, and loads each one from the binary, never from the build machine's
 * disk:
 *
 * - `--include <path>` per `desktop.capabilities.extensions` module — otherwise the app launches
 *   but the runtime fails to load the extension ("Module not found"), since `--include out` only
 *   bundles the export;
 * - `--import-map <.deno-desktop/import-map.json>` when deno.json's import map has an absolute
 *   local target (`"denext/desktop": "file:///…"`): a compiled binary resolves such a target to the
 *   build machine's path, so a relocatable copy of the map is written and used instead.
 *
 * Reads the project's `denext.config.ts` and deno.json next to `entryUrl` (a `scripts/` script →
 * `../`), like {@linkcode desktopPackageFlags}; a project with neither gets `[]`.
 *
 * @param entryUrl The packaging script's `import.meta.url`.
 * @returns `["--include", path, …, "--import-map", file]`, ready to splice into the `deno desktop`
 * argv.
 */
export async function desktopIncludeArgs(entryUrl: string, os?: DesktopOs): Promise<string[]> {
  let config: unknown;
  try {
    const mod = await import(new URL("../denext.config.ts", entryUrl).href);
    config = (mod as { default?: unknown }).default;
  } catch {
    // no denext.config.ts (or it exports no config) → no extensions to embed
  }
  const includes = configExtensionPaths(config).flatMap((p) => ["--include", p]);
  const projectUrl = new URL("../", entryUrl);
  const local = projectUrl.protocol === "file:";
  const importMap = local ? await desktopImportMapArgsFor(fromFileUrl(projectUrl)) : [];
  const sidecars = local
    ? await desktopSidecarIncludeArgs(fromFileUrl(projectUrl), config, os)
    : [];
  return [...includes, ...sidecars, ...importMap];
}

/** The bundler's module, imported by a computed specifier so `deno desktop` never embeds esbuild. */
const SIDECAR_BUNDLER = "./desktop-sidecar-bundle.ts";

/**
 * The `--include`s of `desktop.sidecars`: a Node backend's bundle (built now, see
 * `desktop-sidecar-bundle.ts`), a module sidecar's module, and a program sidecar's file when it is
 * one of the project's (a relative path).
 *
 * @param projectDir The project root.
 * @param config The project config.
 * @param os The OS packaged for (default: the host's).
 * @returns The args.
 */
export async function desktopSidecarIncludeArgs(
  projectDir: string,
  config: unknown,
  os?: DesktopOs,
): Promise<string[]> {
  const cfg = (typeof config === "object" && config !== null ? config : {}) as DesktopFlagConfig;
  const sidecars = configSidecars(cfg);
  if (sidecars.length === 0) return [];
  // Typed locally: even a type-only reference would put esbuild in importers' module graphs.
  const bundler = await import(new URL(SIDECAR_BUNDLER, import.meta.url).href) as {
    bundleDesktopSidecars(
      projectDir: string,
      config: unknown,
      os?: DesktopOs,
    ): Promise<Array<{ dir: string }>>;
  };
  const reports = await bundler.bundleDesktopSidecars(projectDir, config, os);
  const args = reports.flatMap((r) => ["--include", r.dir]);
  for (const d of sidecars) {
    const run = d.run as { module?: unknown; nodeModules?: unknown; exec?: unknown };
    if (typeof run.module === "string" && run.nodeModules === undefined) {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(run.module)) args.push("--include", run.module);
    } else if (typeof run.exec === "string" && isProjectProgram(run.exec)) {
      args.push("--include", run.exec);
    }
  }
  return args;
}

/**
 * `deno desktop` args for a project with a `node_modules` directory (a next-compat app, whose npm
 * packages live there): resolve npm packages from Deno's cache and embed only those the desktop
 * entry's module graph reaches. Without them `deno desktop` — a compile — embeds the WHOLE
 * `node_modules` (hundreds of MB for `next` and its peers) that the window, serving a static
 * export, never loads. A project with a `package.json` but no `node_modules` yet (a fresh clone
 * before `deno install`) gets them too: the `package.json` puts Deno in manual `node_modules`
 * mode, where the type check fails on `npm:@types/node` ("Could not find a matching package … in
 * the node_modules directory"); from the cache it resolves. A project with neither gets `[]`.
 *
 * @param projectDir The project directory.
 * @returns `["--node-modules-dir=none", "--exclude-unused-npm"]`, or `[]`.
 */
export async function desktopNpmArgsFor(projectDir: string): Promise<string[]> {
  const has = (name: string, dir: boolean) =>
    Deno.stat(join(projectDir, name)).then((s) => dir ? s.isDirectory : s.isFile, () => false);
  const npm = await has("node_modules", true) || await has("package.json", false);
  return npm ? ["--node-modules-dir=none", "--exclude-unused-npm"] : [];
}

/**
 * {@linkcode desktopNpmArgsFor} for a packaging script: the project is the script's parent
 * directory (`scripts/package-*.ts` → `../`), as {@linkcode desktopIncludeArgs} reads it.
 *
 * @param entryUrl The packaging script's `import.meta.url`.
 * @returns The args to splice into the `deno desktop` argv.
 */
export function desktopNpmArgs(entryUrl: string): Promise<string[]> {
  return desktopNpmArgsFor(fromFileUrl(new URL("../", entryUrl)));
}

/**
 * The `--list` table: name, config key, trust, note.
 *
 * @param table The capabilities (tests pass their own).
 * @returns The formatted table.
 */
export function formatDesktopCapabilityTable(
  table: Readonly<Record<string, DesktopCapabilityEntry>> = DESKTOP_CAPABILITIES,
): string {
  return Object.entries(table).map(([name, c]) =>
    `  ${name.padEnd(15)}${c.key.padEnd(15)}${c.trust.padEnd(8)}${c.notes}`
  ).join("\n");
}

/** Options for {@linkcode addDesktopCapabilities}. */
export interface AddDesktopCapabilitiesOptions {
  /** Capability names (table names or config keys). */
  readonly capabilities: readonly string[];
  /** The project directory. */
  readonly dir: string;
  /** Plan only: compute the edit and write nothing. */
  readonly dryRun?: boolean;
}

/** What {@linkcode addDesktopCapabilities} did (or would do, with `dryRun`). */
export interface AddDesktopCapabilitiesReport {
  /** The config file edited (or created). */
  readonly configPath: string;
  /** Whether the config file was created. */
  readonly created: boolean;
  /** Capabilities whose key was written. */
  readonly added: readonly string[];
  /** Capabilities already present (left as written). */
  readonly kept: readonly string[];
  /** The unified diff of the config edit (empty when nothing changed). */
  readonly diff: string;
  /** The `--allow-*` flags the enabled capabilities need, per OS. */
  readonly permissions: Readonly<Record<DesktopOs, readonly string[]>>;
  /** The highest trust among the requested capabilities. */
  readonly trust: DesktopTrust;
  /** Steps to do by hand. */
  readonly manual: readonly string[];
}

/** Trust levels, lowest first. */
const TRUST_ORDER: readonly DesktopTrust[] = ["none", "scoped", "broad", "full"];

/** The first existing config file under `dir`, or undefined. */
async function findConfig(dir: string): Promise<string | undefined> {
  for (const name of CONFIG_FILES) {
    try {
      await Deno.stat(join(dir, name));
      return join(dir, name);
    } catch {
      // not this one
    }
  }
  return undefined;
}

/** The value at `desktop.capabilities.<key>` in a config source, when it is a data literal. */
async function presentKeys(source: string): Promise<Set<string>> {
  const model = await readConfigModel(source);
  const desktop = model.keys.desktop;
  const caps = desktop?.kind === "editable"
    ? (desktop.value as { capabilities?: unknown } | null)?.capabilities
    : undefined;
  return new Set(
    typeof caps === "object" && caps !== null ? Object.keys(caps as Record<string, unknown>) : [],
  );
}

/** The config a project without one gets. */
const NEW_CONFIG = "// denext.config.ts\nexport default {};\n";

/** The table names for `raw` (deduplicated), or a throw for an empty list / unknown name. */
function resolveNames(raw: readonly string[]): string[] {
  if (raw.length === 0) {
    throw new Error("name at least one capability (see `denext desktop add --list`)");
  }
  const names: string[] = [];
  for (const r of raw) {
    const name = canonicalName(r);
    if (!name) throw new Error(`unknown capability "${r}" (see \`denext desktop add --list\`)`);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Splice each capability not yet present into `source`; throws with the by-hand snippet. */
async function spliceCapabilities(
  before: string,
  names: readonly string[],
  configPath: string,
): Promise<{ source: string; added: string[]; kept: string[] }> {
  const present = await presentKeys(before);
  let source = before;
  const added: string[] = [];
  const kept: string[] = [];
  for (const name of names) {
    const cap = DESKTOP_CAPABILITIES[name];
    if (present.has(cap.key)) {
      kept.push(name);
      continue;
    }
    const edit = await setConfigValue(source, ["desktop", "capabilities", cap.key], cap.value);
    if (!edit.ok) {
      throw new Error(
        `cannot edit ${configPath}: ${edit.reason}\n  Add by hand: desktop: { capabilities: { ${cap.key}: ${
          JSON.stringify(cap.value)
        } } }`,
      );
    }
    source = edit.source;
    added.push(name);
  }
  // Once a real `capabilities` block exists, drop the scaffold's commented placeholder hint so it
  // doesn't linger beside it (`// capabilities: { … },  // denext desktop add <cap>`).
  if (added.length > 0 || kept.length > 0) source = removeCapabilitiesHint(source);
  return { source, added, kept };
}

/** Remove the scaffold's commented `// capabilities: … // denext desktop add <cap>` placeholder
 * line (only that specific hint — any other comment is preserved). */
function removeCapabilitiesHint(source: string): string {
  return source.replace(/^[ \t]*\/\/ capabilities:.*denext desktop add.*\r?\n/m, "");
}

/** The highest trust among `names`. */
function highestTrust(names: readonly string[]): DesktopTrust {
  return names.map((n) => DESKTOP_CAPABILITIES[n].trust)
    .reduce<DesktopTrust>(
      (a, b) => TRUST_ORDER.indexOf(b) > TRUST_ORDER.indexOf(a) ? b : a,
      "none",
    );
}

/**
 * Enable `capabilities` in the project's `desktop.capabilities`. Idempotent: a key already
 * present is kept as written.
 *
 * @param opts The capabilities, the project directory, and `dryRun`.
 * @returns What changed (or would change), with the permissions the capabilities need.
 * Throws for an unknown capability, or when the config cannot be edited (its `desktop` value is
 * code, not data); the message then carries the snippet to add by hand.
 */
export async function addDesktopCapabilities(
  opts: AddDesktopCapabilitiesOptions,
): Promise<AddDesktopCapabilitiesReport> {
  const names = resolveNames(opts.capabilities);
  const existing = await findConfig(opts.dir);
  const configPath = existing ?? join(opts.dir, "denext.config.ts");
  const before = existing ? await Deno.readTextFile(existing) : NEW_CONFIG;
  const { source, added, kept } = await spliceCapabilities(before, names, configPath);
  const changed = source !== before || !existing;
  const label = basename(configPath);
  const diff = changed
    ? createUnifiedDiff(existing ? before : "", source, `a/${label}`, `b/${label}`)
    : "";
  if (changed && !opts.dryRun) await Deno.writeTextFile(configPath, source);
  const permissions = Object.fromEntries(
    DESKTOP_OSES.map((os) => [os, desktopPermissionFlags(names, os)]),
  ) as Record<DesktopOs, string[]>;
  const trust = highestTrust(names);
  return {
    configPath,
    created: !existing,
    added,
    kept,
    diff,
    permissions,
    trust,
    manual: names.flatMap((n) => DESKTOP_CAPABILITIES[n].manual ?? []),
  };
}

/**
 * The human report for an add (or a `--dry-run` plan).
 *
 * @param report What {@linkcode addDesktopCapabilities} returned.
 * @param dryRun Whether nothing was written.
 * @returns The lines to print.
 */
export function formatDesktopAddReport(
  report: AddDesktopCapabilitiesReport,
  dryRun: boolean,
): string {
  const lines: string[] = [];
  const verb = dryRun ? "would enable" : "enabled";
  if (report.added.length > 0) {
    lines.push(`  ${verb}: ${report.added.join(", ")}  (${report.configPath})`);
  }
  if (report.kept.length > 0) lines.push(`  already enabled: ${report.kept.join(", ")}`);
  if (report.created) lines.push(`  ${dryRun ? "would create" : "created"} ${report.configPath}`);
  if (report.diff) lines.push("", report.diff.trimEnd());
  lines.push("", "  Deno permissions these capabilities add (the package scripts derive them):");
  for (const os of DESKTOP_OSES) {
    const flags = report.permissions[os];
    lines.push(`    ${os.padEnd(8)}${flags.length > 0 ? flags.join(" ") : "(none)"}`);
  }
  if (report.trust === "broad" || report.trust === "full") {
    lines.push(
      "",
      report.trust === "full"
        ? "  Trust: FULL: a spawned program or native library can do anything the user can."
        : "  Trust: BROAD: an unscoped permission: the filesystem (see the dialogs note) or every " +
          "system-information API (--allow-sys).",
    );
  }
  if (report.manual.length > 0) {
    lines.push("", "  By hand:", ...report.manual.map((m) => `    - ${m}`));
  }
  return lines.join("\n");
}
