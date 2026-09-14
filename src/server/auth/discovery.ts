/**
 * OIDC discovery: turn a provider that knows only its `issuer` into the four endpoints
 * the flow needs, by reading `<issuer>/.well-known/openid-configuration`
 * (OpenID Connect Discovery 1.0 §4 / RFC 8414).
 *
 * Discovery is a document fetched over the network that then *decides where denext sends
 * a client secret and from where it takes signing keys*, so it is treated as hostile
 * until proven otherwise:
 *
 * - the request is pinned to the **issuer's own host** (SSRF — `safeFetch` already
 *   refuses loopback/private addresses, and the host pin closes the rest);
 * - the document's `issuer` must equal the configured one **byte for byte** (RFC 8414
 *   §3.3) — otherwise a compromised host could hand us another IdP's identity;
 * - every endpoint must be `https:` and live on the issuer's host, or on a host the app
 *   listed in `provider.allowedHosts`. That is deliberately stricter than the spec: an
 *   IdP whose endpoints live on a sibling domain (Google's `oauth2.googleapis.com` for
 *   the `accounts.google.com` issuer) must say so explicitly — which is also why Google
 *   pins its endpoints and declares no `discovery`;
 * - the discovered document wins over statically pinned endpoints, but a provider that
 *   pins them keeps working when discovery fails (the failure is reported, not hidden);
 * - a document is cached per issuer for its `Cache-Control: max-age` (1 hour by default)
 *   only once its endpoints have been **vetted** — a failure, of the fetch or of the
 *   vetting, is never cached, and concurrent cold resolutions share ONE round-trip;
 * - nothing here throws a raw network error into the sign-in path — every refusal is a
 *   {@linkcode DiscoveryError} with a stable `code`, which the routes turn into a
 *   `?error=config` redirect.
 *
 * @module
 */

import { makeHostPinnedFetch, type ProviderFetch } from "./flow.ts";
import { cacheTtlMs } from "./jwks-cache.ts";
import type { OAuthProvider } from "./types.ts";

/** Why endpoint resolution refused — stable, machine-readable, never a secret. */
export type DiscoveryErrorCode =
  /** The provider has neither complete endpoints nor a `discovery.issuer`. */
  | "missing_issuer"
  /** The discovery document could not be fetched (network error, non-2xx). */
  | "unreachable"
  /** The document is not JSON, or an endpoint is not a URL. */
  | "malformed"
  /** The document's `issuer` is not the configured one. */
  | "issuer_mismatch"
  /** An endpoint (or the issuer) is not `https:`. */
  | "insecure_endpoint"
  /** An endpoint points at a host that is neither the issuer's nor allow-listed. */
  | "foreign_endpoint"
  /** The document omits an endpoint this provider needs. */
  | "missing_endpoint";

/**
 * A refusal to resolve a provider's endpoints. Carries a stable {@link DiscoveryErrorCode}
 * so the routes can answer `?error=config` without ever surfacing the provider's response.
 */
export class DiscoveryError extends Error {
  /** The machine-readable reason. */
  readonly code: DiscoveryErrorCode;

