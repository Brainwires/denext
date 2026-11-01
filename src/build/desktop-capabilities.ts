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

import { createHash } from "node:crypto";
import { basename, fromFileUrl, isAbsolute, join } from "@std/path";
import { assertInsideProject } from "./project-confine.ts";
import { CONFIG_FILES } from "./paths.ts";
import { readConfigModel, setConfigValue } from "./config-edit.ts";
import { createUnifiedDiff } from "./patch-diff.ts";
import { desktopImportMapArgsFor } from "./desktop-import-map.ts";
import { desktopNetSplitFor } from "./desktop-runtime.ts";
import {
  desktopCacheTokenRuntime,
  desktopDataTokenRuntime,
  desktopSidecarIntegrityRuntime,
} from "./desktop-launch-policy.ts";
import { netSplitFlags } from "./net-permissions.ts";
import type { SidecarDefinition } from "../desktop/sidecar.ts";
import { LOGIN_SHELL_PATHS } from "../desktop/sidecar-login-env.ts";
import { permissionListError } from "../desktop/permission-entries.ts";
import { loadConfigBeside } from "./desktop-config-beside.ts";
import { DESKTOP_RUNTIME_ENV } from "./desktop-runtime-env.ts";
import {
  desktopPermissionsMode,
  desktopPermissionsProblem,
  strictPermissionsSidecarError,
} from "../desktop/permissions-mode.ts";

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
  /** `--allow-net`: hosts, both directions. */
  readonly net?: readonly string[];
  /** Outbound hosts only (`--allow-net-connect` where the runtime splits the network grant). */
  readonly netConnect?: readonly string[];
  /** Listen addresses only (`--allow-net-listen` where the runtime splits the network grant). */
  readonly netListen?: readonly string[];
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

/** The by-hand step for a passkeys capability added without `--rp-id` (its `rpIds` is empty). */
const PASSKEY_RP_IDS_MANUAL =
  "passkeys: list your relying parties in desktop.capabilities.passkeys = { rpIds: [...] } (`denext desktop add passkeys --rp-id <domain>`, repeatable, writes them) — it is written empty, and until it names one every request is invalid_rp (on Windows nothing else ties the RP ID to the app).";

/** One DNS label of a hostname: letters, digits and inner hyphens, 1–63 characters. */
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A relying-party ID as `--rp-id` takes it: a registrable domain (`example.com`,
 * `clerk.example.com`), lowercased, an internationalised name in its punycode form. A scheme,
 * port, path, IP address, single-label name (`localhost`) or empty label is refused, as no
 * passkey ceremony could name it for a packaged app.
 *
 * @param raw The ID as typed.
 * @returns The normalised ID.
 * Throws when it is not a registrable domain.
 */
