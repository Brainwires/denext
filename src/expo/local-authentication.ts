/**
 * `expo-local-authentication` for denext: Face ID / Touch ID / fingerprint prompts over
 * `denext/mobile`'s biometrics (`@aparajita/capacitor-biometric-auth` in the Capacitor shell,
 * `denext mobile add biometrics`). On the web there is no biometric API: the device reports no
 * hardware and `authenticateAsync` fails with `not_available`, as Expo's web build does.
 *
 * `cancelAuthenticate` cannot dismiss a prompt the plugin shows (it resolves without effect),
 * and `promptSubtitle` / `promptDescription` / `requireConfirmation` / `biometricsSecurityLevel`
 * are Android BiometricPrompt details the plugin sets itself.
 *
 * @example
 * ```ts
 * import * as LocalAuthentication from "denext/expo/local-authentication";
 *
 * if (await LocalAuthentication.isEnrolledAsync()) {
 *   const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock" });
 *   if (result.success) unlock();
 * }
 * ```
 *
 * @module
 */

import {
  authenticateBiometric,
  type BiometricErrorCode,
  isBiometricAvailable,
} from "../mobile/biometrics.ts";

/** A biometric sensor kind. */
export enum AuthenticationType {
  /** A fingerprint (Touch ID). */
  FINGERPRINT = 1,
  /** A face (Face ID). */
  FACIAL_RECOGNITION = 2,
  /** An iris (Optic ID). */
  IRIS = 3,
}

/** How the device is secured. */
export enum SecurityLevel {
  /** Nothing. */
  NONE = 0,
  /** A passcode / PIN / pattern. */
  SECRET = 1,
  /** A biometric (the same value as `BIOMETRIC_WEAK`). */
  BIOMETRIC = 2,
  /** A weak (class 2) biometric. */
  BIOMETRIC_WEAK = 2,
  /** A strong (class 3) biometric. */
  BIOMETRIC_STRONG = 3,
}

/** Android's biometric class (accepted, not applied here). */
export type BiometricsSecurityLevel = "weak" | "strong";

/** Why an authentication failed. */
export type LocalAuthenticationError =
  | "not_enrolled"
  | "user_cancel"
  | "app_cancel"
  | "not_available"
  | "lockout"
  | "no_space"
  | "timeout"
  | "unable_to_process"
  | "unknown"
  | "system_cancel"
  | "user_fallback"
  | "invalid_context"
  | "passcode_not_set"
  | "authentication_failed";

/** What {@linkcode authenticateAsync} resolves. */
export type LocalAuthenticationResult =
  | { success: true }
  | { success: false; error: LocalAuthenticationError; warning?: string };

/** Options for {@linkcode authenticateAsync}. */
export type LocalAuthenticationOptions = {
  /** The prompt's message. */
  promptMessage?: string;
  /** Android: the subtitle (ignored here). */
  promptSubtitle?: string;
  /** Android: the description (ignored here). */
  promptDescription?: string;
  /** The cancel button's label. */
  cancelLabel?: string;
  /** Biometrics only: do not offer the device passcode (default `false`). */
  disableDeviceFallback?: boolean;
  /** Android: require an explicit confirmation (ignored here). */
  requireConfirmation?: boolean;
  /** Android: the biometric class (ignored here). */
  biometricsSecurityLevel?: BiometricsSecurityLevel;
  /** iOS: the fallback button's label (`""` hides it). */
  fallbackLabel?: string;
};

/** denext's biometric error codes → Expo's. */
const ERRORS: Readonly<Record<BiometricErrorCode, LocalAuthenticationError>> = {
  cancelled: "user_cancel",
  fallback: "user_fallback",
  lockout: "lockout",
  "not-enrolled": "not_enrolled",
  unavailable: "not_available",
  "passcode-not-set": "passcode_not_set",
  failed: "authentication_failed",
  unsupported: "not_available",
};

/** denext's sensor kinds → Expo's. */
const TYPES = { fingerprint: 1, face: 2, iris: 3 } as const;

/**
 * Whether the device has a biometric sensor (enrolled or not).
 *
 * @returns `true` when there is one.
 */
export async function hasHardwareAsync(): Promise<boolean> {
  return (await isBiometricAvailable()).types.length > 0;
}

/**
 * The biometric sensor kinds the device has.
 *
 * @returns The kinds (none on the web).
 */
export async function supportedAuthenticationTypesAsync(): Promise<AuthenticationType[]> {
  return (await isBiometricAvailable()).types.map((t) => TYPES[t] as AuthenticationType);
}

/**
 * Whether a biometric is enrolled and usable.
 *
 * @returns `true` when a prompt can succeed.
 */
export async function isEnrolledAsync(): Promise<boolean> {
  return (await isBiometricAvailable()).available;
}

/**
 * How the device is secured: a biometric, a passcode only, or nothing. The plugin does not
 * tell a weak from a strong Android biometric, so an enrolled one reads `BIOMETRIC_STRONG` on
 * iOS and `BIOMETRIC_WEAK` on Android.
 *
 * @returns The level.
 */
export async function getEnrolledLevelAsync(): Promise<SecurityLevel> {
  const info = await isBiometricAvailable();
  if (info.available) {
    const cap = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    return cap?.getPlatform?.() === "ios"
      ? SecurityLevel.BIOMETRIC_STRONG
      : SecurityLevel.BIOMETRIC_WEAK;
  }
  return info.deviceSecure ? SecurityLevel.SECRET : SecurityLevel.NONE;
}

/**
 * Ask the user to authenticate (biometrics, then the device passcode unless
 * `disableDeviceFallback`). It never rejects for a refusal: the result says why.
 *
 * @param options The prompt's texts and the passcode fallback.
 * @returns `{ success: true }`, or `{ success: false, error }`.
 */
export async function authenticateAsync(
  options: LocalAuthenticationOptions = {},
): Promise<LocalAuthenticationResult> {
  try {
    await authenticateBiometric({
      reason: options.promptMessage,
      cancelTitle: options.cancelLabel,
      fallbackTitle: options.fallbackLabel,
      allowDeviceCredential: options.disableDeviceFallback !== true,
    });
    return { success: true };
  } catch (err) {
    const code = (err as { code?: BiometricErrorCode }).code;
    const error = code && Object.hasOwn(ERRORS, code) ? ERRORS[code] : "unknown";
    return { success: false, error, warning: (err as Error)?.message };
  }
}

/**
 * Cancel a running prompt: the plugin offers no way to, so this resolves without effect.
 *
 * @returns A promise that resolves.
 */
export function cancelAuthenticate(): Promise<void> {
  return Promise.resolve();
}
