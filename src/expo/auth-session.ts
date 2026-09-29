/**
 * `expo-auth-session` for denext: the OAuth 2 / OpenID Connect request flow over
 * `denext/expo/web-browser`'s `openAuthSessionAsync` (which runs `denext/mobile`'s
 * {@linkcode openAuthSession}).
 *
 * Provided: `makeRedirectUri`, `AuthRequest` (with PKCE S256 and `state`), `useAuthRequest`,
 * `useLoadedAuthRequest` and `useAuthRequestResult`, discovery (`fetchDiscoveryAsync`,
 * `resolveDiscoveryAsync`, `useAutoDiscovery`), the token calls (`exchangeCodeAsync`,
 * `refreshAsync`, `revokeAsync`, `fetchUserInfoAsync`) and the request classes behind them
 * (`AccessTokenRequest`, `RefreshTokenRequest`, `RevokeTokenRequest`), `TokenResponse`, the
 * error classes and `requestAsync`. The Google and Facebook presets are
 * `denext/expo/auth-session/providers/google` and `…/facebook`. `loadAsync`'s proxy options
 * are not provided.
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

/** An OAuth error response's parameters (`error`, `error_description`, …). */
export type ResponseErrorConfig = Record<string, string | undefined> & {
  /** The OAuth error code. */
  error: string;
  /** The provider's description. */
  error_description?: string;
  /** The provider's error page. */
  error_uri?: string;
};

/** An authorization error response's parameters (plus the returned `state`). */
export type AuthErrorConfig = ResponseErrorConfig & {
  /** The returned `state`. */
  state?: string;
};

/** An OAuth error response: an authorization redirect's or a token endpoint's. */
export class ResponseError extends Error {
  /** The OAuth error code (`access_denied`, `invalid_grant`, …). */
  readonly code: string;
  /** The provider's description. */
  readonly description?: string;
  /** The provider's error page. */
  readonly uri?: string;
  /** Every returned parameter. */
  readonly params: Record<string, string>;

  /**
   * Create it.
   *
   * @param params The error parameters (`error`, `error_description`, …).
   * @param errorCodeType Whether the authorization (`auth`) or token (`token`) endpoint sent it.
   */
  constructor(params: Record<string, string | undefined>, errorCodeType: "auth" | "token") {
    super(
      params.error_description ?? params.error ??
        (errorCodeType === "auth" ? "Authorization failed" : "The token request failed"),
    );
    this.name = "ResponseError";
    this.code = params.error ?? "unknown";
    this.description = params.error_description;
    this.uri = params.error_uri;
    this.params = params as Record<string, string>;
  }
}

/** An error the authorization endpoint returned. */
export class AuthError extends ResponseError {
  /** The returned `state`. */
  readonly state?: string;

  /**
   * Create it.
   *
   * @param params The error parameters (`error`, `error_description`, …).
   */
  constructor(params: Record<string, string | undefined>) {
    super(params, "auth");
    this.name = "AuthError";
    this.state = params.state;
  }
}