export function passkeyRpId(raw: string): string {
  const id = raw.trim().toLowerCase();
  let host = id;
  if (/[^ -~]/.test(id) && !/[/:?#@\s]/.test(id)) {
    try {
      host = new URL(`https://${id}`).hostname;
    } catch { /* refused below */ }
  }
  const labels = host.split(".");
  const ok = host.length <= 253 && labels.length >= 2 && labels.every((l) => DNS_LABEL.test(l)) &&
    !/^[0-9]+$/.test(labels[labels.length - 1]);
  if (!ok) {
    throw new Error(
      `--rp-id "${raw}" is not a registrable domain: give the relying party's domain, such as ` +
        "example.com (no scheme, port, path or IP address)",
    );
  }
  return host;
}

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
      "app files under the OS app-support / cache folders (survive relaunch); broad --allow-write baked (the app's folders alone from runtime 3.0.0-denext.8 with desktop.app.identifier)",
    manual: [
      'fs: `directory: "documents"` needs "$DOCUMENTS" in desktop.capabilities.fs.read/write (it maps to ~/Documents/<app>); add it by hand if you use it.',
      "fs: the packaged binary bakes a broad --allow-write (the per-user app-support path can't be baked) unless the runtime expands $DENO_DESKTOP_DATA / $DENO_DESKTOP_CACHE (3.0.0-denext.8, with desktop.app.identifier), which scopes it to the app's folders; the runtime cap layer confines writes to the app's folders. downloadToFile fetches in the Deno process, so each download host needs net in desktop.extraPermissions (beyond the loopback baseline).",
    ],
  },
  sqlite: {
    key: "sqlite",
    value: true,
    api: ["openSqlite", "deleteSqlite"],
    all: { read: ["$APPDATA"], write: ["$APPDATA"] },
    // BROAD for the same reason as `fs`: the app-support path can't be baked, so --allow-write is broad.
    trust: "broad",
    notes:
      "node:sqlite database files in the app-support folder (broad --allow-write baked; the folder alone from runtime 3.0.0-denext.8 with desktop.app.identifier)",
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
      "shell: --allow-run of the OS launchers (open and osascript / explorer.exe, rundll32.exe and powershell.exe / xdg-open, gio and dbus-send) can start any app the user can; the runtime only passes URLs of the listed schemes and paths inside the fs scope or picked this session.",
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
  updates: {
    key: "updates",
    value: true,
    api: ["checkForUpdates (denext/updates)", "applyUpdates"],
    // The UI overlay is staged and kept under the app-support folder (a broad --allow-write, as for
    // `fs`); the feed and manifest hosts come from `desktop.update` (`ui.feedUrl`, `manifestUrl`,
    // `hosts`) and the full-app swap is the pinned runtime's own.
    all: { write: ["$APPDATA"] },
    trust: "broad",
    notes:
      "the page installs the app's signed updates: the UI overlay (desktop.update.ui) and the full app (desktop.update.manifestUrl, pinned runtime)",
    manual: [
      "updates: set desktop.update.ui = { feedUrl, publicKey } (a signed `denext ota manifest` export) and/or desktop.update.manifestUrl + publicKey (`denext desktop publish-update`); a target without its config is reported as not configured.",
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
      PASSKEY_RP_IDS_MANUAL,
      "passkeys: the packaged app's laufey-launch.json carries desktop.capabilities.passkeys.rpIds as passkeyRpIds, enforced natively; from runtime 3.0.0-denext.1 (strictPolicy) a launch file without it refuses every request. Linux has no OS passkey API: USB security keys work natively under runtime 3.0.0-rc.1+ (libwebauthn), the browser otherwise.",
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

/**
 * The listen addresses every packaged desktop binary gets where the runtime splits the network
 * grant: `runDesktop` and a sidecar's `port: "auto"` bind loopback, on a port chosen at launch.
 */
const DESKTOP_LISTEN_BASELINE = ["127.0.0.1", "localhost"] as const;

/** Options for {@linkcode desktopBuildFlags}. */
export interface DesktopBuildFlagOptions {
  /**
   * The runtime has the direction-split network flags (denext's pinned Deno Desktop runtime and
   * toolchain, 3.0.0-rc.2 or later; see `desktopNetSplit`): bake `--allow-net-connect` +
   * `--allow-net-listen` instead of `--allow-net`. Default `false` (the stock runtime's flags).
   */
  readonly netSplit?: boolean;
  /**
   * The runtime expands `$DENO_DESKTOP_CACHE` in a baked permission (denext's pinned Deno Desktop
   * runtime, 3.0.0-denext.8 or later; see `desktopCacheTokenRuntime`): a program sidecar copied
   * into the app's cache folder gets `--allow-run` over that copy alone, when
   * `desktop.app.identifier` names the folder. Default: `desktopCacheTokenRuntime()`.
   */
  readonly cacheScope?: boolean;
  /**
   * The project directory, where a project-file program sidecar is read and hashed at packaging.
   * Without it the program's grant records no hash.
   */
  readonly projectDir?: string;
  /**
   * The runtime checks a program sidecar's recorded hash at spawn (denext's pinned Deno Desktop
   * runtime, 3.0.0-denext.9 or later; see `desktopSidecarIntegrityRuntime`), so its `--allow-run`
   * records the hash and it needs no write grant. Needs `cacheScope` and `projectDir`. Default:
   * `desktopSidecarIntegrityRuntime()`.
   */
  readonly sidecarIntegrity?: boolean;
  /**
   * The runtime expands `$DENO_DESKTOP_DATA` (and `$DENO_DESKTOP_CACHE`) in a baked permission
   * (denext's pinned Deno Desktop runtime, 3.0.0-denext.8 or later; see `desktopDataTokenRuntime`):
   * the app-folder writes (`$APPDATA`, `$CACHE`: the `fs` / `sqlite` / `updates` capabilities, a
   * sidecar's log file, the UI overlay's `ui-updates`) are baked as those folders instead of an
   * unscoped `--allow-write`, when `desktop.app.identifier` names them. Default:
   * `desktopDataTokenRuntime()`.
   */
  readonly dataScope?: boolean;
}

/** The relevant slice of `denext.config.ts` for flag derivation. */
interface DesktopFlagConfig {
  readonly desktop?: {
    readonly capabilities?: unknown;
    /** Extra `--allow-*` merged into the baked flags (for the updater's feed host + data dir, an
     * extension's own permissions, or any need the catalog can't see); `--regenerate-scripts`
     * preserves it because it lives in the config. */
    readonly extraPermissions?: DesktopPermissionSet;
    /** Self-update: the manifest host, the UI overlay's feed host and extra hosts need
     * `--allow-net`; the UI overlay (`ui`) is written under the app-support folder. */
    readonly update?: {
      readonly manifestUrl?: unknown;
      readonly hosts?: unknown;
      readonly ui?: unknown;
    };
    /** Deep-link schemes: claiming one back (`registerScheme({ force })`) needs `--allow-sys`. */
    readonly app?: { readonly deepLinks?: unknown; readonly identifier?: unknown };
    /** Sidecars: their own `permissions`, and what running them takes. */
    readonly sidecars?: unknown;
    /** `"strict"` scopes the baked read and environment grants. */
    readonly permissions?: unknown;
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

/** The host of `url`, or `undefined` (an invalid URL is the config validator's to report). */
function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The hosts self-update fetches from: the full-app manifest URL's host, the UI overlay's feed host
 * (`update.ui.feedUrl`) and `update.hosts`, each entry of which is checked by
 * `permissionListError` like any other baked network list (an entry with a comma would grant two
 * hosts, a URL is no host): an invalid one fails the build rather than bake a wider grant.
 */
function updateNetHosts(
  update: { manifestUrl?: unknown; hosts?: unknown; ui?: unknown } | undefined,
): string[] {
  const hosts: string[] = [];
  for (const url of [update?.manifestUrl, (update?.ui as { feedUrl?: unknown })?.feedUrl]) {
    const host = hostOf(url);
    if (host) hosts.push(host);
  }
  if (update?.hosts !== undefined) {
    const error = permissionListError("net", update.hosts);
    if (error) throw new Error(`denext: desktop.update.hosts ${error}`);
    hosts.push(...update.hosts as string[]);
  }
  return hosts;
}

const kindOfFlag = (flag: string): string => flag.split("=", 1)[0];

/**
 * Whether the broad `--allow-write` is baked: a capability writes, `extraPermissions` asks (a
 * per-user path can't be baked), or the UI overlay (`desktop.update.ui`) keeps its boot marker and
 * staged versions in the app-support folder.
 */
function bakesWrite(
  capFlags: readonly string[],
  extra: DesktopPermissionSet,
  cfg: DesktopFlagConfig,
): boolean {
  return capFlags.some((f) => kindOfFlag(f) === "--allow-write") ||
    (extra.write?.length ?? 0) > 0 || cfg.desktop?.update?.ui !== undefined;
}

/**
 * The `--allow-write` to bake: none, the broad one ({@linkcode bakesWrite}), or a scoped list. With
 * `dataScope` (a runtime that expands both folder tokens, in an app with `desktop.app.identifier`)
 * every write the app needs is baked as its folder ({@linkcode desktopScopedPath}) unless one of
 * them cannot be (`*`, `$DOCUMENTS`, a relative path), which keeps the broad grant. Without it,
 * only program sidecars' folders in the app's cache (`$DENO_DESKTOP_CACHE/…`, baked only for a
 * runtime that expands it) are scoped, when they are the only writes.
 */
function writeFlags(
  capFlags: readonly string[],
  extra: DesktopPermissionSet,
  cfg: DesktopFlagConfig,
  dataScope = false,
): string[] {
  if (!bakesWrite(capFlags, extra, cfg)) return [];
  if (dataScope) {
    const scoped = scopedValues(writeValues(capFlags, extra, cfg));
    return scoped ? [`--allow-write=${scoped.join(",")}`] : ["--allow-write"];
  }
  const write = extra.write ?? [];
  const scoped = cfg.desktop?.update?.ui === undefined &&
    !capFlags.some((f) => kindOfFlag(f) === "--allow-write") &&
    write.every((v) => v.startsWith(`${DESKTOP_CACHE_TOKEN}/`));
  return scoped ? [`--allow-write=${[...write].sort().join(",")}`] : ["--allow-write"];
}

/** The `fs` capability's configured `read` or `write` folders (`desktop.capabilities.fs`). */
function fsConfigFolders(cfg: DesktopFlagConfig, kind: "read" | "write"): string[] {
  const fs = (cfg.desktop?.capabilities as { fs?: unknown } | undefined)?.fs;
  const list = typeof fs === "object" && fs !== null ? (fs as Record<string, unknown>)[kind] : [];
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

/** Every value the app writes: the capabilities', the `fs` folders, extras, the UI overlay's. */
function writeValues(
  capFlags: readonly string[],
  extra: DesktopPermissionSet,
  cfg: DesktopFlagConfig,
): string[] {
  return [
    ...capFlags.filter((f) => kindOfFlag(f) === "--allow-write").flatMap(valuesOfFlag),
    ...fsConfigFolders(cfg, "write"),
    ...(extra.write ?? []),
    // The UI overlay is staged and kept in `<data>/ui-updates` (src/desktop/updater.ts).
    ...(cfg.desktop?.update?.ui !== undefined ? [UI_UPDATES_FOLDER] : []),
  ];
}

/** Values as {@linkcode desktopScopedPath}s, sorted and unique, or `undefined` if one is not. */
function scopedValues(values: readonly string[]): string[] | undefined {
  const out = new Set<string>();
  for (const value of values) {
    const scoped = desktopScopedPath(value);
    if (scoped === undefined) return undefined;
    out.add(scoped);
  }
  return [...out].sort();
}

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
 * The token denext's Deno Desktop runtime (from 3.0.0-denext.8) expands at launch, at the start of
 * a baked `--allow-read` / `--allow-write` / `--allow-run` value, to the app's cache folder:
 * `desktopAppDirs(<desktop.app.identifier>).cache` (Brainwires/deno DENEXT.md item 189).
 */
export const DESKTOP_CACHE_TOKEN = "$DENO_DESKTOP_CACHE";

/**
 * The token denext's Deno Desktop runtime (from 3.0.0-denext.8) expands at launch, at the start of
 * a baked `--allow-read` / `--allow-write` / `--allow-run` value, to the app's data folder:
 * `desktopAppDirs(<desktop.app.identifier>).data` — macOS `~/Library/Application Support/<id>`,
 * Windows `%APPDATA%\<id>`, Linux `$XDG_DATA_HOME|~/.local/share/<id>` (Brainwires/deno DENEXT.md
 * item 191). A value with a `..` component, or with no folder to expand to, is dropped from an
 * allow list.
 */
export const DESKTOP_DATA_TOKEN = "$DENO_DESKTOP_DATA";

/** Where the UI overlay keeps its versions (`<data>/ui-updates`, src/desktop/updater.ts). */
const UI_UPDATES_FOLDER = "$APPDATA/ui-updates";

/** The config path tokens a runtime that expands the folder tokens takes, and what they become. */
const FOLDER_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["$APPDATA", DESKTOP_DATA_TOKEN],
  ["$CACHE", DESKTOP_CACHE_TOKEN],
  [DESKTOP_DATA_TOKEN, DESKTOP_DATA_TOKEN],
  [DESKTOP_CACHE_TOKEN, DESKTOP_CACHE_TOKEN],
];

/** An absolute path on any desktop OS (`/x`, `C:\x`, `C:/x`, `\\server\share`). */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * A permission value as a runtime that expands the folder tokens takes it: `$APPDATA[/…]` is
 * {@linkcode DESKTOP_DATA_TOKEN}`[/…]`, `$CACHE[/…]` {@linkcode DESKTOP_CACHE_TOKEN}`[/…]` (the
 * token only at the start, followed by nothing or a separator), a token value or an absolute path
 * stays as it is. Anything else — `*`, `$DOCUMENTS` (no runtime token), a relative path, a `..`
 * component the runtime would drop — is `undefined`: the grant cannot be scoped.
 *
 * @param value A configured or derived permission value.
 * @returns The value to bake, or `undefined`.
 */
export function desktopScopedPath(value: string): string | undefined {
  if (value.split(/[\\/]/).includes("..")) return undefined;
  for (const [token, baked] of FOLDER_TOKENS) {
    if (value === token) return baked;
    if (value.startsWith(`${token}/`) || value.startsWith(`${token}\\`)) {
      return `${baked}/${value.slice(token.length + 1).replaceAll("\\", "/")}`;
    }
  }
  return ABSOLUTE_PATH.test(value) ? value : undefined;
}

/**
 * Where a packaged app copies a project-file program sidecar (`resolveSidecarProgram`:
 * `<cache>/sidecars/<name>/<file>`), as a baked value: its folder and the program, or `undefined`
 * when the name or the file name cannot be one value of a permission list.
 *
 * @param name The sidecar's name.
 * @param exec Its project-relative program path.
 * @returns The folder (for `--allow-write`) and the program (for `--allow-run`).
 */
export function sidecarCacheProgram(
  name: string,
  exec: string,
): { folder: string; program: string } | undefined {
  // The copy is named after the resolved file (`new URL(exec, base)` reads `\` as `/`).
  const file = exec.split(/[\\/]/).at(-1) ?? "";
  const safe = (part: string) =>
    part !== "" && part !== "." && part !== ".." && !/[,\\/]/.test(part);
  if (!safe(name) || !safe(file)) return undefined;
  const folder = `${DESKTOP_CACHE_TOKEN}/sidecars/${name}`;
  return { folder, program: `${folder}/${file}` };
}

/**
 * The baked `--allow-run` value of a project-file program sidecar on a runtime that checks it at
 * spawn: `$DENO_DESKTOP_CACHE/sidecars/<name>/<sha256>/<file>#sha256=<sha256>#embedded=<exec>` (the
 * hash in the path too, so an update's new bytes do not meet the previous version's copy).
 * The hash is taken now, from the same file `--include` embeds. `undefined`, and the caller keeps
 * the grants of a runtime without the check, when the value cannot be one entry of a permission
 * list or the file cannot be read.
 *
 * @param name The sidecar's name.
 * @param exec Its project-relative program path.
 * @param projectDir The project directory.
 * @returns The value.
 */
export function sidecarRecordedProgram(
  name: string,
  exec: string,
  projectDir: string,
): string | undefined {
  const copy = sidecarCacheProgram(name, exec);
  if (!copy || /[,#]/.test(exec) || name.includes("#")) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = Deno.readFileSync(join(projectDir, exec));
  } catch {
    return undefined;
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = copy.program.slice(copy.folder.length + 1);
  const source = exec.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  return `${copy.folder}/${sha256}/${file}#sha256=${sha256}#embedded=${source}`;
}

/** Which of a copied program's grants to bake: see {@linkcode sidecarPermissionSet}. */
interface SidecarProgramBake {
  /** Bake them as {@linkcode DESKTOP_CACHE_TOKEN} paths. */
  readonly cacheScope: boolean;
  /** Record the hash (a runtime that checks it): the project directory to read the program in. */
  readonly integrityDir?: string;
}

/**
 * What the sidecars need baked in, as one permission set: each one's own `permissions`; a program
 * (`run.exec`) its `--allow-run` (for one of the project's files the packaged app runs it from a
 * copy in the app's cache folder, which also needs `--allow-write`: unscoped, or with `cacheScope`
 * the copy alone, `$DENO_DESKTOP_CACHE/sidecars/<name>/<file>`, and its folder; with `integrityDir`
 * no write at all, and a run grant that records the program's hash, {@linkcode sidecarRecordedProgram});
 * a log file
 * `--allow-write`; `loginShellEnv` (on macOS and Linux) the shells it may run
 * ({@linkcode LOGIN_SHELL_PATHS}).
 *
 * @param sidecars The sidecars.
 * @param os The target OS (without it, no login shells).
 * @param cacheScope Bake a copied program's grants as {@linkcode DESKTOP_CACHE_TOKEN} paths: only
 *   for a runtime that expands the token, in an app with `desktop.app.identifier` (the runtime
 *   expands it from the identifier baked into the binary, and drops an entry it cannot expand).
 * @param integrityDir The project directory, for a runtime that checks a program's recorded hash at
 *   spawn (with `cacheScope`).
 * @returns The permissions, merged like `desktop.extraPermissions`.
 */
export function sidecarPermissionSet(
  sidecars: readonly SidecarDefinition[],
  os?: DesktopOs,
  cacheScope = false,
  integrityDir?: string,
): DesktopPermissionSet {
  const out: Record<string, Set<string>> = {};
  for (const d of sidecars) {
    const needs = sidecarNeeds(d, { cacheScope, integrityDir });
    const loginShell = d.loginShellEnv !== undefined && d.loginShellEnv !== false;
    if (loginShell && (os === "darwin" || os === "linux")) {
      needs.push(["run", LOGIN_SHELL_PATHS[os]]);
    }
    for (const [kind, values] of needs) {
      const set = out[kind] ??= new Set();
      for (const v of values) set.add(v);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/**
 * A permission object from the raw config (the package scripts read it unvalidated), each list
 * checked by `permissionListError`: an entry that is not exactly one value, or a list that is not
 * an array of strings, fails the build rather than bake a wider (or a mangled) grant.
 *
 * @param field The config path, for the message.
 * @param value The configured object (`undefined`: none).
 * @returns The object.
 */
function checkedPermissions(field: string, value: unknown): DesktopPermissionSet {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`denext: ${field} must be an object of permission kinds to string arrays`);
  }
  for (const [kind, list] of Object.entries(value)) {
    const error = permissionListError(kind, list);
    if (error) throw new Error(`denext: ${field}.${kind} ${error}`);
  }
  return value as DesktopPermissionSet;
}

/** One sidecar's needs as `[kind, values]`: its `permissions`, its program, its log file. */
function sidecarNeeds(
  d: SidecarDefinition,
  bake: SidecarProgramBake,
): Array<[string, readonly string[]]> {
  const permissions = checkedPermissions(`desktop.sidecars "${d.name}" permissions`, d.permissions);
  const needs = Object.entries(permissions).filter(
    (e): e is [string, readonly string[]] => Array.isArray(e[1]),
  );
  const exec = (d.run as { exec?: unknown } | undefined)?.exec;
  if (typeof exec === "string") needs.push(...programNeeds(d.name, exec, bake));
  // Log files are `<data>/logs/<name>.log` (sidecar-host.ts).
  if (d.logs === "file" || d.logs === "both") needs.push(["write", ["$APPDATA/logs"]]);
  // A Node backend's packages are unpacked into the cache folder (sidecar-modules.ts).
  if ((d.run as { nodeModules?: unknown } | undefined)?.nodeModules !== undefined) {
    needs.push(["write", ["$CACHE"]]);
  }
  return needs;
}

/** A program sidecar's `run` (and, for a copy in the cache folder, `write`) needs. */
function programNeeds(
  name: string,
  exec: string,
  bake: SidecarProgramBake,
): Array<[string, readonly string[]]> {
  if (!isProjectProgram(exec)) return [["run", [exec]]];
  const recorded = bake.cacheScope && bake.integrityDir !== undefined
    ? sidecarRecordedProgram(name, exec, bake.integrityDir)
    : undefined;
  if (recorded) return [["run", [recorded]]];
  const copy = bake.cacheScope ? sidecarCacheProgram(name, exec) : undefined;
  return copy ? [["run", [copy.program]], ["write", [copy.folder]]] : [["run", ["*"]], [
    "write",
    ["$CACHE"],
  ]];
}

/**
 * Why the baked sidecar `run` grants are not containment: one line for each program a sidecar's
 * `run` grant names that a baked `write` grant covers as well (the program's own path, a folder
 * above it, or a write of everything), for the package run to print. Scoping `--allow-run` to a
 * path limits what the app's code may run BY NAME; with a write grant over that path the same code
 * can write the program and then run it, so nothing keeps it from running what it likes. A
 * project-file program sidecar in a packaged app is always such a case: the app copies the program
 * into its cache folder at launch, which takes a write grant on that folder (`sidecarCacheProgram`),
 * and runs it from there. Reported, never refused: refusing it would refuse every project-file
 * program sidecar, and a capability that writes (`fs`, the updater's UI overlay) bakes a write of
 * everything anyway. A bare program name (`git`, looked up on `PATH`) is not compared, and neither
 * is a grant that records its program's hash ({@linkcode sidecarRecordedProgram}): the runtime runs
 * only those bytes, whatever the app writes.
 *
 * @param config The project config (`denext.config.ts` default export).
 * @param os The target OS (the sidecars' login shells depend on it; they are never reported).
 * @param options `cacheScope`, `projectDir`, `sidecarIntegrity`: see {@linkcode desktopBuildFlags}.
 * @returns The warnings, one per covered program.
 */
export function sidecarRunWriteWarnings(
  config: unknown,
  os: DesktopOs,
  options: DesktopBuildFlagOptions = {},
): string[] {
  const cfg = (typeof config === "object" && config !== null ? config : {}) as DesktopFlagConfig;
  const sidecars = configSidecars(cfg);
  if (sidecars.length === 0) return [];
  const bake = sidecarProgramBake(cfg, os, options);
  const extra = mergePermissionSets(
    checkedPermissions("desktop.extraPermissions", cfg.desktop?.extraPermissions),
    sidecarPermissionSet(sidecars, os, bake.cacheScope, bake.integrityDir),
  );
  const capFlags = desktopPermissionFlags(enabledCapabilityKeys(cfg.desktop?.capabilities), os);
  const [writeFlag] = writeFlags(capFlags, extra, cfg);
  if (!writeFlag) return [];
  const writes = valuesOfFlag(writeFlag);
  const out: string[] = [];
  for (const d of sidecars) {
    const exec = (d.run as { exec?: unknown } | undefined)?.exec;
    if (typeof exec !== "string") continue;
    const program = scopedSidecarProgram(d.name, exec, bake);
    const by = program === undefined ? undefined : writeGrantCovering(program, writes);
    if (by === undefined) continue;
    const grant = by === "*" ? "an unscoped --allow-write" : `--allow-write=${by}`;
    out.push(
      `  sidecar "${d.name}": --allow-run=${program} is not containment: ${grant} covers that ` +
        "program too, so the app's own code can write it and then run it (the scope limits what " +
        "is run by name, not what runs)" +
        (isProjectProgram(exec)
          ? "; a project-file program is copied into the app's cache folder at launch under that write grant."
          : "."),
    );
  }
  return out;
}

/**
 * The path a sidecar's baked `run` grant names for its program `exec`, or `undefined` when the
 * grant is not a path: an unscoped grant (`*`), or a bare name looked up on `PATH`.
 */
function scopedSidecarProgram(
  name: string,
  exec: string,
  bake: SidecarProgramBake,
): string | undefined {
  const [[, [program]]] = programNeeds(name, exec, bake);
  return program === "*" || !/[\\/]/.test(program) || program.includes("#sha256=")
    ? undefined
    : program;
}

/**
 * The baked write grant among `writes` that covers `program` (`*` for everything, its own path,
 * or a folder above it; `/` and `\` alike), or `undefined` when none does.
 */
function writeGrantCovering(program: string, writes: readonly string[]): string | undefined {
  const slash = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "");
  const p = slash(program);
  return writes.find((w) => w === "*" || slash(w) === p || p.startsWith(`${slash(w)}/`));
}

/**
 * Whether a copied program sidecar's grants are baked as {@linkcode DESKTOP_CACHE_TOKEN} paths: the
 * runtime expands the token (`options.cacheScope`, by default the pinned runtime's), and
 * `desktop.app.identifier` is set (the runtime keys the folder by the identifier baked into the
 * binary; without one it would drop the entry).
 */
function sidecarCacheScope(cfg: DesktopFlagConfig, options: DesktopBuildFlagOptions): boolean {
  return (options.cacheScope ?? desktopCacheTokenRuntime()) && hasIdentifier(cfg);
}

/**
 * How a copied program sidecar's grants are baked for `options`. An unscoped `--allow-run` from
 * anywhere (`extraPermissions`, a capability, another sidecar) has no value to record a hash in, and
 * the app could run anything anyway, so the program then keeps its copy and write grant.
 */
function sidecarProgramBake(
  cfg: DesktopFlagConfig,
  os: DesktopOs,
  options: DesktopBuildFlagOptions,
): SidecarProgramBake {
  const cacheScope = sidecarCacheScope(cfg, options);
  const integrityDir = cacheScope && (options.sidecarIntegrity ?? desktopSidecarIntegrityRuntime())
    ? options.projectDir
    : undefined;
  if (integrityDir === undefined) return { cacheScope };
  const extra = mergePermissionSets(
    checkedPermissions("desktop.extraPermissions", cfg.desktop?.extraPermissions),
    sidecarPermissionSet(configSidecars(cfg), os, cacheScope, integrityDir),
  );
  const capFlags = desktopPermissionFlags(enabledCapabilityKeys(cfg.desktop?.capabilities), os);
  return bakeableSets(capFlags, extra).run.has("*") ? { cacheScope } : { cacheScope, integrityDir };
}

/** Whether `desktop.app.identifier` is set (the runtime keys both folders by it). */
function hasIdentifier(cfg: DesktopFlagConfig): boolean {
  const identifier = cfg.desktop?.app?.identifier;
  return typeof identifier === "string" && identifier.trim() !== "";
}

/**
 * Whether the app-folder grants are baked as {@linkcode DESKTOP_DATA_TOKEN} /
 * {@linkcode DESKTOP_CACHE_TOKEN} paths: the runtime expands them (`options.dataScope`, by default
 * the pinned runtime's) and `desktop.app.identifier` is set.
 */
function folderScope(cfg: DesktopFlagConfig, options: DesktopBuildFlagOptions): boolean {
  return (options.dataScope ?? desktopDataTokenRuntime()) && hasIdentifier(cfg);
}

/** The kinds a permission set merges: the flag kinds plus the two network directions. */
const MERGED_KINDS = [...PERMISSION_KINDS, "netConnect", "netListen"] as const;

/** Two permission sets as one (each kind's values unioned). */
function mergePermissionSets(
  a: DesktopPermissionSet,
  b: DesktopPermissionSet,
): DesktopPermissionSet {
  const out: Record<string, string[]> = {};
  for (const kind of MERGED_KINDS) {
    const values = [...new Set([...(a[kind] ?? []), ...(b[kind] ?? [])])];
    if (values.length > 0) out[kind] = values;
  }
  return out;
}

/**
 * Whether `desktop.permissions` asks for strict mode, refusing a value the package scripts must
 * not guess about: an invalid one, or strict with a sidecar that needs the whole environment.
 */
function strictRequested(cfg: DesktopFlagConfig): boolean {
  const problem = desktopPermissionsProblem(cfg.desktop?.permissions);
  if (problem) throw new Error(`denext: desktop.${problem[0]} ${problem[1]}`);
  if (!desktopPermissionsMode(cfg.desktop?.permissions).strict) return false;
  const conflict = strictPermissionsSidecarError(cfg.desktop?.sidecars);
  if (conflict) throw new Error(`denext: desktop.permissions ${conflict}`);
  return true;
}

/**
 * Strict mode's `--allow-read`: the app's data and cache folders (the embedded files are granted
 * by the runtime), what the capabilities and the `fs` folders read, and `extraPermissions.read`;
 * unscoped when one of them has no token (a picked path under `dialogs`, `$DOCUMENTS`).
 */
function strictReadFlag(
  capFlags: readonly string[],
  extra: DesktopPermissionSet,
  cfg: DesktopFlagConfig,
): string {
  const scoped = scopedValues([
    DESKTOP_DATA_TOKEN,
    DESKTOP_CACHE_TOKEN,
    ...capFlags.filter((f) => kindOfFlag(f) === "--allow-read").flatMap(valuesOfFlag),
    ...fsConfigFolders(cfg, "read"),
    ...(extra.read ?? []),
  ]);
  return scoped ? `--allow-read=${scoped.join(",")}` : "--allow-read";
}

/**
 * Strict mode's `--allow-env`: the variables denext's desktop runtime reads
 * ({@linkcode DESKTOP_RUNTIME_ENV}), `desktop.permissions.env` and `extraPermissions.env` (a
 * sidecar's included); unscoped when one of them is `"*"`.
 */
function strictEnvFlag(extra: DesktopPermissionSet, cfg: DesktopFlagConfig): string {
  const names = new Set([
    ...DESKTOP_RUNTIME_ENV,
    ...desktopPermissionsMode(cfg.desktop?.permissions).env,
    ...(extra.env ?? []),
  ]);
  return names.has("*") ? "--allow-env" : `--allow-env=${[...names].sort().join(",")}`;
}

/**
 * The full `--allow-*` flag list to bake into the `deno desktop` binary for `os` — the
 * least-privilege replacement for `-A` in the package scripts — derived from the WHOLE project
 * config, not just `desktop.capabilities` (deriving from capabilities alone would starve the
 * non-capability runtime features: an audit found the updater, `openAuthSession` and a non-loopback
 * proxy all broke). On top of {@linkcode DESKTOP_BASELINE_FLAGS} it adds:
 * - the enabled capabilities' `run` / `ffi` / `sys` exactly (the real least-privilege wins), and a
 *   single broad `--allow-write` when any capability writes (a per-user path can't be baked; the
 *   runtime cap layer confines it) — or, on a runtime that expands `$DENO_DESKTOP_DATA` /
 *   `$DENO_DESKTOP_CACHE` (3.0.0-denext.8, `dataScope`) in an app with `desktop.app.identifier`,
 *   `--allow-write` scoped to those folders (and any absolute `extraPermissions.write` path) unless
 *   a write has no token (a picked path, `$DOCUMENTS`); an unscoped `--allow-sys` when a capability needs it
 *   (clipboard, global shortcuts, launch at login, notifications) or `desktop.app.deepLinks`
 *   declares a scheme (claiming it back needs it): the pinned runtime refuses those with
 *   `NotCapable` under a partial `--allow-sys=<names>`;
 * - a non-loopback `spa.proxy` target's host, MERGED into the single `--allow-net` (Deno keeps only
 *   the last `--allow-net`, so every host is one flag), and so are full-app self-update's hosts
 *   (`desktop.update.manifestUrl`'s, `desktop.update.ui.feedUrl`'s and `desktop.update.hosts`), and
 *   `desktop.update.ui` adds the broad `--allow-write` its overlay needs. With `netSplit` (the
 *   pinned runtime, 3.0.0-rc.2 or later) the network grant is baked by direction instead:
 *   `--allow-net-connect` takes those outbound hosts, loopback and `extraPermissions.netConnect`,
 *   `--allow-net-listen` only loopback and `extraPermissions.netListen` (any port: the app's server
 *   picks one at launch), and `extraPermissions.net` / a sidecar's `net` go to both;
 * - `desktop.extraPermissions` — the escape hatch for what the catalog can't see: the updater's
 *   feed host (`net`) and data dir (`write`), an extension's own `run`/`ffi`, etc. It is UNIONED
 *   in, and `--regenerate-scripts` preserves it because it lives in the config, not the script.
 * - with `desktop.permissions: "strict"` on such a runtime (and `desktop.app.identifier`),
 *   `--allow-read` scoped to the app's folders and the declared reads, and `--allow-env` to
 *   {@linkcode DESKTOP_RUNTIME_ENV} and the declared variables.
 * A capability's `read`/`env` is dropped (already broad in the baseline); a capability's `net`
 * (only `downloadToFile`'s `*`) is dropped too — per-host download access is an `extraPermissions`
 * grant, never `*` baked in.
 *
 * @param config The project config (`denext.config.ts` default export), or `undefined` — baseline only.
 * @param os The target OS.
 * @param options `netSplit`: bake the network grant by direction; `cacheScope` / `dataScope`: the
 *   runtime expands the folder tokens (default: the pinned runtime's).
 * @returns The flags, ready to splice into the `deno desktop` argv (never `-A`).
 */
export function desktopBuildFlags(
  config: unknown,
  os: DesktopOs,
  options: DesktopBuildFlagOptions = {},
): string[] {
  const cfg = (typeof config === "object" && config !== null ? config : {}) as DesktopFlagConfig;
  // `desktop.extraPermissions` and what the sidecars need, baked the same way.
  const bake = sidecarProgramBake(cfg, os, options);
  const extra = mergePermissionSets(
    checkedPermissions("desktop.extraPermissions", cfg.desktop?.extraPermissions),
    sidecarPermissionSet(configSidecars(cfg), os, bake.cacheScope, bake.integrityDir),
  );
  const capFlags = desktopPermissionFlags(enabledCapabilityKeys(cfg.desktop?.capabilities), os);

  // net: baseline loopback + a non-loopback spa.proxy host + the update hosts (all outbound) +
  // extraPermissions' net (both ways), netConnect and netListen.
  const connect = new Set<string>([
    ...DESKTOP_LISTEN_BASELINE,
    ...(extra.net ?? []),
    ...(extra.netConnect ?? []),
  ]);
  const proxyHost = proxyNetHost(cfg.spa?.proxy);
  if (proxyHost) connect.add(proxyHost);
  for (const host of updateNetHosts(cfg.desktop?.update)) connect.add(host);
  const listen = new Set<string>([
    ...DESKTOP_LISTEN_BASELINE,
    ...(extra.net ?? []),
    ...(extra.netListen ?? []),
  ]);

  const { run, ffi, sys } = bakeableSets(capFlags, extra);
  const strict = strictRequested(cfg) && folderScope(cfg, options);
  // Deep links: the pinned runtime lets the app claim a declared scheme back from another handler
  // (`registerScheme({ force: true })`, `claimDeepLinkScheme` on a user action) only with an
  // unscoped --allow-sys.
  if (Array.isArray(cfg.desktop?.app?.deepLinks) && cfg.desktop.app.deepLinks.length > 0) {
    sys.add("*");
  }
  // `"*"` grants the whole kind (an unscoped `--allow-ffi`): a Node-API addon extracted from the
  // compiled app's virtual file system has no path that can be named at package time.
  const listFlag = (kind: string, set: Set<string>): string[] =>
    set.has("*")
      ? [`--allow-${kind}`]
      : set.size > 0
      ? [`--allow-${kind}=${[...set].sort().join(",")}`]
      : [];

  return [
    // `"*"` (a sidecar or `extraPermissions` that talks to any host) is the unscoped flag. The
    // stock runtime knows only `--allow-net`, both directions in ONE flag (Deno keeps the last).
    ...(options.netSplit
      ? netSplitFlags([...connect], [...listen])
      : listFlag("net", new Set([...connect, ...listen]))),
    strict ? strictReadFlag(capFlags, extra, cfg) : "--allow-read",
    strict ? strictEnvFlag(extra, cfg) : "--allow-env",
    ...writeFlags(capFlags, extra, cfg, folderScope(cfg, options)),
    ...listFlag("sys", sys),
    ...listFlag("run", run),
    ...listFlag("ffi", ffi),
  ];
}

/**
 * The `deno desktop` `--allow-*` flags for a scaffolded packaging script: read the project's
 * config (next to `entryUrl` — a packaging script lives in `scripts/`, so the config is
 * `../denext.config.ts`, or its `.mts` / `.js` / `.mjs` twin) and derive the least-privilege flags for `os` via {@linkcode
 * desktopBuildFlags}. A project without a config (or one that exports none) gets the baseline. The
 * config is imported dynamically at run time from a caller-supplied URL, so it is never part of
 * this module's own dependency graph (nor a build-time import of user code). The network grant is
 * split by direction when the build runs on denext's pinned runtime and toolchain, 3.0.0-rc.2 or
 * later, read from the `deno` on `PATH` the script builds with ({@linkcode desktopNetSplitFor});
 * `DENEXT_DESKTOP_RUNTIME=stock`, a local runtime build or a stock `deno` keep `--allow-net`.
 *
 * @param entryUrl The packaging script's `import.meta.url`.
 * @param os The target OS.
 * @param netSplit Override the detection (default {@linkcode desktopNetSplitFor}).
 * @returns The `--allow-*` flags, ready to splice into the `deno desktop` argv.
 */
export async function desktopPackageFlags(
  entryUrl: string,
  os: DesktopOs,
  netSplit?: boolean,
): Promise<string[]> {
  // No config (or one that exports none) → the baseline; a config that fails to load fails.
  const config = await loadConfigBeside(entryUrl);
  const root = new URL("../", entryUrl);
  const flags = desktopBuildFlags(config, os, {
    netSplit: netSplit ?? await desktopNetSplitFor(),
    ...(root.protocol === "file:" ? { projectDir: fromFileUrl(root) } : {}),
  });
  const notice = strictPermissionsNotice(config);
  if (notice) console.warn(notice);
  return flags;
}

/**
 * The line a package script prints when `desktop.permissions: "strict"` cannot be baked (the
 * runtime does not expand the folder tokens, or `desktop.app.identifier` is unset), so the
 * default grants are, else `null`.
 *
 * @param config The project config.
 * @param options The runtime's abilities (default: the pinned runtime's).
 * @returns The notice, or `null`.
 */
export function strictPermissionsNotice(
  config: unknown,
  options: DesktopBuildFlagOptions = {},
): string | null {
  const cfg = (typeof config === "object" && config !== null ? config : {}) as DesktopFlagConfig;
  if (!strictRequested(cfg) || folderScope(cfg, options)) return null;
  return 'denext: desktop.permissions "strict" needs Deno Desktop runtime 3.0.0-denext.8 or ' +
    "later and desktop.app.identifier; baking the default (unscoped) --allow-read and --allow-env.";
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
  // No config → no extensions to embed; a config that fails to load fails.
  const config = await loadConfigBeside(entryUrl);
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
  /**
   * `--rp-id`: relying-party IDs written to `desktop.capabilities.passkeys.rpIds` (merged into an
   * existing list); only with the `passkeys` capability. Each must be a registrable domain.
   */
  readonly passkeyRpIds?: readonly string[];
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
  /** `desktop.capabilities.passkeys.rpIds` as written, when `--rp-id` gave any. */
  readonly rpIds?: readonly string[];
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

/** The `desktop.capabilities` object in a config source, when it is a data literal. */
async function presentCapabilities(source: string): Promise<Record<string, unknown>> {
  const model = await readConfigModel(source);
  const desktop = model.keys.desktop;
  const caps = desktop?.kind === "editable"
    ? (desktop.value as { capabilities?: unknown } | null)?.capabilities
    : undefined;
  return typeof caps === "object" && caps !== null ? caps as Record<string, unknown> : {};
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

/** The capabilities spliced in, those kept, and the passkeys RP IDs as written. */
interface SpliceResult {
  source: string;
  added: string[];
  kept: string[];
  rpIds?: string[];
}

/** Set `path` in `source`, or throw with the by-hand snippet. */
async function setOrThrow(
  source: string,
  path: readonly string[],
  value: unknown,
  configPath: string,
): Promise<string> {
  const edit = await setConfigValue(source, [...path], value);
  if (edit.ok) return edit.source;
  const [, , key, ...rest] = path;
  const snippet = rest.length
    ? `${key}: { ${rest.join(".")}: ${JSON.stringify(value)} }`
    : `${key}: ${JSON.stringify(value)}`;
  throw new Error(
    `cannot edit ${configPath}: ${edit.reason}\n  Add by hand: desktop: { capabilities: { ${snippet} } }`,
  );
}

/**
 * `--rp-id`'s IDs merged into an existing passkeys value: the list that results, and the edit
 * that writes it (null when every ID is already listed). A value that is not an object (`true`,
 * `false`) is replaced by `{ rpIds }`.
 */
function mergedRpIds(
  existing: unknown,
  rpIds: readonly string[],
): { list: string[]; edit: { path: string[]; value: unknown } | null } {
  const base = ["desktop", "capabilities", "passkeys"];
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    return { list: [...rpIds], edit: { path: base, value: { rpIds: [...rpIds] } } };
  }
  const raw = (existing as { rpIds?: unknown }).rpIds;
  const current = Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === "string")
    : [];
  const lower = current.map((id) => id.toLowerCase());
  const list = [...current, ...rpIds.filter((id) => !lower.includes(id))];
  const changed = list.length > current.length || !Array.isArray(raw);
  return { list, edit: changed ? { path: [...base, "rpIds"], value: list } : null };
}

/** Splice one capability into `result` (added, kept, or its passkeys `rpIds` merged). */
async function spliceOne(
  result: SpliceResult,
  name: string,
  present: Record<string, unknown>,
  rpIds: readonly string[],
  configPath: string,
): Promise<void> {
  const cap = DESKTOP_CAPABILITIES[name];
  const ids = name === "passkeys" ? rpIds : [];
  if (Object.hasOwn(present, cap.key)) {
    return await mergeExisting(result, name, present[cap.key], ids, configPath);
  }
  if (ids.length) result.rpIds = [...ids];
  const value = ids.length ? { rpIds: [...ids] } : cap.value;
  const path = ["desktop", "capabilities", cap.key];
  result.source = await setOrThrow(result.source, path, value, configPath);
  result.added.push(name);
}

/** A capability already present: kept, unless `--rp-id` adds relying parties to it. */
async function mergeExisting(
  result: SpliceResult,
  name: string,
  existing: unknown,
  rpIds: readonly string[],
  configPath: string,
): Promise<void> {
  const merge = rpIds.length ? mergedRpIds(existing, rpIds) : null;
  if (merge) result.rpIds = merge.list;
  const edit = merge?.edit;
  if (edit) result.source = await setOrThrow(result.source, edit.path, edit.value, configPath);
  // a `true` / `false` replaced by `{ rpIds }` counts as enabling it
  (edit?.path.length === 3 ? result.added : result.kept).push(name);
}

/** Splice each capability not yet present into `source`; throws with the by-hand snippet. */
async function spliceCapabilities(
  before: string,
  names: readonly string[],
  configPath: string,
  rpIds: readonly string[],
): Promise<SpliceResult> {
  const present = await presentCapabilities(before);
  const result: SpliceResult = { source: before, added: [], kept: [] };
  for (const name of names) await spliceOne(result, name, present, rpIds, configPath);
  // Once a real `capabilities` block exists, drop the scaffold's commented placeholder hint so it
  // doesn't linger beside it (`// capabilities: { … },  // denext desktop add <cap>`).
  if (result.added.length > 0 || result.kept.length > 0) {
    result.source = removeCapabilitiesHint(result.source);
  }
  return result;
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
  const rpIds = [...new Set((opts.passkeyRpIds ?? []).map(passkeyRpId))];
  if (rpIds.length > 0 && !names.includes("passkeys")) {
    throw new Error(
      "--rp-id applies to the passkeys capability: `denext desktop add passkeys --rp-id <domain>`",
    );
  }
  const existing = await findConfig(opts.dir);
  const configPath = existing ?? join(opts.dir, "denext.config.ts");
  const before = existing ? await Deno.readTextFile(existing) : NEW_CONFIG;
  const spliced = await spliceCapabilities(before, names, configPath, rpIds);
  const { source, added, kept } = spliced;
  const changed = source !== before || !existing;
  const label = basename(configPath);
  const diff = changed
    ? createUnifiedDiff(existing ? before : "", source, `a/${label}`, `b/${label}`)
    : "";
  if (changed && !opts.dryRun) {
    // A config linked out of the project (a cloned repository's) is never written through.
    await assertInsideProject(opts.dir, configPath);
    await Deno.writeTextFile(configPath, source);
  }
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
    manual: names.flatMap((n) => DESKTOP_CAPABILITIES[n].manual ?? [])
      .filter((m) => !(m === PASSKEY_RP_IDS_MANUAL && spliced.rpIds?.length)),
    ...spliced.rpIds ? { rpIds: spliced.rpIds } : {},
  };
}

/** The report's first lines: what was enabled, kept or created, and the passkeys RP IDs. */
function addReportHead(report: AddDesktopCapabilitiesReport, dryRun: boolean): string[] {
  const lines: string[] = [];
  const verb = dryRun ? "would enable" : "enabled";
  if (report.added.length > 0) {
    lines.push(`  ${verb}: ${report.added.join(", ")}  (${report.configPath})`);
  }
  if (report.kept.length > 0) lines.push(`  already enabled: ${report.kept.join(", ")}`);
  if (report.created) lines.push(`  ${dryRun ? "would create" : "created"} ${report.configPath}`);
  if (report.rpIds?.length) lines.push(`  passkeys relying parties: ${report.rpIds.join(", ")}`);
  return lines;
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
  const lines = addReportHead(report, dryRun);
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
