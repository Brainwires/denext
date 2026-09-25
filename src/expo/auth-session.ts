/**
 * `expo-auth-session` for denext: the OAuth 2 / OpenID Connect request flow over
 * `denext/expo/web-browser`'s `openAuthSessionAsync` (which runs `denext/mobile`'s
 * {@linkcode openAuthSession}).
 *
 * Provided: `makeRedirectUri`, `AuthRequest` (with PKCE S256 and `state`), `useAuthRequest`,
 * discovery (`fetchDiscoveryAsync`, `resolveDiscoveryAsync`, `useAutoDiscovery`), the token
 * calls (`exchangeCodeAsync`, `refreshAsync`, `revokeAsync`, `fetchUserInfoAsync`) and
 * `TokenResponse`. The provider presets (`expo-auth-session/providers/*`), the request
 * classes behind the token calls, and `loadAsync`'s proxy options are not (see the manifest).
 *
 * @example
 * ```ts
 * import { makeRedirectUri, useAuthRequest } from "denext/expo/auth-session";
 *
 * const [request, result, promptAsync] = useAuthRequest(
 *   { clientId: "app", redirectUri: makeRedirectUri({ scheme: "myapp" }), scopes: ["openid"] },
 *   { authorizationEndpoint: "https://auth.example.com/authorize" },
 * );
 * ```
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useState } from "../runtime/hooks.ts";
import { bytesToBase64 } from "../mobile/base64.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { createURL } from "./linking.ts";
import {
  type AuthSessionOpenOptions,
  dismissAuthSession,
  openAuthSessionAsync,
} from "./web-browser.ts";

/** The PKCE challenge method. */
export enum CodeChallengeMethod {
  /** SHA-256 of the verifier (the default). */
  S256 = "S256",
  /** The verifier itself. */
  Plain = "plain",
}

/** The OAuth response type. */
export enum ResponseType {
  /** An authorization code (the default). */
  Code = "code",
  /** An access token (implicit flow). */
  Token = "token",
  /** An ID token. */
  IdToken = "id_token",
}

/** The OpenID Connect `prompt` values. */
export enum Prompt {
  /** No UI. */
  None = "none",
  /** Ask to sign in again. */
  Login = "login",
  /** Ask for consent. */
  Consent = "consent",
  /** Ask which account. */
  SelectAccount = "select_account",
}

/** The token endpoint grant types. */
export enum GrantType {
  /** Exchange an authorization code. */
  AuthorizationCode = "authorization_code",
  /** Implicit. */
  Implicit = "implicit",
  /** Refresh a token. */
  RefreshToken = "refresh_token",
  /** Client credentials. */
  ClientCredentials = "client_credentials",
}

/** Which token a revocation names. */
export enum TokenTypeHint {
  /** An access token. */
  AccessToken = "access_token",
  /** A refresh token. */
  RefreshToken = "refresh_token",
}

/** An OAuth / OIDC provider's endpoints. */
export interface DiscoveryDocument {
  /** The authorization endpoint. */
  authorizationEndpoint?: string;
  /** The token endpoint. */
  tokenEndpoint?: string;
  /** The revocation endpoint. */
  revocationEndpoint?: string;
  /** The user-info endpoint. */
  userInfoEndpoint?: string;
  /** The end-session endpoint. */
  endSessionEndpoint?: string;
  /** The registration endpoint. */
  registrationEndpoint?: string;
  /** The raw OpenID configuration. */
  discoveryDocument?: Record<string, unknown>;
}

/** An issuer URL. */
export type Issuer = string;

/** An issuer URL, or its discovery document. */
export type IssuerOrDiscovery = Issuer | DiscoveryDocument;

