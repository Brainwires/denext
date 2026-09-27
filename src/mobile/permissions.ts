/**
 * One permission API for `denext/mobile`: {@linkcode checkPermission} /
 * {@linkcode requestPermission} report a status normalized across iOS, Android and the web,
 * {@linkcode usePermission} keeps it live (re-checked when the app returns to the foreground),
 * and {@linkcode openAppSettings} opens the app's page in the system settings, the only place a
 * refused permission can be changed.
 *
 * Each name is answered by the plugin behind it in the shell (its own `checkPermissions` /
 * `requestPermissions`), else by the browser's API.
 *
 * @module
 */

import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import { nativePlatform } from "./bridge.ts";
import { availabilityOf, biometricPlugin } from "./biometrics.ts";
import { nativePlugin } from "./plugin.ts";
import { onAppResume } from "./resume.ts";

/** A permission {@linkcode checkPermission} knows. */
export type PermissionName =
  | "camera"
  | "photos"
  | "microphone"
  | "location"
  | "location-background"
  | "notifications"
  | "contacts"
  | "calendar"
  | "biometrics";

/**
 * A permission's status, the same on every platform:
 *
 * - `granted`: allowed.
 * - `limited`: allowed in part (iOS: selected photos only, or limited contacts; Android:
 *   approximate location only; calendar: write-only access).
 * - `prompt`: never asked; {@linkcode requestPermission} shows the system prompt.
 * - `prompt-with-rationale`: Android: refused once, and a request shows the prompt again.
 *   Explain why the app needs it first.
 * - `denied`: {@linkcode requestPermission} just asked and the user said no, but the app may ask
 *   again later (Android's first refusal; on the web, a refusal the browser may reset).
 * - `blocked`: refused and the OS will not prompt again (iOS after any refusal; Android after
 *   "Don't allow" twice or "Don't ask again"). Only {@linkcode openAppSettings} can change it.
 */
export type PermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "prompt-with-rationale"
  | "limited"
  | "blocked";

/** Why a permission call failed, as {@linkcode PermissionError}'s `code` reports it. */
export type PermissionErrorCode =
  /** Nothing here can answer for this permission (no plugin, and no web API). */
  | "unsupported"
  /** The system did not open the app's settings. */
  | "unavailable";

/** A failed {@linkcode checkPermission} / {@linkcode requestPermission} / {@linkcode openAppSettings}. */
export interface PermissionError extends Error {
  /** Why it failed. */
  readonly code: PermissionErrorCode;
}

/** A Capacitor plugin's permission surface (`checkPermissions` / `requestPermissions`). */
interface PermissionPlugin {
  checkPermissions(): Promise<Record<string, unknown>>;
  requestPermissions(options?: { permissions: string[] }): Promise<Record<string, unknown>>;
}

/** A plugin that answers a permission: its JS name, the alias it reports, and how to combine. */
interface NativeSource {
  /** `Capacitor.Plugins[name]`. */
  readonly plugin: string;
  /** The aliases to request (`{ permissions: [...] }`); omitted: request them all. */
  readonly request?: readonly string[];
  /** The status from the plugin's answer (still in Capacitor's vocabulary). */
  readonly read: (answer: Record<string, unknown>) => string | undefined;
}

/** The JS side of denext's `DenextSettings` plugin (`denext mobile add permissions`). */
interface SettingsPlugin {
  open(): Promise<void>;
}

/** Build a {@linkcode PermissionError}. */
function permissionError(code: PermissionErrorCode, message: string): PermissionError {
  const err = new Error(message) as Error & { code: PermissionErrorCode };
  err.name = "PermissionError";
  err.code = code;
  return err;
}

/** A string field of a plugin answer. */
function field(key: string): (answer: Record<string, unknown>) => string | undefined {
  return (answer) => typeof answer[key] === "string" ? answer[key] as string : undefined;
}

