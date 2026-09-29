/**
 * `expo-auth-session/providers/google` for denext: Google sign-in over
 * `denext/expo/auth-session` (so `denext/mobile`'s {@linkcode openAuthSession}: an
 * ASWebAuthenticationSession on iOS, a Custom Tab on Android, a popup on the web) with PKCE.
 *
 * The same hooks as Expo's: {@linkcode useAuthRequest} and {@linkcode useIdTokenAuthRequest}
 * return `[request, response, promptAsync]`.
 *
 * - The client id is picked for the platform the page runs on: `iosClientId` /
 *   `androidClientId` inside the Capacitor shell, `webClientId` on the web (else `clientId`).
 * - Inside the shell the request uses the authorization-code flow with PKCE, and the code is
 *   exchanged for tokens automatically (`response.authentication`, and `id_token` /
 *   `access_token` in `response.params`). The redirect defaults to
 *   `<applicationId>:/oauthredirect`; register that scheme with `denext mobile add
 *   auth-session --scheme <applicationId>` (or pass `redirectUri`, for example Google's
 *   reversed iOS client id).
 * - On the web it asks for a token (`useAuthRequest`) or an ID token
 *   (`useIdTokenAuthRequest`) directly, as Expo does.
 *
 * Expo marks these presets deprecated in favour of native Google Sign-In; denext's native
 * equivalent is `signInWithGoogle` in `denext/mobile` (`denext mobile add social-login`).
 *
 * @example
 * ```ts
 * import * as Google from "denext/expo/auth-session/providers/google";
 *
 * const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
 *   webClientId: "…apps.googleusercontent.com",
 *   iosClientId: "…apps.googleusercontent.com",
 * });
 * // response?.type === "success" → response.params.id_token
 * ```
 *
 * @module
 */

import { useEffect, useMemo, useState } from "../runtime/hooks.ts";
import { applicationId } from "./application.ts";
import {
  AccessTokenRequest,
  AuthError,
  AuthRequest,
  type AuthRequestConfig,
  type AuthRequestPromptOptions,
  type AuthSessionRedirectUriOptions,
  type AuthSessionResult,
  type DiscoveryDocument,
  makeRedirectUri,
  Prompt,
  ResponseType,
  useAuthRequestResult,
  useLoadedAuthRequest,
} from "./auth-session.ts";
import {
  applyRequiredScopes,
  isWebAuth,
  providerClientId,
  randomHex,
} from "./internal/auth-providers.ts";

/** Google's OAuth / OpenID endpoints. */
export const discovery: DiscoveryDocument = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
  userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
};

/** The scopes every Google request asks for (profile and email, as Expo's preset). */
const MINIMUM_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
];

/** The web popup's size. */
const WINDOW_FEATURES = { width: 515, height: 680 };

/** A Google request's configuration. */
export type GoogleAuthRequestConfig = AuthRequestConfig & {
  /** The sign-in UI's language (`it`, `pt-PT`). */
  language?: string;
  /** The email address to preselect. */
  loginHint?: string;
  /** Let the user switch accounts (`prompt=select_account`). */
  selectAccount?: boolean;
  /** The web client id. */
  webClientId?: string;
  /** The iOS client id (the shell on iOS). */
  iosClientId?: string;
  /** The Android client id (the shell on Android). */
  androidClientId?: string;
  /** Exchange a returned code for tokens (default: yes, in the shell with the code flow). */
  shouldAutoExchangeCode?: boolean;
};

/** A Google authorization request: Google's parameters, scopes and ID-token nonce. */
class GoogleAuthRequest extends AuthRequest {
  /** The nonce sent with an ID-token request. */
  nonce?: string;

  constructor(
    { language, loginHint, selectAccount, extraParams = {}, clientSecret, ...config }:
      GoogleAuthRequestConfig,
  ) {
    const params: Record<string, string> = { ...extraParams };
    if (language) params.hl = language;
    if (loginHint) params.login_hint = loginHint;
    if (selectAccount) params.prompt = Prompt.SelectAccount;
    const implicit = config.responseType === ResponseType.Token ||
      config.responseType === ResponseType.IdToken;
    super({
      ...config,
      // Google rejects a client secret in the code flow, and PKCE in the implicit one.
      clientSecret: config.responseType && config.responseType !== ResponseType.Code
        ? clientSecret
        : undefined,
      usePKCE: implicit ? false : config.usePKCE,
      scopes: applyRequiredScopes(config.scopes, MINIMUM_SCOPES),
      extraParams: params,
    });
  }

