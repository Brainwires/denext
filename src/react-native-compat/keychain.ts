/**
 * `react-native-keychain` for denext's React Native mode: credentials in `denext/mobile`'s
 * {@linkcode secureStore} (the iOS Keychain / Android Keystore through the secure-storage
 * plugin in the Capacitor shell, IndexedDB on the web), and biometric access control through
 * {@linkcode authenticateBiometric}.
 *
 * Each service's credentials are one JSON entry (`username`, `password`) in the store, and an
 * index entry lists the services for `getAllGenericPasswordServices`. An `accessControl` that
 * asks for biometrics or the device passcode (`BIOMETRY_*`, `USER_PRESENCE`,
 * `DEVICE_PASSCODE`) stores the value biometric-gated: every later read shows the prompt, and
 * a refusal resolves `false`, as the package's does. That gate is enforced by denext's code,
 * not by the Keychain item (see `secureStore`'s `requireBiometric`). `accessible`,
 * `securityLevel`, `storage`, `accessGroup` and `cloudSync` are accepted and do not change how
 * the value is stored. Shared web credentials (iOS password AutoFill) are not available. Where
 * there is no secret store (the web's plain IndexedDB fallback), an access-controlled set
 * resolves `false` instead of storing the value in the clear, and `canImplyAuthentication` is
 * `false`.
 *
 * @example
 * ```ts
 * import * as Keychain from "react-native-keychain";
 *
 * await Keychain.setGenericPassword("ada", token, { service: "api" });
 * const creds = await Keychain.getGenericPassword({ service: "api" });
 * if (creds) useToken(creds.password);
 * ```
 *
 * @module
 */

import { secureStore, secureStoreIsSecret } from "../mobile/secure-store.ts";
import { authenticateBiometric, isBiometricAvailable } from "../mobile/biometrics.ts";
import { nativePlatform } from "../mobile/bridge.ts";

/** When the item may be read (iOS; accepted and ignored). */
export enum ACCESSIBLE {
  /** While the device is unlocked. */
  WHEN_UNLOCKED = "AccessibleWhenUnlocked",
  /** After the first unlock since boot. */
  AFTER_FIRST_UNLOCK = "AccessibleAfterFirstUnlock",
  /** Always. */
  ALWAYS = "AccessibleAlways",
  /** While a passcode is set, on this device only. */
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = "AccessibleWhenPasscodeSetThisDeviceOnly",
  /** While unlocked, on this device only. */
  WHEN_UNLOCKED_THIS_DEVICE_ONLY = "AccessibleWhenUnlockedThisDeviceOnly",
  /** After the first unlock, on this device only. */
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = "AccessibleAfterFirstUnlockThisDeviceOnly",
}

/** What a read requires. Every value but `APPLICATION_PASSWORD` gates reads behind a prompt. */
export enum ACCESS_CONTROL {
  /** Biometrics or the passcode. */
  USER_PRESENCE = "UserPresence",
  /** Any enrolled biometric. */
  BIOMETRY_ANY = "BiometryAny",
  /** The biometrics enrolled now. */
  BIOMETRY_CURRENT_SET = "BiometryCurrentSet",
  /** The device passcode. */
  DEVICE_PASSCODE = "DevicePasscode",
  /** An application password (not available: stored ungated). */
  APPLICATION_PASSWORD = "ApplicationPassword",
  /** Biometrics or the passcode. */
  BIOMETRY_ANY_OR_DEVICE_PASSCODE = "BiometryAnyOrDevicePasscode",
  /** The current biometrics or the passcode. */
  BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE = "BiometryCurrentSetOrDevicePasscode",
}

/** How a gated read authenticates (iOS). */
export enum AUTHENTICATION_TYPE {
  /** The passcode or biometrics. */
  DEVICE_PASSCODE_OR_BIOMETRICS = "AuthenticationWithBiometricsDevicePasscode",
  /** Biometrics only. */
  BIOMETRICS = "AuthenticationWithBiometrics",
}

/** Android's storage security level (accepted and ignored). */
export enum SECURITY_LEVEL {
  /** Any. */
  ANY = 0,
  /** Software-backed. */
  SECURE_SOFTWARE = 1,
  /** Hardware-backed (TEE / StrongBox). */
  SECURE_HARDWARE = 2,
}