/** Geolocation: precise location, or approximate only (`limited`). */
function readLocation(answer: Record<string, unknown>): string | undefined {
  const fine = field("location")(answer);
  if (fine !== "granted" && field("coarseLocation")(answer) === "granted") return "limited";
  return fine;
}

/**
 * Background location (`@capgo/background-geolocation`, `denext mobile add background-location`):
 * "always" is the background grant; "when_in_use" means foreground only, so background is
 * `denied` (an app asks for the upgrade with `requestPermission`).
 */
function readBackgroundLocation(answer: Record<string, unknown>): string | undefined {
  const state = field("backgroundLocation")(answer);
  if (state === "always") return "granted";
  return state === "when_in_use" ? "denied" : state;
}

/** Calendar: read + write granted, or write-only (`limited`). */
function readCalendar(answer: Record<string, unknown>): string | undefined {
  const read = field("readCalendar")(answer);
  const write = field("writeCalendar")(answer);
  if (read === "granted" && write === "granted") return "granted";
  if (read === "granted" || write === "granted") return "limited";
  return read ?? write;
}

/** Which plugins can answer for each permission, in the order they are tried. */
const NATIVE_SOURCES: Readonly<Record<PermissionName, readonly NativeSource[]>> = {
  camera: [{ plugin: "Camera", request: ["camera"], read: field("camera") }],
  photos: [{ plugin: "Camera", request: ["photos"], read: field("photos") }],
  microphone: [],
  location: [{ plugin: "Geolocation", read: readLocation }],
  "location-background": [
    {
      plugin: "BackgroundGeolocation",
      request: ["backgroundLocation"],
      read: readBackgroundLocation,
    },
  ],
  notifications: [
    { plugin: "LocalNotifications", read: field("display") },
    { plugin: "PushNotifications", read: field("receive") },
  ],
  contacts: [{ plugin: "Contacts", read: field("contacts") }],
  calendar: [{ plugin: "Calendar", read: readCalendar }],
  biometrics: [],
};

/** A permission-state string from a plugin or the browser, before normalization. */
type RawState = string | undefined;

/**
 * Capacitor's vocabulary (`granted`, `denied`, `prompt`, `prompt-with-rationale`, and the
 * camera's `limited`) as a {@linkcode PermissionState}. A native `denied` is `blocked`: iOS never
 * prompts again, and Capacitor's Android reports `denied` only once the OS stopped prompting
 * (a refusal it may still re-ask reads `prompt-with-rationale`). The web's `denied` stays
 * `denied`: a browser may reset it.
 */
function normalize(raw: RawState, native: boolean): PermissionState {
  switch (raw) {
    case "granted":
    case "limited":
    case "prompt-with-rationale":
      return raw;
    case "denied":
      return native ? "blocked" : "denied";
    default:
      return "prompt";
  }
}

/** The first installed plugin that answers `name`, with its source. */
function nativeSource(
  name: PermissionName,
): { source: NativeSource; plugin: PermissionPlugin } | undefined {
  for (const source of NATIVE_SOURCES[name]) {
    const plugin = nativePlugin<PermissionPlugin>(source.plugin, [
      "checkPermissions",
      "requestPermissions",
    ]);
    if (plugin) return { source, plugin };
  }
  return undefined;
}

/** The browser's Permissions API answer for `name`, or undefined when it cannot say. */
async function queryPermission(name: string): Promise<RawState> {
  const permissions = (globalThis as {
    navigator?: { permissions?: { query?: (d: { name: string }) => Promise<{ state: string }> } };
  }).navigator?.permissions;
  if (typeof permissions?.query !== "function") return undefined;
  try {
    return (await permissions.query({ name })).state;
  } catch {
    return undefined;
  }
}

/** The web Notifications API's permission (`default` is not asked yet). */
function notificationApi():
  | { permission?: string; requestPermission?: () => Promise<string> }
  | undefined {
  return (globalThis as { Notification?: { permission?: string } }).Notification;
}