/** An authorization request's configuration. */
export interface AuthRequestConfig {
  /** The response type (default `code`). */
  responseType?: ResponseType | string;
  /** The client id. */
  clientId: string;
  /** Where the provider redirects back ({@linkcode makeRedirectUri}). */
  redirectUri: string;
  /** The scopes. */
  scopes?: string[];
  /** A client secret (avoid in a public client). */
  clientSecret?: string;
  /** The PKCE method (default S256). */
  codeChallengeMethod?: CodeChallengeMethod;
  /** A precomputed PKCE challenge. */
  codeChallenge?: string;
  /** The `prompt` parameter. */
  prompt?: Prompt | Prompt[];
  /** The `state` (default: random). */
  state?: string;
  /** More query parameters. */
  extraParams?: Record<string, string>;
  /** Use PKCE (default `true`). */
  usePKCE?: boolean;
}

/** Options for {@linkcode AuthRequest.promptAsync}. */
export type AuthRequestPromptOptions = Omit<AuthSessionOpenOptions, "windowFeatures"> & {
  /** A prebuilt authorization URL. */
  url?: string;
  /** Web popup window features (ignored). */
  windowFeatures?: Record<string, number | boolean | string>;
};

/** Options for {@linkcode makeRedirectUri}. */
export interface AuthSessionRedirectUriOptions {
  /** The path. */
  path?: string;
  /** The URL scheme (native). */
  scheme?: string;
  /** Query parameters. */
  queryParams?: Record<string, string | undefined>;
  /** Use `scheme:///path`. */
  isTripleSlashed?: boolean;
  /** On the web, use `localhost` instead of the page's host. */
  preferLocalhost?: boolean;
  /** The exact URI to use natively. */
  native?: string;
}

/** An error the provider returned. */
export class AuthError extends Error {
  /** The OAuth error code (`access_denied`, …). */
  readonly code: string;
  /** The provider's description. */
  readonly description?: string;
  /** The provider's error page. */
  readonly uri?: string;
  /** Every returned parameter. */
  readonly params: Record<string, string>;
  /** The returned `state`. */
  readonly state?: string;

  /**
   * Create it.
   *
   * @param params The error parameters (`error`, `error_description`, …).
   */
  constructor(params: Record<string, string>) {
    super(params.error_description ?? params.error ?? "Authorization failed");
    this.name = "AuthError";
    this.code = params.error ?? "unknown";
    this.description = params.error_description;
    this.uri = params.error_uri;
    this.params = params;
    this.state = params.state;
  }
}

/** What the prompt resolves with. */
export type AuthSessionResult =
  | { type: "cancel" | "dismiss" | "opened" | "locked" }
  | {
    type: "error" | "success";
    errorCode: string | null;
    error?: AuthError | null;
    params: Record<string, string>;
    authentication: TokenResponse | null;
    url: string;
  };

/** A token endpoint response. */
export interface TokenResponseConfig {
  /** The access token. */
  accessToken: string;
  /** The token type. */
  tokenType?: "bearer" | "mac";
  /** Lifetime in seconds. */
  expiresIn?: number;
  /** The refresh token. */
  refreshToken?: string;
  /** The granted scope. */
  scope?: string;
  /** The returned state. */
  state?: string;
  /** The ID token. */
  idToken?: string;
  /** When it was issued, in seconds since the epoch. */
  issuedAt?: number;
}

/** The current time in whole seconds. */
export function getCurrentTimeInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A set of tokens. */
export class TokenResponse implements TokenResponseConfig {
  /** The access token. */
  accessToken: string;
  /** The token type. */
  tokenType: "bearer" | "mac";
  /** Lifetime in seconds. */
  expiresIn?: number;
  /** The refresh token. */
  refreshToken?: string;
  /** The granted scope. */
  scope?: string;
  /** The returned state. */
  state?: string;
  /** The ID token. */
  idToken?: string;
  /** When it was issued, in seconds since the epoch. */
  issuedAt: number;

  /**
   * Create it.
   *
   * @param response The token fields.
   */
  constructor(response: TokenResponseConfig) {
    this.accessToken = response.accessToken;
    this.tokenType = response.tokenType ?? "bearer";
    this.expiresIn = response.expiresIn;
    this.refreshToken = response.refreshToken;
    this.scope = response.scope;
    this.state = response.state;
    this.idToken = response.idToken;
    this.issuedAt = response.issuedAt ?? getCurrentTimeInSeconds();
  }