/** A biometric sensor kind. */
export enum BIOMETRY_TYPE {
  /** Touch ID. */
  TOUCH_ID = "TouchID",
  /** Face ID. */
  FACE_ID = "FaceID",
  /** Optic ID. */
  OPTIC_ID = "OpticID",
  /** An Android fingerprint. */
  FINGERPRINT = "Fingerprint",
  /** Android face unlock. */
  FACE = "Face",
  /** Android iris. */
  IRIS = "Iris",
}

/** Android's cipher storage (accepted and ignored; results report `AES_GCM_NO_AUTH`). */
export enum STORAGE_TYPE {
  /** AES-CBC. */
  AES_CBC = "KeystoreAESCBC",
  /** AES-GCM without authentication. */
  AES_GCM_NO_AUTH = "KeystoreAESGCM_NoAuth",
  /** AES-GCM with authentication. */
  AES_GCM = "KeystoreAESGCM",
  /** RSA. */
  RSA = "KeystoreRSAECB",
}

/** The biometric prompt's texts. */
export type AuthenticationPrompt = {
  /** The title (Android). */
  title?: string;
  /** The subtitle (Android). */
  subtitle?: string;
  /** The description: the reason shown. */
  description?: string;
  /** The cancel button. */
  cancel?: string;
};

/** Options every call takes. */
export type BaseOptions = {
  /** The service the credentials belong to (default `"default"`). */
  service?: string;
  /** The server (internet credentials). */
  server?: string;
  /** iCloud Keychain sync (ignored). */
  cloudSync?: boolean;
  /** The Keychain access group (ignored). */
  accessGroup?: string;
};

/** Options for storing. */
export type SetOptions = BaseOptions & {
  /** When the item may be read (ignored). */
  accessible?: ACCESSIBLE;
  /** Android's security level (ignored). */
  securityLevel?: SECURITY_LEVEL;
  /** Android's cipher (ignored). */
  storage?: STORAGE_TYPE;
  /** The prompt (Android shows it on store; here, on read). */
  authenticationPrompt?: AuthenticationPrompt;
  /** What a read requires. */
  accessControl?: ACCESS_CONTROL;
};

/** Options for reading. */
export type GetOptions = BaseOptions & {
  /** What the read requires (the stored item's own control applies). */
  accessControl?: ACCESS_CONTROL;
  /** The prompt a gated read shows. */
  authenticationPrompt?: AuthenticationPrompt;
};

/** Options for {@linkcode getAllGenericPasswordServices}. */
export type GetAllOptions = {
  /** Skip the prompt for gated items (always: the list holds no secrets). */
  skipUIAuth?: boolean;
};

/** Options for {@linkcode canImplyAuthentication}. */
export type AuthenticationTypeOption = {
  /** How it would authenticate. */
  authenticationType?: AUTHENTICATION_TYPE;
};

/** What a store resolves to. */
export type Result = {
  /** The service. */
  service: string;
  /** The cipher storage. */
  storage: STORAGE_TYPE;
};

/** Stored credentials. */
export type UserCredentials = Result & {
  /** The username. */
  username: string;
  /** The password. */
  password: string;
};

/** Shared web credentials (iOS). */
export type SharedWebCredentials = UserCredentials & {
  /** The server. */
  server: string;
};

/** The store key prefixes. */
const GENERIC = "rn-keychain:generic:";
const INTERNET = "rn-keychain:internet:";
/** The key of the generic services index. */
const INDEX = "rn-keychain:services";
/** The default service. */
const DEFAULT_SERVICE = "default";

/** The access controls that gate reads behind a prompt. */
const GATED: ReadonlySet<string> = new Set([
  ACCESS_CONTROL.USER_PRESENCE,
  ACCESS_CONTROL.BIOMETRY_ANY,
  ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
  ACCESS_CONTROL.DEVICE_PASSCODE,
  ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
  ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
]);

/** The controls that accept the passcode too. */
const PASSCODE: ReadonlySet<string> = new Set([
  ACCESS_CONTROL.USER_PRESENCE,
  ACCESS_CONTROL.DEVICE_PASSCODE,
  ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
  ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
]);