  /**
   * @param code The machine-readable reason.
   * @param message A developer-facing explanation (logged, never shown to the user).
   */
  constructor(code: DiscoveryErrorCode, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}

/** The endpoints one OAuth/OIDC provider runs on, however they were obtained. */
export interface ProviderEndpoints {
  /** The expected `iss` — present for OIDC providers, absent for plain OAuth ones. */
  issuer?: string;
  /** Authorization endpoint (where the browser is sent). */
  authorizationUrl: string;
  /** Token endpoint (where the code is exchanged). */
  tokenUrl: string;
  /** JWKS endpoint — present for OIDC providers. */
  jwksUrl?: string;
  /** Userinfo endpoint, when the provider has one. */
  userinfoUrl?: string;
}

/** Options for {@link resolveProviderEndpoints}. */
export interface ResolveEndpointsOptions {
  /**
   * The fetch used for the discovery request. Defaults to an SSRF-safe fetch pinned to
   * the issuer's host; pass one only in tests or to route through a proxy.
   */
  fetchImpl?: ProviderFetch;
  /**
   * Permit an `http://` issuer/endpoints (development only — mirrors
   * `AuthConfig.dangerouslyAllowInsecureProviders`).
   */
  allowInsecure?: boolean;
  /** Current time in ms (injectable for tests; defaults to `Date.now()`). */
  now?: number;
  /**
   * Called when discovery failed but the provider also pins its endpoints, so those were
   * used instead. The flow logs it as a warning — a preset keeps working through an IdP
   * blip, and the operator still hears about it.
   */
  onDiscoveryError?: (error: DiscoveryError) => void;
}

/** The subset of the discovery document denext reads. */
interface DiscoveryDocument {
  /** The issuer identifier the document claims. */
  issuer: string;
  /** Authorization endpoint. */
  authorization_endpoint?: unknown;
  /** Token endpoint. */
  token_endpoint?: unknown;
  /** JWKS endpoint. */
  jwks_uri?: unknown;
  /** Userinfo endpoint. */
  userinfo_endpoint?: unknown;
}

/** What an endpoint URL from a discovery document must satisfy. */
interface EndpointRules {
  /** Hosts an endpoint may live on: the issuer's, plus the provider's `allowedHosts`. */
  allowedHosts: Set<string>;
  /** Whether a non-`https:` endpoint is tolerated (development). */
  allowInsecure: boolean;
}

/** Cached documents, keyed by the configured issuer. Failures are never stored. */
const documentCache = new Map<string, { doc: DiscoveryDocument; expiresAt: number }>();

/**
 * Round-trips in flight, keyed by issuer, so 50 concurrent cold sign-ins make ONE request
 * to the IdP instead of 50. The entry is dropped as soon as it settles: a failure is never
 * shared beyond the callers that were already waiting on it.
 */
const inFlightDocuments = new Map<string, Promise<{ doc: DiscoveryDocument; ttlMs: number }>>();

/**
 * The endpoints to drive this provider with.
 *
 * A provider that names a `discovery.issuer` is resolved from its discovery document —
 * the document is authoritative, so an IdP that moves an endpoint is followed without a
 * denext release. A provider that *also* pins its endpoints statically (every built-in
 * OIDC preset does) falls back to those pinned URLs when discovery fails, so an
 * unreachable or untrustworthy document degrades to today's behaviour instead of taking
 * logins down; `onDiscoveryError` reports that it happened. A provider with no
 * `discovery` uses its configured endpoints and never makes the request.
 *
 * @param provider The OAuth/OIDC provider.
 * @param options The discovery fetch, insecure-scheme opt-in, fallback hook, and clock.
 * @returns The resolved {@link ProviderEndpoints}.
 * @throws {DiscoveryError} When the provider can't be resolved at all — the caller maps
 * this to a `?error=config` redirect rather than a 500.
 */
export async function resolveProviderEndpoints(
  provider: OAuthProvider,
  options: ResolveEndpointsOptions = {},
): Promise<ProviderEndpoints> {
  const configured = configuredEndpoints(provider);
  const issuer = provider.discovery?.issuer;
  if (!issuer) {
    if (configured) return configured;
    throw new DiscoveryError(
      "missing_issuer",
      `auth: provider "${provider.id}" is missing endpoints and has no \`discovery.issuer\` ` +
        "to fetch them from",
    );
  }
  try {
    return await discoverEndpoints(provider, issuer, options);
  } catch (error) {
    if (!configured || !(error instanceof DiscoveryError)) throw error;
    options.onDiscoveryError?.(error);
    return configured;
  }
}

/**
 * Fetch (or reuse) the issuer's document and turn it into vetted endpoints.
 *
 * The order matters: the document is vetted **before** it is cached. Caching first meant a
 * document whose endpoints were refused (a foreign `token_endpoint`, a plaintext one) was
 * still pinned for an hour, so every login in that hour re-derived the same refusal from a
 * document the IdP may already have fixed.
 */
async function discoverEndpoints(
  provider: OAuthProvider,
  issuer: string,
  options: ResolveEndpointsOptions,
): Promise<ProviderEndpoints> {
  const issuerUrl = parseIssuer(issuer, options.allowInsecure ?? false, provider.id);
  const rules: EndpointRules = {
    allowedHosts: new Set([issuerUrl.host, ...(provider.allowedHosts ?? [])]),
    allowInsecure: options.allowInsecure ?? false,
  };
  const needsJwks = provider.type === "oidc";
  const now = options.now ?? Date.now();
  const cached = documentCache.get(issuer);
  if (cached && cached.expiresAt > now) {
    return endpointsFromDocument(cached.doc, rules, needsJwks);
  }
  const { doc, ttlMs } = await loadDiscoveryDocument(issuer, issuerUrl, provider, options);
  const endpoints = endpointsFromDocument(doc, rules, needsJwks); // throws ⇒ nothing cached
  documentCache.set(issuer, { doc, expiresAt: now + ttlMs });
  return endpoints;
}

/**
 * The hosts a set of resolved endpoints reaches — what the provider fetch is pinned to
 * once discovery has run (the provider itself may declare no URL at all).
 *
 * @param endpoints The resolved endpoints.
 * @returns The distinct hosts, skipping anything unparseable.
 */
export function endpointHosts(endpoints: ProviderEndpoints): string[] {
  const hosts = new Set<string>();
  for (
    const url of [
      endpoints.authorizationUrl,
      endpoints.tokenUrl,
      endpoints.jwksUrl,
      endpoints.userinfoUrl,
    ]
  ) {
    if (!url) continue;
    try {
      hosts.add(new URL(url).host);
    } catch { /* an endpoint that didn't parse was already refused */ }
  }
  return [...hosts];
}

/**
 * The provider's own endpoints, when it declares everything its type needs — an OIDC
 * provider also needs an `issuer` and a `jwksUrl` to verify an `id_token` with. Returns
 * `null` when something is missing, which is what sends the caller to discovery.
 *
 * These are what a provider without `discovery` runs on, and what a provider WITH
 * discovery falls back to when the document can't be fetched or can't be trusted.
 */
function configuredEndpoints(provider: OAuthProvider): ProviderEndpoints | null {
  const authorizationUrl = realEndpoint(provider.authorizationUrl);
  const tokenUrl = realEndpoint(provider.tokenUrl);
  const jwksUrl = realEndpoint(provider.jwksUrl);
  const oidcReady = provider.type !== "oidc" || (!!provider.issuer && !!jwksUrl);
  if (!authorizationUrl || !tokenUrl || !oidcReady) return null;
  return {
    issuer: provider.issuer,
    authorizationUrl,
    tokenUrl,
    jwksUrl,
    userinfoUrl: realEndpoint(provider.userinfoUrl),
  };
}

/**
 * An endpoint a provider actually declared. `OAuthProvider.authorizationUrl`/`tokenUrl`
 * are required strings, so a discovery-only provider has to stand *something* in their
 * place: both the empty string and the issuer's well-known URL (never a real
 * authorization/token/JWKS endpoint) read as "not configured" here.
 */
function realEndpoint(url: string | undefined): string | undefined {
  if (!url || url.endsWith("/.well-known/openid-configuration")) return undefined;
  return url;
}

/** Parse and vet the configured issuer: a real absolute URL, and `https:` in production. */
function parseIssuer(issuer: string, allowInsecure: boolean, providerId: string): URL {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new DiscoveryError(
      "malformed",
      `auth: provider "${providerId}" has a \`discovery.issuer\` that is not a URL`,
    );
  }
  if (url.protocol !== "https:" && !allowInsecure) {
    throw new DiscoveryError(
      "insecure_endpoint",
      `auth: provider "${providerId}" has a non-https \`discovery.issuer\``,
    );
  }
  return url;
}

