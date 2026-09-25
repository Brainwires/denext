/**
 * Device facts for `denext/mobile`: the native `Device` plugin in the shell, else a
 * best-effort read of the user agent.
 *
 * @module
 */

import { type NativePlatform, nativePlatform } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";

/** What {@linkcode deviceInfo} reports. Only `platform` is always known. */
export interface DeviceInfo {
  /** `"ios"` / `"android"` inside the native shell, else `"web"`. */
  readonly platform: NativePlatform;
  /** The device model (`"iPhone15,2"` natively; `"iPhone"`, `"Pixel 8"`, … from a user agent). */
  readonly model?: string;
  /** The OS version, e.g. `"17.5"` or `"14"`. */
  readonly osVersion?: string;
  /** Whether it runs in a simulator or emulator (native only). */
  readonly isVirtual?: boolean;
}

/** The JS side of `@capacitor/device` (the fields read here). */
interface DevicePlugin {
  getInfo(): Promise<{ model?: string; osVersion?: string; isVirtual?: boolean }>;
}

/** `{ model, osVersion }` from a user agent: first matching rule wins. */
const UA_RULES: readonly [
  RegExp,
  (m: RegExpExecArray) => { model?: string; osVersion?: string },
][] = [
  [
    /\b(iPhone|iPad|iPod)\b.*?\bOS (\d+(?:_\d+)*)/,
    (m) => ({ model: m[1], osVersion: dotted(m[2]) }),
  ],
  [
    /\bAndroid (\d+(?:\.\d+)*)(?:; ([^;)]+?))?(?: Build\/[^;)]*)?[;)]/,
    // Chrome's reduced user agent says `Android 10; K`: the model is withheld.
    (m) => ({
      model: m[2]?.trim() === "K" ? undefined : m[2]?.trim() || undefined,
      osVersion: m[1],
    }),
  ],
  [/\bMac OS X (\d+(?:[_.]\d+)*)/, (m) => ({ model: "Macintosh", osVersion: dotted(m[1]) })],
  [/\bWindows NT (\d+(?:\.\d+)*)/, (m) => ({ model: "Windows", osVersion: m[1] })],
  [/\bCrOS\b/, () => ({ model: "Chromebook" })],
  [/\bLinux\b/, () => ({ model: "Linux" })],
];

/** `17_5_1` → `17.5.1`. */
function dotted(version: string): string {
  return version.replaceAll("_", ".");
}

/**
 * Best-effort `{ model, osVersion }` from `ua`; empty when nothing matches. Internal (the
 * `denext/expo/device` shim reads it synchronously); not re-exported from `denext/mobile`.
 */
export function parseUserAgent(ua: string): { model?: string; osVersion?: string } {
  for (const [re, pick] of UA_RULES) {
    const m = re.exec(ua);
    if (m) return pick(m);
  }
  return {};
}

/** `info` without its undefined keys. */
function defined(info: DeviceInfo): DeviceInfo {
  return Object.fromEntries(
    Object.entries(info).filter(([, v]) => v !== undefined),
  ) as unknown as DeviceInfo;
}

/**
 * Facts about the device the page runs on.
 *
 * - Inside the native shell with `@capacitor/device` installed (`denext mobile add
 *   device`), the model, OS version and simulator flag from the OS.
 * - Otherwise a best-effort parse of `navigator.userAgent` (model and OS version only; it
 *   can be wrong, and iPadOS reports itself as a Mac). During SSR only `platform` is set.
 *
 * @returns The device facts; `platform` is always present.
 * @example
 * ```ts
 * import { deviceInfo } from "denext/mobile";
 *
 * const { platform, model, osVersion } = await deviceInfo();
 * report({ platform, model, osVersion });
 * ```
 */
export async function deviceInfo(): Promise<DeviceInfo> {
  const platform = nativePlatform();
  const plugin = nativePlugin<DevicePlugin>("Device", ["getInfo"]);
  if (plugin) {
    const info = await plugin.getInfo();
    return defined({
      platform,
      model: info.model,
      osVersion: info.osVersion,
      isVirtual: typeof info.isVirtual === "boolean" ? info.isVirtual : undefined,
    });
  }
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  return defined({ platform, ...(typeof ua === "string" ? parseUserAgent(ua) : {}) });
}
