/**
 * Built-in OAuth 2.0 / OIDC provider presets, plus the shared preset factory every one
 * of them (and `google` / `github` / `oidc` in {@link ./providers.ts | providers.ts}) is
 * a data literal for.
 *
 * Every OIDC preset carries BOTH its documented static endpoints and
 * `discovery: { issuer }`, so the flow works with hard-coded URLs today and lets
 * {@link ./discovery.ts | OIDC discovery} refresh/verify them: a provider that rotates an
 * endpoint is picked up without a denext release, and the discovery document is refused
 * unless it declares exactly the expected `issuer`.
 *
 * Endpoints are data, never interpolation of unvalidated input: a preset that takes a
 * tenant, realm, domain or base URL validates it first — `https:` only, host-only, no
 * credentials, and path segments restricted to `[A-Za-z0-9._-]`.
 *
 * @module
 */

import type { AuthUser, OAuthProvider, ProfileInput } from "./types.ts";

/** The client credentials every OAuth preset needs. */
export interface OAuthClientOptions {
  /** OAuth client id. */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: string;
  /** Override the requested scopes. */
  scopes?: string[];
}

/**
 * Normalize an `email_verified` claim. The OIDC spec makes it a boolean, but IdPs have
 * shipped it as the STRING `"false"` / `"true"`; a strict `=== false` check would treat the
 * string `"false"` as verified. Unknown shapes → `undefined` (no claim made).
 */
function emailVerifiedClaim(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * The standard OIDC profile mapper: `sub`, `email` (+ `email_verified`), `name`,
 * `picture`, merging userinfo and id_token claims (claims win). The email is dropped when
 * the IdP explicitly marks it unverified, so an app that links accounts by email can never
 * be handed an attacker-chosen address.
 *
 * @param input The token/userinfo/claims bundle from the flow.
 * @returns The normalized {@link AuthUser}.
 */
export function oidcClaimProfile({ claims, userinfo }: ProfileInput): AuthUser {
  const src = { ...userinfo, ...claims };
  const verified = emailVerifiedClaim(src.email_verified);
  return {
    id: String(src.sub ?? ""),
    name: src.name as string | undefined,
    email: verified === false ? undefined : (src.email as string | undefined),
    emailVerified: verified,
    image: src.picture as string | undefined,
  };
}

/** The static half of a provider preset — everything that is not a client credential. */
export interface OAuthPresetSpec {
  /** URL-safe provider id (the `[provider]` route segment). */
  id: string;
  /** `"oidc"` verifies an `id_token`; `"oauth"` calls a userinfo endpoint. */
  type: "oauth" | "oidc";
  /** Authorization endpoint. */
  authorizationUrl: string;
  /** Token endpoint. */
  tokenUrl: string;
  /** Userinfo endpoint (OAuth presets; the OIDC presets read the verified id_token). */
  userinfoUrl?: string;
  /** Endpoint returning the account's email list (e.g. GitHub `/user/emails`). */
  userEmailsUrl?: string;
  /** Expected `iss` for id_token verification (OIDC). */
  issuer?: string;
  /** JWKS endpoint for id_token signature keys (OIDC). */
  jwksUrl?: string;
  /** Publish `discovery: { issuer }` so the endpoints above can be refreshed/verified. */
  discovery?: boolean;
  /** Scopes requested when the app does not override them. */
  scopes: string[];
  /** Profile mapper (defaults to {@link oidcClaimProfile}). */
  profile?: (input: ProfileInput) => AuthUser;
  /** Extra authorization-request query params. */
  authorizationParams?: Record<string, string>;
}

/**
 * Build a provider from its static endpoint data plus the app's client credentials — the
 * single factory behind every built-in preset. `strictAudience` is deliberately left
 * unset, so the framework default (refuse a multi-audience `id_token` without a matching
 * `azp`) applies to all of them.
 *
 * @param spec The provider's static endpoints, scopes and mapper.
 * @param options The app's client id/secret and optional scope override.
 * @returns The {@link OAuthProvider} to list in `AuthConfig.providers`.
 */
export function oauthPreset(spec: OAuthPresetSpec, options: OAuthClientOptions): OAuthProvider {
  const scopes = options.scopes ?? spec.scopes;
  if (scopes.length === 0) {
    throw new TypeError(`auth: provider "${spec.id}" needs at least one scope`);
  }
  return {
    id: spec.id,
    type: spec.type,
    authorizationUrl: spec.authorizationUrl,
    tokenUrl: spec.tokenUrl,
    userinfoUrl: spec.userinfoUrl,
    userEmailsUrl: spec.userEmailsUrl,
    issuer: spec.issuer,
    jwksUrl: spec.jwksUrl,
    discovery: spec.discovery && spec.issuer ? { issuer: spec.issuer } : undefined,
    scopes,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: spec.profile ?? oidcClaimProfile,
    authorizationParams: spec.authorizationParams,
  };
}

/**
 * Validate a caller-supplied host (`"acme.eu.auth0.com"`, or the same with an `https://`
 * scheme) and return its origin. Refuses anything that could smuggle a different endpoint
 * into an interpolated URL: a non-`https:` scheme, embedded credentials, a path, a query
 * or a fragment.
 *
 * @param value The configured domain or base URL.
 * @param label The option name, for the error message.
 * @returns The origin, e.g. `"https://acme.eu.auth0.com"`.
 */
function providerOrigin(value: string, label: string): string {
  const raw = String(value ?? "").trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError(`auth: ${label} is not a valid host`);
  }
  const clean = url.protocol === "https:" && url.username === "" && url.password === "" &&
    (url.pathname === "" || url.pathname === "/") && url.search === "" && url.hash === "";
  if (!clean || !url.hostname) {
    throw new TypeError(
      `auth: ${label} must be an https host with no path, query, fragment or credentials`,
    );
  }
  return url.origin;
}

