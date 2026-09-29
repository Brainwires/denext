/**
 * `react-native-biometrics` for denext's React Native mode: Face ID / Touch ID / fingerprint
 * prompts over `denext/mobile`'s {@linkcode isBiometricAvailable} /
 * {@linkcode authenticateBiometric} (`@aparajita/capacitor-biometric-auth` in the Capacitor
 * shell, `denext mobile add biometrics`). On the web there is no biometric API: no sensor is
 * reported and prompts fail.
 *
 * The signing keys are a best effort: `createKeys` makes an RSA-2048 key pair with WebCrypto
 * and keeps the private key in `denext/mobile`'s `secureStore` (the Keychain / Keystore in the
 * shell); `createSignature` shows the biometric prompt, then signs the payload with
 * RSASSA-PKCS1-v1_5 / SHA-256 and returns it base64, as the package does. Unlike the package,
 * the key is not generated inside the Secure Enclave / StrongBox and is not bound to the
 * biometric set by the hardware: the prompt is enforced by denext's code. `publicKey` is the
 * base64 SubjectPublicKeyInfo (Android's format; iOS's is PKCS#1).
 *
 * @example
 * ```ts
 * import ReactNativeBiometrics, { BiometryTypes } from "react-native-biometrics";
 *
 * const rnBiometrics = new ReactNativeBiometrics();
 * const { available, biometryType } = await rnBiometrics.isSensorAvailable();
 * if (available && biometryType === BiometryTypes.FaceID) {
 *   const { success } = await rnBiometrics.simplePrompt({ promptMessage: "Confirm" });
 * }
 * ```
 *
 * @module
 */

import { authenticateBiometric, isBiometricAvailable } from "../mobile/biometrics.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { secureStore } from "../mobile/secure-store.ts";

/** The biometry kind a device reports. */
export type BiometryType = "TouchID" | "FaceID" | "Biometrics";

/** Touch ID. */
export const TouchID = "TouchID";
/** Face ID. */
export const FaceID = "FaceID";
/** Generic biometrics (the only value Android reports). */
export const Biometrics = "Biometrics";

/** The biometry kinds. */
export const BiometryTypes: {
  /** Touch ID. */
  TouchID: string;
  /** Face ID. */
  FaceID: string;
  /** Generic biometrics. */
  Biometrics: string;
} = { TouchID, FaceID, Biometrics };

/** Constructor options. */
export interface RNBiometricsOptions {
  /** Accept the device passcode too (default `false`). */
  allowDeviceCredentials?: boolean;
}

/** What {@linkcode ReactNativeBiometrics.isSensorAvailable} resolves to. */
export interface IsSensorAvailableResult {
  /** Whether a prompt can succeed. */
  available: boolean;
  /** The sensor, when there is one. */
  biometryType?: BiometryType;
  /** Why not, when it is not available. */
  error?: string;
}

/** What {@linkcode ReactNativeBiometrics.createKeys} resolves to. */
export interface CreateKeysResult {
  /** The public key, base64 SubjectPublicKeyInfo. */
  publicKey: string;
}

/** What {@linkcode ReactNativeBiometrics.biometricKeysExist} resolves to. */
export interface BiometricKeysExistResult {
  /** Whether a key pair exists. */
  keysExist: boolean;
}

/** What {@linkcode ReactNativeBiometrics.deleteKeys} resolves to. */
export interface DeleteKeysResult {
  /** Whether a key pair was deleted. */
  keysDeleted: boolean;
}

/** Options for {@linkcode ReactNativeBiometrics.createSignature}. */
export interface CreateSignatureOptions {
  /** The prompt's message. */
  promptMessage: string;
  /** The payload to sign. */
  payload: string;
  /** The cancel button. */
  cancelButtonText?: string;
}

/** What {@linkcode ReactNativeBiometrics.createSignature} resolves to. */
export interface CreateSignatureResult {
  /** Whether the user passed and the payload was signed. */
  success: boolean;
  /** The signature, base64. */
  signature?: string;
  /** Why not. */
  error?: string;
}

/** Options for {@linkcode ReactNativeBiometrics.simplePrompt}. */
export interface SimplePromptOptions {
  /** The prompt's message. */
  promptMessage: string;
  /** iOS: the fallback button's title. */
  fallbackPromptMessage?: string;
  /** The cancel button. */
  cancelButtonText?: string;
}

/** What {@linkcode ReactNativeBiometrics.simplePrompt} resolves to. */
export interface SimplePromptResult {
  /** Whether the user passed. */
  success: boolean;
  /** Why not. */
  error?: string;
}

/** Where the private key is kept. */
const KEY = "rn-biometrics:private-key";
/** The signing algorithm. */
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** Bytes as base64. */
function base64(bytes: ArrayBuffer): string {
  let text = "";
  for (const b of new Uint8Array(bytes)) text += String.fromCharCode(b);
  return btoa(text);
}

/** A prompt that resolves `{ success, error }` instead of rejecting on a refusal. */
async function prompt(
  message: string,
  allowDeviceCredential: boolean,
  cancel?: string,
  fallback?: string,
): Promise<SimplePromptResult> {
  try {
    await authenticateBiometric({
      reason: message,
      allowDeviceCredential,
      ...(cancel ? { cancelTitle: cancel } : {}),
      ...(fallback !== undefined ? { fallbackTitle: fallback } : {}),
    });
    return { success: true };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "cancelled" || code === "fallback") {
      return { success: false, error: "User cancellation" };
    }
    throw err;
  }
}

