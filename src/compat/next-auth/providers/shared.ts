/**
 * The provider descriptors `next-auth/providers/*` return, and how each becomes a denext
 * provider: Auth.js's environment defaults (`AUTH_<ID>_ID` / `_SECRET` / `_ISSUER` / `_KEY`),
 * `authorization.params`, an app `profile()` override (the preset's email-verification verdict
 * is kept only for the address it vouched for), and the per-request record the Auth.js
 * callbacks read (`account`, `profile`, the raw `user`).
 *
 * @module
 */

import {
  oauthPreset,
  type OAuthPresetSpec,
  oidcClaimProfile,
} from "../../../server/auth/providers-presets.ts";
import { oidc } from "../../../server/auth/providers.ts";
import type {
  AuthPasskeyConfig,
  AuthProvider,
  AuthUser,
  OAuthProvider,
  ProfileInput,
  SendVerificationRequest,
} from "../../../server/auth/types.ts";
import { type AuthJsAccount, signInRecord } from "../state.ts";

/** Reads one environment variable (injectable for tests). */
export type EnvReader = (name: string) => string | undefined;

/** The key of the internal builder a descriptor carries (a symbol, so a spread keeps it). */
const BUILD: unique symbol = Symbol.for("denext.next-auth.provider");

/**
 * What building a provider yields: the denext provider and an email provider's sender — or, for
 * a WebAuthn provider (`passkey`), the passkey settings it turns on instead of a provider.
 */
export interface BuiltProvider {
  /** The denext provider (absent for a WebAuthn provider). */
  provider?: AuthProvider;
  /** An email provider's mail sender. */
  send?: SendVerificationRequest;
  /** A WebAuthn provider's `denextAuth({ passkeys })` settings. */
  passkeys?: AuthPasskeyConfig;
}

/** A provider as `next-auth/providers/*` returns it. */
export interface ProviderDescriptor<Options = unknown> {
  /** The provider id (the `[provider]` route segment). */
  id: string;
  /** Its display name. */
  name: string;
  /** Its kind. */
  type: "oauth" | "oidc" | "credentials" | "email" | "webauthn";
  /** The options it was created with. */
  options: Options;
}

/** A descriptor with its builder. */
interface BuildableDescriptor {
  /** Builds the denext provider. */
  [BUILD]: (env: EnvReader) => BuiltProvider;
}

/**
 * Attach the builder that turns `descriptor` into a denext provider.
 *
 * @param descriptor The descriptor.
 * @param build Builds the denext provider from the environment.
 * @returns The same descriptor.
 */
export function describeProvider<O>(
  descriptor: ProviderDescriptor<O>,
  build: (env: EnvReader) => BuiltProvider,
): ProviderDescriptor<O> {
  (descriptor as unknown as BuildableDescriptor)[BUILD] = build;
  return descriptor;
}

/**
 * Build the denext provider a descriptor describes.
 *
 * @param descriptor A descriptor {@linkcode describeProvider} registered.
 * @param env The environment reader.
 * @returns The built provider.
 */
export function buildProvider(descriptor: ProviderDescriptor, env: EnvReader): BuiltProvider {
  return (descriptor as unknown as BuildableDescriptor)[BUILD](env);
}

/** The user an Auth.js `profile()` callback returns. */
export interface ProfileUser extends Record<string, unknown> {
  /** The provider's id for the account. */
  id?: string | number | null;
  /** Display name. */
  name?: string | null;
  /** Email address. */
  email?: string | null;
  /** Avatar URL. */
  image?: string | null;
}

/** An Auth.js endpoint: a URL, or `{ url, params }`. */
export type EndpointConfig = string | { url?: string; params?: Record<string, string> };

