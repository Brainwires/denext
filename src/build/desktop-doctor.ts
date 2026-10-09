// `denext desktop doctor [--linux] [--json]`: what the Deno Desktop runtime will find on this
// machine, with a fix for each missing piece.
//
//   - The pinned runtime: its version, whether the `deno` on PATH is its exact Deno version, the
//     cache state (the same status `denext doctor` prints), and whether it carries the session
//     probe (`Deno.desktop.platformFeatures()`, laufey API 45, runtime 2.9.7-denext.10).
//   - On Linux (or with `--linux`), the session facts the runtime's probe reports, read the same
//     way from the CLI: the session type (as the runtime corrects it: the display that is there,
//     never a display alone), the D-Bus session bus, a tray host (`org.kde.StatusNotifierWatcher`,
//     or on X11 an XEmbed system tray: the `_NET_SYSTEM_TRAY_S<n>` selection's owner, read through
//     libX11 in a `deno eval` child, as the runtime reads it), the Secret Service and its lock
//     state (a locked gnome-keyring keyring with no password unlocks on first use with no prompt:
//     its file's header says so), CEF's cookie store as the runtime picks it (`os` / `basic`, or
//     `unknown` where Chromium uses KWallet), libsecret (which the runtime loads for the secure store), a
//     notification server (and why D-Bus could not start one) and the xdg-desktop-portal
//     interfaces with their versions (and whether the portal answered at all); whether the portal
//     can register a host app's id (a notification click that starts a quit app), a systemd user
//     manager (a scheduled notification posted while the app is closed) and a dock that reads
//     launcher badges (runtime 2.9.7-denext.11); and the Chromium sandbox a CEF window would run in
//     (unprivileged user namespaces, else the `chrome-sandbox` helper of a `.deb` / `.rpm`
//     install, else off), with `desktop.linux.requireSandbox` for an app that would rather not
//     start unsandboxed.
//
// The probe needs no window: it asks the session bus through `busctl --user` (systemd) or
// `gdbus` (GLib), argv only, never a shell, each call bounded by a timeout. The runtime's own
// probe runs only inside a desktop app, and the pinned runtime may predate it, so the CLI reads the
// same D-Bus names instead of building an app to ask. It never starts the Secret Service or asks
// it to unlock (the keyring check reads the first 16 bytes of the default keyring's file: its
// format, never a secret); the XEmbed check asks an X11 session's display only (in a Wayland
// session `$DISPLAY` is Xwayland's, which connecting could start); reading the portal's versions may start xdg-desktop-portal (D-Bus activation),
// as any portal call would, and an activatable notification server is started the way the runtime
// starts it on first use, so a failure shows its reason. The sandbox probe runs `unshare` (a user
// namespace with a nested one, as Chromium checks) and reads one sysctl.

import {
  DESKTOP_RUNTIME_PIN,
  type DesktopRuntimePin,
  type DesktopRuntimeStatus,
} from "./desktop-runtime.ts";
import { formatDoctorFindings } from "./doctor-format.ts";
import {
  CEF_SIGNING_FIX,
  cefCertificateProblem,
  certificateTrust,
  type PowerShellRunner,
} from "./desktop-windows-trust.ts";

/** One problem, with its fix. */
export interface DesktopDoctorFinding {
  /** The check that found it (`runtime`, `tray-host`, `secret-service`, …). */
  readonly check: string;
  /** `error`: the app cannot work as built; `warning`: a feature is missing or degraded. */
  readonly level: "error" | "warning";
  readonly message: string;
  readonly fix: string;
}

/** The Secret Service's state, as the runtime's probe names it. */
export type DoctorSecretService =
  | "available"
  | "locked"
  | "activatable"
  | "absent"
  | "no-session-bus";

/**
 * The Chromium sandbox a CEF window would run its web content in here (the runtime's own probe
 * decides at launch, `appCapabilities().sandbox`): `namespace` (unprivileged user namespaces
 * work), `helper` (they don't: the `chrome-sandbox` helper a `.deb` / `.rpm` installs setuid root
 * gives `setuid`, while a tarball or AppImage runs `off`), `off` (root) or `unknown` (no
 * `unshare` to probe with).
 */
export interface DoctorSandbox {
  readonly mode: "namespace" | "helper" | "off" | "unknown";
  /** What the probe found. */
  readonly reason: string;
}

/** An XEmbed system tray on the X display. */
export interface DoctorXEmbedTray {
  /** The selection owner's window id (`0x…`). */
  readonly owner: string;
  /** Its `WM_CLASS` class (`i3bar`, `stalonetray`, …), or `null` when it sets none. */
  readonly name: string | null;
}

/** What this Linux session provides, read over D-Bus. */
export interface LinuxSessionFacts {
  /**
   * As the runtime reports it: `XDG_SESSION_TYPE` (`"unknown"` when unset), a graphical one
   * corrected to the display that is there (`x11` for a declared `wayland` with only `$DISPLAY`,
   * as after GDM's autologin into XFCE or i3). A display alone never makes a session graphical.
   */
  readonly sessionType: "wayland" | "x11" | "tty" | "unknown";
  /** `XDG_CURRENT_DESKTOP`: a hint for wording only, never a branch condition. */
  readonly desktopHint: string | null;
  /** The tool that read the bus, or `null` when neither is installed. */
  readonly probe: "busctl" | "gdbus" | null;
  /** A D-Bus session bus answered. */
  readonly sessionBus: boolean;
  /** `org.kde.StatusNotifierWatcher` is owned (a tray host runs). */
  readonly trayHost: boolean;
  /**
   * X11 with no StatusNotifierWatcher: the XEmbed system tray (`_NET_SYSTEM_TRAY_S<n>`'s owner,
   * and its `WM_CLASS` when it has one), which the runtime falls back to; `false` when no one owns
   * the selection; `null` when not asked (another session type, a watcher runs) or the display
   * could not be read.
   */
  readonly xembedTray: DoctorXEmbedTray | false | null;
  /** The Secret Service's state, read without starting or unlocking it. */
  readonly secretService: DoctorSecretService;
  /**
   * A `locked` gnome-keyring default keyring: `no-password` (stored unencrypted: it unlocks on
   * first use with no prompt, as the empty-password login keyring of an autologin does),
   * `password` (an unlock prompt), `unknown` (another provider, or its file can't be read);
   * `null` when the Secret Service is not locked.
   */
  readonly keyringUnlock: "no-password" | "password" | "unknown" | null;
  /**
   * The cookie store a CEF window starts with, as the runtime picks it for a new profile: `os`
   * (the Secret Service keeps the key), `basic` (Chromium's fixed key: cookies only obfuscated),
   * or `unknown` (Chromium keeps the key in KWallet on this desktop, whose state isn't read here).
   */
  readonly cookieEncryption: "os" | "basic" | "unknown";
  /** Why `basic` or `unknown`; `null` for `os`. */
  readonly cookieEncryptionReason: string | null;
  /**
   * libsecret (`libsecret-1.so.0`, which the runtime loads for the secure store) is installed;
   * `null` when the linker cache could not be read.
   */
  readonly libsecret: boolean | null;
  /** A notification server runs, or D-Bus started one (`org.freedesktop.Notifications`). */
  readonly notifications: boolean;
  /**
   * Why no notification server answers, when one is activatable but D-Bus could not start it (the
   * runtime's `notificationReason` wording), else `null`.
   */
  readonly notificationReason: string | null;
  /** `org.freedesktop.portal.Desktop` is owned or activatable. */
  readonly portal: boolean;
  /**
   * The portal answered (it runs, or D-Bus started it); `false` when it is installed but did not
   * answer, so its interfaces and registry are unknown rather than missing.
   */
  readonly portalAnswered: boolean;
  /** The portal interfaces offered, by version (an absent one is not listed). */
  readonly portalVersions: Readonly<Record<string, number>>;
  /**
   * The portal registers a host app's id (`org.freedesktop.host.portal.Registry`,
   * xdg-desktop-portal 1.19+): the runtime then posts notifications through the portal, and a
   * click starts the app when it isn't running.
   */
  readonly portalRegistry: boolean;
  /** A systemd user manager answers (`org.freedesktop.systemd1`): scheduled-notification timers. */
  readonly systemdUser: boolean;
  /**
   * A dock reads launcher badges (`com.canonical.Unity` owned: Ubuntu's dock, Dash to Dock; or
   * `org.kde.plasmashell`: Plasma's task manager).
   */
  readonly launcherBadges: boolean;
  /** The Chromium sandbox a CEF window would run in. */
  readonly sandbox: DoctorSandbox;
}