/**
 * The package's class: biometric availability, a simple prompt and a signing key pair.
 */
export default class ReactNativeBiometrics {
  /** Whether the device passcode is accepted too. */
  allowDeviceCredentials = false;

  /**
   * A biometrics helper.
   *
   * @param options Whether the passcode is accepted too.
   */
  constructor(options?: RNBiometricsOptions) {
    this.allowDeviceCredentials = options?.allowDeviceCredentials ?? false;
  }

  /**
   * Whether a biometric prompt can succeed, and the sensor.
   *
   * @returns The availability.
   */
  async isSensorAvailable(): Promise<IsSensorAvailableResult> {
    const status = await isBiometricAvailable();
    const ios = nativePlatform() === "ios";
    const biometryType: BiometryType | undefined = !status.type
      ? undefined
      : !ios
      ? "Biometrics"
      : status.type === "face"
      ? "FaceID"
      : "TouchID";
    if (status.available) return { available: true, biometryType };
    if (this.allowDeviceCredentials && status.deviceSecure) return { available: true };
    return {
      available: false,
      ...(biometryType ? { biometryType } : {}),
      error: status.reason ?? "unavailable",
    };
  }

  /**
   * Show the biometric prompt.
   *
   * @param options The message and buttons.
   * @returns `{ success: true }`, or `{ success: false }` when the user cancelled.
   */
  simplePrompt(options: SimplePromptOptions): Promise<SimplePromptResult> {
    return prompt(
      options.promptMessage,
      this.allowDeviceCredentials,
      options.cancelButtonText,
      options.fallbackPromptMessage,
    );
  }

  /**
   * Make a new RSA-2048 key pair (replacing any earlier one) and keep the private key in
   * `secureStore`.
   *
   * @returns The public key.
   */
  async createKeys(): Promise<CreateKeysResult> {
    const pair = await crypto.subtle.generateKey(
      { ...ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    await secureStore.set(KEY, JSON.stringify(jwk));
    return { publicKey: base64(await crypto.subtle.exportKey("spki", pair.publicKey)) };
  }

  /**
   * Whether a key pair exists.
   *
   * @returns The answer.
   */
  async biometricKeysExist(): Promise<BiometricKeysExistResult> {
    return { keysExist: (await secureStore.get(KEY)) !== null };
  }

  /**
   * Delete the key pair.
   *
   * @returns Whether one was deleted.
   */
  async deleteKeys(): Promise<DeleteKeysResult> {
    const existed = (await secureStore.get(KEY)) !== null;
    await secureStore.delete(KEY);
    return { keysDeleted: existed };
  }

  /**
   * Show the biometric prompt, then sign `payload` with the private key.
   *
   * @param options The message, payload and cancel button.
   * @returns The signature, or `{ success: false }` when the user cancelled.
   */
  async createSignature(options: CreateSignatureOptions): Promise<CreateSignatureResult> {
    const raw = await secureStore.get(KEY);
    if (raw === null) return { success: false, error: "No keys found; call createKeys() first" };
    const passed = await prompt(
      options.promptMessage,
      this.allowDeviceCredentials,
      options.cancelButtonText,
    );
    if (!passed.success) return { success: false, error: passed.error };
    const key = await crypto.subtle.importKey("jwk", JSON.parse(raw), ALGORITHM, false, ["sign"]);
    const signature = await crypto.subtle.sign(
      ALGORITHM,
      key,
      new TextEncoder().encode(options.payload),
    );
    return { success: true, signature: base64(signature) };
  }
}

/**
 * The package's legacy module-level API: each call on a default {@linkcode ReactNativeBiometrics}.
 */
export const ReactNativeBiometricsLegacy: {
  /** {@linkcode ReactNativeBiometrics.isSensorAvailable}. */
  isSensorAvailable(): Promise<IsSensorAvailableResult>;
  /** {@linkcode ReactNativeBiometrics.createKeys}. */
  createKeys(): Promise<CreateKeysResult>;
  /** {@linkcode ReactNativeBiometrics.biometricKeysExist}. */
  biometricKeysExist(): Promise<BiometricKeysExistResult>;
  /** {@linkcode ReactNativeBiometrics.deleteKeys}. */
  deleteKeys(): Promise<DeleteKeysResult>;
  /** {@linkcode ReactNativeBiometrics.createSignature}. */
  createSignature(options: CreateSignatureOptions): Promise<CreateSignatureResult>;
  /** {@linkcode ReactNativeBiometrics.simplePrompt}. */
  simplePrompt(options: SimplePromptOptions): Promise<SimplePromptResult>;
} = {
  isSensorAvailable: () => new ReactNativeBiometrics().isSensorAvailable(),
  createKeys: () => new ReactNativeBiometrics().createKeys(),
  biometricKeysExist: () => new ReactNativeBiometrics().biometricKeysExist(),
  deleteKeys: () => new ReactNativeBiometrics().deleteKeys(),
  createSignature: (options) => new ReactNativeBiometrics().createSignature(options),
  simplePrompt: (options) => new ReactNativeBiometrics().simplePrompt(options),
};