  /** Whether a token is still valid `secondsMargin` from now (default 10 minutes). */
  static isTokenFresh(
    token: Pick<TokenResponse, "expiresIn" | "issuedAt">,
    secondsMargin = 60 * 10 * -1,
  ): boolean {
    if (!token) return false;
    if (token.expiresIn === undefined) return true;
    return getCurrentTimeInSeconds() < token.issuedAt + token.expiresIn + secondsMargin;
  }

  /** A response from snake_case query or JSON parameters. */
  static fromQueryParams(params: Record<string, unknown>): TokenResponse {
    const num = (v: unknown) => (v === undefined ? undefined : Number(v));
    return new TokenResponse({
      accessToken: String(params.access_token ?? ""),
      tokenType: params.token_type as "bearer" | undefined,
      expiresIn: num(params.expires_in),
      refreshToken: params.refresh_token as string | undefined,
      scope: params.scope as string | undefined,
      state: params.state as string | undefined,
      idToken: params.id_token as string | undefined,
      issuedAt: num(params.issued_at),
    });
  }

  /** The fields as a plain object. */
  getRequestConfig(): TokenResponseConfig {
    return { ...this };
  }

  /** Whether the token should be refreshed now. */
  shouldRefresh(): boolean {
    return !TokenResponse.isTokenFresh(this) && this.refreshToken !== undefined;
  }

  /** Refresh the token. */
  async refreshAsync(
    config: { clientId: string; clientSecret?: string; scopes?: string[] },
    discovery: Pick<DiscoveryDocument, "tokenEndpoint">,
  ): Promise<TokenResponse> {
    const next = await refreshAsync({ ...config, refreshToken: this.refreshToken }, discovery);
    next.refreshToken ??= this.refreshToken;
    return next;
  }
}

/** A random URL-safe string of `size` characters. */
function randomString(size: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), (b) => chars[b % chars.length])
    .join("");
}

