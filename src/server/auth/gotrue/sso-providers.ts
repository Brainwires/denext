/**
 * The SAML identity providers `/auth/v1` knows: the ones declared in config and the ones stored
 * through the SSO admin API, resolved to one shape; this service provider's own configuration
 * (entity id, ACS / SLO URLs, keys); the replay cache every replica shares; and the SSRF-safe,
 * cached fetch of a provider's metadata URL.
 *
 * @module
 */

import type { AuthAdapter, SsoAttributeMapping, SsoProviderRecord } from "../adapter.ts";
import { makeHostPinnedFetch } from "../flow.ts";
import { sha256Hex } from "../hash.ts";
import { resolveAuthOptions } from "../options.ts";
import { safeFetch } from "../../safe-fetch.ts";
import { checkKeyPair } from "../saml/keys.ts";
import {
  inMemorySamlReplayCache,
  parseIdpMetadata,
  type SamlIdpConfig,
  type SamlReplayCache,
  type SamlSpConfig,
} from "../saml/mod.ts";
import { MAX_XML_BYTES } from "../saml/xml.ts";
import { GOTRUE_PREFIX, type GoTrueContext } from "./context.ts";
import { GoTrueError } from "./errors.ts";
import type { GoTrueSamlProvider } from "./options.ts";

/** The adapter's SSO group. */
export type SsoAdapter = Required<
  Pick<
    AuthAdapter,
    | "createSsoProvider"
    | "updateSsoProvider"
    | "getSsoProvider"
    | "getSsoProviderByEntityId"
    | "getSsoProviderByDomain"
    | "listSsoProviders"
    | "deleteSsoProvider"
    | "createSsoSession"
    | "listSsoSessions"
    | "claimSamlMessageId"
  >
>;

const SSO_METHODS = [
  "createSsoProvider",
  "updateSsoProvider",
  "getSsoProvider",
  "getSsoProviderByEntityId",
  "getSsoProviderByDomain",
  "listSsoProviders",
  "deleteSsoProvider",
  "createSsoSession",
  "listSsoSessions",
  "claimSamlMessageId",
] as const;

/**
 * The adapter's SSO group, or `null` when it keeps none.
 *
 * @param adapter The auth adapter.
 * @returns The adapter narrowed to the SSO methods.
 */
export function ssoAdapterOf(adapter: AuthAdapter | undefined): SsoAdapter | null {
  if (!adapter) return null;
  return SSO_METHODS.every((m) => typeof adapter[m] === "function") ? adapter as SsoAdapter : null;
}

/** A provider, config-declared or stored, as the SSO routes use it. */
export interface SsoProvider {
  /** The provider id. */
  id: string;
  /** Where it was declared. */
  source: "config" | "stored";
  /** Its email domains (lower-case). */
  domains: string[];
  /** The IdP, from its metadata. */
  idp: SamlIdpConfig;
  /** How attributes map to user metadata. */
  mapping: SsoAttributeMapping;
  /** The NameID format to request. */
  nameIdFormat?: string;
}

/** 404 `sso_provider_not_found`. */
export function providerNotFound(): GoTrueError {
  return new GoTrueError(404, "sso_provider_not_found", "No SSO provider assigned for this domain");
}

/**
 * Refuse the SSO routes when `/auth/v1` has no `saml` options.
 *
 * @param ctx The context.
 * @returns The SAML options.
 */
export function samlOptions(ctx: GoTrueContext): NonNullable<GoTrueContext["options"]["saml"]> {
  const saml = ctx.options.saml;
  if (!saml) throw new GoTrueError(404, "saml_provider_disabled", "SAML 2.0 is disabled");
  return saml;
}

const parsed = new Map<string, SamlIdpConfig>();

/**
 * Parse IdP metadata, memoized by its text (a bounded cache).
 *
 * @param xml The metadata.
 * @returns The IdP.
 */
export function idpFromMetadata(xml: string): SamlIdpConfig {
  let idp = parsed.get(xml);
  if (!idp) {
    idp = parseIdpMetadata(xml);
    if (parsed.size >= 256) parsed.delete(parsed.keys().next().value as string);
    parsed.set(xml, idp);
  }
  return idp;
}