/** The pinned runtime as the doctor reports it. */
export interface DoctorRuntime {
  /** `denext doctor`'s status of the pinned runtime for this host. */
  readonly status: DesktopRuntimeStatus;
  /** The pinned runtime's laufey API level. */
  readonly laufeyApiVersion: number;
  /** The pinned runtime has `Deno.desktop.platformFeatures()` (laufey API 45). */
  readonly platformFeatures: boolean;
  /**
   * The pinned runtime posts Linux notifications through the portal (a click starts a quit app),
   * schedules them with systemd user timers and badges the launcher (runtime 2.9.7-denext.11).
   */
  readonly linuxNotifications: boolean;
}

/** What `denext desktop doctor` found. */
export interface DesktopDoctorReport {
  /** The host OS (`Deno.build.os`). */
  readonly os: string;
  readonly runtime: DoctorRuntime;
  /** The Linux session facts, or `null` when the Linux checks did not run. */
  readonly linux: LinuxSessionFacts | null;
  /** The checks that ran, in order. */
  readonly checks: readonly string[];
  readonly findings: readonly DesktopDoctorFinding[];
}

/**
 * Runs `cmd args` and captures stdout (and stderr, when the runner keeps it); `null` when `cmd` is
 * not installed (or timed out).
 */
export type DoctorRunner = (
  cmd: string,
  args: readonly string[],
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr?: string } | null>;

/** Options for {@linkcode runDesktopDoctor}. */
export interface DesktopDoctorOptions {
  /** The pinned runtime's status (`desktopRuntimeStatus`). */
  readonly runtimeStatus: () => Promise<DesktopRuntimeStatus>;
  /** Run the Linux session checks (default: on a Linux host). */
  readonly linux?: boolean;
  /** The host OS (default `Deno.build.os`). */
  readonly os?: string;
  /** Env reader (default `Deno.env.get`). */
  readonly env?: (key: string) => string | undefined;
  /** The subprocess runner (default: `Deno.Command`, 8 s per call). */
  readonly run?: DoctorRunner;
  /** Whether a path is a Unix socket (default: `Deno.statSync`); the Wayland display check. */
  readonly isSocket?: (path: string) => boolean;
  /** The `deno` that runs the XEmbed tray probe (`deno eval`; default `deno`). */
  readonly deno?: string;
  /** The pin (tests). */
  readonly pin?: DesktopRuntimePin;
  /** Runs PowerShell for the Windows CEF signing check (default: `powershell.exe`). */
  readonly powershell?: PowerShellRunner;
}

/** The laufey API level that added `Deno.desktop.platformFeatures()`. */
const PLATFORM_FEATURES_API = 45;

/**
 * The runtime release (`2.9.7-denext.N`) that brought Linux notification cold starts, scheduled
 * notifications posted while the app is closed and launcher badges.
 */
const LINUX_NOTIFICATIONS_RELEASE = 11;

/** `N` of a `…-denext.N` runtime version, or `null`. */
function runtimeRelease(version: unknown): number | null {
  const m = typeof version === "string" ? /-denext\.(\d+)$/.exec(version) : null;
  return m ? Number(m[1]) : null;
}

/** One D-Bus call's bound. */
const CALL_TIMEOUT_S = 5;

/** The portal interfaces the runtime reports versions of. */
const PORTAL_INTERFACES = ["Notification", "FileChooser", "GlobalShortcuts", "Settings"] as const;

const TRAY_WATCHER = "org.kde.StatusNotifierWatcher";
const SECRETS = "org.freedesktop.secrets";
const GNOME_KEYRING = "org.gnome.keyring";
/** gcr's prompter, which gnome-keyring asks through (gnome-shell's own, or gcr-prompter). */
const GCR_PROMPTER = "org.gnome.keyring.SystemPrompter";
const NOTIFICATIONS = "org.freedesktop.Notifications";
const PORTAL = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const REGISTRY = "org.freedesktop.host.portal.Registry";
const SYSTEMD = "org.freedesktop.systemd1";
/** The names a dock that reads `com.canonical.Unity.LauncherEntry` owns. */
const LAUNCHER_BADGE_READERS = ["com.canonical.Unity", "org.kde.plasmashell"];

/** The default runner: `Deno.Command`, stdout and stderr captured, killed after 8 s. */
export const defaultDoctorRunner: DoctorRunner = async (cmd, args) => {
  try {
    const out = await new Deno.Command(cmd, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(8_000),
    }).output();
    const text = new TextDecoder();
    return { code: out.code, stdout: text.decode(out.stdout), stderr: text.decode(out.stderr) };
  } catch {
    return null;
  }
};

/** The default socket check: the path exists and is a Unix socket. */
function defaultIsSocket(path: string): boolean {
  try {
    return Deno.statSync(path).isSocket === true;
  } catch {
    return false;
  }
}

/** The names on the session bus: owned now, and activatable on demand. */
interface BusNames {
  readonly tool: "busctl" | "gdbus";
  readonly owned: ReadonlySet<string>;
  readonly activatable: ReadonlySet<string>;
}

/** `busctl --user list`: one row per name; an activatable one shows `(activatable)`. */
async function busctlNames(run: DoctorRunner): Promise<BusNames | null | "no-tool"> {
  const out = await run("busctl", ["--user", "--no-pager", "--no-legend", "list"]);
  if (out === null) return "no-tool";
  if (out.code !== 0) return null;
  const owned = new Set<string>();
  const activatable = new Set<string>();
  for (const line of out.stdout.split("\n")) {
    const name = line.trim().split(/\s+/)[0];
    if (!name || name.startsWith(":")) continue;
    (line.includes("(activatable)") ? activatable : owned).add(name);
  }
  return { tool: "busctl", owned, activatable };
}

