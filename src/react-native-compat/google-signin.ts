/**
 * `@react-native-google-signin/google-signin` for denext's React Native mode: the "Original"
 * `GoogleSignin` API over `denext/mobile`'s {@linkcode signInWithGoogle} (the native Google
 * sheet through `@capgo/capacitor-social-login` in the Capacitor shell,
 * `denext mobile add social-login`). There is no web fallback: outside the shell `signIn`
 * rejects with `PLAY_SERVICES_NOT_AVAILABLE`, as the package's own web build does.
 *
 * `configure({ webClientId, iosClientId, scopes })` is required (`webClientId` is the id
 * token's audience on both platforms). The signed-in user is remembered for the session
 * (`getCurrentUser`, `hasPreviousSignIn`, `signInSilently` answer from it); a relaunch starts
 * signed out, so `signInSilently` reports `noSavedCredentialFound`. The plugin returns only an
 * id token: `getTokens().accessToken` and `serverAuthCode` are empty, `user.photo` is null, and
 * `addScopes` signs in again with the extra scopes. `revokeAccess` forgets the user locally
 * (revoke the grant on your server). `GoogleSigninButton` is a styled `<button>`.
 *
 * @example
 * ```ts
 * import { GoogleSignin, isSuccessResponse } from "@react-native-google-signin/google-signin";
 *
 * GoogleSignin.configure({ webClientId: WEB_ID, iosClientId: IOS_ID });
 * const response = await GoogleSignin.signIn();
 * if (isSuccessResponse(response)) await api.signIn(response.data.idToken);
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { signInWithGoogle } from "../mobile/social-login.ts";
import { viewStyle } from "../expo/internal/common.ts";
import * as RN from "./internal/react-native.ts";

/** The error codes the calls reject with (`error.code`). */
export const statusCodes: {
  /** The user closed the sheet. */
  readonly SIGN_IN_CANCELLED: "SIGN_IN_CANCELLED";
  /** A sign-in is already running. */
  readonly IN_PROGRESS: "IN_PROGRESS";
  /** No Google sign-in here (the web, or a shell without the plugin). */
  readonly PLAY_SERVICES_NOT_AVAILABLE: "PLAY_SERVICES_NOT_AVAILABLE";
  /** Nobody is signed in. */
  readonly SIGN_IN_REQUIRED: "SIGN_IN_REQUIRED";
  /** No view controller to present from (iOS). */
  readonly NULL_PRESENTER: "NULL_PRESENTER";
} = {
  SIGN_IN_CANCELLED: "SIGN_IN_CANCELLED",
  IN_PROGRESS: "IN_PROGRESS",
  PLAY_SERVICES_NOT_AVAILABLE: "PLAY_SERVICES_NOT_AVAILABLE",
  SIGN_IN_REQUIRED: "SIGN_IN_REQUIRED",
  NULL_PRESENTER: "NULL_PRESENTER",
};

/** Options for {@linkcode GoogleSignin}`.configure`. */
export type ConfigureParams = {
  /** Extra OAuth scopes (default email and profile). */
  scopes?: string[];
  /** The "Web application" OAuth client id (required: the id token's audience). */
  webClientId?: string;
  /** iOS: the "iOS" OAuth client id (required on iOS). */
  iosClientId?: string;
  /** Request a server auth code (not available: `serverAuthCode` stays null). */
  offlineAccess?: boolean;
  /** A hosted domain restriction (ignored). */
  hostedDomain?: string;
  /** Android: force a code for a refresh token (ignored). */
  forceCodeForRefreshToken?: boolean;
  /** Android: the account to prefer (ignored). */
  accountName?: string;
  /** iOS: the OpenID2 realm (ignored). */
  openIdRealm?: string;
  /** iOS: the profile image size (ignored). */
  profileImageSize?: number;
  /** iOS: a GoogleService-Info plist path (ignored: pass `iosClientId`). */
  googleServicePlistPath?: string;
};

/** Options for {@linkcode GoogleSignin}`.signIn`. */
export type SignInParams = {
  /** iOS: an account to prefill (ignored). */
  loginHint?: string;
};

/** Options for {@linkcode GoogleSignin}`.hasPlayServices`. */
export type HasPlayServicesParams = {
  /** Show Google's update dialog (ignored). */
  showPlayServicesUpdateDialog: boolean;
};

/** Options for {@linkcode GoogleSignin}`.addScopes`. */
export type AddScopesParams = {
  /** The scopes to add. */
  scopes: string[];
};

/** What {@linkcode GoogleSignin}`.getTokens` resolves to. */
export type GetTokensResponse = {
  /** The id token. */
  idToken: string;
  /** The access token (empty: the plugin returns none). */
  accessToken: string;
};