/** A getUserMedia round trip for `constraints`, stopped at once: granted or denied. */
async function askMedia(constraints: { video?: boolean; audio?: boolean }): Promise<RawState> {
  const media = (globalThis as {
    navigator?: { mediaDevices?: { getUserMedia?: (c: unknown) => Promise<MediaStream> } };
  }).navigator?.mediaDevices;
  if (typeof media?.getUserMedia !== "function") return undefined;
  try {
    const stream = await media.getUserMedia(constraints);
    for (const track of stream.getTracks()) track.stop();
    return "granted";
  } catch {
    return "denied";
  }
}

/** A geolocation read that shows the browser's prompt: granted, or denied on code 1. */
function askLocation(): Promise<RawState> {
  const geo = (globalThis as { navigator?: { geolocation?: Geolocation } }).navigator
    ?.geolocation;
  if (typeof geo?.getCurrentPosition !== "function") return Promise.resolve(undefined);
  return new Promise((resolve) =>
    geo.getCurrentPosition(
      () => resolve("granted"),
      (err) => resolve(err?.code === 1 ? "denied" : "prompt"),
      { maximumAge: Infinity, timeout: 30_000 },
    )
  );
}

/** How the web answers (and asks for) a permission, when it can. */
const WEB_SOURCES: Partial<
  Record<PermissionName, { check: () => Promise<RawState>; request: () => Promise<RawState> }>
> = {
  camera: { check: () => queryPermission("camera"), request: () => askMedia({ video: true }) },
  microphone: {
    check: () => queryPermission("microphone"),
    request: () => askMedia({ audio: true }),
  },
  // Picking a photo from a file input needs no permission on the web.
  photos: { check: () => Promise.resolve("granted"), request: () => Promise.resolve("granted") },
  location: { check: () => queryPermission("geolocation"), request: askLocation },
  notifications: {
    check: () => {
      const permission = notificationApi()?.permission;
      return Promise.resolve(permission === "default" ? "prompt" : permission);
    },
    request: async () => {
      const api = notificationApi();
      if (typeof api?.requestPermission !== "function") return undefined;
      const answer = await api.requestPermission();
      return answer === "default" ? "prompt" : answer;
    },
  },
};

/** The error for a permission nothing here can answer. */
function unsupported(fn: string, name: PermissionName, why: string): PermissionError {
  return permissionError("unsupported", `${fn}("${name}"): ${why}`);
}

/**
 * Biometrics: iOS asks for Face ID at the first prompt (there is no separate request), Android's
 * biometric permission is granted at install. So: `granted` when a prompt can run; `blocked` on
 * iOS when the device has Face ID but the user turned it off for this app; `denied` when the
 * sensor is there but unusable (nothing enrolled, locked out).
 */
async function biometricState(fn: string): Promise<PermissionState> {
  const plugin = biometricPlugin();
  if (!plugin) {
    throw unsupported(
      fn,
      "biometrics",
      "needs the iOS/Android shell with @aparajita/capacitor-biometric-auth " +
        "(`denext mobile add biometrics`)",
    );
  }
  const info = availabilityOf(await plugin.checkBiometry());
  if (info.available) return "granted";
  if (info.type === undefined) {
    throw unsupported(fn, "biometrics", "the device has no biometric sensor");
  }
  return nativePlatform() === "ios" && info.type === "face" && info.reason === "unavailable"
    ? "blocked"
    : "denied";
}

/** Refuse a name this module does not know. */
function checkName(fn: string, name: PermissionName): void {
  if (!Object.hasOwn(NATIVE_SOURCES, name)) {
    throw new TypeError(`${fn}: unknown permission "${String(name)}"`);
  }
}