/** The options every OAuth / OIDC provider takes. */
export interface OAuthUserConfig<P = Record<string, unknown>> {
  /** Client id (default `AUTH_<ID>_ID`). */
  clientId?: string;
  /** Client secret (default `AUTH_<ID>_SECRET`). */
  clientSecret?: string;
  /** Override the provider id (and its route segment). */
  id?: string;
  /** Override the display name. */
  name?: string;
  /** The issuer (default `AUTH_<ID>_ISSUER`) — the tenant URL for Microsoft Entra ID. */
  issuer?: string;
  /** The authorization endpoint, or just `{ params }` (`scope`, `prompt`, …) for a preset. */
  authorization?: EndpointConfig;
  /** Map the provider profile to the user. */
  profile?(profile: P, tokens: Record<string, unknown>): ProfileUser | Promise<ProfileUser>;
  /** Link to an existing user by email even when the address is unverified (dangerous). */
  allowDangerousEmailAccountLinking?: boolean;
  /** Accepted and ignored: denext always runs `state` + PKCE (+ `nonce` for OIDC). */
  checks?: string[];
  /**
   * denext-only: extra hosts the provider's endpoints may live on (exact, or `*.domain`) — a
   * discovered endpoint on another host is refused otherwise (a Cognito custom domain).
   */
  allowedHosts?: string[];
}

