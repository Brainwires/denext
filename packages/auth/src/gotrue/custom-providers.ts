/**
 * Stored OAuth 2.0 / OIDC identity providers (`supabase.auth.admin.customProviders.*`): the
 * admin API keeps them in the adapter, and `signInWithOAuth({ provider: "custom:<name>" })`
 * signs in through one — the record becomes a denext {@linkcode OAuthProvider} for the flow in
 * `./routes-oauth.ts`, whose callback is `<origin>/auth/v1/callback` (register that URL at the
 * identity provider).
 *
 * - The client secret is sealed (AES-256-GCM, a key derived from the auth `secret` by HKDF
 *   under a label of its own, the identifier as additional data) before it reaches the
 *   adapter, and no response ever carries it.
 * - An OIDC provider's discovery document is fetched when it is saved — through denext's
 *   host-pinned, SSRF-safe provider fetch, the document's `issuer` required to match — and its
 *   endpoints stored, so a sign-in makes no discovery request. Explicit endpoints skip it.
 * - Every endpoint must be `https:` (unless `dangerouslyAllowInsecureProviders`).
 *
 * @module
 */

import {
  type CustomProviderRecord,
  type CustomProviderStore,
  customProviderStoreOf,
} from "../adapter-oauth-server.ts";
import { DiscoveryError, resolveProviderEndpoints } from "../discovery.ts";
import { base64UrlDecode, base64UrlEncode } from "../oauth.ts";
import { authSecrets } from "../totp-seal.ts";
import type { AuthUser, OAuthProvider, ProfileInput } from "../types.ts";
import { type GoTrueContext, nowSeconds, ok, readJson } from "./context.ts";
import { fail, GoTrueError } from "./errors.ts";
import { iso } from "./user.ts";

const SEAL_INFO = "denext auth: stored provider client secret (AES-256-GCM) v1";
const SEAL_PREFIX = "cps.v1.";
const IDENTIFIER_RE = /^custom:[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const encoder = new TextEncoder();

// ── sealing ──────────────────────────────────────────────────────────────────

async function sealKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("denext.auth.custom-provider"),
      info: encoder.encode(SEAL_INFO),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Seal a provider's client secret under the current auth secret.
 *
 * @param secrets The auth secrets, current first.
 * @param identifier The provider (bound as additional data).
 * @param plaintext The client secret.
 * @returns `cps.v1.<nonce>.<ciphertext‖tag>`.
 */
async function sealProviderSecret(
  secrets: string[],
  identifier: string,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(identifier) },
    await sealKey(secrets[0]),
    encoder.encode(plaintext),
  );
  return `${SEAL_PREFIX}${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(sealed))}`;
}

/**
 * Open a sealed client secret with whichever auth secret sealed it.
 *
 * @param secrets The auth secrets, current first.
 * @param identifier The provider it was sealed for.
 * @param sealed The stored value.
 * @returns The secret, or `null` when no secret opens it.
 */
async function openProviderSecret(
  secrets: string[],
  identifier: string,
  sealed: string,
): Promise<string | null> {
  if (!sealed.startsWith(SEAL_PREFIX)) return null;
  const [iv, body] = sealed.slice(SEAL_PREFIX.length).split(".");
  if (!iv || !body) return null;
  for (const secret of secrets) {
    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: new Uint8Array(base64UrlDecode(iv)),
          additionalData: encoder.encode(identifier),
        },
        await sealKey(secret),
        new Uint8Array(base64UrlDecode(body)),
      );
      return new TextDecoder().decode(plain);
    } catch { /* the next secret */ }
  }
  return null;
}

// ── records ↔ the API ────────────────────────────────────────────────────────

/** The settings fields the API reads and writes, with their kind. */
const SETTINGS: Record<string, "url" | "strings" | "bool" | "object" | "text"> = {
  acceptable_client_ids: "strings",
  scopes: "strings",
  custom_claims_allowlist: "strings",
  pkce_enabled: "bool",
  attribute_mapping: "object",
  authorization_params: "object",
  email_optional: "bool",
  issuer: "url",
  discovery_url: "url",
  skip_nonce_check: "bool",
  authorization_url: "url",
  token_url: "url",
  userinfo_url: "url",
  jwks_uri: "url",
};