/**
 * Validate a value that is interpolated as a single URL path segment (a tenant id, an Okta
 * authorization server, a Keycloak realm). Only `[A-Za-z0-9._-]` is accepted, so no
 * traversal (`../`), separator (`/`) or query character can escape the template.
 *
 * @param value The configured segment.
 * @param label The option name, for the error message.
 * @returns The segment unchanged.
 */
function providerSegment(value: string, label: string): string {
  const raw = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) {
    throw new TypeError(`auth: ${label} must match [A-Za-z0-9._-] (1-128 chars)`);
  }
  return raw;
}

/** Options for {@link microsoftEntra}. */
export interface MicrosoftEntraOptions extends OAuthClientOptions {
  /**
   * The directory (tenant) id — a GUID, or a verified domain such as `"contoso.com"`.
   * The multi-tenant aliases `common` / `organizations` / `consumers` are **refused**:
   * their discovery document declares the template issuer
   * `https://login.microsoftonline.com/{tenantid}/v2.0` while the `id_token` carries the
   * tenant-specific one, and denext verifies `iss` by exact match.
   */
  tenant: string;
}

/** Tenant aliases whose issuer is a template denext cannot match exactly. */
const ENTRA_MULTI_TENANT = new Set(["common", "organizations", "consumers"]);

/**
 * Microsoft Entra ID (formerly Azure AD) — OIDC v2.0 endpoints, `id_token` verified
 * against the tenant's JWKS. Single-tenant only (see {@link MicrosoftEntraOptions.tenant});
 * claims come from the verified `id_token`, so no Microsoft Graph call is made.
 *
 * @param options Tenant plus the app's client credentials.
 * @returns The configured Entra provider (`id: "microsoft-entra"`).
 */
export function microsoftEntra(options: MicrosoftEntraOptions): OAuthProvider {
  const tenant = providerSegment(options.tenant, "microsoftEntra tenant");
  if (ENTRA_MULTI_TENANT.has(tenant.toLowerCase())) {
    throw new TypeError(
      `auth: microsoftEntra needs a specific tenant id or domain — "${tenant}" issues a ` +
        `template issuer (https://login.microsoftonline.com/{tenantid}/v2.0) that cannot be verified`,
    );
  }
  const base = `https://login.microsoftonline.com/${tenant}`;
  return oauthPreset({
    id: "microsoft-entra",
    type: "oidc",
    issuer: `${base}/v2.0`,
    authorizationUrl: `${base}/oauth2/v2.0/authorize`,
    tokenUrl: `${base}/oauth2/v2.0/token`,
    jwksUrl: `${base}/discovery/v2.0/keys`,
    discovery: true,
    scopes: ["openid", "email", "profile"],
  }, options);
}

/** Scopes Apple only grants with `response_mode=form_post`, which denext cannot receive. */
const APPLE_FORM_POST_SCOPES = new Set(["name", "email"]);

/**
 * Sign in with Apple (OIDC). Ships **`openid` only**: Apple returns `name` / `email` just
 * once, and only over `response_mode=form_post` — a POST callback the auth router does not
 * accept — so requesting them would break the login rather than enrich it. Requesting
 * either scope throws; the session therefore carries Apple's `sub` and no email.
 *
 * `clientSecret` must be the ES256 client-secret **JWT** you mint from your Apple key
 * (max 6 months); denext passes it through to the token endpoint verbatim.
 *
 * @param options The app's Apple client credentials (Services ID + secret JWT).
 * @returns The configured Apple provider (`id: "apple"`).
 */