/** The status of `name` without prompting (see {@linkcode checkPermission}). */
async function check(fn: string, name: PermissionName): Promise<PermissionState> {
  checkName(fn, name);
  if (name === "biometrics") return await biometricState(fn);
  const found = nativeSource(name);
  if (found) return normalize(found.source.read(await found.plugin.checkPermissions()), true);
  const web = WEB_SOURCES[name];
  const raw = web ? await web.check() : undefined;
  if (raw === undefined) throw notAnswerable(fn, name);
  return normalize(raw, nativePlatform() !== "web");
}

/** The error for a name no installed plugin and no browser API answers. */
function notAnswerable(fn: string, name: PermissionName): PermissionError {
  const hint = name === "contacts"
    ? "install a contacts plugin with checkPermissions (@capacitor-community/contacts)"
    : name === "calendar"
    ? "install @capacitor/calendar"
    : `install its capability (\`denext mobile add ${
      name === "notifications"
        ? "local-notifications"
        : name === "location"
        ? "geolocation"
        : name === "location-background"
        ? "background-location"
        : name
    }\`), or run where the browser has a permission API for it`;
  return unsupported(fn, name, `nothing here can answer for it: ${hint}`);
}

/**
 * The current status of a permission, without prompting (see {@linkcode PermissionState} for
 * what each status means).
 *
 * In the iOS/Android shell it asks the plugin behind the permission (`Camera` for `camera` and
 * `photos`, `Geolocation` for `location`, `LocalNotifications` / `PushNotifications` for
 * `notifications`, `Contacts`, `Calendar`, and the biometric plugin for `biometrics`); on the
 * web (and for `microphone`, which the WebView itself asks for) the browser's Permissions /
 * Notifications API. It rejects with a {@linkcode PermissionError} (`unsupported`) when nothing
 * here can answer: a plugin that is not installed and no browser API.
 *
 * @param name The permission.
 * @returns Its status.
 * @example
 * ```ts
 * import { checkPermission, openAppSettings } from "denext/mobile";
 *
 * if ((await checkPermission("camera")) === "blocked") {
 *   if (confirm("Camera access is off. Open Settings?")) await openAppSettings();
 * }
 * ```
 */
export function checkPermission(name: PermissionName): Promise<PermissionState> {
  return check("checkPermission", name);
}

/**
 * Ask for a permission when a prompt can still be shown, and report the outcome. A decided
 * permission (`granted`, `limited`, `blocked`) comes back as it is, without a prompt. A refusal
 * reads `blocked` on iOS (it never prompts again) and `denied` on Android's first refusal (a
 * later request prompts again, after your rationale); see {@linkcode PermissionState}.
 *
 * `biometrics` has no separate prompt (iOS asks for Face ID the first time
 * `authenticateBiometric` runs), so it returns what {@linkcode checkPermission} does.
 *
 * @param name The permission.
 * @returns Its status after the prompt, if one was shown.
 * @example
 * ```ts
 * import { requestPermission } from "denext/mobile";
 *
 * const status = await requestPermission("location");
 * if (status === "granted" || status === "limited") startMap();
 * ```
 */
export async function requestPermission(name: PermissionName): Promise<PermissionState> {
  const before = await check("requestPermission", name);
  if (before === "granted" || before === "limited" || before === "blocked") return before;
  if (name === "biometrics") return before;
  const found = nativeSource(name);
  let raw: RawState;
  if (found) {
    const request = found.source.request;
    raw = found.source.read(
      await found.plugin.requestPermissions(request ? { permissions: [...request] } : undefined),
    );
  } else {
    raw = await WEB_SOURCES[name]?.request();
  }
  const after = normalize(raw, nativePlatform() !== "web");
  // Android: a refusal that may be asked again reads prompt-with-rationale afterwards.
  return after === "prompt-with-rationale" ? "denied" : after;
}

/** Options for {@linkcode usePermission}. */
export interface UsePermissionOptions {
  /** Request the permission on mount instead of only checking it (default `false`). */
  readonly request?: boolean;
}

