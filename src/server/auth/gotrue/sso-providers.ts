/**
 * The SAML identity providers `/auth/v1` knows: the ones declared in config and the ones stored
 * through the SSO admin API, resolved to one shape; this service provider's own configuration
 * (entity id, ACS / SLO URLs, keys); and the replay cache every replica shares. A provider's
 * metadata (its refresh from a metadata URL, its expiry) is `sso-metadata.ts`'s.
 *
 * @module
 */

import type { AuthAdapter, SsoAttributeMapping, SsoProviderRecord } from "../adapter.ts";
import { backendPostgresClient } from "../backend-postgres.ts";
import { sha256Hex } from "../hash.ts";
import { postgresAuthAdapter } from "../postgres-adapter.ts";
import type { SqlClient } from "../../postgres.ts";
import { checkKeyPair } from "../saml/keys.ts";
import {
  inMemorySamlReplayCache,
  type ParsedIdpMetadata,
  type SamlReplayCache,
  type SamlSpConfig,
} from "../saml/mod.ts";
import { GOTRUE_PREFIX, type GoTrueContext } from "./context.ts";
import { GoTrueError } from "./errors.ts";
import type { GoTrueSamlProvider } from "./options.ts";
import {
  assertIdpEndpoints,
  assertMetadataFresh,
  idpFromMetadata,
  refreshProvider,
} from "./sso-metadata.ts";

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
  idp: ParsedIdpMetadata;
  /** How attributes map to user metadata. */
  mapping: SsoAttributeMapping;
  /** The NameID format to request. */
  nameIdFormat?: string;
  /** Link a first sign-in to an existing account on its domains (config providers only). */
  linkExistingAccounts: boolean;
  /** Create new users on a first sign-in. */
  allowSignUp: boolean;
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
    linkExistingAccounts: provider.linkExistingAccounts === true,
    allowSignUp: provider.allowSignUp !== false,
  };
}

function fromRecord(record: SsoProviderRecord): SsoProvider {
  const out: SsoProvider = {
    id: record.id,
    source: "stored",
    domains: record.domains,
    idp: idpFromMetadata(record.metadataXml),
    mapping: record.attributeMapping ?? {},
    // A provider registered through the admin API (possibly by a tenant) never takes over an
    // existing account by email.
    linkExistingAccounts: false,
    allowSignUp: true,
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
  store: SsoAdapter,
  by: ProviderLookup,
): Promise<SsoProviderRecord | undefined> {
  if ("id" in by) {
    return /^[\w-]{1,128}$/.test(by.id) ? await store.getSsoProvider(by.id) : undefined;
  }
  if ("domain" in by) return await store.getSsoProviderByDomain(by.domain.toLowerCase());
  return await store.getSsoProviderByEntityId(by.entityId);
}

/**
 * The provider for an id, a domain or an IdP entity id — config-declared first, then stored (a
 * stored one's metadata URL fetched again when it is due) — refused when its metadata is past
 * its `validUntil`.
 *
 * @param ctx The context.
 * @param by What to look up.
 * @returns The provider.
 * @throws {GoTrueError} 404 `sso_provider_not_found`, 400 `saml_metadata_expired`.
 */
export async function findProvider(ctx: GoTrueContext, by: ProviderLookup): Promise<SsoProvider> {
  const declared = configMatch(ctx, by);
  const store = declared ? null : ssoAdapterOf(ctx.adapter);
  const stored = store ? await storedMatch(store, by) : undefined;
  if (!declared && !stored) throw providerNotFound();
  const provider = declared
    ? fromConfig(declared)
    : fromRecord((await refreshProvider(ctx, stored!, (r) => store!.updateSsoProvider(r))).record);
  assertMetadataFresh(ctx, provider.id, provider.idp);
  assertIdpEndpoints(ctx, provider.idp);
  return provider;
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

/** One adapter per backend client, for its `auth_saml_message_ids` claim. */
const backendClaims = new WeakMap<SqlClient, AuthAdapter>();

/** Claim a message id. */
type Claim = (id: string, expiresAt: number) => Promise<boolean>;

/**
 * Where message ids are claimed: the adapter's table when it keeps one (shared by every
 * replica), else — with `backend({ postgres })` — the auth table on the backend's database, and
 * only without either a process-local cache. A Postgres app never falls back to the process.
 */
function claimOf(adapter: AuthAdapter | undefined): Claim {
  if (typeof adapter?.claimSamlMessageId === "function") {
    return async (id, expiresAt) => await adapter.claimSamlMessageId!(id, expiresAt);
  }
  const sql = backendPostgresClient();
  if (sql) {
    let shared = backendClaims.get(sql);
    if (!shared) {
      // The plugin owns the client and closes it on drain.
      shared = postgresAuthAdapter({ sql });
      backendClaims.set(sql, shared);
    }
    return async (id, expiresAt) => await shared.claimSamlMessageId!(id, expiresAt);
  }
  return (id, expiresAt) => Promise.resolve(processCache.claim(id, expiresAt));
}

/**
 * The SAML message-id replay cache: the adapter's (shared by every replica) when it keeps one,
 * else the backend's Postgres when `backend({ postgres })` is set up, else a process-local one.
 * Ids are namespaced and hashed to a fixed length.
 *
 * @param ctx The context.
 * @param namespace What kind of id (`assertion`, `logout`).
 * @returns The cache.
 */
export function replayCacheOf(ctx: GoTrueContext, namespace: string): SamlReplayCache {
  const claim = claimOf(ctx.adapter);
  return {
    async claim(id, expiresAt) {
      return await claim(await sha256Hex(`gotrue-saml:${namespace}:${id}`), expiresAt);
    },
  };
}
