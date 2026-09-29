/**
 * `expo-apple-authentication` for denext: "Sign in with Apple" over `denext/mobile`'s
 * {@linkcode signInWithApple} (`@capgo/capacitor-social-login` in the Capacitor shell, `denext
 * mobile add social-login`). iOS only, as in Expo: `isAvailableAsync` is `false` elsewhere and
 * `signInAsync` rejects.
 *
 * The credential carries the `identityToken`, the `authorizationCode`, the `user` id and, on
 * the first sign-in only, the name and email. Pass `nonce` (from your server) to bind the token;
 * denext sends Apple its SHA-256, as Expo apps usually do by hand, and a denext server
 * (`POST /auth/native/apple`) accepts either form. `state` is echoed back. Not provided by the
 * plugin: `refreshAsync`, `signOutAsync` and `getCredentialStateAsync` (reject), and revocation
 * events (`addRevokeListener` never fires). `AppleAuthenticationButton` is a styled button
 * following Apple's black / white / outline styles.
 *
 * @example
 * ```ts
 * import * as AppleAuthentication from "denext/expo/apple-authentication";
 *
 * const credential = await AppleAuthentication.signInAsync({
 *   requestedScopes: [
 *     AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
 *     AppleAuthentication.AppleAuthenticationScope.EMAIL,
 *   ],
 *   nonce,
 * });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { signInWithApple } from "../mobile/social-login.ts";
import { type Subscription, subscription } from "./internal/common.ts";

export type { Subscription };

/** What the sign-in asks for. */
export enum AppleAuthenticationScope {
  /** The user's name. */
  FULL_NAME = 0,
  /** The user's email. */
  EMAIL = 1,
}

/** The operation a request performs. */
export enum AppleAuthenticationOperation {
  /** Let the system pick. */
  IMPLICIT = 0,
  /** Sign in. */
  LOGIN = 1,
  /** Refresh. */
  REFRESH = 2,
  /** Sign out. */
  LOGOUT = 3,
}

/** Whether a user's Apple ID is still authorized for the app. */
export enum AppleAuthenticationCredentialState {
  /** Revoked. */
  REVOKED = 0,
  /** Authorized. */
  AUTHORIZED = 1,
  /** Not found. */
  NOT_FOUND = 2,
  /** Transferred. */
  TRANSFERRED = 3,
}

/** Apple's guess whether the user is a real person. */
export enum AppleAuthenticationUserDetectionStatus {
  /** Not supported. */
  UNSUPPORTED = 0,
  /** Unknown. */
  UNKNOWN = 1,
  /** Likely real. */
  LIKELY_REAL = 2,
}

/** The button's label. */
export enum AppleAuthenticationButtonType {
  /** "Sign in with Apple". */
  SIGN_IN = 0,
  /** "Continue with Apple". */
  CONTINUE = 1,
  /** "Sign up with Apple". */
  SIGN_UP = 2,
}

/** The button's look. */
export enum AppleAuthenticationButtonStyle {
  /** White. */
  WHITE = 0,
  /** White with a black outline. */
  WHITE_OUTLINE = 1,
  /** Black. */
  BLACK = 2,
}

/** Options for {@linkcode signInAsync}. */
export type AppleAuthenticationSignInOptions = {
  /** The scopes (the name and email are always asked for here). */
  requestedScopes?: AppleAuthenticationScope[];
  /** An opaque value echoed back in the credential. */
  state?: string;
  /** A single-use nonce from your server. */
  nonce?: string;
};

/** Options for {@linkcode refreshAsync}. */
export type AppleAuthenticationRefreshOptions = {
  /** The user id. */
  user: string;
  /** The scopes. */
  requestedScopes?: AppleAuthenticationScope[];
  /** An opaque value echoed back. */
  state?: string;
};

/** Options for {@linkcode signOutAsync}. */
export type AppleAuthenticationSignOutOptions = {
  /** The user id. */
  user: string;
  /** An opaque value echoed back. */
  state?: string;
};