  /** The configuration, with a nonce for an ID-token request. */
  override async getAuthRequestConfigAsync(): Promise<AuthRequestConfig> {
    const { extraParams = {}, ...config } = await super.getAuthRequestConfigAsync();
    if (config.responseType === ResponseType.IdToken && !extraParams.nonce) {
      this.nonce ??= randomHex(16);
      extraParams.nonce = this.nonce;
    }
    return { ...config, extraParams };
  }
}

/** What both hooks return: the loaded request, the latest response, and the prompt. */
export type GoogleAuthRequestHook = [
  AuthRequest | null,
  AuthSessionResult | null,
  (options?: AuthRequestPromptOptions) => Promise<AuthSessionResult>,
];

/**
 * A Google authorization request, its latest response, and the prompt. Inside the shell the
 * code is exchanged for tokens once the prompt succeeds (see the module docs).
 *
 * @param config The client ids, scopes and Google options.
 * @param redirectUriOptions Options for the default redirect URI.
 * @returns `[request, response, promptAsync]`.
 */
export function useAuthRequest(
  config: Partial<GoogleAuthRequestConfig> = {},
  redirectUriOptions: Partial<AuthSessionRedirectUriOptions> = {},
): GoogleAuthRequestHook {
  const clientId = useMemo(
    () => providerClientId(config, "Google"),
    [config.iosClientId, config.androidClientId, config.webClientId, config.clientId],
  );
  const responseType = useMemo(() => {
    if (config.responseType !== undefined) return config.responseType;
    return config.clientSecret || !isWebAuth() ? ResponseType.Code : ResponseType.Token;
  }, [config.responseType, config.clientSecret]);
  const redirectUri = useMemo(
    () =>
      config.redirectUri ??
        makeRedirectUri({ native: `${applicationId}:/oauthredirect`, ...redirectUriOptions }),
    [config.redirectUri, JSON.stringify(redirectUriOptions)],
  );
  const request = useLoadedAuthRequest(
    { ...config, responseType, clientId, redirectUri } as GoogleAuthRequestConfig,
    discovery,
    GoogleAuthRequest as unknown as new (c: AuthRequestConfig) => AuthRequest,
  );
  const [result, promptAsync] = useAuthRequestResult(request, discovery, {
    windowFeatures: WINDOW_FEATURES,
  });
  const [fullResult, setFullResult] = useState<AuthSessionResult | null>(null);
  const exchange = config.shouldAutoExchangeCode ??
    (result?.type === "success" && !!result.params.code && !result.authentication);
  useEffect(() => {
    let mounted = true;
    if (!exchange || result?.type !== "success") {
      setFullResult(result);
      return;
    }
    new AccessTokenRequest({
      clientId,
      clientSecret: config.clientSecret,
      redirectUri,
      scopes: config.scopes,
      code: result.params.code ?? "",
      extraParams: { code_verifier: request?.codeVerifier ?? "" },
    }).performAsync(discovery).then((authentication) => {
      if (!mounted) return;
      setFullResult({
        ...result,
        params: {
          id_token: authentication.idToken ?? "",
          access_token: authentication.accessToken,
          ...result.params,
        },
        authentication,
      });
    }, (error: Error & { code?: string; description?: string }) => {
      if (!mounted) return;
      const failure = new AuthError({
        error: error.code ?? "token_exchange_failed",
        error_description: error.description ?? error.message,
      });
      setFullResult({ ...result, type: "error", errorCode: failure.code, error: failure });
    });
    return () => void (mounted = false);
  }, [clientId, redirectUri, exchange, config.clientSecret, request?.codeVerifier, result]);
  return [request, fullResult, promptAsync];
}

/**
 * A Google request for an ID token (for Firebase and your own backend): on the web it asks
 * for `id_token` directly; in the shell it runs the code flow and the exchange returns it.
 * Read it from `response.params.id_token`.
 *
 * @param config The client ids, scopes and Google options.
 * @param redirectUriOptions Options for the default redirect URI.
 * @returns `[request, response, promptAsync]`.
 */
export function useIdTokenAuthRequest(
  config: Partial<GoogleAuthRequestConfig>,
  redirectUriOptions: Partial<AuthSessionRedirectUriOptions> = {},
): GoogleAuthRequestHook {
  return useAuthRequest(
    {
      ...config,
      responseType: !config.clientSecret && isWebAuth() ? ResponseType.IdToken : undefined,
    },
    { ...redirectUriOptions },
  );
}