/** A signed-in user. */
export type User = {
  /** The profile. */
  user: {
    /** Google's user id (`sub`). */
    id: string;
    /** The display name. */
    name: string | null;
    /** The email. */
    email: string;
    /** The photo URL (null here). */
    photo: string | null;
    /** The family name (null here). */
    familyName: string | null;
    /** The given name (null here). */
    givenName: string | null;
  };
  /** The scopes granted. */
  scopes: string[];
  /** The id token (a JWT your server verifies). */
  idToken: string | null;
  /** The server auth code (null here). */
  serverAuthCode: string | null;
};

/** A successful sign-in. */
export type SignInSuccessResponse = {
  /** `"success"`. */
  type: "success";
  /** The user. */
  data: User;
};

/** The user cancelled. */
export type CancelledResponse = {
  /** `"cancelled"`. */
  type: "cancelled";
  /** Nothing. */
  data: null;
};

/** `signInSilently` found nobody signed in. */
export type NoSavedCredentialFound = {
  /** `"noSavedCredentialFound"`. */
  type: "noSavedCredentialFound";
  /** Nothing. */
  data: null;
};

/** What `signIn` resolves to. */
export type SignInResponse = SignInSuccessResponse | CancelledResponse;
/** What `signInSilently` resolves to. */
export type SignInSilentlyResponse = SignInSuccessResponse | NoSavedCredentialFound;

/** An error the calls reject with, carrying one of {@linkcode statusCodes}. */
export interface NativeModuleError extends Error {
  /** The status code. */
  code: string;
}

/** The session's state. */
let config: ConfigureParams | null = null;
let current: User | null = null;
let busy = false;

/** An error carrying `code`. */
function codeError(code: string, message: string): NativeModuleError {
  return Object.assign(new Error(`Google sign-in (denext): ${message}`), { code });
}

/** Sign in with `scopes`, mapping denext's result and errors onto the package's. */
async function run(scopes: string[] | undefined): Promise<SignInResponse> {
  if (!config?.webClientId) {
    throw codeError(
      statusCodes.PLAY_SERVICES_NOT_AVAILABLE,
      "call GoogleSignin.configure({ webClientId }) first",
    );
  }
  if (busy) throw codeError(statusCodes.IN_PROGRESS, "a sign-in is already in progress");
  busy = true;
  try {
    const result = await signInWithGoogle({
      webClientId: config.webClientId,
      ...(config.iosClientId ? { iosClientId: config.iosClientId } : {}),
      ...(scopes && scopes.length ? { scopes } : {}),
    });
    current = {
      user: {
        id: result.user ?? "",
        name: result.name ?? null,
        email: result.email ?? "",
        photo: null,
        familyName: null,
        givenName: null,
      },
      scopes: scopes ?? ["email", "profile", "openid"],
      idToken: result.idToken,
      serverAuthCode: null,
    };
    return { type: "success", data: current };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "cancelled") return { type: "cancelled", data: null };
    if (code === "unsupported") {
      throw codeError(statusCodes.PLAY_SERVICES_NOT_AVAILABLE, (err as Error).message);
    }
    throw err;
  } finally {
    busy = false;
  }
}

/** The "Original Google Sign In" API. */
export const GoogleSignin: {
  /** Store the client ids and scopes. */
  configure(options?: ConfigureParams): void;
  /** Always `true`: the plugin brings what it needs. */
  hasPlayServices(options?: HasPlayServicesParams): Promise<boolean>;
  /** Show Google's sheet. */
  signIn(options?: SignInParams): Promise<SignInResponse>;
  /** Sign in again with extra scopes. */
  addScopes(options: AddScopesParams): Promise<SignInResponse | null>;
  /** The session's user, or `noSavedCredentialFound`. */
  signInSilently(): Promise<SignInSilentlyResponse>;
  /** Forget the session's user. */
  signOut(): Promise<null>;
  /** Forget the session's user (revoke the grant on your server). */
  revokeAccess(): Promise<null>;
  /** Whether someone signed in this session. */
  hasPreviousSignIn(): boolean;
  /** The session's user, or null. */
  getCurrentUser(): User | null;
  /** Nothing to clear (there is no access token). */
  clearCachedAccessToken(tokenString: string): Promise<null>;
  /** The session's id token (and an empty access token). */
  getTokens(): Promise<GetTokensResponse>;
} = {
  configure(options = {}) {
    config = { ...options };
  },
  hasPlayServices(_options?: HasPlayServicesParams) {
    return Promise.resolve(true);
  },
  signIn(_options?: SignInParams) {
    return run(config?.scopes);
  },
  async addScopes(options: AddScopesParams) {
    if (!current) return null;
    return await run([...new Set([...(current.scopes ?? []), ...options.scopes])]);
  },
  signInSilently() {
    return Promise.resolve(
      current ? { type: "success", data: current } : { type: "noSavedCredentialFound", data: null },
    );
  },
  signOut() {
    current = null;
    return Promise.resolve(null);
  },
  revokeAccess() {
    current = null;
    return Promise.resolve(null);
  },
  hasPreviousSignIn() {
    return current !== null;
  },
  getCurrentUser() {
    return current;
  },
  clearCachedAccessToken(tokenString: string) {
    if (!tokenString || typeof tokenString !== "string") {
      return Promise.reject(new Error("clearCachedAccessToken: expects a token string"));
    }
    return Promise.resolve(null);
  },
  getTokens() {
    if (!current?.idToken) {
      return Promise.reject(
        codeError(statusCodes.SIGN_IN_REQUIRED, "getTokens requires a user to be signed in"),
      );
    }
    return Promise.resolve({ idToken: current.idToken, accessToken: "" });
  },
};