function insecureAllowed(ctx: GoTrueContext): boolean {
  return ctx.config.dangerouslyAllowInsecureProviders === true;
}

function checkUrl(ctx: GoTrueContext, key: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw fail.validation(`invalid ${key}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail.validation(`invalid ${key}`);
  }
  const secure = url.protocol === "https:" || (insecureAllowed(ctx) && url.protocol === "http:");
  if (!secure || url.username || url.password || url.hash) {
    throw fail.validation(`${key} must be an https URL`);
  }
  return value;
}

function checkSetting(ctx: GoTrueContext, key: string, value: unknown): unknown {
  switch (SETTINGS[key]) {
    case "url":
      return checkUrl(ctx, key, value);
    case "strings":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length > 256)) {
        throw fail.validation(`${key} must be an array of strings`);
      }
      return value;
    case "bool":
      if (typeof value !== "boolean") throw fail.validation(`${key} must be a boolean`);
      return value;
    default:
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw fail.validation(`${key} must be an object`);
      }
      if (Object.values(value).some((v) => typeof v !== "string")) {
        throw fail.validation(`${key} values must be strings`);
      }
      return value;
  }
}

/** Apply a body's settings to a record (`null` clears one). */
function applySettings(
  ctx: GoTrueContext,
  record: CustomProviderRecord,
  body: Record<string, unknown>,
): void {
  for (const key of Object.keys(SETTINGS)) {
    if (!(key in body)) continue;
    if (body[key] === null) delete record.settings[key];
    else record.settings[key] = checkSetting(ctx, key, body[key]);
  }
  const name = requiredText(body, "name");
  const clientId = requiredText(body, "client_id");
  if (name !== undefined) record.name = name;
  if (clientId !== undefined) record.clientId = clientId;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw fail.validation("enabled must be a boolean");
    record.enabled = body.enabled;
  }
}

/** A non-empty text field, trimmed, when the body has it. */
function requiredText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw fail.validation(`${key} is required`);
  }
  return value.trim();
}

/**
 * Supabase's `CustomOAuthProvider` JSON (never the secret).
 *
 * @param record The record.
 * @returns The JSON.
 */
function providerJson(record: CustomProviderRecord): Record<string, unknown> {
  return {
    id: record.id,
    provider_type: record.providerType,
    identifier: record.identifier,
    name: record.name,
    client_id: record.clientId,
    pkce_enabled: true,
    email_optional: false,
    skip_nonce_check: false,
    ...record.settings,
    enabled: record.enabled,
    created_at: iso(record.createdAt),
    updated_at: iso(record.updatedAt),
  };
}

// ── discovery and the provider object ────────────────────────────────────────

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The endpoints a record drives: explicit ones, or the stored discovery document's. */
function endpointsOf(record: CustomProviderRecord): Record<string, string | undefined> {
  const s = record.settings;
  const doc = (s.discovery_document ?? {}) as Record<string, unknown>;
  return {
    issuer: str(s.issuer),
    authorizationUrl: str(s.authorization_url) ?? str(doc.authorization_endpoint),
    tokenUrl: str(s.token_url) ?? str(doc.token_endpoint),
    jwksUrl: str(s.jwks_uri) ?? str(doc.jwks_uri),
    userinfoUrl: str(s.userinfo_url) ?? str(doc.userinfo_endpoint),
  };
}

/** Map the provider's claims / userinfo to a user through `attribute_mapping`. */
function mapProfile(record: CustomProviderRecord): (input: ProfileInput) => AuthUser {
  const mapping = (record.settings.attribute_mapping ?? {}) as Record<string, string>;
  const emailOptional = record.settings.email_optional === true;
  return ({ claims, userinfo }) => {
    const source: Record<string, unknown> = { ...(userinfo ?? {}), ...(claims ?? {}) };
    const pick = (field: string, fallback: string) => source[mapping[field] ?? fallback];
    const id = pick("sub", "sub") ?? pick("id", "id");
    const email = str(pick("email", "email"));
    if (!email && !emailOptional) throw new Error("provider returned no email address");
    const verified = pick("email_verified", "email_verified");
    return {
      id: typeof id === "number" ? String(id) : str(id) ?? "",
      ...(email ? { email } : {}),
      emailVerified: verified === true || verified === "true",
      ...(str(pick("name", "name")) ? { name: str(pick("name", "name")) } : {}),
      ...(str(pick("picture", "picture")) ? { image: str(pick("picture", "picture")) } : {}),
    };
  };
}

/**
 * The denext provider a stored record signs in through.
 *
 * @param record The record.
 * @param clientSecret The opened client secret.
 * @returns The provider.
 */
function providerOf(record: CustomProviderRecord, clientSecret: string): OAuthProvider {
  const endpoints = endpointsOf(record);
  const scopes = (record.settings.scopes as string[] | undefined) ??
    (record.providerType === "oidc" ? ["openid", "email", "profile"] : []);
  return {
    id: record.identifier,
    type: record.providerType === "oidc" ? "oidc" : "oauth",
    authorizationUrl: endpoints.authorizationUrl ?? "",
    tokenUrl: endpoints.tokenUrl ?? "",
    ...(endpoints.userinfoUrl ? { userinfoUrl: endpoints.userinfoUrl } : {}),
    ...(endpoints.issuer ? { issuer: endpoints.issuer } : {}),
    ...(endpoints.jwksUrl ? { jwksUrl: endpoints.jwksUrl } : {}),
    scopes,
    clientId: record.clientId,
    clientSecret,
    profile: mapProfile(record),
    ...(record.settings.authorization_params
      ? { authorizationParams: record.settings.authorization_params as Record<string, string> }
      : {}),
  };
}

/** Check a record is complete, and fetch an OIDC provider's discovery document. */
async function resolveEndpoints(ctx: GoTrueContext, record: CustomProviderRecord): Promise<void> {
  const s = record.settings;
  if (record.providerType === "oauth2") {
    if (!s.authorization_url || !s.token_url || !s.userinfo_url) {
      throw fail.validation("an oauth2 provider needs authorization_url, token_url, userinfo_url");
    }
    return;
  }
  if (!s.issuer) throw fail.validation("an oidc provider needs an issuer");
  if (s.authorization_url && s.token_url && s.jwks_uri) {
    delete s.discovery_document;
    return;
  }
  const issuer = String(s.issuer);
  const wellKnown = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  if (s.discovery_url && s.discovery_url !== wellKnown) {
    throw fail.validation("discovery_url must be the issuer's /.well-known/openid-configuration");
  }
  s.discovery_document = await discover(ctx, record, issuer);
}

async function discover(
  ctx: GoTrueContext,
  record: CustomProviderRecord,
  issuer: string,
): Promise<Record<string, unknown>> {
  const probe = { ...providerOf(record, ""), discovery: { issuer } };
  try {
    const endpoints = await resolveProviderEndpoints(probe, {
      allowInsecure: insecureAllowed(ctx),
    });
    return {
      issuer,
      authorization_endpoint: endpoints.authorizationUrl,
      token_endpoint: endpoints.tokenUrl,
      jwks_uri: endpoints.jwksUrl,
      ...(endpoints.userinfoUrl ? { userinfo_endpoint: endpoints.userinfoUrl } : {}),
    };
  } catch (error) {
    throw fail.validation(
      `the OIDC discovery document could not be used${
        error instanceof DiscoveryError ? ` (${error.code})` : ""
      }`,
    );
  }
}

// ── the store and lookups ────────────────────────────────────────────────────

function store(ctx: GoTrueContext): CustomProviderStore {
  const found = customProviderStoreOf(ctx.adapter);
  if (!found) {
    throw new GoTrueError(500, "unexpected_failure", "the auth adapter keeps no custom providers");
  }
  return found;
}

/** Providers built from records, so a flow can tell them from configured ones. */
const STORED = new WeakSet<OAuthProvider>();

/**
 * Whether a provider object was built from a stored record.
 *
 * @param provider The provider.
 * @returns `true` for a stored one.
 */
export function isStoredProvider(provider: OAuthProvider): boolean {
  return STORED.has(provider);
}

/**
 * The enabled stored provider named `identifier`, ready for a flow.
 *
 * @param ctx The context (adapter, auth secret).
 * @param identifier `custom:<name>`.
 * @returns The provider, or `undefined`.
 */
export async function storedProvider(
  ctx: Pick<GoTrueContext, "adapter" | "config">,
  identifier: string,
): Promise<OAuthProvider | undefined> {
  if (!IDENTIFIER_RE.test(identifier)) return undefined;
  const providers = customProviderStoreOf(ctx.adapter);
  const record = await providers?.getCustomProvider(identifier);
  if (!record || !record.enabled) return undefined;
  const secret = await openProviderSecret(
    authSecrets(ctx.config.secret),
    identifier,
    record.clientSecretSealed,
  );
  if (secret === null) return undefined;
  const provider = providerOf(record, secret);
  STORED.add(provider);
  return provider;
}

async function recordOf(ctx: GoTrueContext): Promise<CustomProviderRecord> {
  const identifier = ctx.params.identifier;
  const record = IDENTIFIER_RE.test(identifier)
    ? await store(ctx).getCustomProvider(identifier)
    : undefined;
  if (!record) {
    throw new GoTrueError(404, "custom_provider_not_found", "Custom provider not found");
  }
  return record;
}

// ── the admin API ────────────────────────────────────────────────────────────

/** `GET /admin/custom-providers?type=`. */
export async function listProviders(ctx: GoTrueContext): Promise<Response> {
  const type = ctx.url.searchParams.get("type");
  const providers = (await store(ctx).listCustomProviders())
    .filter((record) => !type || record.providerType === type);
  return ok({ providers: providers.map(providerJson) });
}

/** `POST /admin/custom-providers`. */
export async function createProvider(ctx: GoTrueContext): Promise<Response> {
  const providers = store(ctx);
  const body = await readJson(ctx);
  const type = body.provider_type;
  if (type !== "oauth2" && type !== "oidc") throw fail.validation("invalid provider_type");
  const raw = typeof body.identifier === "string" ? body.identifier.trim() : "";
  const identifier = raw.startsWith("custom:") ? raw : `custom:${raw}`;
  if (!IDENTIFIER_RE.test(identifier)) throw fail.validation("invalid identifier");
  const secret = body.client_secret;
  if (typeof secret !== "string" || !secret || secret.length > 4096) {
    throw fail.validation("client_secret is required");
  }
  if (body.name === undefined || body.client_id === undefined) {
    throw fail.validation("name and client_id are required");
  }
  const at = nowSeconds();
  const record: CustomProviderRecord = {
    id: crypto.randomUUID(),
    identifier,
    providerType: type,
    name: "",
    clientId: "",
    clientSecretSealed: await sealProviderSecret(
      authSecrets(ctx.config.secret),
      identifier,
      secret,
    ),
    enabled: true,
    settings: {},
    createdAt: at,
    updatedAt: at,
  };
  applySettings(ctx, record, body);
  await resolveEndpoints(ctx, record);
  if (!(await providers.createCustomProvider(record))) {
    throw new GoTrueError(422, "validation_failed", "A provider with this identifier exists");
  }
  return ok(providerJson(record), 201);
}

/** `GET /admin/custom-providers/:identifier`. */
export async function getProvider(ctx: GoTrueContext): Promise<Response> {
  return ok(providerJson(await recordOf(ctx)));
}

/** `PUT /admin/custom-providers/:identifier` (`provider_type` and `identifier` are fixed). */
export async function updateProvider(ctx: GoTrueContext): Promise<Response> {
  const record = await recordOf(ctx);
  const body = await readJson(ctx);
  if (body.provider_type !== undefined && body.provider_type !== record.providerType) {
    throw fail.validation("provider_type cannot be changed");
  }
  applySettings(ctx, record, body);
  if (typeof body.client_secret === "string" && body.client_secret) {
    if (body.client_secret.length > 4096) throw fail.validation("client_secret is too long");
    record.clientSecretSealed = await sealProviderSecret(
      authSecrets(ctx.config.secret),
      record.identifier,
      body.client_secret,
    );
  }
  await resolveEndpoints(ctx, record);
  record.updatedAt = nowSeconds();
  await store(ctx).updateCustomProvider(record);
  return ok(providerJson(record));
}

/** `DELETE /admin/custom-providers/:identifier`. */
export async function deleteProvider(ctx: GoTrueContext): Promise<Response> {
  const record = await recordOf(ctx);
  await store(ctx).deleteCustomProvider(record.identifier);
  return new Response(null, { status: 204 });
}
