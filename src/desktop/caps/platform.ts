/**
 * The runtime's probe of the session (`Deno.desktop.platformFeatures()`, runtime 2.9.7-denext.10
 * and later), read for the `app`, `window` and `notifications` capabilities. Runtime
 * 2.9.7-denext.11 adds how the badge shows and, on Linux, how notifications are sent, whether a
 * click starts a quit app and whether a scheduled one is posted while it is closed. Runtime
 * 2.9.7-denext.12 adds the Chromium sandbox a Linux CEF window runs in and the file chooser a Linux
 * dialog uses, each with the runtime's reason. The runtime (laufey) does the probing:
 * D-Bus names, the Secret Service's lock state, the portal versions, the cookie store. denext only
 * validates what it answered and passes it on, so the page learns WHY a feature is missing.
 *
 * A runtime without the probe (denext.9 and older, the stock runtime), a probe that throws and a
 * `null` answer all read `"unknown"`: never a crash, never a guess.
 *
 * Runtime-only (imported by the caps, never a client bundle).
 *
 * @module
 */

import type { DesktopAppApi } from "../launch-events.ts";

/** A fact the runtime could not report (no probe in this runtime, or it did not answer). */
export type Unknown = "unknown";

/** The Secret Service's state as the runtime reads it (`"os"`: Keychain / DPAPI). */
export type SecretServiceState =
  | "available"
  | "locked"
  | "activatable"
  | "absent"
  | "no-session-bus"
  | "os";

/** How the badge shows: the Dock tile, a Linux launcher count, or a window-title prefix. */
export type BadgeShows = "dock" | "launcher-entry" | "title";

/** How Linux notifications are sent: the xdg-desktop-portal, or `org.freedesktop.Notifications`. */
export type NotificationTransport = "portal" | "freedesktop";

/**
 * The Chromium sandbox a Linux CEF window's web content runs in: unprivileged user namespaces, the
 * setuid `chrome-sandbox` helper (installed by the `.deb` / `.rpm`), on with Chromium choosing the
 * layer (the runtime's probe could not run), or off (neither is available: a tarball or AppImage
 * on Ubuntu 23.10 and later, or root).
 */
export type SandboxMode = "namespace" | "setuid" | "chromium" | "off";

/** The file chooser a Linux dialog uses: xdg-desktop-portal's FileChooser, or GTK's own. */
export type FileChooser = "portal" | "gtk";

/** The probe facts the capabilities surface. */
export interface PlatformFacts {
  /** Linux: `wayland` / `x11` / `tty` / `unknown`; `null` on macOS and Windows. */
  readonly sessionType: "wayland" | "x11" | "tty" | "unknown" | null;
  /** A tray icon can be seen here (Linux: a StatusNotifierWatcher or an XEmbed tray runs). */
  readonly trayHost: boolean | Unknown;
  /** Why not, when `trayHost` is `false`. */
  readonly trayReason: string | null;
  /** The Secret Service (the secure store's, and CEF's cookie key's, backing store). */
  readonly secretService: SecretServiceState | Unknown;
  /**
   * CEF's cookie store: `"os"` (encrypted with an OS-held key) or `"basic"` (a fixed key: always
   * on macOS, Chromium's mock keychain; on Linux when no keyring can be unlocked).
   */
  readonly cookieEncryption: "os" | "basic" | null | Unknown;
  /** How the badge shows (runtime 2.9.7-denext.11 and later). */
  readonly badge: BadgeShows | Unknown;
  /** Linux, when `badge` is `"title"`: why no launcher shows the count. */
  readonly badgeReason: string | null;
  /** Linux: how notifications are sent; `null` with no notification server (and elsewhere). */
  readonly notificationTransport: NotificationTransport | null | Unknown;
  /** Linux: a click on a notification starts the app when it isn't running. */
  readonly notificationColdStart: boolean | null | Unknown;
  /** Why not, when `notificationColdStart` is `false`. */
  readonly notificationColdStartReason: string | null;
  /** Linux: a scheduled notification is posted while the app is closed (a systemd user timer). */
  readonly notificationScheduleWhileClosed: boolean | null | Unknown;
  /** Why not, when `notificationScheduleWhileClosed` is `false`. */
  readonly notificationScheduleReason: string | null;
  /** CEF on Linux: the Chromium sandbox web content runs in; `null` elsewhere. */
  readonly sandbox: SandboxMode | null | Unknown;
  /** CEF on Linux: why the runtime chose that sandbox mode (its `laufey: sandbox:` line). */
  readonly sandboxReason: string | null;
  /** Linux: the chooser a file dialog uses; `null` elsewhere. */
  readonly fileChooser: FileChooser | null | Unknown;
  /** Why GTK's, when `fileChooser` is `"gtk"`. */
  readonly fileChooserReason: string | null;
}

/** The longest runtime reason passed on. */
const MAX_REASON = 256;

const SESSION_TYPES = new Set(["wayland", "x11", "tty", "unknown"]);
const SECRET_STATES = new Set([
  "available",
  "locked",
  "activatable",
  "absent",
  "no-session-bus",
  "os",
]);

