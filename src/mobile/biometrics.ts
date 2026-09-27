/**
 * Biometric authentication for `denext/mobile` (Face ID / Touch ID / Optic ID on iOS, the
 * fingerprint / face / iris BiometricPrompt on Android) through the native
 * `BiometricAuthNative` plugin that `@aparajita/capacitor-biometric-auth` installs
 * (`denext mobile add biometrics`). The web has no biometric API a page can use for this, so
 * outside the shell nothing is available and {@linkcode authenticateBiometric} rejects.
 *
 * @module
 */

import { nativePlatform } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";

/** A kind of biometric sensor. */
export type BiometricType = "face" | "fingerprint" | "iris";

/** Why a biometric check failed, as {@linkcode BiometricError}'s `code` reports it. */
export type BiometricErrorCode =
  /** The user (or the system, or the app) dismissed the prompt. */
  | "cancelled"
  /** The user tapped the fallback button (`fallbackTitle`) instead. */
  | "fallback"
  /** Too many failed attempts: biometrics are locked until the device passcode is entered. */
  | "lockout"
  /** The device has a sensor but no enrolled face / finger. */
  | "not-enrolled"
  /** No usable sensor, or the user turned biometrics off for this app (iOS Settings). */
  | "unavailable"
  /** `allowDeviceCredential` needs a device passcode, and none is set. */
  | "passcode-not-set"
  /** The biometric did not match. */
  | "failed"
  /** Not inside the iOS/Android shell, or `@aparajita/capacitor-biometric-auth` is missing. */
  | "unsupported";

/** A failed {@linkcode authenticateBiometric} (or a biometric-gated `secureStore.get`). */
export interface BiometricError extends Error {
  /** Why it failed. */
  readonly code: BiometricErrorCode;
}

/** What the device offers, from {@linkcode isBiometricAvailable}. */
export interface BiometricAvailability {
  /** Whether a biometric prompt can succeed now (a sensor, an enrolment, not locked out). */
  readonly available: boolean;
  /** The main sensor, when the device has one (even when nothing is enrolled). */
  readonly type?: BiometricType;
  /** Every sensor kind the device reports (Android can have several). */
  readonly types: readonly BiometricType[];
  /** Whether a device passcode / PIN / pattern is set (`allowDeviceCredential` needs one). */
  readonly deviceSecure: boolean;
  /** Why `available` is `false`, when it is. */
  readonly reason?: BiometricErrorCode;
}

/** Options for {@linkcode authenticateBiometric}. */
export interface BiometricAuthOptions {
  /**
   * The reason shown in the prompt (iOS: under Face ID / Touch ID; Android: the prompt's
   * subtitle). Default: "Access requires authentication".
   */
  readonly reason?: string;
  /**
   * Let the user authenticate with the device passcode / PIN / pattern instead (default
   * `false`: biometrics only).
   */
  readonly allowDeviceCredential?: boolean;
  /**
   * iOS: the fallback button's title after a failed match (`""` hides it); tapping it rejects
   * with `fallback`, unless `allowDeviceCredential` is on, when it opens the passcode screen.
   */
  readonly fallbackTitle?: string;
  /** The cancel button's title. */
  readonly cancelTitle?: string;
  /** Android: the prompt's title (default: the plugin's "Authenticate"). */
  readonly title?: string;
}

/** The raw result of the plugin's `checkBiometry()`. */
interface RawCheck {
  isAvailable?: boolean;
  biometryType?: number;
  biometryTypes?: number[];
  deviceIsSecure?: boolean;
  code?: string;
}

/** The native methods of `@aparajita/capacitor-biometric-auth` (its JS wrapper calls these). */
interface BiometricPlugin {
  checkBiometry(): Promise<RawCheck>;
  internalAuthenticate(options: Record<string, unknown>): Promise<void>;
}

/** The plugin's error codes (`BiometryErrorType`) → {@linkcode BiometricErrorCode}. */
const NATIVE_CODES: Readonly<Record<string, BiometricErrorCode>> = {
  appCancel: "cancelled",
  systemCancel: "cancelled",
  userCancel: "cancelled",
  userFallback: "fallback",
  biometryLockout: "lockout",
  biometryNotEnrolled: "not-enrolled",
  biometryNotAvailable: "unavailable",
  noDeviceCredential: "passcode-not-set",
  passcodeNotSet: "passcode-not-set",
  authenticationFailed: "failed",
  invalidContext: "failed",
  notInteractive: "failed",
};

/**
 * The plugin's `biometryType` numbers per platform: iOS reports `LABiometryType` raw values
 * (1 Touch ID, 2 Face ID, 4 Optic ID); Android the plugin's own enum (3 fingerprint, 4 face,
 * 5 iris).
 */
const SENSORS: Readonly<Record<"ios" | "android", Readonly<Record<number, BiometricType>>>> = {
  ios: { 1: "fingerprint", 2: "face", 4: "iris" },
  android: { 3: "fingerprint", 4: "face", 5: "iris" },
};

