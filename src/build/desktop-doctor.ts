// `denext desktop doctor [--linux] [--json]`: what the Deno Desktop runtime will find on this
// machine, with a fix for each missing piece.
//
//   - The pinned runtime: its version, whether the `deno` on PATH is its exact Deno version, the
//     cache state (the same status `denext doctor` prints), and whether it carries the session
//     probe (`Deno.desktop.platformFeatures()`, laufey API 45, runtime 2.9.7-denext.10).
//   - On Linux (or with `--linux`), the session facts the runtime's probe reports, read the same
//     way from the CLI: the session type, the D-Bus session bus, a tray host
//     (`org.kde.StatusNotifierWatcher`), the Secret Service and its lock state, `secret-tool`, a
//     notification server and the xdg-desktop-portal interfaces with their versions.
//
// The probe needs no window: it asks the session bus through `busctl --user` (systemd) or
// `gdbus` (GLib), argv only, never a shell, each call bounded by a timeout. The runtime's own
// probe runs only inside a desktop app, and the pinned runtime may predate it, so the CLI reads the
// same D-Bus names instead of building an app to ask. It never starts the Secret Service or asks
// it to unlock; reading the portal's versions may start xdg-desktop-portal (D-Bus activation),
// as any portal call would.

import {
  DESKTOP_RUNTIME_PIN,
  type DesktopRuntimePin,
  type DesktopRuntimeStatus,
} from "./desktop-runtime.ts";
import { formatDoctorFindings } from "./doctor-format.ts";

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

/** What this Linux session provides, read over D-Bus. */
export interface LinuxSessionFacts {
  /** From `XDG_SESSION_TYPE`, else `WAYLAND_DISPLAY` / `DISPLAY`. */
  readonly sessionType: "wayland" | "x11" | "tty" | "unknown";
  /** `XDG_CURRENT_DESKTOP`: a hint for wording only, never a branch condition. */
  readonly desktopHint: string | null;
  /** The tool that read the bus, or `null` when neither is installed. */
  readonly probe: "busctl" | "gdbus" | null;
  /** A D-Bus session bus answered. */
  readonly sessionBus: boolean;
  /** `org.kde.StatusNotifierWatcher` is owned (a tray host runs). */
  readonly trayHost: boolean;
  /** The Secret Service's state, read without starting or unlocking it. */
  readonly secretService: DoctorSecretService;
  /** `secret-tool` (libsecret's CLI, which the secure store uses) is installed. */
  readonly secretTool: boolean;
  /** `org.freedesktop.Notifications` is owned or activatable. */
  readonly notifications: boolean;
  /** `org.freedesktop.portal.Desktop` is owned or activatable. */
  readonly portal: boolean;
  /** The portal interfaces offered, by version (an absent one is not listed). */
  readonly portalVersions: Readonly<Record<string, number>>;
}

/** The pinned runtime as the doctor reports it. */
export interface DoctorRuntime {
  /** `denext doctor`'s status of the pinned runtime for this host. */
  readonly status: DesktopRuntimeStatus;
  /** The pinned runtime's laufey API level. */
  readonly laufeyApiVersion: number;
  /** The pinned runtime has `Deno.desktop.platformFeatures()` (laufey API 45). */
  readonly platformFeatures: boolean;
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

/** Runs `cmd args` and captures stdout; `null` when `cmd` is not installed (or timed out). */
export type DoctorRunner = (
  cmd: string,
  args: readonly string[],
) => Promise<{ readonly code: number; readonly stdout: string } | null>;

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
  /** The pin (tests). */
  readonly pin?: DesktopRuntimePin;
}

/** The laufey API level that added `Deno.desktop.platformFeatures()`. */
const PLATFORM_FEATURES_API = 45;

/** One D-Bus call's bound. */
const CALL_TIMEOUT_S = 5;

/** The portal interfaces the runtime reports versions of. */
const PORTAL_INTERFACES = ["Notification", "FileChooser", "GlobalShortcuts", "Settings"] as const;

const TRAY_WATCHER = "org.kde.StatusNotifierWatcher";
const SECRETS = "org.freedesktop.secrets";
const NOTIFICATIONS = "org.freedesktop.Notifications";
const PORTAL = "org.freedesktop.portal.Desktop";

/** The default runner: `Deno.Command`, stdout captured, stderr dropped, killed after 8 s. */
export const defaultDoctorRunner: DoctorRunner = async (cmd, args) => {
  try {
    const out = await new Deno.Command(cmd, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(8_000),
    }).output();
    return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
  } catch {
    return null;
  }
};

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

/** The session type, as the runtime derives it. */
function sessionTypeOf(env: (k: string) => string | undefined): LinuxSessionFacts["sessionType"] {
  const declared = (env("XDG_SESSION_TYPE") ?? "").trim().toLowerCase();
  if (declared === "wayland" || declared === "x11" || declared === "tty") return declared;
  if (env("WAYLAND_DISPLAY")) return "wayland";
  if (env("DISPLAY")) return "x11";
  return "unknown";
}

/**
 * Read this Linux session's facts over D-Bus (`busctl --user`, else `gdbus`).
 *
 * @param run The subprocess runner.
 * @param env Env reader.
 * @returns The facts.
 */