/** The parts of a name. */
export type AppleAuthenticationFullName = {
  /** The prefix. */
  namePrefix: string | null;
  /** The given name. */
  givenName: string | null;
  /** The middle name. */
  middleName: string | null;
  /** The family name. */
  familyName: string | null;
  /** The suffix. */
  nameSuffix: string | null;
  /** The nickname. */
  nickname: string | null;
};

/** How {@linkcode formatFullName} joins the parts. */
export type AppleAuthenticationFullNameFormatStyle =
  | "default"
  | "short"
  | "medium"
  | "long"
  | "abbreviated";

/** A signed-in user's credential. */
export type AppleAuthenticationCredential = {
  /** Apple's stable user id for this app. */
  user: string;
  /** The `state` passed in, or null. */
  state: string | null;
  /** The name (first sign-in only). */
  fullName: AppleAuthenticationFullName | null;
  /** The email (first sign-in only; possibly a private relay address). */
  email: string | null;
  /** Apple's real-user guess (not reported here: `UNKNOWN`). */
  realUserStatus: AppleAuthenticationUserDetectionStatus;
  /** The identity token (a JWT) for your server. */
  identityToken: string | null;
  /** The authorization code, for your server to exchange or revoke. */
  authorizationCode: string | null;
};

/** `AppleAuthenticationButton` props. */
export type AppleAuthenticationButtonProps = {
  /** Called on a tap: start {@linkcode signInAsync} from it. */
  onPress: () => void;
  /** The label. */
  buttonType: AppleAuthenticationButtonType;
  /** The look. */
  buttonStyle: AppleAuthenticationButtonStyle;
  /** The corner radius in px (default 6). */
  cornerRadius?: number;
  /** The style (its size, margins; not the background or radius). */
  style?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
};

/**
 * Whether Sign in with Apple can run: in the iOS shell with the social-login plugin.
 *
 * @returns `true` there.
 */
export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(
    nativePlatform() === "ios" &&
      nativePlugin<{ initialize: unknown; login: unknown }>("SocialLogin", [
          "initialize",
          "login",
        ]) !==
        undefined,
  );
}

/** A name string split into Expo's parts (the plugin reports the given and family names joined). */
function nameParts(name: string | undefined): AppleAuthenticationFullName | null {
  if (!name) return null;
  const [given, ...rest] = name.split(" ");
  return {
    namePrefix: null,
    givenName: given || null,
    middleName: null,
    familyName: rest.join(" ") || null,
    nameSuffix: null,
    nickname: null,
  };
}

/**
 * Show the Sign in with Apple sheet.
 *
 * @param options The nonce and the state to echo back.
 * @returns The credential.
 */
export async function signInAsync(
  options: AppleAuthenticationSignInOptions = {},
): Promise<AppleAuthenticationCredential> {
  const result = await signInWithApple({ nonce: options.nonce });
  return {
    user: result.user ?? "",
    state: options.state ?? null,
    fullName: nameParts(result.name),
    email: result.email ?? null,
    realUserStatus: AppleAuthenticationUserDetectionStatus.UNKNOWN,
    identityToken: result.idToken,
    authorizationCode: result.authorizationCode ?? null,
  };
}

/** The rejection for an operation the plugin does not offer. */
function notProvided(name: string): Promise<never> {
  return Promise.reject(
    new Error(
      `${name} is not supported by denext's Sign in with Apple (the social-login plugin signs ` +
        "in only). Sign in again with signInAsync, and check the account on your server.",
    ),
  );
}

/**
 * Refresh a credential: not provided (the plugin signs in only).
 *
 * @param _options The user.
 * @returns A promise that rejects.
 */
export function refreshAsync(
  _options: AppleAuthenticationRefreshOptions,
): Promise<AppleAuthenticationCredential> {
  return notProvided("refreshAsync");
}