/** The `AUTH_<ID>` prefix Auth.js reads a provider's defaults from. */
function envPrefix(id: string): string {
  return `AUTH_${id.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * The default reader: `Deno.env`, or nothing when env access is not granted.
 *
 * @param name The variable.
 * @returns Its value, or `undefined`.
 */
export const readEnv: EnvReader = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

/**
 * A provider option, else its `AUTH_<ID>_<suffix>` environment default.
 *
 * @param env The reader.
 * @param id The provider id.
 * @param value The configured value.
 * @param suffix `ID`, `SECRET`, `ISSUER` or `KEY`.
 * @returns The value, or `""` when neither is set (denext refuses it when serving).
 */
function optionOrEnv(
  env: EnvReader,
  id: string,
  value: string | undefined,
  suffix: string,
): string {
  return value ?? env(`${envPrefix(id)}_${suffix}`) ?? "";
}

/** `{ scope, …rest }` of an `authorization` option's params. */
function authorizationParams(
  authorization: EndpointConfig | undefined,
): { scopes?: string[]; rest?: Record<string, string> } {
  const params = typeof authorization === "object" ? authorization.params : undefined;
  if (!params) return {};
  const { scope, response_mode: _mode, ...rest } = params;
  return {
    scopes: scope ? scope.split(/[\s,]+/).filter(Boolean) : undefined,
    rest: Object.keys(rest).length ? rest : undefined,
  };
}

/** The Auth.js `account` a provider round-trip produced. */
function accountOf(
  provider: string,
  type: string,
  tokens: Record<string, unknown>,
  providerAccountId: string,
): AuthJsAccount {
  const expiresIn = Number(tokens.expires_in);
  const account: AuthJsAccount = { provider, type, providerAccountId };
  for (const field of ["access_token", "refresh_token", "token_type", "scope", "id_token"]) {
    if (typeof tokens[field] === "string") account[field] = tokens[field];
  }
  if (Number.isFinite(expiresIn)) account.expires_at = Math.floor(Date.now() / 1000) + expiresIn;
  return account;
}

/**
 * The user an app `profile()` override returned, as denext's: its id and email decide the
 * account, as in Auth.js. The preset's "verified" verdict carries over only to the address the
 * preset itself read, so an override can't turn an address into a verified one.
 */
function overrideUser(mine: ProfileUser, preset: AuthUser): AuthUser {
  const user: AuthUser = { id: String(mine.id ?? preset.id ?? "") };
  if (typeof mine.name === "string") user.name = mine.name;
  if (typeof mine.image === "string") user.image = mine.image;
  if (typeof mine.email === "string" && mine.email) {
    user.email = mine.email;
    if (mine.email === preset.email && preset.emailVerified !== undefined) {
      user.emailVerified = preset.emailVerified;
    }
  }
  return user;
}

/** The raw profile Auth.js hands `profile()`: the userinfo response and the id_token claims. */
function mergedProfile(input: ProfileInput): Record<string, unknown> {
  return { ...(input.userinfo ?? {}), ...(input.claims ?? {}) };
}

/**
 * Wrap a denext profile mapper so the app's `profile()` override (sync or async) decides the
 * user, and the Auth.js callbacks see the round-trip: the raw profile, the account with its
 * tokens, and the user exactly as the override returned it.
 */
function recordingProfile<P>(
  preset: OAuthProvider["profile"],
  custom: OAuthUserConfig<P>["profile"],
  providerId: string,
  type: string,
  rawProfile: (input: ProfileInput) => Record<string, unknown> = mergedProfile,
  authJsUser?: (input: ProfileInput) => Record<string, unknown>,
): OAuthProvider["profile"] {
  return async (input: ProfileInput) => {
    const base = await preset(input);
    const raw = rawProfile(input);
    const record = signInRecord();
    record.profile = raw;
    let user = base;
    record.user = authJsUser ? { ...authJsUser(input), id: base.id } : { ...base };
    if (custom) {
      const mine = await custom(raw as P, input.tokens);
      user = overrideUser(mine, base);
      record.user = { ...mine, id: user.id };
    }
    record.account = accountOf(providerId, type, input.tokens, user.id);
    return user;
  };
}

/**
 * Finish a built OAuth provider with the Auth.js options every preset shares: the id, the
 * extra authorization params, dangerous linking, and the recording profile mapper.
 *
 * @param built The denext preset.
 * @param options The app's options.
 * @returns The provider.
 */
function withAuthJsOptions<P>(
  built: OAuthProvider,
  options: OAuthUserConfig<P>,
  rawProfile?: (input: ProfileInput) => Record<string, unknown>,
  authJsUser?: (input: ProfileInput) => Record<string, unknown>,
): OAuthProvider {
  const id = options.id ?? built.id;
  const { rest } = authorizationParams(options.authorization);
  const provider: OAuthProvider = { ...built, id };
  if (rest) provider.authorizationParams = { ...built.authorizationParams, ...rest };
  if (options.allowDangerousEmailAccountLinking) provider.allowDangerousEmailAccountLinking = true;
  if (options.allowedHosts?.length) {
    provider.allowedHosts = [...(built.allowedHosts ?? []), ...options.allowedHosts];
  }
  provider.profile = recordingProfile(
    built.profile,
    options.profile,
    id,
    built.type,
    rawProfile,
    authJsUser,
  );
  return provider;
}

/**
 * Describe one preset OAuth / OIDC provider.
 *
 * @param meta The default id, name and type.
 * @param options The app's options.
 * @param preset Builds the denext preset from the resolved credentials.
 * @returns The descriptor.
 */
export function oauthDescriptor<P, O extends OAuthUserConfig<P>>(
  meta: {
    id: string;
    name: string;
    type: "oauth" | "oidc";
    /** The raw profile `profile()` receives, when it is not the userinfo + claims. */
    rawProfile?: (input: ProfileInput) => Record<string, unknown>;
    /** The user the Auth.js callbacks see, when it is not the denext user (a generated mapping). */
    authJsUser?: (input: ProfileInput) => Record<string, unknown>;
  },
  options: O,
  preset: (
    credentials: { clientId: string; clientSecret: string; scopes?: string[] },
    issuer: string,
  ) => OAuthProvider,
): ProviderDescriptor<O> {
  const id = options.id ?? meta.id;
  const descriptor = { id, name: options.name ?? meta.name, type: meta.type, options };
  return describeProvider(descriptor, (env) => {
    const { scopes } = authorizationParams(options.authorization);
    const built = preset({
      clientId: optionOrEnv(env, id, options.clientId, "ID"),
      clientSecret: optionOrEnv(env, id, options.clientSecret, "SECRET"),
      ...(scopes ? { scopes } : {}),
    }, optionOrEnv(env, id, options.issuer, "ISSUER"));
    return {
      provider: withAuthJsOptions(built, { ...options, id }, meta.rawProfile, meta.authJsUser),
    };
  });
}

/** A preset's static data, plus how it authenticates at the token endpoint. */
export interface ProviderSpec extends OAuthPresetSpec {
  /** `"client_secret_basic"` for a provider that wants the credentials in a Basic header. */
  tokenEndpointAuthMethod?: OAuthProvider["tokenEndpointAuthMethod"];
}

/**
 * A provider from static endpoint data the shim carries itself (where denext has no preset).
 * Unlike `oauthPreset()` it allows no scopes at all, for a provider that takes them from the
 * app registration (Zoom, Notion): the authorization request then carries no `scope`.
 *
 * @param spec The endpoints, scopes, mapper and token-endpoint auth method.
 * @param credentials The client credentials and an optional scope override.
 * @returns The denext provider.
 */
export function specProvider(
  spec: ProviderSpec,
  credentials: { clientId: string; clientSecret: string; scopes?: string[] },
): OAuthProvider {
  const scopes = credentials.scopes ?? spec.scopes;
  const { tokenEndpointAuthMethod, ...preset } = spec;
  // `oauthPreset` refuses an empty list; the placeholder is replaced by the real (empty) one.
  const built = oauthPreset(
    { ...preset, scopes: scopes.length ? scopes : ["openid"] },
    { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
  );
  return { ...built, scopes, ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}) };
}

/**
 * The issuer a provider needs (its option, else `AUTH_<ID>_ISSUER`), parsed; a config-time
 * error naming both when it is missing or not an https URL.
 *
 * @param id The provider id.
 * @param issuer The resolved issuer (`""` when neither is set).
 * @returns The issuer URL.
 * @throws {TypeError} When it is missing or not https.
 */
export function issuerUrl(id: string, issuer: string): URL {
  let url: URL | undefined;
  try {
    url = issuer ? new URL(issuer) : undefined;
  } catch { /* reported below */ }
  if (!url || url.protocol !== "https:") {
    throw new TypeError(
      `next-auth: provider "${id}" needs an https \`issuer\` (or ${envPrefix(id)}_ISSUER)`,
    );
  }
  return url;
}

