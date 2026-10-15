/**
 * The provider descriptors `next-auth/providers/*` return, and how each becomes a denext
 * provider: Auth.js's environment defaults (`AUTH_<ID>_ID` / `_SECRET` / `_ISSUER` / `_KEY`),
 * `authorization.params`, an app `profile()` override (the preset's email-verification verdict
 * is kept only for the address it vouched for), and the per-request record the Auth.js
 * callbacks read (`account`, `profile`, the raw `user`).
 *
 * @module
 */

import { oauthPreset, oidcClaimProfile } from "../../../server/auth/providers-presets.ts";
import { oidc } from "../../../server/auth/providers.ts";
import type {
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

/** What building a provider yields: the denext provider, and an email provider's sender. */
export interface BuiltProvider {
  /** The denext provider. */
  provider: AuthProvider;
  /** An email provider's mail sender. */
  send?: SendVerificationRequest;
}

/** A provider as `next-auth/providers/*` returns it. */
export interface ProviderDescriptor<Options = unknown> {
  /** The provider id (the `[provider]` route segment). */
  id: string;
  /** Its display name. */
  name: string;
  /** Its kind. */
  type: "oauth" | "oidc" | "credentials" | "email";
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
 * Record a provider round-trip for the Auth.js callbacks — the raw profile, the account with
 * its tokens, the user — and, when the app overrides `profile()`, a step that runs it later
 * (denext maps profiles synchronously; the override may be async): the sign-in's `signIn` hook
 * applies its name, image and extra fields. The account keeps the preset's id and verified
 * email, so an override can't change which account (or address) a sign-in links to.
 */
function recordingProfile<P>(
  preset: OAuthProvider["profile"],
  custom: OAuthUserConfig<P>["profile"],
  providerId: string,
  type: string,
): OAuthProvider["profile"] {
  return (input: ProfileInput) => {
    const base = preset(input);
    const raw = { ...(input.userinfo ?? {}), ...(input.claims ?? {}) };
    const record = signInRecord();
    record.profile = raw;
    record.user = { ...base };
    record.account = accountOf(providerId, type, input.tokens, base.id);
    if (custom) {
      record.applyProfile = async () => await custom(raw as P, input.tokens);
    }
    return base;
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
): OAuthProvider {
  const id = options.id ?? built.id;
  const { rest } = authorizationParams(options.authorization);
  const provider: OAuthProvider = { ...built, id };
  if (rest) provider.authorizationParams = { ...built.authorizationParams, ...rest };
  if (options.allowDangerousEmailAccountLinking) provider.allowDangerousEmailAccountLinking = true;
  provider.profile = recordingProfile(built.profile, options.profile, id, built.type);
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
  meta: { id: string; name: string; type: "oauth" | "oidc" },
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
    return { provider: withAuthJsOptions(built, { ...options, id }) };
  });
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
  return describeProvider(
    descriptor,
    (env) => ({ provider: withAuthJsOptions(buildCustomOAuth(config, env), config) }),
  );
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