export function apple(options: OAuthClientOptions): OAuthProvider {
  const requested = options.scopes ?? [];
  if (requested.some((s) => APPLE_FORM_POST_SCOPES.has(s))) {
    throw new TypeError(
      "auth: apple() cannot request the name/email scopes — Apple only returns them via " +
        "response_mode=form_post, which the denext auth callback does not accept",
    );
  }
  return oauthPreset({
    id: "apple",
    type: "oidc",
    issuer: "https://appleid.apple.com",
    authorizationUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    jwksUrl: "https://appleid.apple.com/auth/keys",
    discovery: true,
    scopes: ["openid"],
  }, options);
}

/**
 * Map Discord's `/users/@me` response. Discord's `verified` flag is the email-ownership
 * assertion, so an unverified address is dropped exactly like an OIDC
 * `email_verified: false`.
 *
 * @param input The flow's profile bundle (`userinfo` is the `/users/@me` body).
 * @returns The normalized {@link AuthUser}.
 */
function discordProfile({ userinfo }: ProfileInput): AuthUser {
  const id = String(userinfo?.id ?? "");
  const verified = typeof userinfo?.verified === "boolean" ? userinfo.verified : undefined;
  const avatar = typeof userinfo?.avatar === "string" ? userinfo.avatar : undefined;
  return {
    id,
    name: (userinfo?.global_name ?? userinfo?.username) as string | undefined,
    email: verified === true ? (userinfo?.email as string | undefined) : undefined,
    emailVerified: verified,
    image: id && avatar
      ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(id)}/${
        encodeURIComponent(avatar)
      }.png`
      : undefined,
  };
}

/**
 * Discord (OAuth 2.0). Reads the profile from `/users/@me`; only an address Discord
 * reports as `verified` reaches the session.
 *
 * @param options The app's Discord client credentials.
 * @returns The configured Discord provider (`id: "discord"`).
 */
export function discord(options: OAuthClientOptions): OAuthProvider {
  return oauthPreset({
    id: "discord",
    type: "oauth",
    authorizationUrl: "https://discord.com/api/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    userinfoUrl: "https://discord.com/api/users/@me",
    scopes: ["identify", "email"],
    profile: discordProfile,
  }, options);
}

/** Options for {@link gitlab}. */
export interface GitLabOptions extends OAuthClientOptions {
  /**
   * The GitLab instance origin (default `"https://gitlab.com"`). Self-managed instances
   * must be reachable over `https:` and mounted at the host root — a GitLab behind a path
   * prefix is configured with the generic `oidc()` provider instead.
   */
  baseUrl?: string;
}

/**
 * GitLab (OIDC, gitlab.com or self-managed). Claims come from the verified `id_token`.
 *
 * @param options Optional instance origin plus the app's client credentials.
 * @returns The configured GitLab provider (`id: "gitlab"`).
 */
export function gitlab(options: GitLabOptions): OAuthProvider {
  const base = providerOrigin(options.baseUrl ?? "https://gitlab.com", "gitlab baseUrl");
  return oauthPreset({
    id: "gitlab",
    type: "oidc",
    issuer: base,
    authorizationUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    jwksUrl: `${base}/oauth/discovery/keys`,
    discovery: true,
    scopes: ["openid", "email", "profile"],
  }, options);
}

/**
 * Slack ("Sign in with Slack", OIDC). Claims come from the verified `id_token`; Slack's
 * `email_verified` claim is honoured by the shared mapper.
 *
 * @param options The app's Slack client credentials.
 * @returns The configured Slack provider (`id: "slack"`).
 */
export function slack(options: OAuthClientOptions): OAuthProvider {
  return oauthPreset({
    id: "slack",
    type: "oidc",
    issuer: "https://slack.com",
    authorizationUrl: "https://slack.com/openid/connect/authorize",
    tokenUrl: "https://slack.com/api/openid.connect.token",
    jwksUrl: "https://slack.com/openid/connect/keys",
    discovery: true,
    scopes: ["openid", "profile", "email"],
  }, options);
}

/** Options for {@link auth0}. */
export interface Auth0Options extends OAuthClientOptions {
  /** The tenant domain, e.g. `"acme.eu.auth0.com"` or a custom domain. Host only. */
  domain: string;
}

/**
 * Auth0 (OIDC). Note the issuer carries Auth0's trailing slash
 * (`https://<domain>/`) — that is what the tenant's discovery document and `id_token`
 * declare, and `iss` is compared exactly.
 *
 * @param options Tenant domain plus the app's client credentials.
 * @returns The configured Auth0 provider (`id: "auth0"`).
 */
export function auth0(options: Auth0Options): OAuthProvider {
  const base = providerOrigin(options.domain, "auth0 domain");
  return oauthPreset({
    id: "auth0",
    type: "oidc",
    issuer: `${base}/`,
    authorizationUrl: `${base}/authorize`,
    tokenUrl: `${base}/oauth/token`,
    jwksUrl: `${base}/.well-known/jwks.json`,
    discovery: true,
    scopes: ["openid", "email", "profile"],
  }, options);
}

/** Options for {@link okta}. */
export interface OktaOptions extends OAuthClientOptions {
  /** The Okta org domain, e.g. `"dev-1234.okta.com"`. Host only. */
  domain: string;
  /**
   * The custom authorization server id (default `"default"`). Okta's *org* authorization
   * server (endpoints under `/oauth2/v1/...`, no server id) is not covered by this preset —
   * configure it with the generic `oidc()` provider.
   */
  authorizationServer?: string;
}

/**
 * Okta (OIDC, custom authorization server). Claims come from the verified `id_token`.
 *
 * @param options Org domain, optional authorization server id, and client credentials.
 * @returns The configured Okta provider (`id: "okta"`).
 */
export function okta(options: OktaOptions): OAuthProvider {
  const origin = providerOrigin(options.domain, "okta domain");
  const server = providerSegment(
    options.authorizationServer ?? "default",
    "okta authorizationServer",
  );
  const base = `${origin}/oauth2/${server}`;
  return oauthPreset({
    id: "okta",
    type: "oidc",
    issuer: base,
    authorizationUrl: `${base}/v1/authorize`,
    tokenUrl: `${base}/v1/token`,
    jwksUrl: `${base}/v1/keys`,
    discovery: true,
    scopes: ["openid", "email", "profile"],
  }, options);
}

/** Options for {@link keycloak}. */
export interface KeycloakOptions extends OAuthClientOptions {
  /** The Keycloak origin, e.g. `"https://sso.example.com"`. `https:` and host only. */
  baseUrl: string;
  /** The realm name, e.g. `"acme"`. */
  realm: string;
}

/**
 * Keycloak (OIDC). Endpoints follow the modern (Keycloak 17+) `/realms/<realm>` layout; a
 * legacy instance served under `/auth` is configured with the generic `oidc()` provider.
 *
 * @param options Keycloak origin, realm, and the app's client credentials.
 * @returns The configured Keycloak provider (`id: "keycloak"`).
 */
export function keycloak(options: KeycloakOptions): OAuthProvider {
  const origin = providerOrigin(options.baseUrl, "keycloak baseUrl");
  const realm = providerSegment(options.realm, "keycloak realm");
  const base = `${origin}/realms/${realm}`;
  return oauthPreset({
    id: "keycloak",
    type: "oidc",
    issuer: base,
    authorizationUrl: `${base}/protocol/openid-connect/auth`,
    tokenUrl: `${base}/protocol/openid-connect/token`,
    jwksUrl: `${base}/protocol/openid-connect/certs`,
    discovery: true,
    scopes: ["openid", "email", "profile"],
  }, options);
}

/**
 * Map the Facebook Graph `/me` response. Graph never asserts that the address was
 * verified, so `emailVerified` stays `undefined` — an adapter will refuse to link such a
 * login to an existing local account unless the app opts in explicitly.
 *
 * @param input The flow's profile bundle (`userinfo` is the Graph `/me` body).
 * @returns The normalized {@link AuthUser}.
 */
function facebookProfile({ userinfo }: ProfileInput): AuthUser {
  const picture = userinfo?.picture as { data?: { url?: string } } | undefined;
  return {
    id: String(userinfo?.id ?? ""),
    name: userinfo?.name as string | undefined,
    email: userinfo?.email as string | undefined,
    image: typeof picture?.data?.url === "string" ? picture.data.url : undefined,
  };
}

/**
 * Facebook (OAuth 2.0, Graph API v19.0). The Graph `/me` response carries no verification
 * flag, so the mapped user's `emailVerified` is always `undefined`, and Facebook may omit
 * the email entirely (an account registered with a phone number, or a revoked permission).
 *
 * @param options The app's Facebook app credentials.
 * @returns The configured Facebook provider (`id: "facebook"`).
 */
export function facebook(options: OAuthClientOptions): OAuthProvider {
  return oauthPreset({
    id: "facebook",
    type: "oauth",
    authorizationUrl: "https://www.facebook.com/v19.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v19.0/oauth/access_token",
    userinfoUrl: "https://graph.facebook.com/me?fields=id,name,email,picture",
    scopes: ["email", "public_profile"],
    profile: facebookProfile,
  }, options);
}