/** A custom Auth.js OAuth / OIDC provider written as a plain object. */
export interface CustomOAuthConfig extends OAuthUserConfig {
  /** The provider id. */
  id: string;
  /** `"oauth"` or `"oidc"`. */
  type: "oauth" | "oidc";
  /** The token endpoint. */
  token?: EndpointConfig;
  /** The userinfo endpoint. */
  userinfo?: EndpointConfig;
  /** The JWKS endpoint (OIDC with explicit endpoints). */
  jwks_endpoint?: string;
  /** The client's token-endpoint authentication (`client_secret_post` by default). */
  client?: { token_endpoint_auth_method?: string };
}

/** An endpoint's URL. */
function urlOf(endpoint: EndpointConfig | undefined): string | undefined {
  return typeof endpoint === "string" ? endpoint : endpoint?.url;
}

/** The default mapping Auth.js applies to a custom provider's profile. */
function defaultCustomProfile(input: ProfileInput): AuthUser {
  const raw = { ...(input.userinfo ?? {}), ...(input.claims ?? {}) } as Record<string, unknown>;
  if (input.claims) return oidcClaimProfile(input);
  const pick = (...keys: string[]) =>
    keys.map((k) => raw[k]).find((v) => typeof v === "string" || typeof v === "number");
  const user: AuthUser = { id: String(pick("sub", "id") ?? "") };
  const name = pick("name", "nickname", "preferred_username");
  if (typeof name === "string") user.name = name;
  if (typeof raw.email === "string") user.email = raw.email;
  if (typeof raw.picture === "string") user.image = raw.picture;
  return user;
}

