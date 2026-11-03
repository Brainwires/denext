// The microphone and camera of a Deno Desktop app (`denext desktop add microphone` / `camera`):
// what the packaged app needs for a page's `getUserMedia` to reach the device.
//
// - `laufey-launch.json` `"mediaCapture"`: the webview backend grants the kinds to the app's own
//   origin only (exact match: never another origin the window navigates to, nor a sub-frame of
//   another origin; on Linux, where WebKitGTK does not say which frame asks, a sub-frame the page
//   delegates the device to with `allow="microphone"` is honoured), from runtime `3.0.0-denext.9`
//   (laufey API 53), which refuses every other request (`NotAllowedError`).
// - macOS `Info.plist` `NSMicrophoneUsageDescription` / `NSCameraUsageDescription`: the text
//   macOS shows when it asks the user (TCC). Without it macOS ends the app the first time the page
//   captures.
// - macOS Hardened Runtime entitlements `com.apple.security.device.audio-input` /
//   `com.apple.security.device.camera`: without them a signed, hardened app is refused the device.
//   On the main executable only: TCC checks the responsible process, which for a CEF helper
//   (Chromium's audio service runs in one) is the app that launched it, so Chromium signs only its
//   app with them (`chrome/app/app-entitlements.plist`) and its helpers without.
//
// An older runtime does not enforce the grant: each engine then asks (or refuses) by its own
// rules, for whatever origin asks, and the usage strings and entitlements would take away the only
// barriers left. So packaging with either kind on refuses such a runtime
// ({@linkcode assertMediaCaptureRuntime}), and nothing here is written for it.

import { parsePlist, type PlistNode, renderPlist } from "./plist-value.ts";
import { FIRST_MEDIA_CAPTURE_RUNTIME } from "./deno-version.ts";

/** The devices a page may capture. */
export type DesktopMediaKind = "microphone" | "camera";

/** Each kind's config key, Info.plist usage key and Hardened Runtime entitlement. */
const KINDS: Readonly<
  Record<DesktopMediaKind, { readonly plistKey: string; readonly entitlement: string }>
> = {
  microphone: {
    plistKey: "NSMicrophoneUsageDescription",
    entitlement: "com.apple.security.device.audio-input",
  },
  camera: {
    plistKey: "NSCameraUsageDescription",
    entitlement: "com.apple.security.device.camera",
  },
};

/** The kinds, in the order they are written. */
const DESKTOP_MEDIA_KINDS: readonly DesktopMediaKind[] = ["microphone", "camera"];

/** One enabled kind: the text macOS shows when it asks the user (`undefined`: the default). */
export interface DesktopMediaGrant {
  readonly usageDescription?: string;
}

/**
 * The enabled kinds of `desktop.capabilities` (`microphone` / `camera`: `true` or
 * `{ usageDescription }`; `false`, absent or an invalid value is off).
 *
 * @param config The project config.
 * @returns The enabled kinds with their usage text.
 */
export function desktopMediaCapture(
  config: unknown,
): Partial<Record<DesktopMediaKind, DesktopMediaGrant>> {
  const caps = (config as { desktop?: { capabilities?: unknown } } | null | undefined)?.desktop
    ?.capabilities;
  const out: Partial<Record<DesktopMediaKind, DesktopMediaGrant>> = {};
  if (typeof caps !== "object" || caps === null) return out;
  for (const kind of DESKTOP_MEDIA_KINDS) {
    const value = (caps as Record<string, unknown>)[kind];
    if (value === true) out[kind] = {};
    else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const text = (value as { usageDescription?: unknown }).usageDescription;
      out[kind] = typeof text === "string" && text.trim() !== ""
        ? { usageDescription: text.trim() }
        : {};
    }
  }
  return out;
}

/**
 * The launch file's `"mediaCapture"` for the enabled kinds, each granted to `appOrigin` alone, or
 * `undefined` when neither kind is on.
 *
 * @param config The project config.
 * @param appOrigin The app's own origin (`desktop.app.origin`, else `app://localhost`).
 * @returns The grant.
 */
export function mediaCaptureLaunchGrant(
  config: unknown,
  appOrigin: string,
): Partial<Record<DesktopMediaKind, string[]>> | undefined {
  const enabled = desktopMediaCapture(config);
  const kinds = DESKTOP_MEDIA_KINDS.filter((k) => enabled[k]);
  if (kinds.length === 0) return undefined;
  return Object.fromEntries(kinds.map((k) => [k, [appOrigin]]));
}