/** The stored shape. */
interface Stored {
  username: string;
  password: string;
  /** The access control, when gated. */
  control?: string;
}

/** The service an options object names. */
function serviceOf(options?: BaseOptions): string {
  return options?.service ?? DEFAULT_SERVICE;
}

/** Store `entry` under `key`. */
async function put(key: string, entry: Stored): Promise<void> {
  // The gate is ours (a prompt before handing the value out), so the value is stored plainly
  // and `control` records it; `secureStore`'s own gate would prompt on every index read.
  await secureStore.set(key, JSON.stringify(entry));
}

/** The entry under `key`, or null. */
async function read(key: string): Promise<Stored | null> {
  const raw = await secureStore.get(key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Stored;
    return typeof parsed?.password === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether the user passes the prompt an entry's control asks for. */
async function unlocked(entry: Stored, prompt?: AuthenticationPrompt): Promise<boolean> {
  if (!entry.control || !GATED.has(entry.control)) return true;
  try {
    await authenticateBiometric({
      reason: prompt?.description ?? prompt?.subtitle ?? "Unlock a saved password",
      title: prompt?.title,
      cancelTitle: prompt?.cancel,
      allowDeviceCredential: PASSCODE.has(entry.control),
    });
    return true;
  } catch {
    return false;
  }
}

/** The generic services index. */
async function services(): Promise<string[]> {
  try {
    const list = JSON.parse(await secureStore.get(INDEX) ?? "[]");
    return Array.isArray(list) ? list.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Add or remove a service in the index. */
async function index(service: string, present: boolean): Promise<void> {
  const list = new Set(await services());
  if (present === list.has(service)) return;
  if (present) list.add(service);
  else list.delete(service);
  await secureStore.set(INDEX, JSON.stringify([...list]));
}

/**
 * Whether an entry stored with `options` keeps its promise: an access-controlled one needs a
 * secret store under it (the shell's plugin, the desktop keychain), never the web's plain
 * IndexedDB fallback.
 */
async function gateHolds(options?: SetOptions): Promise<boolean> {
  const control = options?.accessControl;
  return !(control && GATED.has(control)) || await secureStoreIsSecret();
}

/** The entry for `options`' access control. */
function entryFor(username: string, password: string, options?: SetOptions): Stored {
  const control = options?.accessControl;
  return control && GATED.has(control) ? { username, password, control } : { username, password };
}

/**
 * Store a username and password for a service.
 *
 * @param username The username.
 * @param password The password.
 * @param options The service and access control.
 * @returns The service and storage, or `false` when storing failed.
 */
export async function setGenericPassword(
  username: string,
  password: string,
  options?: SetOptions,
): Promise<false | Result> {
  const service = serviceOf(options);
  if (!(await gateHolds(options))) return false;
  try {
    await put(GENERIC + service, entryFor(username, password, options));
    await index(service, true);
  } catch {
    return false;
  }
  return { service, storage: STORAGE_TYPE.AES_GCM_NO_AUTH };
}

/**
 * A service's credentials, after the prompt when they are gated.
 *
 * @param options The service and prompt.
 * @returns The credentials, or `false` when there are none or the prompt failed.
 */
export async function getGenericPassword(options?: GetOptions): Promise<false | UserCredentials> {
  const service = serviceOf(options);
  const entry = await read(GENERIC + service);
  if (!entry || !(await unlocked(entry, options?.authenticationPrompt))) return false;
  return {
    service,
    storage: STORAGE_TYPE.AES_GCM_NO_AUTH,
    username: entry.username,
    password: entry.password,
  };
}

/**
 * Whether a service has credentials (no prompt).
 *
 * @param options The service.
 * @returns Whether it has.
 */
export async function hasGenericPassword(options?: BaseOptions): Promise<boolean> {
  return (await read(GENERIC + serviceOf(options))) !== null;
}

/**
 * Remove a service's credentials.
 *
 * @param options The service.
 * @returns `true`.
 */
export async function resetGenericPassword(options?: BaseOptions): Promise<boolean> {
  const service = serviceOf(options);
  await secureStore.delete(GENERIC + service);
  await index(service, false);
  return true;
}

/**
 * Every service with generic credentials.
 *
 * @param _options Ignored (the list holds no secrets, so there is no prompt).
 * @returns The services.
 */
export function getAllGenericPasswordServices(_options?: GetAllOptions): Promise<string[]> {
  return services();
}

/** The server an options object names, or the error. */
function serverOf(options: BaseOptions | undefined, fn: string): string {
  if (typeof options?.server === "string" && options.server) return options.server;
  throw new TypeError(`react-native-keychain (denext): ${fn} needs options.server`);
}

/**
 * Whether a server has credentials (no prompt).
 *
 * @param options `{ server }`.
 * @returns Whether it has.
 */
export async function hasInternetCredentials(options: BaseOptions): Promise<boolean> {
  return (await read(INTERNET + serverOf(options, "hasInternetCredentials"))) !== null;
}

/**
 * Store a username and password for a server.
 *
 * @param server The server.
 * @param username The username.
 * @param password The password.
 * @param options The access control.
 * @returns The storage result, or `false` when storing failed.
 */
export async function setInternetCredentials(
  server: string,
  username: string,
  password: string,
  options?: SetOptions,
): Promise<false | Result> {
  if (!(await gateHolds(options))) return false;
  try {
    await put(INTERNET + server, entryFor(username, password, options));
  } catch {
    return false;
  }
  return { service: server, storage: STORAGE_TYPE.AES_GCM_NO_AUTH };
}

/**
 * A server's credentials, after the prompt when they are gated.
 *
 * @param server The server.
 * @param options The prompt.
 * @returns The credentials, or `false`.
 */
export async function getInternetCredentials(
  server: string,
  options?: GetOptions,
): Promise<false | (UserCredentials & { server: string })> {
  const entry = await read(INTERNET + server);
  if (!entry || !(await unlocked(entry, options?.authenticationPrompt))) return false;
  return {
    server,
    service: server,
    storage: STORAGE_TYPE.AES_GCM_NO_AUTH,
    username: entry.username,
    password: entry.password,
  };
}

/**
 * Remove a server's credentials.
 *
 * @param options `{ server }`.
 * @returns A promise that settles once removed.
 */
export async function resetInternetCredentials(options: BaseOptions): Promise<void> {
  await secureStore.delete(INTERNET + serverOf(options, "resetInternetCredentials"));
}

/**
 * The device's biometric sensor, or null when there is none (or on the web).
 *
 * @returns The sensor kind.
 */
export async function getSupportedBiometryType(): Promise<BIOMETRY_TYPE | null> {
  const { available, type } = await isBiometricAvailable();
  if (!available || !type) return null;
  const ios = nativePlatform() === "ios";
  if (type === "face") return ios ? BIOMETRY_TYPE.FACE_ID : BIOMETRY_TYPE.FACE;
  if (type === "iris") return ios ? BIOMETRY_TYPE.OPTIC_ID : BIOMETRY_TYPE.IRIS;
  return ios ? BIOMETRY_TYPE.TOUCH_ID : BIOMETRY_TYPE.FINGERPRINT;
}

/**
 * Whether a gated item can be protected here: biometrics are available, or (for
 * `DEVICE_PASSCODE_OR_BIOMETRICS`) a passcode is set.
 *
 * @param options The authentication type.
 * @returns Whether it can.
 */
export async function canImplyAuthentication(
  options?: AuthenticationTypeOption,
): Promise<boolean> {
  if (!(await secureStoreIsSecret())) return false; // the web fallback protects nothing
  const status = await isBiometricAvailable();
  if (options?.authenticationType === AUTHENTICATION_TYPE.BIOMETRICS) return status.available;
  return status.available || status.deviceSecure;
}

/**
 * Android's storage security level: unknown here (`null`).
 *
 * @param _options Ignored.
 * @returns `null`.
 */
export function getSecurityLevel(_options?: SetOptions): Promise<SECURITY_LEVEL | null> {
  return Promise.resolve(null);
}

/**
 * Whether a device passcode is set.
 *
 * @returns Whether it is.
 */
export async function isPasscodeAuthAvailable(): Promise<boolean> {
  return (await isBiometricAvailable()).deviceSecure;
}

/** The error the shared web credential calls reject with. */
function sharedCredentialsUnavailable(fn: string): Error {
  return new Error(
    `react-native-keychain (denext): ${fn}() is not available (no Safari shared web ` +
      "credentials in a web view).",
  );
}

/**
 * iOS shared web credentials. Not available.
 *
 * @returns A rejected promise.
 */
export function requestSharedWebCredentials(): Promise<false | SharedWebCredentials> {
  return Promise.reject(sharedCredentialsUnavailable("requestSharedWebCredentials"));
}

/**
 * iOS shared web credentials. Not available.
 *
 * @param _server The server.
 * @param _username The username.
 * @param _password The password.
 * @returns A rejected promise.
 */
export function setSharedWebCredentials(
  _server: string,
  _username: string,
  _password?: string,
): Promise<void> {
  return Promise.reject(sharedCredentialsUnavailable("setSharedWebCredentials"));
}

/** The package's default export. */
const Keychain: {
  /** {@linkcode SECURITY_LEVEL}. */
  readonly SECURITY_LEVEL: typeof SECURITY_LEVEL;
  /** {@linkcode ACCESSIBLE}. */
  readonly ACCESSIBLE: typeof ACCESSIBLE;
  /** {@linkcode ACCESS_CONTROL}. */
  readonly ACCESS_CONTROL: typeof ACCESS_CONTROL;
  /** {@linkcode AUTHENTICATION_TYPE}. */
  readonly AUTHENTICATION_TYPE: typeof AUTHENTICATION_TYPE;
  /** {@linkcode BIOMETRY_TYPE}. */
  readonly BIOMETRY_TYPE: typeof BIOMETRY_TYPE;
  /** {@linkcode STORAGE_TYPE}. */
  readonly STORAGE_TYPE: typeof STORAGE_TYPE;
  /** {@linkcode getSecurityLevel}. */
  readonly getSecurityLevel: typeof getSecurityLevel;
  /** {@linkcode canImplyAuthentication}. */
  readonly canImplyAuthentication: typeof canImplyAuthentication;
  /** {@linkcode getSupportedBiometryType}. */
  readonly getSupportedBiometryType: typeof getSupportedBiometryType;
  /** {@linkcode setInternetCredentials}. */
  readonly setInternetCredentials: typeof setInternetCredentials;
  /** {@linkcode isPasscodeAuthAvailable}. */
  readonly isPasscodeAuthAvailable: typeof isPasscodeAuthAvailable;
  /** {@linkcode getInternetCredentials}. */
  readonly getInternetCredentials: typeof getInternetCredentials;
  /** {@linkcode resetInternetCredentials}. */
  readonly resetInternetCredentials: typeof resetInternetCredentials;
  /** {@linkcode setGenericPassword}. */
  readonly setGenericPassword: typeof setGenericPassword;
  /** {@linkcode getGenericPassword}. */
  readonly getGenericPassword: typeof getGenericPassword;
  /** {@linkcode getAllGenericPasswordServices}. */
  readonly getAllGenericPasswordServices: typeof getAllGenericPasswordServices;
  /** {@linkcode resetGenericPassword}. */
  readonly resetGenericPassword: typeof resetGenericPassword;
  /** {@linkcode requestSharedWebCredentials}. */
  readonly requestSharedWebCredentials: typeof requestSharedWebCredentials;
  /** {@linkcode setSharedWebCredentials}. */
  readonly setSharedWebCredentials: typeof setSharedWebCredentials;
} = {
  SECURITY_LEVEL,
  ACCESSIBLE,
  ACCESS_CONTROL,
  AUTHENTICATION_TYPE,
  BIOMETRY_TYPE,
  STORAGE_TYPE,
  getSecurityLevel,
  canImplyAuthentication,
  getSupportedBiometryType,
  setInternetCredentials,
  isPasscodeAuthAvailable,
  getInternetCredentials,
  resetInternetCredentials,
  setGenericPassword,
  getGenericPassword,
  getAllGenericPasswordServices,
  resetGenericPassword,
  requestSharedWebCredentials,
  setSharedWebCredentials,
};

export default Keychain;