/**
 * One round-trip for this issuer — shared with anything already waiting for it, so a cold
 * cache under a login burst costs the IdP one request rather than one per sign-in.
 */
function loadDiscoveryDocument(
  issuer: string,
  issuerUrl: URL,
  provider: OAuthProvider,
  options: ResolveEndpointsOptions,
): Promise<{ doc: DiscoveryDocument; ttlMs: number }> {
  const existing = inFlightDocuments.get(issuer);
  if (existing) return existing;
  const doFetch = options.fetchImpl ??
    makeHostPinnedFetch([issuerUrl.host], provider.id, options.allowInsecure ?? false);
  const pending = fetchDiscoveryDocument(issuer, doFetch).finally(() => {
    inFlightDocuments.delete(issuer);
  });
  inFlightDocuments.set(issuer, pending);
  return pending;
}

/**
 * One discovery round-trip: fetch, parse, and check the document's own `issuer`. Nothing
 * is cached unless all three succeed, so an IdP blip can't pin a bad answer for an hour.
 */
async function fetchDiscoveryDocument(
  issuer: string,
  doFetch: ProviderFetch,
): Promise<{ doc: DiscoveryDocument; ttlMs: number }> {
  // The well-known path is appended to the issuer, trailing slash or not (RFC 8414 §3.1).
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await doFetch(url, { method: "GET", headers: { "accept": "application/json" } });
  } catch (error) {
    throw new DiscoveryError(
      "unreachable",
      `auth: could not fetch the discovery document for ${issuer}: ${describe(error)}`,
    );
  }
  if (!res.ok) {
    throw new DiscoveryError(
      "unreachable",
      `auth: the discovery document for ${issuer} responded ${res.status}`,
    );
  }
  const body = await res.json().catch(() => null) as DiscoveryDocument | null;
  if (!body || typeof body !== "object" || typeof body.issuer !== "string") {
    throw new DiscoveryError(
      "malformed",
      `auth: the discovery document for ${issuer} is not a discovery document`,
    );
  }
  if (body.issuer !== issuer) {
    throw new DiscoveryError(
      "issuer_mismatch",
      `auth: the discovery document at ${issuer} declares issuer "${body.issuer}"`,
    );
  }
  return { doc: body, ttlMs: cacheTtlMs(res.headers) };
}