/**
 * The Hardened Runtime entitlements the enabled kinds need on macOS.
 *
 * @param config The project config.
 * @returns The entitlements, `true` each (empty when neither kind is on).
 */
export function mediaCaptureEntitlements(config: unknown): Record<string, boolean> {
  const enabled = desktopMediaCapture(config);
  return Object.fromEntries(
    DESKTOP_MEDIA_KINDS.filter((k) => enabled[k]).map((k) => [KINDS[k].entitlement, true]),
  );
}

/** The text macOS shows for `kind` when the config gives none: names the app by `name`. */
export function defaultUsageDescription(kind: DesktopMediaKind, name: string | undefined): string {
  const app = name?.trim() || "This app";
  return kind === "microphone" ? `${app} uses your microphone.` : `${app} uses your camera.`;
}

/** A dict's string value, if it has one. */
function plistString(entries: ReadonlyArray<[string, PlistNode]>, key: string): string | undefined {
  const node = entries.find(([k]) => k === key)?.[1];
  return node?.kind === "string" ? node.text : undefined;
}

/**
 * `Info.plist` with the enabled kinds' usage descriptions: the config's text, else one naming the
 * bundle (`CFBundleDisplayName`, else `CFBundleName`). A description the plist already has is
 * replaced; a kind that is off is left as it is.
 *
 * @param text The `Info.plist` XML.
 * @param config The project config.
 * @returns The plist, unchanged when neither kind is on.
 */
export function withMediaUsageDescriptions(text: string, config: unknown): string {
  const enabled = desktopMediaCapture(config);
  const kinds = DESKTOP_MEDIA_KINDS.filter((k) => enabled[k]);
  if (kinds.length === 0) return text;
  const root = parsePlist(text);
  if (root.kind !== "dict") throw new Error("Info.plist is not a dict");
  const name = plistString(root.entries, "CFBundleDisplayName") ??
    plistString(root.entries, "CFBundleName");
  const keys = new Set(kinds.map((k) => KINDS[k].plistKey));
  const entries: Array<[string, PlistNode]> = root.entries.filter(([k]) => !keys.has(k));
  for (const kind of kinds) {
    entries.push([KINDS[kind].plistKey, {
      kind: "string",
      text: enabled[kind]?.usageDescription ?? defaultUsageDescription(kind, name),
    }]);
  }
  return renderPlist({ kind: "dict", entries });
}

/** The enabled kinds, in order. */
function enabledKinds(config: unknown): DesktopMediaKind[] {
  const enabled = desktopMediaCapture(config);
  return DESKTOP_MEDIA_KINDS.filter((k) => enabled[k]);
}

/**
 * Why the microphone or camera cannot be packaged: a runtime that does not enforce the launch
 * file's grant (`"mediaCapture"`), so the app's own origin could not be the only one that captures.
 *
 * @param config The project config.
 * @param supported Whether the runtime reads `"mediaCapture"` (`mediaCaptureRuntime()`).
 * @param runtime The runtime the build uses, for the message (`runtime 3.0.0-denext.7`, "the stock
 *   runtime").
 * @returns The message (one line), or `null` when nothing is missing.
 */
export function mediaCaptureRuntimeProblem(
  config: unknown,
  supported: boolean,
  runtime: string,
): string | null {
  const kinds = enabledKinds(config);
  if (kinds.length === 0 || supported) return null;
  return `desktop.capabilities.${kinds.join(" / ")} needs Deno Desktop runtime ` +
    `${FIRST_MEDIA_CAPTURE_RUNTIME} or later to package (this build uses ${runtime}): an older ` +
    "runtime cannot restrict capture to the app's origin";
}

/**
 * Refuse to package the microphone or camera on a runtime that does not enforce the grant
 * ({@linkcode mediaCaptureRuntimeProblem}): `denext desktop package` fails with that one line.
 *
 * @param config The project config.
 * @param supported Whether the runtime reads `"mediaCapture"` (`mediaCaptureRuntime()`).
 * @param runtime The runtime the build uses, for the message.
 * @throws {Error} When either kind is on and `supported` is false.
 */
export function assertMediaCaptureRuntime(
  config: unknown,
  supported: boolean,
  runtime: string,
): void {
  const problem = mediaCaptureRuntimeProblem(config, supported, runtime);
  if (problem) {
    throw new Error(
      `${problem}. Upgrade denext once it pins that runtime (\`denext upgrade\`), or turn the ` +
        "capability off.",
    );
  }
}