/** The S256 PKCE challenge of `verifier`. */
async function s256(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64(new Uint8Array(hash)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The query and fragment parameters of `url`. */
function returnParams(url: string): Record<string, string> {
  const parsed = new URL(url);
  const params = Object.fromEntries(parsed.searchParams);
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  return { ...params, ...Object.fromEntries(hash) };
}

/** One authorization request: its URL, PKCE verifier and state. */
export class AuthRequest {
  /** The `state` sent (and expected back). */
  state: string;
  /** The authorization URL, once built. */
  url: string | null = null;
  /** The PKCE verifier. */
  codeVerifier?: string;
  /** The PKCE challenge. */
  codeChallenge?: string;
  /** The response type. */
  readonly responseType: ResponseType | string;
  /** The client id. */
  readonly clientId: string;
  /** Extra query parameters. */
  readonly extraParams: Record<string, string>;
  /** Whether PKCE is used. */
  readonly usePKCE?: boolean;
  /** The PKCE method. */
  readonly codeChallengeMethod: CodeChallengeMethod;
  /** The redirect URI. */
  readonly redirectUri: string;
  /** The scopes. */
  readonly scopes?: string[];
  /** The client secret. */
  readonly clientSecret?: string;
  /** The `prompt`. */
  readonly prompt?: Prompt | Prompt[];

  /**
   * Create it.
   *
   * @param request The request's configuration.
   */
  constructor(request: AuthRequestConfig) {
    this.responseType = request.responseType ?? ResponseType.Code;
    this.clientId = request.clientId;
    this.redirectUri = request.redirectUri;
    this.scopes = request.scopes;
    this.clientSecret = request.clientSecret;
    this.prompt = request.prompt;
    this.state = request.state ?? randomString(10);
    this.extraParams = request.extraParams ?? {};
    this.codeChallengeMethod = request.codeChallengeMethod ?? CodeChallengeMethod.S256;
    this.usePKCE = request.usePKCE ?? true;
    this.codeChallenge = request.codeChallenge;
  }

  /** The request's configuration, PKCE included. */
  async getAuthRequestConfigAsync(): Promise<AuthRequestConfig> {
    if (this.usePKCE) await this.ensureCodeIsSetupAsync();
    return {
      responseType: this.responseType,
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      scopes: this.scopes,
      clientSecret: this.clientSecret,
      codeChallenge: this.codeChallenge,
      codeChallengeMethod: this.codeChallengeMethod,
      prompt: this.prompt,
      state: this.state,
      extraParams: this.extraParams,
      usePKCE: this.usePKCE,
    };
  }

  /** Build the authorization URL for `discovery`. */
  async makeAuthUrlAsync(
    discovery: Pick<DiscoveryDocument, "authorizationEndpoint">,
  ): Promise<string> {
    if (!discovery.authorizationEndpoint) throw new Error("No authorizationEndpoint");
    const config = await this.getAuthRequestConfigAsync();
    const url = new URL(discovery.authorizationEndpoint);
    const set = (key: string, value: string | undefined) =>
      value && url.searchParams.set(key, value);
    set("client_id", config.clientId);
    set("redirect_uri", config.redirectUri);
    set("response_type", String(config.responseType));
    set("state", config.state);
    set("scope", config.scopes?.join(" "));
    set("prompt", [config.prompt ?? []].flat().join(" "));
    if (config.usePKCE) {
      set("code_challenge", config.codeChallenge);
      set("code_challenge_method", config.codeChallengeMethod);
    }
    for (const [key, value] of Object.entries(config.extraParams ?? {})) set(key, value);
    this.url = url.href;
    return this.url;
  }

  /** Open the authorization page and resolve with its result. */
  async promptAsync(
    discovery: Pick<DiscoveryDocument, "authorizationEndpoint">,
    { url, ...options }: AuthRequestPromptOptions = {},
  ): Promise<AuthSessionResult> {
    const target = url ?? await this.makeAuthUrlAsync(discovery);
    const result = await openAuthSessionAsync(target, this.redirectUri, options);
    if (result.type !== "success") return { type: result.type };
    return this.parseReturnUrl((result as { url: string }).url);
  }

  /** Read a redirect URL: its parameters, an error, and (implicit flow) the tokens. */
  parseReturnUrl(url: string): AuthSessionResult {
    const params = returnParams(url);
    const base = { params, url, authentication: null };
    if (params.state !== this.state) {
      const error = new AuthError({
        error: "state_mismatch",
        error_description: "The returned state does not match the request's state",
      });
      return { ...base, type: "error", errorCode: error.code, error };
    }
    if (params.error) {
      const error = new AuthError(params);
      return { ...base, type: "error", errorCode: error.code, error };
    }
    const authentication = params.access_token ? TokenResponse.fromQueryParams(params) : null;
    return { ...base, type: "success", errorCode: null, error: null, authentication };
  }

  /** Create the PKCE verifier and challenge when missing. */
  private async ensureCodeIsSetupAsync(): Promise<void> {
    if (this.codeVerifier) return;
    this.codeVerifier = randomString(64);
    this.codeChallenge = this.codeChallengeMethod === CodeChallengeMethod.Plain
      ? this.codeVerifier
      : await s256(this.codeVerifier);
  }
}

/**
 * The redirect URI for an auth request: natively `native` when given, else
 * `<scheme>://<path>`; on the web a URL on the page's origin (`localhost` with
 * `preferLocalhost`).
 *
 * @param options The path, scheme and query parameters.
 * @returns The URI.
 */
export function makeRedirectUri(options: AuthSessionRedirectUriOptions = {}): string {
  if (options.native && nativePlatform() !== "web") return options.native;
  const url = createURL(options.path ?? "", {
    scheme: options.scheme,
    queryParams: options.queryParams,
    isTripleSlashed: options.isTripleSlashed,
  });
  if (!options.preferLocalhost || !/^https?:/.test(url)) return url;
  const parsed = new URL(url);
  parsed.hostname = "localhost";
  return parsed.href;
}

/**
 * The redirect URL for `path` on this app ({@linkcode makeRedirectUri}).
 *
 * @param path The path.
 * @returns The URL.
 */
export function getRedirectUrl(path?: string): string {
  return makeRedirectUri({ path });
}

/**
 * The default return URL ({@linkcode makeRedirectUri} with `path`).
 *
 * @param urlPath The path.
 * @param options The scheme and triple-slash form.
 * @returns The URL.
 */
export function getDefaultReturnUrl(
  urlPath?: string,
  options?: { scheme?: string; isTripleSlashed?: boolean },
): string {
  return makeRedirectUri({ path: urlPath, ...options });
}

/** Close the open auth session, where the platform allows it. */
export function dismiss(): void {
  dismissAuthSession();
}

/**
 * The OpenID configuration URL of `issuer`.
 *
 * @param issuer The issuer URL.
 * @returns `<issuer>/.well-known/openid-configuration`.
 */
export function issuerWithWellKnownUrl(issuer: Issuer): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

/**
 * Fetch `issuer`'s OpenID configuration.
 *
 * @param issuer The issuer URL.
 * @returns Its endpoints.
 */
export async function fetchDiscoveryAsync(issuer: Issuer): Promise<DiscoveryDocument> {
  const response = await fetch(issuerWithWellKnownUrl(issuer));
  if (!response.ok) throw new Error(`Discovery of ${issuer} failed: HTTP ${response.status}`);
  const json = await response.json() as Record<string, string>;
  return {
    discoveryDocument: json,
    authorizationEndpoint: json.authorization_endpoint,
    tokenEndpoint: json.token_endpoint,
    revocationEndpoint: json.revocation_endpoint,
    userInfoEndpoint: json.userinfo_endpoint,
    endSessionEndpoint: json.end_session_endpoint,
    registrationEndpoint: json.registration_endpoint,
  };
}

/**
 * A discovery document: fetched for an issuer URL, returned as is otherwise.
 *
 * @param issuerOrDiscovery An issuer URL or a document.
 * @returns The document.
 */
export async function resolveDiscoveryAsync(
  issuerOrDiscovery: IssuerOrDiscovery,
): Promise<DiscoveryDocument> {
  return typeof issuerOrDiscovery === "string"
    ? await fetchDiscoveryAsync(issuerOrDiscovery)
    : issuerOrDiscovery;
}

/**
 * Build an {@linkcode AuthRequest} after resolving its discovery document.
 *
 * @param config The request configuration.
 * @param issuerOrDiscovery The issuer or document.
 * @returns The request, with its URL built.
 */
export async function loadAsync(
  config: AuthRequestConfig,
  issuerOrDiscovery: IssuerOrDiscovery,
): Promise<AuthRequest> {
  const request = new AuthRequest(config);
  await request.makeAuthUrlAsync(await resolveDiscoveryAsync(issuerOrDiscovery));
  return request;
}

/**
 * Hook form of {@linkcode resolveDiscoveryAsync}.
 *
 * @param issuerOrDiscovery The issuer or document.
 * @returns The document, or null until it is known.
 */
export function useAutoDiscovery(issuerOrDiscovery: IssuerOrDiscovery): DiscoveryDocument | null {
  const [discovery, setDiscovery] = useState<DiscoveryDocument | null>(null);
  const key = typeof issuerOrDiscovery === "string"
    ? issuerOrDiscovery
    : JSON.stringify(issuerOrDiscovery);
  useEffect(() => {
    let active = true;
    resolveDiscoveryAsync(issuerOrDiscovery).then((d) => active && setDiscovery(d), () => {});
    return () => void (active = false);
  }, [key]);
  return discovery;
}

/**
 * An {@linkcode AuthRequest} for `config`, its latest result, and the prompt.
 *
 * @param config The request configuration.
 * @param discovery The provider's endpoints (null until known).
 * @returns `[request, result, promptAsync]`.
 */
export function useAuthRequest(
  config: AuthRequestConfig,
  discovery: DiscoveryDocument | null,
): [
  AuthRequest | null,
  AuthSessionResult | null,
  (options?: AuthRequestPromptOptions) => Promise<AuthSessionResult>,
] {
  const request = useMemo(() => new AuthRequest(config), [JSON.stringify(config)]);
  const [result, setResult] = useState<AuthSessionResult | null>(null);
  const promptAsync = useCallback(async (options?: AuthRequestPromptOptions) => {
    if (!discovery) throw new Error("useAuthRequest: the discovery document is not loaded yet");
    const next = await request.promptAsync(discovery, options);
    setResult(next);
    return next;
  }, [request, discovery]);
  return [discovery ? request : null, result, promptAsync];
}

/** POST a form to a token-family endpoint and read the JSON answer. */
async function postForm(
  endpoint: string | undefined,
  body: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  if (!endpoint) throw new Error("The discovery document has no endpoint for this call");
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) if (value !== undefined) form.set(key, value);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok || json.error) {
    throw new AuthError(
      { error: String(json.error ?? `http_${response.status}`), ...json } as Record<string, string>,
    );
  }
  return json;
}