/**
 * Whether `error` carries a `code` (a {@linkcode statusCodes} value).
 *
 * @param error Anything thrown.
 * @returns Whether it does.
 */
export function isErrorWithCode(error: unknown): error is NativeModuleError {
  return typeof error === "object" && error !== null && "code" in error;
}

/**
 * Whether a response is a success.
 *
 * @param response A sign-in response.
 * @returns Whether it is.
 */
export function isSuccessResponse(response: { type: string }): response is SignInSuccessResponse {
  return response.type === "success";
}

/**
 * Whether a response is a cancellation.
 *
 * @param response A sign-in response.
 * @returns Whether it is.
 */
export function isCancelledResponse(response: { type: string }): response is CancelledResponse {
  return response.type === "cancelled";
}

/**
 * Whether a response says nobody was signed in.
 *
 * @param response A sign-in response.
 * @returns Whether it does.
 */
export function isNoSavedCredentialFoundResponse(
  response: { type: string },
): response is NoSavedCredentialFound {
  return response.type === "noSavedCredentialFound";
}

/** `GoogleSigninButton` props. */
export interface GoogleSigninButtonProps {
  /** Called on press. */
  onPress?: () => void;
  /** A {@linkcode GoogleSigninButton}`.Size` value. */
  size?: number;
  /** A {@linkcode GoogleSigninButton}`.Color` value (default light). */
  color?: "dark" | "light";
  /** Disabled. */
  disabled?: boolean;
  /** The style. */
  style?: unknown;
  /** Any other prop. */
  [prop: string]: unknown;
}

/** {@linkcode GoogleSigninButton}: the component with its constants. */
export interface GoogleSigninButtonComponent {
  /** Render the button. */
  (props: GoogleSigninButtonProps): VNode;
  /** The sizes. */
  readonly Size: { readonly Icon: 2; readonly Standard: 0; readonly Wide: 1 };
  /** The colors. */
  readonly Color: { readonly Dark: "dark"; readonly Light: "light" };
}

/** The button sizes. */
const SIZES = { Icon: 2, Standard: 0, Wide: 1 } as const;
/** The button colors. */
const COLORS = { Dark: "dark", Light: "light" } as const;

/** The button's box per size. */
const BOXES: Readonly<Record<number, Record<string, number>>> = {
  0: { width: 212, height: 48 },
  1: { width: 312, height: 48 },
  2: { width: 48, height: 48 },
};

/**
 * Google's sign-in button, drawn as a styled `<button>` ("Sign in with Google", or a "G" for
 * the icon size).
 *
 * @param props The handler, size, color and style.
 * @returns The button.
 */
function SigninButton(props: GoogleSigninButtonProps): VNode {
  const { onPress, size = SIZES.Standard, color = "light", disabled, style, ...rest } = props;
  const dark = color === "dark";
  const base = {
    ...BOXES[size] ?? BOXES[0],
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    border: dark ? "none" : "1px solid #dadce0",
    backgroundColor: dark ? "#4285f4" : "#fff",
    color: dark ? "#fff" : "#3c4043",
    fontSize: 14,
    fontWeight: 500,
    opacity: disabled ? 0.6 : 1,
  };
  const label = size === SIZES.Icon ? "G" : "Sign in with Google";
  const flat = RN.StyleSheet ? { ...RN.StyleSheet.flatten(style) } : viewStyle(style);
  return h("button", {
    type: "button",
    "aria-label": "Sign in with Google",
    ...rest,
    disabled,
    onClick: () => onPress?.(),
    style: { ...base, ...(flat as Record<string, unknown>) },
  }, label);
}

/** Google's sign-in button, with its `Size` and `Color` constants. */
export const GoogleSigninButton: GoogleSigninButtonComponent = /* @__PURE__ */ Object.assign(
  SigninButton,
  { Size: SIZES, Color: COLORS },
);

/** Forget the configuration and the session's user (for tests). */
export function resetGoogleSigninForTesting(): void {
  config = null;
  current = null;
  busy = false;
}