/** Every fact unknown (no probe in this runtime). */
const UNKNOWN_FACTS: PlatformFacts = Object.freeze({
  sessionType: "unknown",
  trayHost: "unknown",
  trayReason: null,
  secretService: "unknown",
  cookieEncryption: "unknown",
  badge: "unknown",
  badgeReason: null,
  notificationTransport: "unknown",
  notificationColdStart: "unknown",
  notificationColdStartReason: null,
  notificationScheduleWhileClosed: "unknown",
  notificationScheduleReason: null,
  sandbox: "unknown",
  sandboxReason: null,
  fileChooser: "unknown",
  fileChooserReason: null,
});

const BADGE_SHOWS = new Set(["dock", "launcher-entry", "title"]);
const TRANSPORTS = new Set(["portal", "freedesktop"]);
const SANDBOX_MODES = new Set(["namespace", "setuid", "chromium", "off"]);
const FILE_CHOOSERS = new Set(["portal", "gtk"]);

/** `value` when it is `null` or in `allowed`, else `"unknown"` (an older runtime omits the key). */
function oneOfOrNull<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): T | null | Unknown {
  return value === null || allowed.has(value as string) ? value as T | null : "unknown";
}

/** A `boolean | null` fact a runtime reports (`"unknown"` when it doesn't: an older runtime). */
function booleanOrNull(value: unknown): boolean | null | Unknown {
  return value === null || typeof value === "boolean" ? value : "unknown";
}

/** A short reason string, or `null`. */
export function reasonText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text.slice(0, MAX_REASON);
}

/**
 * The runtime's raw answer, or `null` when it has no probe / did not answer. The probe is async
 * (it runs off the JavaScript thread: its first call on Linux may wait for xdg-desktop-portal).
 */
async function rawFeatures(
  api: DesktopAppApi | undefined,
): Promise<Record<string, unknown> | null> {
  if (typeof api?.platformFeatures !== "function") return null;
  try {
    const raw = await api.platformFeatures();
    return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The probe facts, validated: an unexpected value reads `"unknown"`, a reason is trimmed and
 * capped.
 *
 * @param api The runtime's app API (`Deno.desktop`), when there is one.
 * @returns The facts (every one `"unknown"` without the probe).
 */
export async function platformFacts(api: DesktopAppApi | undefined): Promise<PlatformFacts> {
  const raw = await rawFeatures(api);
  if (!raw) return UNKNOWN_FACTS;
  const session = raw.sessionType;
  const cookie = raw.cookieEncryption;
  const trayHost = typeof raw.trayHost === "boolean" ? raw.trayHost : "unknown";
  return {
    sessionType: session === null || SESSION_TYPES.has(session as string)
      ? session as PlatformFacts["sessionType"]
      : "unknown",
    trayHost,
    trayReason: trayHost === false ? reasonText(raw.trayReason) : null,
    secretService: SECRET_STATES.has(raw.secretService as string)
      ? raw.secretService as SecretServiceState
      : "unknown",
    cookieEncryption: cookie === null || cookie === "os" || cookie === "basic" ? cookie : "unknown",
    ...notificationAndBadgeFacts(raw),
    ...sandboxAndChooserFacts(raw),
  };
}

/** The sandbox and file chooser facts (runtime 2.9.7-denext.12): `"unknown"` before it. */
function sandboxAndChooserFacts(
  raw: Record<string, unknown>,
): Pick<PlatformFacts, "sandbox" | "sandboxReason" | "fileChooser" | "fileChooserReason"> {
  const sandbox = oneOfOrNull<SandboxMode>(raw.sandbox, SANDBOX_MODES);
  const fileChooser = oneOfOrNull<FileChooser>(raw.fileChooser, FILE_CHOOSERS);
  return {
    sandbox,
    sandboxReason: sandbox === null || sandbox === "unknown" ? null : reasonText(raw.sandboxReason),
    fileChooser,
    fileChooserReason: fileChooser === "gtk" ? reasonText(raw.fileChooserReason) : null,
  };
}

/** The notification and badge facts (runtime 2.9.7-denext.11): `"unknown"` before it. */
function notificationAndBadgeFacts(
  raw: Record<string, unknown>,
): Omit<
  PlatformFacts,
  | "sessionType"
  | "trayHost"
  | "trayReason"
  | "secretService"
  | "cookieEncryption"
  | "sandbox"
  | "sandboxReason"
  | "fileChooser"
  | "fileChooserReason"
> {
  const badge: BadgeShows | Unknown = BADGE_SHOWS.has(raw.badge as string)
    ? raw.badge as BadgeShows
    : "unknown";
  const transport = raw.notificationTransport;
  const coldStart = booleanOrNull(raw.notificationColdStart);
  const whileClosed = booleanOrNull(raw.notificationScheduleWhileClosed);
  return {
    badge,
    badgeReason: badge === "title" ? reasonText(raw.badgeReason) : null,
    notificationTransport: transport === null || TRANSPORTS.has(transport as string)
      ? transport as NotificationTransport | null
      : "unknown",
    notificationColdStart: coldStart,
    notificationColdStartReason: coldStart === false
      ? reasonText(raw.notificationColdStartReason)
      : null,
    notificationScheduleWhileClosed: whileClosed,
    notificationScheduleReason: whileClosed === false
      ? reasonText(raw.notificationScheduleReason)
      : null,
  };
}
