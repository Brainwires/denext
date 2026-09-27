/**
 * `expo-auth-session/providers/facebook` for denext: Facebook Login over
 * `denext/expo/auth-session` (so `denext/mobile`'s {@linkcode openAuthSession}).
 *
 * {@linkcode useAuthRequest} returns `[request, response, promptAsync]`, as Expo's does. The
 * client id is picked for the platform the page runs on (`iosClientId` / `androidClientId`
 * inside the Capacitor shell, `webClientId` on the web, else `clientId`); the request is
 * implicit (`response_type=token`) by default, so `response.authentication.accessToken` is
 * the Facebook access token. Inside the shell the redirect defaults to
 * `fb<clientId>://authorize`; register that scheme with `denext mobile add auth-session
 * --scheme fb<clientId>`.
 *
 * @example
 * ```ts
 * import * as Facebook from "denext/expo/auth-session/providers/facebook";
 *
 * const [request, response, promptAsync] = Facebook.useAuthRequest({ clientId: "1234" });
 * ```
 *
 * @module
 */

import { useMemo } from "../runtime/hooks.ts";
import {
  AuthRequest,
  type AuthRequestConfig,
  type AuthRequestPromptOptions,
  type AuthSessionRedirectUriOptions,
  type AuthSessionResult,
  type DiscoveryDocument,
  makeRedirectUri,
  ResponseType,
  useAuthRequestResult,
  useLoadedAuthRequest,
} from "./auth-session.ts";
import { applyRequiredScopes, providerClientId, randomHex } from "./internal/auth-providers.ts";

/** Facebook's OAuth endpoints. */
export const discovery: DiscoveryDocument = {
  authorizationEndpoint: "https://www.facebook.com/v6.0/dialog/oauth",
  tokenEndpoint: "https://graph.facebook.com/v6.0/oauth/access_token",
};

/** The scopes every Facebook request asks for (as Expo's preset: Firebase needs them). */
const MINIMUM_SCOPES = ["public_profile", "email"];

/** The web popup's size. */
const WINDOW_FEATURES = { width: 700, height: 600 };

/** A Facebook request's configuration. */
export type FacebookAuthRequestConfig = AuthRequestConfig & {
  /** The login dialog's locale (`it_IT`). */
  language?: string;
  /** The web client (app) id. */
  webClientId?: string;
  /** The iOS client (app) id. */
  iosClientId?: string;
  /** The Android client (app) id. */
  androidClientId?: string;
};

/** A Facebook authorization request: its scopes, popup display and nonce. */
class FacebookAuthRequest extends AuthRequest {
  /** The nonce sent as `auth_nonce`. */
  nonce?: string;

  constructor(
    { language, extraParams = {}, clientSecret, ...config }: FacebookAuthRequestConfig,
  ) {
    const params: Record<string, string> = { display: "popup", ...extraParams };
    if (language) params.locale = language;
    const responseType = config.responseType ?? ResponseType.Token;
    super({
      ...config,
      responseType,
      // Facebook rejects a client secret in the code flow.
      clientSecret: responseType !== ResponseType.Code ? clientSecret : undefined,
      scopes: applyRequiredScopes(config.scopes, MINIMUM_SCOPES),
      extraParams: params,
    });
  }

  /** The configuration, with an `auth_nonce`. */
  override async getAuthRequestConfigAsync(): Promise<AuthRequestConfig> {
    const { extraParams = {}, ...config } = await super.getAuthRequestConfigAsync();
    if (!extraParams.nonce) {
      this.nonce ??= randomHex(16);
      extraParams.auth_nonce = this.nonce;
    }
    return { ...config, extraParams };
  }
}

/**
 * A Facebook authorization request, its latest response, and the prompt.
 *
 * @param config The client ids, scopes and options.
 * @param redirectUriOptions Options for the default redirect URI.
 * @returns `[request, response, promptAsync]`.
 */
export function useAuthRequest(
  config: Partial<FacebookAuthRequestConfig> = {},
  redirectUriOptions: Partial<AuthSessionRedirectUriOptions> = {},
): [
  AuthRequest | null,
  AuthSessionResult | null,
  (options?: AuthRequestPromptOptions) => Promise<AuthSessionResult>,
] {
  const clientId = useMemo(
    () => providerClientId(config, "Facebook"),
    [config.iosClientId, config.androidClientId, config.webClientId, config.clientId],
  );
  const redirectUri = useMemo(
    () =>
      config.redirectUri ??
        makeRedirectUri({ native: `fb${clientId}://authorize`, ...redirectUriOptions }),
    [clientId, config.redirectUri, JSON.stringify(redirectUriOptions)],
  );
  const request = useLoadedAuthRequest(
    { ...config, clientId, redirectUri } as FacebookAuthRequestConfig,
    discovery,
    FacebookAuthRequest as unknown as new (c: AuthRequestConfig) => AuthRequest,
  );
  const [result, promptAsync] = useAuthRequestResult(request, discovery, {
    windowFeatures: WINDOW_FEATURES,
  });
  return [request, result, promptAsync];
}