/**
 * Sign out: not provided (Apple has no sign-out; forget the session on your side).
 *
 * @param _options The user.
 * @returns A promise that rejects.
 */
export function signOutAsync(
  _options: AppleAuthenticationSignOutOptions,
): Promise<AppleAuthenticationCredential> {
  return notProvided("signOutAsync");
}

/**
 * A user's credential state: not provided (check it server-side with Apple's REST API).
 *
 * @param _user The user id.
 * @returns A promise that rejects.
 */
export function getCredentialStateAsync(
  _user: string,
): Promise<AppleAuthenticationCredentialState> {
  return notProvided("getCredentialStateAsync");
}

/**
 * A name's parts joined for display (`short` and `abbreviated` give the given name alone).
 *
 * @param fullName The parts.
 * @param formatStyle How to join them.
 * @returns The name.
 */
export function formatFullName(
  fullName: AppleAuthenticationFullName,
  formatStyle: AppleAuthenticationFullNameFormatStyle = "default",
): string {
  if (formatStyle === "short" || formatStyle === "abbreviated") return fullName.givenName ?? "";
  const parts = formatStyle === "long"
    ? [
      fullName.namePrefix,
      fullName.givenName,
      fullName.middleName,
      fullName.familyName,
      fullName.nameSuffix,
    ]
    : [fullName.givenName, fullName.middleName, fullName.familyName];
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" ");
}

/**
 * Listen for the user revoking the app's access: never reported here.
 *
 * @param _listener Never called.
 * @returns A subscription to remove.
 */
export function addRevokeListener(_listener: () => void): Subscription {
  return subscription(() => {});
}

/** Each button type's label. */
const LABELS: Readonly<Record<number, string>> = {
  [AppleAuthenticationButtonType.SIGN_IN]: "Sign in with Apple",
  [AppleAuthenticationButtonType.CONTINUE]: "Continue with Apple",
  [AppleAuthenticationButtonType.SIGN_UP]: "Sign up with Apple",
};

/** Each button style's colours: [background, text, border]. */
const COLORS: Readonly<Record<number, readonly [string, string, string]>> = {
  [AppleAuthenticationButtonStyle.WHITE]: ["#fff", "#000", "#fff"],
  [AppleAuthenticationButtonStyle.WHITE_OUTLINE]: ["#fff", "#000", "#000"],
  [AppleAuthenticationButtonStyle.BLACK]: ["#000", "#fff", "#000"],
};

/**
 * A "Sign in with Apple" button in Apple's styles: a `<button>` with the Apple logo and the
 * label for `buttonType`. Like Expo's, it renders nothing where Sign in with Apple cannot run
 * (anywhere but the iOS shell); start {@linkcode signInAsync} from `onPress`.
 *
 * @param props The press handler, label, look and style.
 * @returns The button, or null off iOS.
 */
export function AppleAuthenticationButton(props: AppleAuthenticationButtonProps): VNode | null {
  const { onPress, buttonType, buttonStyle, cornerRadius = 6, style, ...rest } = props;
  if (nativePlatform() !== "ios") return null;
  const [background, color, border] = COLORS[buttonStyle] ?? COLORS[2];
  const flat = Array.isArray(style)
    ? Object.assign({}, ...style.filter((s) => s && typeof s === "object"))
    : (typeof style === "object" && style !== null ? style : {});
  return h(
    "button",
    {
      ...rest,
      type: "button",
      "aria-label": LABELS[buttonType] ?? LABELS[0],
      onClick: () => onPress(),
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: 44,
        padding: "0 16px",
        font: "600 17px -apple-system, system-ui, sans-serif",
        cursor: "pointer",
        ...flat,
        backgroundColor: background,
        color,
        border: `1px solid ${border}`,
        borderRadius: cornerRadius,
      },
    },
    h("span", { "aria-hidden": "true", style: { fontSize: 19 } }, ""),
    LABELS[buttonType] ?? LABELS[0],
  );
}