/** The `'…'` strings of a gdbus reply (`(['a', 'b'],)`). */
function gdbusStrings(text: string): Set<string> {
  return new Set([...text.matchAll(/'([^']*)'/g)].map((m) => m[1]));
}

/** `gdbus call … ListNames` / `ListActivatableNames`. */
async function gdbusNames(run: DoctorRunner): Promise<BusNames | null | "no-tool"> {
  const list = (method: string) =>
    run("gdbus", [
      "call",
      "--session",
      "--timeout",
      String(CALL_TIMEOUT_S),
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      `org.freedesktop.DBus.${method}`,
    ]);
  const owned = await list("ListNames");
  if (owned === null) return "no-tool";
  if (owned.code !== 0) return null;
  const activatable = await list("ListActivatableNames");
  return {
    tool: "gdbus",
    owned: gdbusStrings(owned.stdout),
    activatable: activatable?.code === 0 ? gdbusStrings(activatable.stdout) : new Set(),
  };
}

/** A D-Bus property's printed value (`b true` / `(<uint32 2>,)`), or `null` when the call failed. */
async function getProperty(
  run: DoctorRunner,
  tool: BusNames["tool"],
  dest: string,
  path: string,
  iface: string,
  prop: string,
): Promise<string | null> {
  const out = tool === "busctl"
    ? await run("busctl", [
      "--user",
      `--timeout=${CALL_TIMEOUT_S}`,
      "get-property",
      dest,
      path,
      iface,
      prop,
    ])
    : await run("gdbus", [
      "call",
      "--session",
      "--timeout",
      String(CALL_TIMEOUT_S),
      "--dest",
      dest,
      "--object-path",
      path,
      "--method",
      "org.freedesktop.DBus.Properties.Get",
      iface,
      prop,
    ]);
  return out && out.code === 0 ? out.stdout.trim() : null;
}

/** The Secret Service's state: never started, never asked to unlock. */
async function secretServiceState(
  run: DoctorRunner,
  names: BusNames,
): Promise<DoctorSecretService> {
  if (!names.owned.has(SECRETS)) return names.activatable.has(SECRETS) ? "activatable" : "absent";
  const locked = await getProperty(
    run,
    names.tool,
    SECRETS,
    "/org/freedesktop/secrets/aliases/default",
    "org.freedesktop.Secret.Collection",
    "Locked",
  );
  // No default collection reads as locked, as the runtime reports it: a store needs one unlocked.
  if (locked === null) return "locked";
  return /\bfalse\b/.test(locked) ? "available" : "locked";
}

/**
 * Whether a `locked` gnome-keyring default keyring has a password: gnome-keyring stores a keyring
 * with no password unencrypted (a text file starting `[keyring]`), and unlocks it on first use
 * with no prompt; an encrypted one starts with the `GnomeKeyring\n\r\0\n` magic. Reads the default
 * keyring's name (`keyrings/default`, else `login`) and the first 16 bytes of its file: the
 * format, never a secret.
 */
async function keyringUnlock(
  run: DoctorRunner,
  env: (key: string) => string | undefined,
): Promise<"no-password" | "password" | "unknown"> {
  const home = env("HOME");
  const data = env("XDG_DATA_HOME") || (home ? `${home}/.local/share` : "");
  if (!data) return "unknown";
  const dir = `${data}/keyrings`;
  const named = await run("cat", [`${dir}/default`]);
  const name = named?.code === 0 ? named.stdout.trim() : "";
  const file = `${dir}/${
    /^[\w .-]+$/.test(name) && !name.startsWith(".") ? name : "login"
  }.keyring`;
  const head = await run("head", ["-c", "16", file]);
  if (head === null || head.code !== 0) return "unknown";
  if (head.stdout.startsWith("GnomeKeyring")) return "password";
  return head.stdout.startsWith("[keyring]") ? "no-password" : "unknown";
}

/**
 * The XEmbed tray probe, run by `deno eval` (full permissions, its own process: a display that
 * never answers is killed with it by the runner's timeout): libX11's owner of
 * `_NET_SYSTEM_TRAY_S<default screen>` (an existing atom only: nothing is created) and the owner
 * window's `WM_CLASS` (or, as i3bar's selection window has none, that of another window of the
 * same X client), printed as one JSON line.
 */
const XEMBED_PROBE = `const x = Deno.dlopen("libX11.so.6", {
  XOpenDisplay: { parameters: ["pointer"], result: "pointer" },
  XDefaultScreen: { parameters: ["pointer"], result: "i32" },
  XDefaultRootWindow: { parameters: ["pointer"], result: "u64" },
  XInternAtom: { parameters: ["pointer", "buffer", "i32"], result: "u64" },
  XGetSelectionOwner: { parameters: ["pointer", "u64"], result: "u64" },
  XGetClassHint: { parameters: ["pointer", "u64", "buffer"], result: "i32" },
  XQueryTree: {
    parameters: ["pointer", "u64", "buffer", "buffer", "buffer", "buffer"],
    result: "i32",
  },
  XFree: { parameters: ["pointer"], result: "i32" },
  XCloseDisplay: { parameters: ["pointer"], result: "i32" },
}).symbols;
const dpy = x.XOpenDisplay(null);
// A window's WM_CLASS class (else its instance name), or null.
const classOf = (w) => {
  const hint = new BigUint64Array(2);
  if (x.XGetClassHint(dpy, w, hint) === 0) return null;
  let name = null;
  for (const [i, address] of [...hint].entries()) {
    const p = Deno.UnsafePointer.create(address);
    if (p === null) continue;
    const text = Deno.UnsafePointerView.getCString(p);
    if (text && (i === 1 || name === null)) name = text;
    x.XFree(p);
  }
  return name;
};
// The windows under w, breadth first (bounded).
const windows = (top) => {
  const out = [];
  const queue = [top];
  while (queue.length && out.length < 4000) {
    const w = queue.shift();
    const parent = new BigUint64Array(1);
    const children = new BigUint64Array(1);
    const count = new Uint32Array(1);
    if (x.XQueryTree(dpy, w, parent, parent, children, count) === 0) continue;
    const list = Deno.UnsafePointer.create(children[0]);
    if (list === null) continue;
    const view = new Deno.UnsafePointerView(list);
    for (let i = 0; i < count[0]; i++) {
      const child = view.getBigUint64(i * 8);
      out.push(child);
      queue.push(child);
    }
    x.XFree(list);
  }
  return out;
};
if (dpy === null) {
  console.log(JSON.stringify({ display: false }));
} else {
  const selection = "_NET_SYSTEM_TRAY_S" + x.XDefaultScreen(dpy);
  const atom = x.XInternAtom(dpy, new TextEncoder().encode(selection + "\\0"), 1);
  const owner = atom === 0n ? 0n : x.XGetSelectionOwner(dpy, atom);
  let name = owner === 0n ? null : classOf(owner);
  if (owner !== 0n && name === null) {
    // The selection window usually has no WM_CLASS (i3bar's doesn't): name it after another
    // window of the same X client (the same resource id base), such as the bar itself.
    const base = owner & ~0x1fffffn;
    for (const w of windows(x.XDefaultRootWindow(dpy))) {
      if (w !== owner && (w & ~0x1fffffn) === base && (name = classOf(w)) !== null) break;
    }
  }
  x.XCloseDisplay(dpy);
  console.log(JSON.stringify({
    display: true,
    selection,
    owner: owner === 0n ? null : "0x" + owner.toString(16),
    name,
  }));
}
`;

/**
 * The XEmbed system tray on the X display (`_NET_SYSTEM_TRAY_S<n>`'s owner), as the runtime reads
 * it before it falls back to one: `false` when no one owns the selection, `null` when the display
 * could not be asked (no libX11, no X server answering).
 */
async function xembedTray(
  run: DoctorRunner,
  deno: string,
): Promise<DoctorXEmbedTray | false | null> {
  const out = await run(deno, ["eval", XEMBED_PROBE]);
  if (out === null || out.code !== 0) return null;
  try {
    const r = JSON.parse(out.stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
    if (r.display !== true) return null;
    if (typeof r.owner !== "string") return false;
    return { owner: r.owner, name: typeof r.name === "string" && r.name ? r.name : null };
  } catch {
    return null;
  }
}

/** The desktops Chromium's `GetDesktopEnvironment` knows by `XDG_CURRENT_DESKTOP` (not KDE). */
const CHROMIUM_DESKTOPS = new Set([
  "Unity",
  "Deepin",
  "GNOME",
  "X-Cinnamon",
  "Pantheon",
  "XFCE",
  "UKUI",
  "LXQt",
  "COSMIC",
]);

/**
 * Whether Chromium's password store lands on KWallet here (its own rule, as the runtime mirrors
 * it): the first desktop `XDG_CURRENT_DESKTOP` names that Chromium knows decides; else
 * `DESKTOP_SESSION`; else `KDE_FULL_SESSION` (unless `GNOME_DESKTOP_SESSION_ID` is set). A
 * variable set to "" counts as set.
 */
function chromiumPicksKWallet(env: (key: string) => string | undefined): boolean {
  for (const raw of (env("XDG_CURRENT_DESKTOP") ?? "").split(":")) {
    const desktop = raw.trim();
    if (desktop === "KDE") return true;
    if (CHROMIUM_DESKTOPS.has(desktop)) return false;
  }
  const session = env("DESKTOP_SESSION") ?? "";
  if (["kde4", "kde-plasma", "kde"].includes(session)) return true;
  if (
    ["deepin", "gnome", "mate", "xubuntu", "ukui"].includes(session) || session.includes("xfce")
  ) return false;
  if (env("GNOME_DESKTOP_SESSION_ID") !== undefined) return false;
  return env("KDE_FULL_SESSION") !== undefined;
}

/**
 * The cookie store a CEF window starts a new profile with, as the runtime picks it
 * (`NeedsBasicPasswordStore`): the OS key when the Secret Service hands it out (running and
 * unlocked, or locked where someone can answer its unlock prompt: a graphical session, and gcr's
 * prompter for gnome-keyring), else `--password-store=basic`; with no Secret Service at all
 * Chromium falls back to basic by itself. Where Chromium uses KWallet the wallet's state decides,
 * which the doctor doesn't read.
 */
function cookieStore(
  secretService: DoctorSecretService,
  prompter: boolean,
  env: (key: string) => string | undefined,
): { store: LinuxSessionFacts["cookieEncryption"]; reason: string | null } {
  if (chromiumPicksKWallet(env)) {
    return {
      store: "unknown",
      reason: "Chromium keeps the cookie key in KWallet on this desktop, and the doctor doesn't " +
        "read the wallet's state (appCapabilities().cookieEncryption in the app says)",
    };
  }
  switch (secretService) {
    case "available":
      return { store: "os", reason: null };
    case "absent":
      return {
        store: "basic",
        reason: "no Secret Service (org.freedesktop.secrets): Chromium falls back to its fixed key",
      };
    case "no-session-bus":
      return { store: "basic", reason: "no session bus: Chromium falls back to its fixed key" };
    default:
      if (prompter) return { store: "os", reason: null };
      return {
        store: "basic",
        reason: secretService === "locked"
          ? "the default keyring is locked and no one can answer its unlock prompt here (no " +
            "graphical session, or gnome-keyring without gcr's prompter)"
          : "the Secret Service is not running, and once started it may ask for an unlock no " +
            "one can answer here (no graphical session, or gnome-keyring without gcr's prompter)",
      };
  }
}

/** The portal interfaces' versions. */
async function portalVersions(run: DoctorRunner, names: BusNames): Promise<Record<string, number>> {
  const versions: Record<string, number> = {};
  for (const iface of PORTAL_INTERFACES) {
    const raw = await getProperty(
      run,
      names.tool,
      PORTAL,
      "/org/freedesktop/portal/desktop",
      `org.freedesktop.portal.${iface}`,
      "version",
    );
    const m = raw === null ? null : /(\d+)\D*$/.exec(raw);
    if (m) versions[iface] = Number(m[1]);
  }
  return versions;
}

/**
 * Whether the portal offers the host app registry (introspected; never called): `null` when the
 * introspection failed (the portal did not answer, or this busctl refuses an interface the object
 * lacks).
 */
async function portalRegistry(
  run: DoctorRunner,
  tool: BusNames["tool"],
): Promise<boolean | null> {
  const out = tool === "busctl"
    ? await run("busctl", [
      "--user",
      `--timeout=${CALL_TIMEOUT_S}`,
      "introspect",
      PORTAL,
      PORTAL_PATH,
      REGISTRY,
    ])
    : await run("gdbus", [
      "introspect",
      "--session",
      "--dest",
      PORTAL,
      "--object-path",
      PORTAL_PATH,
    ]);
  if (out === null || out.code !== 0) return null;
  return tool === "busctl" ? out.stdout.includes(".Register") : out.stdout.includes(REGISTRY);
}

/**
 * The display that is actually there, as the runtime finds it (laufey's `DisplayBackend`):
 * `wayland` when `$WAYLAND_SOCKET` hands one over or `$WAYLAND_DISPLAY` names a socket that exists
 * (an absolute path, else one under `$XDG_RUNTIME_DIR`), else `x11` when `$DISPLAY` is set, else
 * none.
 */
function displayBackend(
  env: (k: string) => string | undefined,
  isSocket: (path: string) => boolean,
): "wayland" | "x11" | null {
  if (env("WAYLAND_SOCKET")) return "wayland";
  const wayland = env("WAYLAND_DISPLAY") ?? "";
  if (wayland !== "") {
    const runtimeDir = env("XDG_RUNTIME_DIR") ?? "";
    const path = wayland.startsWith("/") ? wayland : runtimeDir ? `${runtimeDir}/${wayland}` : "";
    if (path !== "" && isSocket(path)) return "wayland";
  }
  return env("DISPLAY") ? "x11" : null;
}

/**
 * The session type, as the runtime reports it: `XDG_SESSION_TYPE` (`"unknown"` when unset), a
 * graphical one (`x11` / `wayland`) corrected to the display that is there. A declared `wayland`
 * with only an X display is `x11`: GDM can register an Xorg session (XFCE, i3) as `wayland`, and a
 * backend that believed it (CEF's Ozone platform) would open no window. A display alone never
 * makes a session graphical (Xvfb under cron or a systemd service has a `$DISPLAY` and no one in
 * front of it).
 *
 * @param env Env reader.
 * @param isSocket Whether a path is a Unix socket (default: `Deno.statSync`).
 * @returns The session type.
 */
export function sessionTypeOf(
  env: (k: string) => string | undefined,
  isSocket: (path: string) => boolean = defaultIsSocket,
): LinuxSessionFacts["sessionType"] {
  const declared = (env("XDG_SESSION_TYPE") ?? "").trim().toLowerCase();
  if (declared === "wayland" || declared === "x11") {
    return displayBackend(env, isSocket) ?? declared;
  }
  return declared === "tty" ? "tty" : "unknown";
}

/** The first line of a D-Bus error, without GDBus's `GDBus.Error:<name>: ` / busctl's prefix. */
function dbusErrorText(stderr: string | undefined): string {
  const line = (stderr ?? "").trim().split("\n")[0] ?? "";
  return line
    .replace(/^Error:\s*/, "")
    .replace(/^Call failed:\s*/, "")
    .replace(/^GDBus\.Error:[\w.]+:\s*/, "")
    .slice(0, 200);
}

/**
 * Start the activatable notification server, as the runtime does when notifications are first
 * used (`StartServiceByName`): `null` when it started, else the runtime's reason.
 */
async function startNotificationServer(
  run: DoctorRunner,
  tool: BusNames["tool"],
): Promise<string | null> {
  const out = tool === "busctl"
    ? await run("busctl", [
      "--user",
      `--timeout=${CALL_TIMEOUT_S}`,
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "StartServiceByName",
      "su",
      NOTIFICATIONS,
      "0",
    ])
    : await run("gdbus", [
      "call",
      "--session",
      "--timeout",
      String(CALL_TIMEOUT_S),
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.StartServiceByName",
      NOTIFICATIONS,
      "0",
    ]);
  if (out !== null && out.code === 0) return null;
  return "D-Bus could not start the notification server for org.freedesktop.Notifications: " +
    (out === null ? "no answer" : dbusErrorText(out.stderr) || `exit status ${out.code}`);
}

/** Whether the linker cache lists `libsecret-1.so.0` (`null`: it could not be read). */
async function hasLibsecret(run: DoctorRunner): Promise<boolean | null> {
  const out = await run("/sbin/ldconfig", ["-p"]);
  if (out === null || out.code !== 0 || out.stdout.trim() === "") return null;
  return out.stdout.includes("libsecret-1.so.0");
}

/**
 * The Chromium sandbox a CEF window would get here, probed as the runtime probes it: root never
 * runs sandboxed; else a user namespace with a nested one (Chromium's check) means `namespace`;
 * else only the setuid helper is left.
 */
async function probeSandbox(run: DoctorRunner): Promise<DoctorSandbox> {
  const uid = await run("id", ["-u"]);
  if (uid?.code === 0 && uid.stdout.trim() === "0") {
    return { mode: "off", reason: "running as root: Chromium refuses its sandbox to root" };
  }
  const ns = await run("unshare", ["--user", "--map-root-user", "unshare", "--user", "true"]);
  if (ns === null) {
    return { mode: "unknown", reason: "unshare (util-linux) is not installed to probe with" };
  }
  if (ns.code === 0) {
    return { mode: "namespace", reason: "unprivileged user namespaces work" };
  }
  const apparmor = await run("cat", ["/proc/sys/kernel/apparmor_restrict_unprivileged_userns"]);
  const restricted = apparmor?.code === 0 && apparmor.stdout.trim() === "1";
  return {
    mode: "helper",
    reason: restricted
      ? "unprivileged user namespaces are restricted by AppArmor " +
        "(kernel.apparmor_restrict_unprivileged_userns=1)"
      : "unprivileged user namespaces are not available (the kernel or a container refused)",
  };
}

/** The session bus's names (`busctl --user`, else `gdbus`), and which tool read them. */
async function readBusNames(
  run: DoctorRunner,
): Promise<{ names: BusNames | null; probe: LinuxSessionFacts["probe"] }> {
  const viaBusctl = await busctlNames(run);
  if (viaBusctl !== "no-tool" && viaBusctl !== null) return { names: viaBusctl, probe: "busctl" };
  const viaGdbus = await gdbusNames(run);
  if (viaGdbus !== "no-tool") return { names: viaGdbus, probe: "gdbus" };
  return { names: null, probe: viaBusctl === "no-tool" ? null : "busctl" };
}

/** The facts the session-independent part of the probe reads. */
type BaseFacts = Pick<
  LinuxSessionFacts,
  "sessionType" | "desktopHint" | "probe" | "libsecret" | "sandbox"
>;

/** The facts when no session bus answered (or no tool could ask one). */
function noBusFacts(base: BaseFacts, env: (key: string) => string | undefined): LinuxSessionFacts {
  const cookie = base.probe === null
    ? { store: "unknown" as const, reason: "the session bus could not be read" }
    : cookieStore("no-session-bus", false, env);
  return {
    ...base,
    sessionBus: false,
    trayHost: false,
    xembedTray: null,
    secretService: "no-session-bus",
    keyringUnlock: null,
    cookieEncryption: cookie.store,
    cookieEncryptionReason: cookie.reason,
    notifications: false,
    notificationReason: null,
    portal: false,
    portalAnswered: false,
    portalVersions: {},
    portalRegistry: false,
    systemdUser: false,
    launcherBadges: false,
  };
}

/** The Secret Service facts: its state, how a locked keyring unlocks, CEF's cookie store. */
async function secretFacts(
  run: DoctorRunner,
  names: BusNames,
  env: (key: string) => string | undefined,
  graphical: boolean,
): Promise<
  Pick<
    LinuxSessionFacts,
    "secretService" | "keyringUnlock" | "cookieEncryption" | "cookieEncryptionReason"
  >
> {
  const has = (name: string) => names.owned.has(name) || names.activatable.has(name);
  const secretService = await secretServiceState(run, names);
  // The runtime's `secret_prompter`: someone can answer an unlock prompt (a graphical session;
  // gnome-keyring asks through gcr's prompter, other providers prompt by themselves).
  const prompter = graphical && (!has(GNOME_KEYRING) || has(GCR_PROMPTER));
  const cookie = cookieStore(secretService, prompter, env);
  let unlock: LinuxSessionFacts["keyringUnlock"] = null;
  if (secretService === "locked") {
    unlock = has(GNOME_KEYRING) ? await keyringUnlock(run, env) : "unknown";
  }
  return {
    secretService,
    keyringUnlock: unlock,
    cookieEncryption: cookie.store,
    cookieEncryptionReason: cookie.reason,
  };
}

/** The portal facts: whether it is there, answered, its versions and its app id registry. */
async function portalFacts(
  run: DoctorRunner,
  names: BusNames,
): Promise<
  Pick<LinuxSessionFacts, "portal" | "portalAnswered" | "portalVersions" | "portalRegistry">
> {
  const portal = names.owned.has(PORTAL) || names.activatable.has(PORTAL);
  const versions = portal ? await portalVersions(run, names) : {};
  const registry = portal ? await portalRegistry(run, names.tool) : false;
  return {
    portal,
    // An introspection that fails while the versions answered is a portal without the registry.
    portalAnswered: portal && (registry !== null || Object.keys(versions).length > 0),
    portalVersions: versions,
    portalRegistry: registry === true,
  };
}

/**
 * Read this Linux session's facts over D-Bus (`busctl --user`, else `gdbus`).
 *
 * @param run The subprocess runner.
 * @param env Env reader.
 * @param isSocket Whether a path is a Unix socket (the Wayland display check).
 * @param deno The `deno` that runs the XEmbed tray probe (`deno eval`).
 * @returns The facts.
 */
export async function probeLinuxSession(
  run: DoctorRunner,
  env: (key: string) => string | undefined,
  isSocket: (path: string) => boolean = defaultIsSocket,
  deno = "deno",
): Promise<LinuxSessionFacts> {
  const { names, probe } = await readBusNames(run);
  const base: BaseFacts = {
    sessionType: sessionTypeOf(env, isSocket),
    desktopHint: env("XDG_CURRENT_DESKTOP") || null,
    probe,
    libsecret: await hasLibsecret(run),
    sandbox: await probeSandbox(run),
  };
  if (names === null) return noBusFacts(base, env);
  const notifiable = names.owned.has(NOTIFICATIONS) || names.activatable.has(NOTIFICATIONS);
  const notificationReason = !names.owned.has(NOTIFICATIONS) && names.activatable.has(NOTIFICATIONS)
    ? await startNotificationServer(run, names.tool)
    : null;
  const portal = await portalFacts(run, names);
  const trayHost = names.owned.has(TRAY_WATCHER);
  const graphical = (base.sessionType === "x11" || base.sessionType === "wayland") &&
    displayBackend(env, isSocket) !== null;
  return {
    ...base,
    sessionBus: true,
    trayHost,
    xembedTray: base.sessionType === "x11" && !trayHost ? await xembedTray(run, deno) : null,
    ...await secretFacts(run, names, env, graphical),
    notifications: notifiable && notificationReason === null,
    notificationReason,
    ...portal,
    systemdUser: names.owned.has(SYSTEMD),
    launcherBadges: LAUNCHER_BADGE_READERS.some((n) => names.owned.has(n)),
  };
}

/** The findings about the pinned runtime. */
function runtimeFindings(runtime: DoctorRuntime, linuxChecks: boolean): DesktopDoctorFinding[] {
  const s = runtime.status;
  const out: DesktopDoctorFinding[] = [];
  const add = (level: DesktopDoctorFinding["level"], message: string, fix: string) =>
    out.push({ check: "runtime", level, message, fix });
  if (s.mode === "stock") {
    add(
      "warning",
      "DENEXT_DESKTOP_RUNTIME=stock: the stock runtime has no session probe, so tray and " +
        "keyring problems show only as failures",
      "unset DENEXT_DESKTOP_RUNTIME to use denext's pinned runtime",
    );
  }
  if (s.mode !== "pinned") return out;
  if (s.deno.found !== s.deno.required) {
    add(
      "error",
      `the runtime ${s.version} needs Deno ${s.deno.required} exactly; \`deno\` is ` +
        `${s.deno.found ?? "not found"}`,
      `deno upgrade --version ${s.deno.required} (or point DENO_BIN at a Deno ` +
        `${s.deno.required} binary)`,
    );
  }
  if (s.cache === "unpinned") {
    add(
      "error",
      `no pinned runtime build for ${s.target}`,
      "set DENEXT_DESKTOP_RUNTIME=stock to use the stock runtime",
    );
  } else if (s.cache === "invalid") {
    add(
      "warning",
      "the cached runtime failed verification",
      "nothing to do: the next `denext desktop run` or `package` downloads it again",
    );
  } else if (s.backend === null) {
    add("error", s.detail, 'set deno.json desktop.backend to "webview" or "cef"');
  }
  if (linuxChecks && !runtime.platformFeatures) {
    add(
      "warning",
      `the pinned runtime ${s.version} (laufey API ${runtime.laufeyApiVersion}) predates ` +
        "Deno.desktop.platformFeatures(): appCapabilities() / windowCapabilities() report the " +
        'session facts as "unknown", and a tray with no tray host is not detected',
      "upgrade denext to a release that pins runtime 2.9.7-denext.10 or later",
    );
  }
  if (linuxChecks && !runtime.linuxNotifications) {
    add(
      "warning",
      `the pinned runtime ${s.version} predates Linux notification cold starts, scheduled ` +
        "notifications posted while the app is closed, and launcher badges: a click on a " +
        "notification can't start the app, a schedule waits for the app to run, and setBadge() " +
        'is a "(N) " title prefix',
      "upgrade denext to a release that pins runtime 2.9.7-denext.11 or later",
    );
  }
  return out;
}

/**
 * The Windows CEF signing check: CEF's bootstrap verifies the app's Authenticode signature with
 * WinVerifyTrust and dies at launch when it does not chain to a trusted root, so a CEF app signed
 * with an untrusted DENEXT_WINDOWS_CERT (a self-signed test certificate) never starts here.
 */
async function cefSigningFindings(
  env: (key: string) => string | undefined,
  powershell: PowerShellRunner | undefined,
): Promise<DesktopDoctorFinding[]> {
  const cert = env("DENEXT_WINDOWS_CERT")?.trim();
  if (!cert) return [];
  const trust = await certificateTrust(cert, env("DENEXT_WINDOWS_CERT_PASSWORD"), {
    os: "windows",
    powershell,
  });
  const problem = trust ? cefCertificateProblem(trust) : undefined;
  return problem
    ? [{ check: "cef-signing", level: "warning", message: problem, fix: CEF_SIGNING_FIX }]
    : [];
}

/** The fix for a missing tray host. */
const TRAY_FIX = "GNOME: install and enable the AppIndicator extension " +
  "(`gnome-shell-extension-appindicator`, then `gnome-extensions enable " +
  "appindicatorsupport@rgcjonas.gmail.com`, or ubuntu-appindicators@ubuntu.com on Ubuntu) and log " +
  "in again; other desktops: run a StatusNotifierItem host (Plasma has one; on Sway, waybar's " +
  "tray module); X11 window managers: an XEmbed system tray works too (xfce4-panel's " +
  "notification area, i3bar, stalonetray)";

/** The fix for a CEF app that would run unsandboxed: the packages, or refusing to start. */
const SANDBOX_FIX = "ship the .deb / .rpm (they install chrome-sandbox setuid root), or allow " +
  "unprivileged user namespaces for the app (an AppArmor profile); to refuse to start " +
  "unsandboxed instead, set desktop.linux.requireSandbox: true (the package scripts write " +
  '"requireSandbox": true to laufey-launch.json; or launch with LAUFEY_REQUIRE_SANDBOX=1): the ' +
  "app then exits with status 78 and one line saying why";

/** The findings about the Secret Service. */
function secretFindings(f: LinuxSessionFacts): DesktopDoctorFinding[] {
  const out: DesktopDoctorFinding[] = [];
  if (f.secretService === "absent") {
    out.push({
      check: "secret-service",
      level: "warning",
      message: "no Secret Service (org.freedesktop.secrets): secureStore cannot store secrets, " +
        "and the CEF backend keeps its cookies unencrypted (--password-store=basic)",
      fix: "install gnome-keyring (or enable KWallet's or KeePassXC's Secret Service integration)",
    });
  } else if (f.secretService === "locked" && f.keyringUnlock !== "no-password") {
    out.push({
      check: "secret-service",
      level: "warning",
      message: "the default keyring is locked (or missing): reads prompt to unlock it, and where " +
        "no one can answer that prompt (a headless or ssh session) the CEF backend starts with " +
        "--password-store=basic, keeping its cookies unencrypted",
      fix: "unlock it (Passwords and Keys / seahorse), or give the login keyring your login " +
        "password so logging in unlocks it",
    });
  }
  if (f.libsecret === false) {
    out.push({
      check: "libsecret",
      level: "warning",
      message: "libsecret (libsecret-1.so.0) is not installed: the runtime loads it for " +
        "secureStore, which rejects backend_unavailable without it",
      fix: "install libsecret-1-0 (Debian / Ubuntu) or libsecret (Fedora, Arch); the app's .deb " +
        "/ .rpm depend on it when secure-store is on",
    });
  }
  return out;
}

/** The fix for a CEF cookie store on Chromium's fixed key, by why. */
function cookieFix(f: LinuxSessionFacts): string {
  if (f.secretService === "absent") {
    return "install gnome-keyring (or enable KWallet's or KeePassXC's Secret Service integration)";
  }
  if (f.secretService === "no-session-bus") {
    return "run the app inside a desktop session (it needs a D-Bus session bus)";
  }
  return "run the app in the graphical session, where the keyring's unlock prompt can be answered " +
    "(gnome-keyring prompts through gcr: install gcr), or give the login keyring your login " +
    "password so logging in unlocks it";
}

/** The finding about a CEF app's cookie store (none for the WebView backend). */
function cookieFindings(f: LinuxSessionFacts, runtime: DoctorRuntime): DesktopDoctorFinding[] {
  if (runtime.status.backend !== "cef" || f.cookieEncryption !== "basic") return [];
  return [{
    check: "cookie-encryption",
    level: "warning",
    message: "a CEF window keeps its cookies with --password-store=basic (Chromium's fixed key: " +
      `obfuscated, not encrypted with an OS-held key): ${f.cookieEncryptionReason}`,
    fix: cookieFix(f),
  }];
}

/** The finding about the Chromium sandbox of a CEF app (none for the WebView backend). */
function sandboxFindings(f: LinuxSessionFacts, runtime: DoctorRuntime): DesktopDoctorFinding[] {
  if (runtime.status.backend !== "cef") return [];
  if (f.sandbox.mode === "helper") {
    return [{
      check: "sandbox",
      level: "warning",
      message: `${f.sandbox.reason}: installed from its .deb / .rpm the app runs web content in ` +
        "Chromium's sandbox through the setuid chrome-sandbox helper; from the .tar.gz or an " +
        'AppImage it runs unsandboxed (appCapabilities().sandbox "off")',
      fix: SANDBOX_FIX,
    }];
  }
  if (f.sandbox.mode === "off") {
    return [{
      check: "sandbox",
      level: "warning",
      message: `${f.sandbox.reason}: a CEF app run like this has no sandbox for its web content`,
      fix: "run the app as a normal user",
    }];
  }
  return [];
}

/** The findings about the portal. */
function portalFindings(f: LinuxSessionFacts): DesktopDoctorFinding[] {
  if (!f.portal) {
    return [{
      check: "portal",
      level: "warning",
      message: "no xdg-desktop-portal: file dialogs fall back to GTK, and Wayland global " +
        "shortcuts are unavailable",
      fix: "install xdg-desktop-portal and your desktop's backend (xdg-desktop-portal-gnome, " +
        "-kde or -wlr; add -gtk for file dialogs on wlroots)",
    }];
  }
  if (!f.portalAnswered) {
    return [{
      check: "portal",
      level: "warning",
      message: "xdg-desktop-portal is installed but did not answer (it is not running, and D-Bus " +
        "could not start it): file dialogs fall back to GTK, notifications go to " +
        "org.freedesktop.Notifications, and Wayland global shortcuts are unavailable",
      fix: "check `systemctl --user status xdg-desktop-portal` (and `journalctl --user -u " +
        "xdg-desktop-portal`): it needs a backend for this desktop (xdg-desktop-portal-gnome, " +
        "-kde, -wlr or -gtk) and a session that exports its display to the user manager",
    }];
  }
  const out: DesktopDoctorFinding[] = [];
  if (f.portalVersions.FileChooser === undefined) {
    out.push({
      check: "portal",
      level: "warning",
      message: "the portal has no FileChooser backend",
      fix: "install xdg-desktop-portal-gtk (or -gnome / -kde)",
    });
  }
  if (f.sessionType === "wayland" && f.portalVersions.GlobalShortcuts === undefined) {
    out.push({
      check: "portal",
      level: "warning",
      message: "the portal has no GlobalShortcuts backend: registerShortcut() rejects " +
        "unsupported on Wayland",
      fix: "use a portal backend that implements it (xdg-desktop-portal-kde, recent " +
        "xdg-desktop-portal-gnome, -hyprland)",
    });
  }
  return out;
}

/**
 * The findings about notification clicks, scheduled notifications and the launcher badge (what
 * runtime 2.9.7-denext.11 uses; an older runtime gets one runtime finding instead).
 */
function notificationFindings(f: LinuxSessionFacts): DesktopDoctorFinding[] {
  const out: DesktopDoctorFinding[] = [];
  if (f.notifications && f.portal && f.portalAnswered && !f.portalRegistry) {
    out.push({
      check: "notification-clicks",
      level: "warning",
      message: "xdg-desktop-portal can't register an app's id (older than 1.19): notifications " +
        "go to org.freedesktop.Notifications, so a click after the app quit can't start it",
      fix: "upgrade xdg-desktop-portal to 1.19 or later; installing the app from its .deb / .rpm " +
        "(its desktop entry and D-Bus service file) is the other half",
    });
  }
  if (!f.systemdUser) {
    out.push({
      check: "scheduled-notifications",
      level: "warning",
      message: "no systemd user manager on the session bus: a notification scheduled for while " +
        "the app is closed is posted at its next launch",
      fix: "log in through a systemd distribution's display manager (its user manager runs " +
        "with every login); there is no other scheduler",
    });
  }
  if (!f.launcherBadges) {
    out.push({
      check: "badge",
      level: "warning",
      message: "no dock reads launcher badges (com.canonical.Unity.LauncherEntry): setBadge() " +
        'shows a "(N) " prefix on the window titles',
      fix: "GNOME: enable Ubuntu Dock or Dash to Dock; Plasma's task manager reads them",
    });
  }
  return out;
}

/** The findings about the Linux session. */
function linuxFindings(f: LinuxSessionFacts, runtime: DoctorRuntime): DesktopDoctorFinding[] {
  const out: DesktopDoctorFinding[] = [];
  if (f.sessionType === "tty" || f.sessionType === "unknown") {
    out.push({
      check: "session",
      level: "warning",
      message: `no graphical session in this terminal (session type ${f.sessionType}): the ` +
        "facts below are this terminal's, not the desktop's",
      fix: "run `denext desktop doctor` from a terminal inside the desktop session",
    });
  }
  if (f.probe === null) {
    out.push({
      check: "session-bus",
      level: "warning",
      message: "neither busctl nor gdbus is installed, so the session could not be read",
      fix: "install systemd's busctl or GLib's gdbus (libglib2.0-bin on Debian / Ubuntu)",
    });
    return [
      ...out,
      ...secretFindings({ ...f, secretService: "available" }),
      ...sandboxFindings(f, runtime),
    ];
  }
  if (!f.sessionBus) {
    out.push({
      check: "session-bus",
      level: "error",
      message: "no D-Bus session bus answered: tray icons, notifications, the secure store and " +
        "the portals all need one",
      fix: "run inside a desktop session, or start one with `dbus-run-session -- <command>`",
    });
    return out;
  }
  if (!f.trayHost && !f.xembedTray) {
    out.push({
      check: "tray-host",
      level: "warning",
      message: f.sessionType === "x11" && f.xembedTray === false
        ? "no tray host: no StatusNotifierWatcher on the session bus, and no XEmbed system tray " +
          "on the display (no one owns _NET_SYSTEM_TRAY_S<n>): createTray() rejects unsupported " +
          "and a tray-only app shows its window instead"
        : f.sessionType === "x11"
        ? "no StatusNotifierWatcher on the session bus: unless the window manager runs an " +
          "XEmbed system tray (which the runtime also uses on X11, but the display could not be " +
          "asked here; appCapabilities().trayHost in the app says), createTray() rejects " +
          "unsupported and a tray-only app shows its window instead"
        : "no tray host (no StatusNotifierWatcher on the session bus): createTray() " +
          "rejects unsupported and a tray-only app shows its window instead",
      fix: TRAY_FIX,
    });
  }
  out.push(...secretFindings(f));
  if (f.notificationReason !== null) {
    out.push({
      check: "notifications",
      level: "warning",
      message: f.notificationReason,
      fix: "the server D-Bus activates failed to start: check its service file and its log " +
        "(`journalctl --user`), or run a server that starts with the session (GNOME and Plasma " +
        "include one; on Sway / wlroots, mako or dunst)",
    });
  } else if (!f.notifications) {
    out.push({
      check: "notifications",
      level: "warning",
      message: "no notification server (org.freedesktop.Notifications)",
      fix: "GNOME and Plasma include one; on Sway / wlroots install mako or dunst",
    });
  }
  out.push(...portalFindings(f));
  if (runtime.linuxNotifications) out.push(...notificationFindings(f));
  out.push(...cookieFindings(f, runtime), ...sandboxFindings(f, runtime));
  return out;
}

/**
 * Run the desktop doctor: the pinned runtime, on Linux the session facts, and on Windows whether a
 * CEF app signed with DENEXT_WINDOWS_CERT would start.
 *
 * @param options The runtime status and the seams.
 * @returns The report.
 */
export async function runDesktopDoctor(
  options: DesktopDoctorOptions,
): Promise<DesktopDoctorReport> {
  const os = options.os ?? Deno.build.os;
  const pin = options.pin ?? DESKTOP_RUNTIME_PIN;
  const linuxChecks = options.linux ?? os === "linux";
  const laufeyApiVersion = (pin as { laufeyApiVersion?: number }).laufeyApiVersion ?? 0;
  const release = runtimeRelease((pin as { version?: unknown }).version);
  const runtime: DoctorRuntime = {
    status: await options.runtimeStatus(),
    laufeyApiVersion,
    platformFeatures: laufeyApiVersion >= PLATFORM_FEATURES_API,
    linuxNotifications: release !== null && release >= LINUX_NOTIFICATIONS_RELEASE,
  };
  const linux = linuxChecks
    ? await probeLinuxSession(
      options.run ?? defaultDoctorRunner,
      options.env ?? ((k) => Deno.env.get(k)),
      options.isSocket,
      options.deno,
    )
    : null;
  const cefSigning = os === "windows" && runtime.status.backend === "cef";
  const checks = ["runtime", ...(linux ? linuxCheckNames(runtime) : [])];
  if (cefSigning) checks.push("cef-signing");
  return {
    os,
    runtime,
    linux,
    checks,
    findings: [
      ...runtimeFindings(runtime, linuxChecks),
      ...(linux ? linuxFindings(linux, runtime) : []),
      ...(cefSigning
        ? await cefSigningFindings(options.env ?? ((k) => Deno.env.get(k)), options.powershell)
        : []),
    ],
  };
}

/** The Linux session checks that run for `runtime`, in order. */
function linuxCheckNames(runtime: DoctorRuntime): string[] {
  const checks = [
    "session",
    "session-bus",
    "tray-host",
    "secret-service",
    "libsecret",
    "notifications",
    "portal",
  ];
  if (runtime.linuxNotifications) {
    checks.push("notification-clicks", "scheduled-notifications", "badge");
  }
  if (runtime.status.backend === "cef") checks.push("cookie-encryption", "sandbox");
  return checks;
}

/** The sandbox a CEF window would run in, for the listing. */
const SANDBOX_TEXT: Record<DoctorSandbox["mode"], string> = {
  namespace: "namespace",
  helper: "setuid from a .deb / .rpm install, off from a .tar.gz or AppImage",
  off: "off",
  unknown: "unknown",
};

/** The tray fact: a host, an XEmbed tray, or none. */
function trayText(f: LinuxSessionFacts): string {
  if (f.trayHost) return "a tray host runs";
  if (f.xembedTray) {
    return `an XEmbed system tray (${f.xembedTray.name ?? `window ${f.xembedTray.owner}`})`;
  }
  if (f.sessionType !== "x11") return "no tray host";
  return f.xembedTray === false
    ? "no StatusNotifierWatcher, no XEmbed system tray"
    : "no StatusNotifierWatcher (an XEmbed tray is not visible from here)";
}

/** The Secret Service fact, with how a locked keyring unlocks. */
function secretText(f: LinuxSessionFacts): string {
  if (f.secretService !== "locked") return f.secretService;
  if (f.keyringUnlock === "no-password") {
    return "locked (no password: it unlocks on first use, with no prompt)";
  }
  return f.keyringUnlock === "password" ? "locked (a password unlocks it: a prompt)" : "locked";
}

/** CEF's cookie store fact. */
function cookieText(f: LinuxSessionFacts): string {
  return f.cookieEncryptionReason
    ? `CEF: ${f.cookieEncryption} (${f.cookieEncryptionReason})`
    : `CEF: ${f.cookieEncryption}`;
}

/** The portal fact: its interfaces, or why there are none. */
function portalText(f: LinuxSessionFacts): string {
  if (!f.portal) return "absent";
  if (!f.portalAnswered) return "installed, did not answer";
  return Object.entries(f.portalVersions).map(([k, v]) => `${k} v${v}`).join(", ") ||
    "no interfaces";
}

/** `yes` / `no`. */
const yesNo = (b: boolean) => (b ? "yes" : "no");

/** The Linux session's lines for the listing. */
function linuxFactLines(f: LinuxSessionFacts): string[] {
  const libsecret = f.libsecret === null ? "unknown" : f.libsecret ? "installed" : "missing";
  return [
    `  session   ${f.sessionType}${f.desktopHint ? ` (${f.desktopHint})` : ""}; session bus ${
      f.sessionBus ? `yes (via ${f.probe})` : "no"
    }`,
    `  tray      ${trayText(f)}`,
    `  secrets   ${secretText(f)}; libsecret ${libsecret}`,
    `  cookies   ${cookieText(f)}`,
    `  notify    ${f.notifications ? "a notification server" : "none"}; app id registry ${
      yesNo(f.portalRegistry)
    }; systemd user manager ${yesNo(f.systemdUser)}`,
    `  portal    ${portalText(f)}`,
    `  badge     ${f.launcherBadges ? "a dock reads launcher badges" : '"(N) " title prefix'}`,
    `  sandbox   CEF: ${SANDBOX_TEXT[f.sandbox.mode]} (${f.sandbox.reason})`,
  ];
}

/** A fact for the listing. */
function factLines(report: DesktopDoctorReport): string[] {
  const lines = [`  runtime   ${report.runtime.status.detail}`];
  lines.push(
    `  probe     Deno.desktop.platformFeatures() ${
      report.runtime.platformFeatures ? "available" : 'not in this runtime (facts read "unknown")'
    }`,
  );
  return report.linux ? [...lines, ...linuxFactLines(report.linux)] : lines;
}

/**
 * The report as the lines `denext desktop doctor` prints.
 *
 * @param report A report from {@linkcode runDesktopDoctor}.
 * @returns The text, without a trailing newline.
 */
export function formatDesktopDoctor(report: DesktopDoctorReport): string {
  return [...factLines(report), "", ...formatDoctorFindings(report.checks, report.findings)]
    .join("\n");
}