/** A custom provider's endpoints and credentials, resolved. */
interface CustomEndpoints {
  clientId: string;
  clientSecret: string;
  issuer?: string;
  scopes?: string[];
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
}

/** Resolve a custom provider's endpoints and its environment defaults. */
function customEndpoints(config: CustomOAuthConfig, env: EnvReader): CustomEndpoints {
  return {
    clientId: optionOrEnv(env, config.id, config.clientId, "ID"),
    clientSecret: optionOrEnv(env, config.id, config.clientSecret, "SECRET"),
    issuer: config.issuer ?? env(`${envPrefix(config.id)}_ISSUER`),
    scopes: authorizationParams(config.authorization).scopes,
    authorizationUrl: urlOf(config.authorization),
    tokenUrl: urlOf(config.token),
    userinfoUrl: urlOf(config.userinfo),
  };
}

/** A custom OIDC provider with an issuer: discovery, or its explicit endpoints. */
function customOidc(config: CustomOAuthConfig, e: CustomEndpoints, issuer: string): OAuthProvider {
  const jwksUrl = config.jwks_endpoint;
  const explicit = e.authorizationUrl && e.tokenUrl && jwksUrl
    ? { authorizationUrl: e.authorizationUrl, tokenUrl: e.tokenUrl, jwksUrl }
    : {};
  return oidc({
    id: config.id,
    issuer,
    clientId: e.clientId,
    clientSecret: e.clientSecret,
    ...(e.scopes ? { scopes: e.scopes } : {}),
    ...explicit,
    ...(e.userinfoUrl ? { userinfoUrl: e.userinfoUrl } : {}),
  });
}

/**
 * Build a custom provider object (`{ id, type: "oauth", authorization, token, userinfo, … }`).
 *
 * @param config The Auth.js provider object.
 * @param env The environment reader.
 * @returns The denext provider.
 */
function buildCustomOAuth(config: CustomOAuthConfig, env: EnvReader): OAuthProvider {
  const e = customEndpoints(config, env);
  if (config.type === "oidc" && e.issuer) return customOidc(config, e, e.issuer);
  const scopes = e.scopes ?? (config.type === "oidc" ? ["openid", "email", "profile"] : []);
  if (!e.authorizationUrl || !e.tokenUrl || scopes.length === 0) {
    throw new TypeError(
      `next-auth: provider "${config.id}" needs \`authorization\` and \`token\` URLs and, ` +
        'for type "oauth", `authorization.params.scope` (or, for type "oidc", an `issuer`)',
    );
  }
  return oauthPreset({
    id: config.id,
    type: config.type,
    authorizationUrl: e.authorizationUrl,
    tokenUrl: e.tokenUrl,
    userinfoUrl: e.userinfoUrl,
    issuer: e.issuer,
    scopes,
    profile: defaultCustomProfile,
  }, { clientId: e.clientId, clientSecret: e.clientSecret });
}

/**
 * Describe a custom provider object, so it lists and builds like a preset.
 *
 * @param config The Auth.js provider object.
 * @returns The descriptor.
 */
export function customDescriptor(config: CustomOAuthConfig): ProviderDescriptor {
  const descriptor = {
    id: config.id,
    name: config.name ?? config.id,
    type: config.type,
    options: config,
  };
  return describeProvider(descriptor, (env) => {
    const provider = withAuthJsOptions(buildCustomOAuth(config, env), config);
    const method = config.client?.token_endpoint_auth_method;
    if (method === "client_secret_basic" || method === "client_secret_post") {
      provider.tokenEndpointAuthMethod = method;
    }
    return { provider };
  });
}

/**
 * Whether `value` is a descriptor `next-auth/providers/*` built.
 *
 * @param value A `providers` entry.
 * @returns `true` for a descriptor.
 */
export function isDescriptor(value: unknown): value is ProviderDescriptor {
  return typeof value === "object" && value !== null && BUILD in value;
}