/** Build a {@linkcode BiometricError}. */
function biometricError(code: BiometricErrorCode, message: string): BiometricError {
  const err = new Error(message) as Error & { code: BiometricErrorCode };
  err.name = "BiometricError";
  err.code = code;
  return err;
}

/** The native plugin, when the shell has it. Internal to `denext/mobile`. */
export function biometricPlugin(): BiometricPlugin | undefined {
  return nativePlugin<BiometricPlugin>("BiometricAuthNative", [
    "checkBiometry",
    "internalAuthenticate",
  ]);
}

/** A native error code as a {@linkcode BiometricErrorCode} (anything unknown is `failed`). */
function codeOf(raw: unknown): BiometricErrorCode {
  return typeof raw === "string" && Object.hasOwn(NATIVE_CODES, raw) ? NATIVE_CODES[raw] : "failed";
}

/** The sensor kinds in a raw check, in the plugin's order, each once. */
function sensorsOf(raw: RawCheck): BiometricType[] {
  const platform = nativePlatform();
  if (platform === "web") return [];
  const table = SENSORS[platform];
  const numbers = [...(raw.biometryTypes ?? []), raw.biometryType ?? 0];
  return [...new Set(numbers.flatMap((n) => table[n] ? [table[n]] : []))];
}

/**
 * The raw availability, as {@linkcode BiometricAvailability}. Internal to `denext/mobile`
 * (the permission API reads it too).
 */
export function availabilityOf(raw: RawCheck): BiometricAvailability {
  const types = sensorsOf(raw);
  const available = raw.isAvailable === true;
  return {
    available,
    type: types[0],
    types,
    deviceSecure: raw.deviceIsSecure === true,
    ...(available ? {} : { reason: raw.code ? codeOf(raw.code) : "unavailable" }),
  };
}

/**
 * Whether biometric authentication can succeed on this device now, and which sensor it uses.
 *
 * - In the iOS/Android shell with `@aparajita/capacitor-biometric-auth` installed (`denext
 *   mobile add biometrics`): the plugin's check. On iOS a Face ID device whose Info.plist lacks
 *   `NSFaceIDUsageDescription` reads unavailable (prompting would crash the app); the install
 *   writes it.
 * - Elsewhere (the web, SSR, a shell without the plugin): `{ available: false, types: [],
 *   reason: "unsupported" }`. No web API offers this.
 *
 * @returns What the device offers.
 * @example
 * ```ts
 * import { isBiometricAvailable } from "denext/mobile";
 *
 * const { available, type } = await isBiometricAvailable();
 * label.textContent = available ? (type === "face" ? "Unlock with Face ID" : "Unlock") : "";
 * ```
 */
export async function isBiometricAvailable(): Promise<BiometricAvailability> {
  const plugin = biometricPlugin();
  if (!plugin) return { available: false, types: [], deviceSecure: false, reason: "unsupported" };
  return availabilityOf(await plugin.checkBiometry());
}

/** A non-empty string option, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Ask the user to authenticate with Face ID / Touch ID / a fingerprint (or, with
 * `allowDeviceCredential`, the device passcode).
 *
 * It resolves once the user is verified and rejects with a {@linkcode BiometricError}
 * otherwise: `cancelled`, `fallback`, `lockout`, `not-enrolled`, `unavailable`,
 * `passcode-not-set`, `failed`, or `unsupported` outside the shell (there is no web fallback:
 * gate a web build's flow on {@linkcode isBiometricAvailable} first).
 *
 * This is a presence check in the app, not a key release: a verified prompt proves the device
 * owner is here, and the app decides what that unlocks. See `secureStore.set(key, value,
 * { requireBiometric })` for the store's gate and its limits.
 *
 * @param options The prompt's texts and whether the passcode is accepted.
 * @returns A promise that resolves once the user is verified.
 * @example
 * ```ts
 * import { authenticateBiometric } from "denext/mobile";
 *
 * try {
 *   await authenticateBiometric({ reason: "Unlock your notes", allowDeviceCredential: true });
 *   showNotes();
 * } catch (err) {
 *   if ((err as { code?: string }).code !== "cancelled") showError(err);
 * }
 * ```
 */
export async function authenticateBiometric(options: BiometricAuthOptions = {}): Promise<void> {
  const plugin = biometricPlugin();
  if (!plugin) {
    throw biometricError(
      "unsupported",
      "authenticateBiometric: needs the iOS/Android shell with " +
        "@aparajita/capacitor-biometric-auth (`denext mobile add biometrics`); the web has none.",
    );
  }
  const reason = text(options.reason);
  try {
    await plugin.internalAuthenticate({
      reason,
      cancelTitle: text(options.cancelTitle),
      allowDeviceCredential: options.allowDeviceCredential === true,
      iosFallbackTitle: text(options.fallbackTitle),
      androidTitle: text(options.title),
      androidSubtitle: reason,
    });
  } catch (err) {
    const code = typeof err === "object" && err !== null
      ? (err as { code?: unknown }).code
      : undefined;
    const message = err instanceof Error ? err.message : String(err);
    throw biometricError(codeOf(code), `authenticateBiometric: ${message}`);
  }
}