/** An error a token endpoint returned. */
export class TokenError extends ResponseError {
  /**
   * Create it.
   *
   * @param params The error parameters (`error`, `error_description`, …).
   */
  constructor(params: Record<string, string | undefined>) {
    super(params, "token");
    this.name = "TokenError";
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
  /** The token endpoint's whole answer, when it came from one. */
  rawResponse?: unknown;

  /**
   * Create it.
   *
   * @param response The token fields.
   * @param rawResponse The token endpoint's whole answer.
   */
  constructor(response: TokenResponseConfig, rawResponse?: unknown) {
    this.rawResponse = rawResponse;
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
    const { rawResponse: _raw, ...config } = this;
    return config;
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

/** The PKCE-unreserved characters `randomString` draws from. */
const RANDOM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** Bytes at or above this are rejected, so every character is equally likely (256 - 256 % 66). */
const RANDOM_LIMIT = 256 - 256 % RANDOM_CHARS.length;

/**
 * A random URL-safe string of `size` characters, uniform over {@linkcode RANDOM_CHARS}: a byte
 * that would favour the first characters (`b % 66` over 256 values) is drawn again.
 */
function randomString(size: number): string {
  let out = "";
  while (out.length < size) {
    for (const b of crypto.getRandomValues(new Uint8Array(size - out.length))) {
      if (b < RANDOM_LIMIT) out += RANDOM_CHARS[b % RANDOM_CHARS.length];
    }
  }
  return out;
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

/**
 * An `AuthRequestInstance` (an {@linkcode AuthRequest} or a subclass, like a provider's) for
 * `config`, once its authorization URL is built for `discovery`; null until then. Rebuilt
 * when the client, redirect, response type, PKCE, state, scopes, prompt or extra parameters
 * change.
 *
 * @param config The request configuration.
 * @param discovery The provider's endpoints (null until known).
 * @param AuthRequestInstance The request class.
 * @returns The loaded request, or null.
 */
export function useLoadedAuthRequest(
  config: AuthRequestConfig,
  discovery: DiscoveryDocument | null,
  AuthRequestInstance: new (config: AuthRequestConfig) => AuthRequest,
): AuthRequest | null {
  const [request, setRequest] = useState<AuthRequest | null>(null);
  const key = JSON.stringify([
    discovery?.authorizationEndpoint,
    config.clientId,
    config.redirectUri,
    config.responseType,
    config.clientSecret,
    config.codeChallenge,
    config.state,
    config.usePKCE,
    config.scopes?.join(" "),
    [config.prompt ?? []].flat().join(" "),
    config.extraParams ?? {},
  ]);
  useEffect(() => {
    if (!discovery) return;
    let mounted = true;
    const next = new AuthRequestInstance(config);
    next.makeAuthUrlAsync(discovery).then(() => mounted && setRequest(next), () => {});
    return () => void (mounted = false);
  }, [key]);
  return request;
}

/** What {@linkcode useAuthRequestResult}'s prompt does. */
export type PromptMethod = (options?: AuthRequestPromptOptions) => Promise<AuthSessionResult>;

/**
 * The latest result of `request` and the prompt that produces it. `customOptions` are the
 * defaults of every prompt (a provider's popup size, say).
 *
 * @param request The loaded request ({@linkcode useLoadedAuthRequest}).
 * @param discovery The provider's endpoints.
 * @param customOptions Default prompt options.
 * @returns `[result, promptAsync]`.
 */
export function useAuthRequestResult(
  request: AuthRequest | null,
  discovery: DiscoveryDocument | null,
  customOptions: AuthRequestPromptOptions = {},
): [AuthSessionResult | null, PromptMethod] {
  const [result, setResult] = useState<AuthSessionResult | null>(null);
  const promptAsync = useCallback(async (options: AuthRequestPromptOptions = {}) => {
    if (!discovery || !request) {
      throw new Error("Cannot prompt to authenticate until the request has finished loading.");
    }
    const next = await request.promptAsync(discovery, {
      ...customOptions,
      ...options,
      windowFeatures: { ...customOptions.windowFeatures, ...options.windowFeatures },
    });
    setResult(next);
    return next;
  }, [request?.url, discovery?.authorizationEndpoint]);
  return [result, promptAsync];
}

/** A {@linkcode requestAsync} request. */
export interface FetchRequest {
  /** The headers. */
  headers?: Record<string, string>;
  /** The parameters: a form body for a POST, the query string otherwise. */
  body?: Record<string, string>;
  /** `json` to ask for and parse JSON. */
  dataType?: string;
  /** The method (default GET). */
  method?: string;
}

/**
 * Expo's small fetch helper: send `body` as a form (POST) or a query string, and read the
 * answer as JSON (for `dataType: "json"` or a JSON content type) or text.
 *
 * @param requestUrl The URL.
 * @param fetchRequest The method, headers, body and data type.
 * @returns The parsed answer.
 */
export async function requestAsync<T>(requestUrl: string, fetchRequest: FetchRequest): Promise<T> {
  const url = new URL(requestUrl);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(fetchRequest.headers ?? {})) {
    if (value != null) headers[key] = value;
  }
  const isPost = fetchRequest.method?.toUpperCase() === "POST";
  let body: string | undefined;
  if (fetchRequest.body && isPost) body = new URLSearchParams(fetchRequest.body).toString();
  else if (fetchRequest.body) {
    for (const [key, value] of Object.entries(fetchRequest.body)) {
      url.searchParams.append(key, value);
    }
  }
  const json = fetchRequest.dataType?.toLowerCase() === "json";
  if (json && !headers.Accept && !headers.accept) {
    headers.Accept = "application/json, text/javascript; q=0.01";
  }
  const response = await fetch(url.toString().replace(/\/$/, ""), {
    method: fetchRequest.method,
    mode: "cors",
    headers,
    body,
  });
  if (json || response.headers.get("content-type")?.includes("application/json")) {
    return await response.json() as T;
  }
  return await response.text() as T;
}

/** The base of the token-family requests: a config, a body and `performAsync`. */
export class Request<T, B> {
  /** The request's configuration. */
  protected request: T;

  /**
   * Create it.
   *
   * @param request The request's configuration.
   */
  constructor(request: T) {
    this.request = request;
  }

  /** Send it (a subclass implements this). */
  performAsync(_discovery: DiscoveryDocument): Promise<B> {
    return Promise.reject(new Error("performAsync must be extended"));
  }

  /** The configuration (a subclass implements this). */
  getRequestConfig(): T {
    throw new Error("getRequestConfig must be extended");
  }

  /** The form body (a subclass implements this). */
  getQueryBody(): Record<string, string> {
    throw new Error("getQueryBody must be extended");
  }
}

/** The fields every token call sends. */
export interface TokenRequestBase {
  /** The client id. */
  clientId: string;
  /** The client secret (sent as HTTP Basic credentials). */
  clientSecret?: string;
  /** The scopes. */
  scopes?: string[];
  /** More body parameters. */
  extraParams?: Record<string, string>;
  /** More headers (`Content-Type` is fixed, and `Authorization` too with a secret). */
  extraHeaders?: Record<string, string>;
}

/** A token request's configuration. */
export type TokenRequestConfig = TokenRequestBase;

/** An authorization-code exchange's configuration. */
export type AccessTokenRequestConfig = TokenRequestBase & {
  /** The authorization code. */
  code: string;
  /** The redirect URI of the authorization request. */
  redirectUri: string;
};

/** A refresh's configuration. */
export type RefreshTokenRequestConfig = TokenRequestBase & {
  /** The refresh token. */
  refreshToken?: string;
};

/** A revocation's configuration. */
export type RevokeTokenRequestConfig = Partial<TokenRequestBase> & {
  /** The token to revoke. */
  token: string;
  /** Which kind of token it is. */
  tokenTypeHint?: TokenTypeHint;
};

/** `extra` without `Content-Type`, and without `Authorization` when a secret sets it. */
function sanitizeHeaders(
  extra: Record<string, string> | undefined,
  hasSecret: boolean,
): Record<string, string> | undefined {
  if (!extra) return undefined;
  const out = { ...extra };
  delete out["Content-Type"];
  delete out["content-type"];
  if (hasSecret) {
    delete out.Authorization;
    delete out.authorization;
  }
  return out;
}

/** The form headers, with HTTP Basic client credentials when there is a secret. */
function formHeaders(
  extra: Record<string, string> | undefined,
  clientId: string | undefined,
  clientSecret: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...extra,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (clientSecret !== undefined) {
    const credentials = `${encodeURIComponent(clientId ?? "")}:${encodeURIComponent(clientSecret)}`;
    headers.Authorization = `Basic ${bytesToBase64(new TextEncoder().encode(credentials))}`;
  }
  return headers;
}

/** A token-endpoint request: its grant, client and body. */
export class TokenRequest<T extends TokenRequestConfig> extends Request<T, TokenResponse>
  implements TokenRequestConfig {
  /** The grant type. */
  grantType: GrantType;
  /** The client id. */
  readonly clientId: string;
  /** The client secret. */
  readonly clientSecret?: string;
  /** The scopes. */
  readonly scopes?: string[];
  /** More body parameters. */
  readonly extraParams?: Record<string, string>;
  /** More headers. */
  readonly extraHeaders?: Record<string, string>;

  /**
   * Create it.
   *
   * @param request The request's configuration.
   * @param grantType The grant type.
   */
  constructor(request: T, grantType: GrantType) {
    super(request);
    this.grantType = grantType;
    this.clientId = request.clientId;
    this.clientSecret = request.clientSecret;
    this.scopes = request.scopes;
    this.extraParams = request.extraParams;
    this.extraHeaders = sanitizeHeaders(request.extraHeaders, request.clientSecret !== undefined);
  }

  /** The request headers. */
  getHeaders(): Record<string, string> {
    return formHeaders(this.extraHeaders, this.clientId, this.clientSecret);
  }

  /** POST it to the token endpoint. */
  override async performAsync(
    discovery: Pick<DiscoveryDocument, "tokenEndpoint">,
  ): Promise<TokenResponse> {
    if (!discovery.tokenEndpoint) {
      throw new Error("Cannot invoke `performAsync()` without a valid tokenEndpoint");
    }
    const response = await requestAsync<Record<string, unknown>>(discovery.tokenEndpoint, {
      dataType: "json",
      method: "POST",
      headers: this.getHeaders(),
      body: this.getQueryBody(),
    });
    if (typeof response !== "object" || response === null || "error" in response) {
      throw new TokenError(
        (response ?? { error: "invalid_response" }) as Record<string, string | undefined>,
      );
    }
    const token = TokenResponse.fromQueryParams(response);
    token.rawResponse = response;
    return token;
  }

  /** The form body: the grant, the client id (without a secret), the scope and extras. */
  override getQueryBody(): Record<string, string> {
    const body: Record<string, string> = { grant_type: this.grantType };
    if (!this.clientSecret) body.client_id = this.clientId;
    if (this.scopes) body.scope = this.scopes.join(" ");
    for (const [key, value] of Object.entries(this.extraParams ?? {})) {
      if (!(key in body) && value != null) body[key] = value;
    }
    return body;
  }
}

/** An authorization-code exchange. */
export class AccessTokenRequest extends TokenRequest<AccessTokenRequestConfig>
  implements AccessTokenRequestConfig {
  /** The authorization code. */
  readonly code: string;
  /** The redirect URI. */
  readonly redirectUri: string;

  /**
   * Create it.
   *
   * @param options The code, redirect URI and client.
   */
  constructor(options: AccessTokenRequestConfig) {
    if (!options.redirectUri) throw new Error("`AccessTokenRequest` requires a `redirectUri`");
    if (!options.code) throw new Error("`AccessTokenRequest` requires an authorization `code`");
    super(options, GrantType.AuthorizationCode);
    this.code = options.code;
    this.redirectUri = options.redirectUri;
  }

  /** The form body, with the code and redirect URI. */
  override getQueryBody(): Record<string, string> {
    return { ...super.getQueryBody(), redirect_uri: this.redirectUri, code: this.code };
  }

  /** The configuration. */
  override getRequestConfig(): AccessTokenRequestConfig & { grantType: GrantType } {
    return {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      grantType: this.grantType,
      code: this.code,
      redirectUri: this.redirectUri,
      extraParams: this.extraParams,
      extraHeaders: this.extraHeaders,
      scopes: this.scopes,
    };
  }
}

/** A refresh-token grant. */
export class RefreshTokenRequest extends TokenRequest<RefreshTokenRequestConfig>
  implements RefreshTokenRequestConfig {
  /** The refresh token. */
  readonly refreshToken?: string;

  /**
   * Create it.
   *
   * @param options The refresh token and client.
   */
  constructor(options: RefreshTokenRequestConfig) {
    if (!options.refreshToken) throw new Error("`RefreshTokenRequest` requires a `refreshToken`");
    super(options, GrantType.RefreshToken);
    this.refreshToken = options.refreshToken;
  }

  /** The form body, with the refresh token. */
  override getQueryBody(): Record<string, string> {
    return { ...super.getQueryBody(), refresh_token: this.refreshToken! };
  }

  /** The configuration. */
  override getRequestConfig(): RefreshTokenRequestConfig & { grantType: GrantType } {
    return {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      grantType: this.grantType,
      refreshToken: this.refreshToken,
      extraParams: this.extraParams,
      extraHeaders: this.extraHeaders,
      scopes: this.scopes,
    };
  }
}

/** A token revocation (RFC 7009). */
export class RevokeTokenRequest extends Request<RevokeTokenRequestConfig, boolean>
  implements RevokeTokenRequestConfig {
  /** The client id. */
  readonly clientId?: string;
  /** The client secret. */
  readonly clientSecret?: string;
  /** The token. */
  readonly token: string;
  /** Which kind of token it is. */
  readonly tokenTypeHint?: TokenTypeHint;
  /** More headers. */
  readonly extraHeaders?: Record<string, string>;

  /**
   * Create it.
   *
   * @param request The token and client.
   */
  constructor(request: RevokeTokenRequestConfig) {
    if (!request.token) throw new Error("`RevokeTokenRequest` requires a `token`");
    super(request);
    this.clientId = request.clientId;
    this.clientSecret = request.clientSecret;
    this.token = request.token;
    this.tokenTypeHint = request.tokenTypeHint;
    this.extraHeaders = sanitizeHeaders(request.extraHeaders, request.clientSecret !== undefined);
  }

  /** POST it to the revocation endpoint. */
  override async performAsync(
    discovery: Pick<DiscoveryDocument, "revocationEndpoint">,
  ): Promise<boolean> {
    if (!discovery.revocationEndpoint) {
      throw new Error("Cannot invoke `performAsync()` without a valid revocationEndpoint");
    }
    await requestAsync<unknown>(discovery.revocationEndpoint, {
      method: "POST",
      headers: this.getHeaders(),
      body: this.getQueryBody(),
    });
    return true;
  }

  /** The request headers (HTTP Basic client credentials with a secret). */
  getHeaders(): Record<string, string> {
    return formHeaders(this.extraHeaders, this.clientId, this.clientSecret);
  }

  /** The configuration. */
  override getRequestConfig(): RevokeTokenRequestConfig {
    return {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      token: this.token,
      tokenTypeHint: this.tokenTypeHint,
      extraHeaders: this.extraHeaders,
    };
  }

  /** The form body: the token, its hint and (without a secret) the client id. */
  override getQueryBody(): Record<string, string> {
    const body: Record<string, string> = { token: this.token };
    if (this.tokenTypeHint) body.token_type_hint = this.tokenTypeHint;
    if (this.clientId && !this.clientSecret) body.client_id = this.clientId;
    return body;
  }
}

/**
 * Exchange an authorization code for tokens ({@linkcode AccessTokenRequest}).
 *
 * @param config The code, redirect URI, client and PKCE verifier (`extraParams.code_verifier`).
 * @param discovery The token endpoint.
 * @returns The tokens.
 */
export function exchangeCodeAsync(
  config: AccessTokenRequestConfig,
  discovery: Pick<DiscoveryDocument, "tokenEndpoint">,
): Promise<TokenResponse> {
  return new AccessTokenRequest(config).performAsync(discovery);
}

/**
 * Refresh an access token ({@linkcode RefreshTokenRequest}).
 *
 * @param config The refresh token and client.
 * @param discovery The token endpoint.
 * @returns The new tokens.
 */
export function refreshAsync(
  config: RefreshTokenRequestConfig,
  discovery: Pick<DiscoveryDocument, "tokenEndpoint">,
): Promise<TokenResponse> {
  return new RefreshTokenRequest(config).performAsync(discovery);
}

/**
 * Revoke a token ({@linkcode RevokeTokenRequest}).
 *
 * @param config The token and client.
 * @param discovery The revocation endpoint.
 * @returns `true` once revoked.
 */
export function revokeAsync(
  config: RevokeTokenRequestConfig,
  discovery: Pick<DiscoveryDocument, "revocationEndpoint">,
): Promise<boolean> {
  return new RevokeTokenRequest(config).performAsync(discovery);
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