/** Map a validated document to {@link ProviderEndpoints}, vetting every URL it names. */
function endpointsFromDocument(
  doc: DiscoveryDocument,
  rules: EndpointRules,
  needsJwks: boolean,
): ProviderEndpoints {
  return {
    issuer: doc.issuer,
    authorizationUrl: endpointUrl(
      doc.authorization_endpoint,
      "authorization_endpoint",
      rules,
      true,
    )!,
    tokenUrl: endpointUrl(doc.token_endpoint, "token_endpoint", rules, true)!,
    jwksUrl: endpointUrl(doc.jwks_uri, "jwks_uri", rules, needsJwks),
    userinfoUrl: endpointUrl(doc.userinfo_endpoint, "userinfo_endpoint", rules, false),
  };
}

/**
 * One endpoint from the document: present when required, a parseable URL without
 * embedded credentials, `https:`, and on a permitted host.
 */
function endpointUrl(
  raw: unknown,
  field: string,
  rules: EndpointRules,
  required: boolean,
): string | undefined {
  if (typeof raw !== "string" || raw === "") {
    if (!required) return undefined;
    throw new DiscoveryError(
      "missing_endpoint",
      `auth: the discovery document has no \`${field}\``,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DiscoveryError("malformed", `auth: discovery \`${field}\` is not a URL`);
  }
  if (url.username || url.password) {
    throw new DiscoveryError(
      "malformed",
      `auth: discovery \`${field}\` carries embedded credentials`,
    );
  }
  if (url.protocol !== "https:" && !rules.allowInsecure) {
    throw new DiscoveryError("insecure_endpoint", `auth: discovery \`${field}\` is not https`);
  }
  if (!rules.allowedHosts.has(url.host)) {
    throw new DiscoveryError(
      "foreign_endpoint",
      `auth: discovery \`${field}\` points at ${url.host}, which is neither the issuer's host ` +
        "nor listed in the provider's `allowedHosts`",
    );
  }
  return url.href;
}

/** A one-line description of a thrown value, for the developer-facing message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