function fromConfig(provider: GoTrueSamlProvider): SsoProvider {
  const keys: NonNullable<SsoAttributeMapping["keys"]> = {};
  for (const [field, name] of Object.entries(provider.attributeMapping ?? {})) {
    keys[field] = { name };
  }
  return {
    id: provider.id,
    source: "config",
    domains: (provider.domains ?? []).map((d) => d.toLowerCase()),
    idp: idpFromMetadata(provider.metadataXml),
    mapping: { keys },
  };
}

function fromRecord(record: SsoProviderRecord): SsoProvider {
  const out: SsoProvider = {
    id: record.id,
    source: "stored",
    domains: record.domains,
    idp: idpFromMetadata(record.metadataXml),
    mapping: record.attributeMapping ?? {},
  };
  if (record.nameIdFormat) out.nameIdFormat = record.nameIdFormat;
  return out;
}

/** The config-declared providers. */
export function configProviders(ctx: GoTrueContext): GoTrueSamlProvider[] {
  return ctx.options.saml?.providers ?? [];
}

/** What to look a provider up by. */
export type ProviderLookup = { id: string } | { domain: string } | { entityId: string };

function configMatch(ctx: GoTrueContext, by: ProviderLookup): GoTrueSamlProvider | undefined {
  return configProviders(ctx).find((p) =>
    "id" in by
      ? p.id === by.id
      : "domain" in by
      ? (p.domains ?? []).some((d) => d.toLowerCase() === by.domain.toLowerCase())
      : idpFromMetadata(p.metadataXml).entityId === by.entityId
  );
}

async function storedMatch(
  ctx: GoTrueContext,
  by: ProviderLookup,
): Promise<SsoProviderRecord | undefined> {
  const store = ssoAdapterOf(ctx.adapter);
  if (!store) return undefined;
  if ("id" in by) {
    return /^[\w-]{1,128}$/.test(by.id) ? await store.getSsoProvider(by.id) : undefined;
  }
  if ("domain" in by) return await store.getSsoProviderByDomain(by.domain.toLowerCase());
  return await store.getSsoProviderByEntityId(by.entityId);
}

/**
 * The provider for an id, a domain or an IdP entity id — config-declared first, then stored (a
 * stored one's metadata URL refreshed when its cached copy is stale).
 *
 * @param ctx The context.
 * @param by What to look up.
 * @returns The provider.
 * @throws {GoTrueError} 404 `sso_provider_not_found`.
 */
export async function findProvider(ctx: GoTrueContext, by: ProviderLookup): Promise<SsoProvider> {
  const declared = configMatch(ctx, by);
  if (declared) return fromConfig(declared);
  const stored = await storedMatch(ctx, by);
  if (!stored) throw providerNotFound();
  return fromRecord(await refreshed(ctx, stored));
}

// ---- metadata URLs -----------------------------------------------------------------------

/** How long a fetched metadata document is used before it is fetched again, seconds. */
const METADATA_TTL = 24 * 3600;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Refuse a metadata URL that is not HTTPS (http only for loopback, in development). */
export function checkMetadataUrl(ctx: GoTrueContext, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GoTrueError(400, "validation_failed", "metadata_url is not a valid URL");
  }
  const devLoopback = url.protocol === "http:" && LOOPBACK.has(url.hostname) &&
    ctx.config.dangerouslyAllowInsecureProviders === true;
  if (url.protocol !== "https:" && !devLoopback) {
    throw new GoTrueError(400, "validation_failed", "metadata_url needs to use HTTPS");
  }
  if (url.username || url.password) {
    throw new GoTrueError(400, "validation_failed", "metadata_url must not carry credentials");
  }
  return url;
}

async function cappedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_XML_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("metadata too large");
    }
    chunks.push(value);
  }
  const all = await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer();
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

/**
 * Fetch a metadata URL SSRF-safely: `safeFetch` pinned to the URL's host (private addresses
 * refused, every redirect re-checked, size and time bounded); a loopback `http` URL only under
 * `dangerouslyAllowInsecureProviders` (development), still host-pinned.
 *
 * @param ctx The context.
 * @param url The (checked) URL.
 * @returns The metadata XML.
 * @throws {GoTrueError} 400 `saml_metadata_fetch_failed`.
 */