/** The fields every token call sends. */
export interface TokenRequestBase {
  /** The client id. */
  clientId: string;
  /** The client secret. */
  clientSecret?: string;
  /** The scopes. */
  scopes?: string[];
  /** More body parameters. */
  extraParams?: Record<string, string>;
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param config The code, redirect URI, client and PKCE verifier (`extraParams.code_verifier`).
 * @param discovery The token endpoint.
 * @returns The tokens.
 */
export async function exchangeCodeAsync(
  config: TokenRequestBase & { code: string; redirectUri: string },
  discovery: Pick<DiscoveryDocument, "tokenEndpoint">,
): Promise<TokenResponse> {
  return TokenResponse.fromQueryParams(
    await postForm(discovery.tokenEndpoint, {
      grant_type: GrantType.AuthorizationCode,
      code: config.code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: config.scopes?.join(" "),
      ...config.extraParams,
    }),
  );
}

/**
 * Refresh an access token.
 *
 * @param config The refresh token and client.
 * @param discovery The token endpoint.
 * @returns The new tokens.
 */
export async function refreshAsync(
  config: TokenRequestBase & { refreshToken?: string },
  discovery: Pick<DiscoveryDocument, "tokenEndpoint">,
): Promise<TokenResponse> {
  return TokenResponse.fromQueryParams(
    await postForm(discovery.tokenEndpoint, {
      grant_type: GrantType.RefreshToken,
      refresh_token: config.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: config.scopes?.join(" "),
      ...config.extraParams,
    }),
  );
}

/**
 * Revoke a token.
 *
 * @param config The token and client.
 * @param discovery The revocation endpoint.
 * @returns `true` once revoked.
 */
export async function revokeAsync(
  config: Partial<TokenRequestBase> & { token: string; tokenTypeHint?: TokenTypeHint },
  discovery: Pick<DiscoveryDocument, "revocationEndpoint">,
): Promise<boolean> {
  await postForm(discovery.revocationEndpoint, {
    token: config.token,
    token_type_hint: config.tokenTypeHint,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  return true;
}

/**
 * Fetch the signed-in user's claims.
 *
 * @param config The access token.
 * @param discovery The user-info endpoint.
 * @returns The claims.
 */
export async function fetchUserInfoAsync(
  config: Pick<TokenResponse, "accessToken">,
  discovery: Pick<DiscoveryDocument, "userInfoEndpoint">,
): Promise<Record<string, unknown>> {
  if (!discovery.userInfoEndpoint) {
    throw new Error("The discovery document has no userInfoEndpoint");
  }
  const response = await fetch(discovery.userInfoEndpoint, {
    headers: { Authorization: `Bearer ${config.accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`User info failed: HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}