export async function probeLinuxSession(
  run: DoctorRunner,
  env: (key: string) => string | undefined,
): Promise<LinuxSessionFacts> {
  let names: BusNames | null | "no-tool" = await busctlNames(run);
  let probe: LinuxSessionFacts["probe"] = names === "no-tool" ? null : "busctl";
  if (names === "no-tool" || names === null) {
    const viaGdbus = await gdbusNames(run);
    if (viaGdbus !== "no-tool") {
      names = viaGdbus;
      probe = "gdbus";
    }
  }
  const secretTool = (await run("secret-tool", [])) !== null;
  const base = {
    sessionType: sessionTypeOf(env),
    desktopHint: env("XDG_CURRENT_DESKTOP") || null,
    probe,
    secretTool,
  };
  if (names === null || names === "no-tool") {
    return {
      ...base,
      sessionBus: false,
      trayHost: false,
      secretService: "no-session-bus",
      notifications: false,
      portal: false,
      portalVersions: {},
    };
  }
  const has = (name: string) => names.owned.has(name) || names.activatable.has(name);
  const portal = has(PORTAL);
  return {
    ...base,
    sessionBus: true,
    trayHost: names.owned.has(TRAY_WATCHER),
    secretService: await secretServiceState(run, names),
    notifications: has(NOTIFICATIONS),
    portal,
    portalVersions: portal ? await portalVersions(run, names) : {},
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
  return out;
}

/** The fix for a missing tray host. */
const TRAY_FIX = "GNOME: install and enable the AppIndicator extension " +
  "(`gnome-shell-extension-appindicator`, then `gnome-extensions enable " +
  "appindicatorsupport@rgcjonas.gmail.com`, or ubuntu-appindicators@ubuntu.com on Ubuntu) and log " +
  "in again; other desktops: run a StatusNotifierItem host (Plasma has one; on Sway, waybar's " +
  "tray module)";

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
  } else if (f.secretService === "locked") {
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
  if (!f.secretTool) {
    out.push({
      check: "secret-tool",
      level: "warning",
      message: "secret-tool is not installed: denext's secureStore uses it on Linux",
      fix: "install libsecret-tools (Debian / Ubuntu) or libsecret (Fedora, Arch)",
    });
  }
  return out;
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

/** The findings about the Linux session. */
function linuxFindings(f: LinuxSessionFacts): DesktopDoctorFinding[] {
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
    return [...out, ...secretFindings({ ...f, secretService: "available" })];
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
  if (!f.trayHost) {
    out.push({
      check: "tray-host",
      level: "warning",
      message: "no tray host (no StatusNotifierWatcher on the session bus): createTray() " +
        "rejects unsupported and a tray-only app shows its window instead",
      fix: TRAY_FIX,
    });
  }
  out.push(...secretFindings(f));
  if (!f.notifications) {
    out.push({
      check: "notifications",
      level: "warning",
      message: "no notification server (org.freedesktop.Notifications)",
      fix: "GNOME and Plasma include one; on Sway / wlroots install mako or dunst",
    });
  }
  out.push(...portalFindings(f));
  return out;
}

/**
 * Run the desktop doctor: the pinned runtime, and on Linux the session facts.
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
  const runtime: DoctorRuntime = {
    status: await options.runtimeStatus(),
    laufeyApiVersion,
    platformFeatures: laufeyApiVersion >= PLATFORM_FEATURES_API,
  };
  const linux = linuxChecks
    ? await probeLinuxSession(
      options.run ?? defaultDoctorRunner,
      options.env ?? ((k) => Deno.env.get(k)),
    )
    : null;
  const checks = ["runtime"];
  if (linux) {
    checks.push(
      "session",
      "session-bus",
      "tray-host",
      "secret-service",
      "secret-tool",
      "notifications",
      "portal",
    );
  }
  return {
    os,
    runtime,
    linux,
    checks,
    findings: [...runtimeFindings(runtime, linuxChecks), ...(linux ? linuxFindings(linux) : [])],
  };
}

/** A fact for the listing. */
function factLines(report: DesktopDoctorReport): string[] {
  const lines = [`  runtime   ${report.runtime.status.detail}`];
  lines.push(
    `  probe     Deno.desktop.platformFeatures() ${
      report.runtime.platformFeatures ? "available" : 'not in this runtime (facts read "unknown")'
    }`,
  );
  const f = report.linux;
  if (!f) return lines;
  const portal = f.portal
    ? Object.entries(f.portalVersions).map(([k, v]) => `${k} v${v}`).join(", ") || "no interfaces"
    : "absent";
  lines.push(
    `  session   ${f.sessionType}${f.desktopHint ? ` (${f.desktopHint})` : ""}; session bus ${
      f.sessionBus ? `yes (via ${f.probe})` : "no"
    }`,
    `  tray      ${f.trayHost ? "a tray host runs" : "no tray host"}`,
    `  secrets   ${f.secretService}; secret-tool ${f.secretTool ? "installed" : "missing"}`,
    `  notify    ${f.notifications ? "a notification server" : "none"}`,
    `  portal    ${portal}`,
  );
  return lines;
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