export async function fetchMetadata(ctx: GoTrueContext, url: URL): Promise<string> {
  const headers = { accept: "application/samlmetadata+xml, application/xml, text/xml" };
  try {
    const response = url.protocol === "https:"
      ? await safeFetch(url, {
        allowedHosts: [url.hostname],
        headers,
        maxBytes: MAX_XML_BYTES,
        timeoutMs: 10_000,
      })
      : await makeHostPinnedFetch([url.host], "saml-metadata", true)(url.href, {
        method: "GET",
        headers,
      });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    return await cappedText(response);
  } catch (error) {
    resolveAuthOptions(ctx.config).logger.warn("/auth/v1: SAML metadata fetch failed", {
      host: url.host,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new GoTrueError(400, "saml_metadata_fetch_failed", "Unable to fetch SAML metadata");
  }
}

const fetchedAt = new Map<string, number>();
const inflight = new Map<string, Promise<SsoProviderRecord>>();

/** A stored provider with its metadata re-fetched when the cached copy is older than the TTL. */
function refreshed(ctx: GoTrueContext, record: SsoProviderRecord): Promise<SsoProviderRecord> {
  if (!record.metadataUrl) return Promise.resolve(record);
  const last = fetchedAt.get(record.id) ?? record.updatedAt;
  if (Math.floor(Date.now() / 1000) - last < METADATA_TTL) return Promise.resolve(record);
  let pending = inflight.get(record.id);
  if (!pending) {
    pending = refetch(ctx, record).finally(() => inflight.delete(record.id));
    inflight.set(record.id, pending);
  }
  return pending;
}

/** Fetch again; a failure (or a document for another entity) keeps the cached copy. */
async function refetch(ctx: GoTrueContext, record: SsoProviderRecord): Promise<SsoProviderRecord> {
  const now = Math.floor(Date.now() / 1000);
  fetchedAt.set(record.id, now);
  try {
    const xml = await fetchMetadata(ctx, checkMetadataUrl(ctx, record.metadataUrl!));
    if (xml === record.metadataXml) return record;
    if (idpFromMetadata(xml).entityId !== record.entityId) throw new Error("entity id changed");
    const next = { ...record, metadataXml: xml, updatedAt: now };
    const store = ssoAdapterOf(ctx.adapter);
    if (store && (await store.updateSsoProvider(next)) === "ok") return next;
    return record;
  } catch (error) {
    resolveAuthOptions(ctx.config).logger.warn(
      "/auth/v1: SAML metadata refresh failed; the cached copy stays in use",
      { provider: record.id, error: error instanceof Error ? error.message : String(error) },
    );
    return record;
  }
}

// ---- this SP ------------------------------------------------------------------------------

/**
 * This service provider: entity id, ACS URL, the SLO URL (when a signing key turns Single
 * Logout on) and its keys — each key checked once against its certificate.
 *
 * @param ctx The context.
 * @returns The SP configuration.
 */
export async function spOf(ctx: GoTrueContext): Promise<SamlSpConfig> {
  const saml = samlOptions(ctx);
  const base = `${ctx.origin}${GOTRUE_PREFIX}/sso/saml`;
  const sp: SamlSpConfig = { entityId: saml.entityId ?? `${base}/metadata`, acsUrl: `${base}/acs` };
  if (saml.signingKey) {
    if (!saml.signingCertificate) throw new Error("saml.signingKey needs saml.signingCertificate");
    await checkKeyPair(saml.signingKey, saml.signingCertificate);
    Object.assign(sp, {
      sloUrl: `${base}/slo`,
      signingKey: saml.signingKey,
      signingCertificate: saml.signingCertificate,
    });
  }
  if (saml.encryptionKey) {
    if (!saml.encryptionCertificate) {
      throw new Error("saml.encryptionKey needs saml.encryptionCertificate");
    }
    await checkKeyPair(saml.encryptionKey, saml.encryptionCertificate);
    sp.encryptionKey = saml.encryptionKey;
    sp.encryptionCertificate = saml.encryptionCertificate;
  }
  return sp;
}

const processCache = inMemorySamlReplayCache();

/**
 * The SAML message-id replay cache: the adapter's (shared by every replica) when it keeps one,
 * else a process-local one. Ids are namespaced and hashed to a fixed length.
 *
 * @param ctx The context.
 * @param namespace What kind of id (`assertion`, `logout`).
 * @returns The cache.
 */
export function replayCacheOf(ctx: GoTrueContext, namespace: string): SamlReplayCache {
  const store = ssoAdapterOf(ctx.adapter);
  return {
    async claim(id, expiresAt) {
      const key = await sha256Hex(`gotrue-saml:${namespace}:${id}`);
      return store
        ? await store.claimSamlMessageId(key, expiresAt)
        : await processCache.claim(key, expiresAt);
    },
  };
}
