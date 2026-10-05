/**
 * The runtime's probe of the session (`Deno.desktop.platformFeatures()`, runtime 2.9.7-denext.10
 * and later), read for the `app` and `window` capabilities. The runtime (laufey) does the probing:
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
  /** CEF's cookie store: `"os"` (encrypted with an OS-held key) or `"basic"` (unencrypted). */
  readonly cookieEncryption: "os" | "basic" | null | Unknown;
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
});

/** A short reason string, or `null`. */
export function reasonText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text.slice(0, MAX_REASON);
}

/** The runtime's raw answer, or `null` when it has no probe / did not answer. */
function rawFeatures(api: DesktopAppApi | undefined): Record<string, unknown> | null {
  if (typeof api?.platformFeatures !== "function") return null;
  try {
    const raw = api.platformFeatures();
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
export function platformFacts(api: DesktopAppApi | undefined): PlatformFacts {
  const raw = rawFeatures(api);
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
  };
}