/** What {@linkcode usePermission} returns. */
export interface PermissionHandle {
  /** The latest status (`undefined` until the first check settles, or when it failed). */
  readonly status: PermissionState | undefined;
  /** The last check's error (e.g. a {@linkcode PermissionError} `unsupported`), if any. */
  readonly error: Error | undefined;
  /** Ask for the permission (see {@linkcode requestPermission}); updates `status`. */
  readonly request: () => Promise<PermissionState>;
  /** Check again; updates `status`. */
  readonly refresh: () => Promise<PermissionState>;
}

/**
 * A permission's live status: checked on mount (or requested, with `request: true`), and
 * checked again each time the app returns to the foreground, so it follows a change the user
 * made in Settings after {@linkcode openAppSettings}.
 *
 * @param name The permission.
 * @param options Request on mount instead of checking.
 * @returns The status, the last error, and `request` / `refresh`.
 * @example
 * ```tsx
 * "use client";
 * import { openAppSettings, usePermission } from "denext/mobile";
 *
 * export function CameraGate({ children }: { children: unknown }) {
 *   const camera = usePermission("camera");
 *   if (camera.status === "granted") return children;
 *   return camera.status === "blocked"
 *     ? <button type="button" onClick={() => openAppSettings()}>Allow the camera in Settings</button>
 *     : <button type="button" onClick={() => camera.request()}>Allow the camera</button>;
 * }
 * ```
 */
export function usePermission(
  name: PermissionName,
  options: UsePermissionOptions = {},
): PermissionHandle {
  const [state, setState] = useState<{ status?: PermissionState; error?: Error }>({});
  const alive = useRef(true);
  const run = useRef<(ask: boolean) => Promise<PermissionState>>(() => Promise.resolve("prompt"));
  run.current = async (ask: boolean) => {
    try {
      const status = await (ask ? requestPermission(name) : checkPermission(name));
      if (alive.current) setState({ status });
      return status;
    } catch (err) {
      if (alive.current) setState({ error: err as Error });
      throw err;
    }
  };
  useEffect(() => {
    alive.current = true;
    run.current(options.request === true).catch(() => {});
    const stop = onAppResume(() => void run.current(false).catch(() => {}));
    return () => {
      alive.current = false;
      stop();
    };
  }, [name]);
  return {
    status: state.status,
    error: state.error,
    request: () => run.current(true),
    refresh: () => run.current(false),
  };
}

/**
 * Open the app's own page in the system settings, where the user can change a permission they
 * refused (a `blocked` one can only be changed there).
 *
 * - In the shell with denext's `DenextSettings` plugin (`denext mobile add permissions`; the
 *   local-notifications, biometrics and geolocation capabilities install it too): iOS opens
 *   `UIApplication.openSettingsURLString`, Android the app's "App info" screen
 *   (`ACTION_APPLICATION_DETAILS_SETTINGS`).
 * - iOS without the plugin: it hands `app-settings:` to the OS, which opens the same page.
 * - Android without the plugin, and the web: it rejects with a {@linkcode PermissionError}
 *   (`unsupported`); a browser has no way to open its site settings.
 *
 * @returns A promise that settles once the settings were opened.
 * @example
 * ```ts
 * import { openAppSettings } from "denext/mobile";
 *
 * await openAppSettings();
 * ```
 */
export async function openAppSettings(): Promise<void> {
  const plugin = nativePlugin<SettingsPlugin>("DenextSettings", ["open"]);
  if (plugin) {
    try {
      return await plugin.open();
    } catch (err) {
      throw permissionError("unavailable", `openAppSettings: ${(err as Error)?.message ?? err}`);
    }
  }
  if (nativePlatform() === "ios" && typeof globalThis.open === "function") {
    globalThis.open("app-settings:", "_blank");
    return;
  }
  throw permissionError(
    "unsupported",
    nativePlatform() === "android"
      ? "openAppSettings: needs denext's DenextSettings plugin (`denext mobile add permissions`)."
      : "openAppSettings: a web page cannot open the system settings.",
  );
}
