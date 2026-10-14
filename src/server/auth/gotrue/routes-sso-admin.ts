/**
 * The SSO admin API (`/auth/v1/admin/sso/providers`, GoTrue's shape): list, create, read,
 * update and delete stored SAML identity providers. Service role only (the handler's `admin`
 * access). A provider is registered by its metadata — inline (`metadata_xml`) or by an HTTPS
 * URL (`metadata_url`, fetched SSRF-safely and refreshed when stale) — with the email domains
 * that route to it; an entity id and every domain belong to one provider only, config-declared
 * providers included.
 *
 * @module
 */

import type { SsoAttributeMapping, SsoAttributeMappingKey, SsoProviderRecord } from "../adapter.ts";
import type { ParsedIdpMetadata } from "../saml/mod.ts";
import { SamlError } from "../saml/errors.ts";
import { type GoTrueContext, nowSeconds, ok, readJson, str } from "./context.ts";
import { fail, GoTrueError } from "./errors.ts";
import {
  assertIdpEndpoints,
  checkMetadataUrl,
  fetchMetadata,
  idpFromMetadata,
  metadataExpired,
  withValidity,
} from "./sso-metadata.ts";
import {
  configProviders,
  providerNotFound,
  samlOptions,
  type SsoAdapter,
  ssoAdapterOf,
} from "./sso-providers.ts";
import { iso } from "./user.ts";

const NAME_ID_FORMATS = new Set([
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
]);

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

function store(ctx: GoTrueContext): SsoAdapter {
  samlOptions(ctx);
  const adapter = ssoAdapterOf(ctx.adapter);
  if (!adapter) {
    throw new GoTrueError(500, "unexpected_failure", "the auth adapter keeps no SSO providers");
  }
  return adapter;
}

/** GoTrue's `SSOProvider` JSON. */
function providerJson(record: SsoProviderRecord): Record<string, unknown> {
  const saml: Record<string, unknown> = {
    entity_id: record.entityId,
    metadata_xml: record.metadataXml,
    attribute_mapping: record.attributeMapping ?? {},
  };
  if (record.metadataUrl) saml.metadata_url = record.metadataUrl;
  if (record.nameIdFormat) saml.name_id_format = record.nameIdFormat;
  return {
    id: record.id,
    saml,
    domains: record.domains.map((domain) => ({ domain })),
    created_at: iso(record.createdAt),
    updated_at: iso(record.updatedAt),
  };
}

/** The `domains` field: valid hostnames, lower-cased, de-duplicated. */
function readDomains(body: Record<string, unknown>): string[] | undefined {
  const value = body.domains;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw fail.validation("domains must be an array of strings");
  const out = new Set<string>();
  for (const raw of value) {
    const domain = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!DOMAIN_RE.test(domain)) throw fail.validation(`Domain ${JSON.stringify(raw)} is invalid`);
    out.add(domain);
  }
  return [...out].sort();
}

function mappingKey(field: string, raw: unknown): SsoAttributeMappingKey {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw fail.validation(`attribute_mapping.keys.${field} must be an object`);
  }
  const { name, names, default: fallback, array } = raw as Record<string, unknown>;
  const key: SsoAttributeMappingKey = {};
  if (name !== undefined) {
    if (typeof name !== "string") throw fail.validation("attribute_mapping name must be a string");
    key.name = name;
  }
  if (names !== undefined) {
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
      throw fail.validation("attribute_mapping names must be an array of strings");
    }
    key.names = names as string[];
  }
  if (fallback !== undefined) key.default = fallback;
  if (array !== undefined) key.array = array === true;
  return key;
}

/** The `attribute_mapping` field (`{ keys: { field: { name, names, default, array } } }`). */
function readMapping(body: Record<string, unknown>): SsoAttributeMapping | undefined {
  const value = body.attribute_mapping;
  if (value === undefined || value === null) return undefined;
  const keys = (value as { keys?: unknown }).keys;
  if (
    typeof value !== "object" || Array.isArray(value) || (keys !== undefined &&
      (typeof keys !== "object" || keys === null || Array.isArray(keys)))
  ) {
    throw fail.validation("attribute_mapping must be { keys: { … } }");
  }
  const out: Record<string, SsoAttributeMappingKey> = {};
  for (const [field, raw] of Object.entries((keys ?? {}) as Record<string, unknown>)) {
    if (field === "__proto__") continue;
    out[field] = mappingKey(field, raw);
  }
  return { keys: out };
}

function readNameIdFormat(body: Record<string, unknown>): string | undefined {
  const format = str(body, "name_id_format");
  if (format !== undefined && !NAME_ID_FORMATS.has(format)) {
    throw fail.validation("name_id_format is not supported");
  }
  return format;
}

/** Metadata a body named: the document, its URL and the parsed IdP. */
interface BodyMetadata {
  xml: string;
  url?: string;
  idp: ParsedIdpMetadata;
}

/**
 * The metadata a body names (fetched for a URL), parsed; `undefined` when none. Metadata past
 * its `validUntil` is refused.
 */
async function readMetadata(
  ctx: GoTrueContext,
  body: Record<string, unknown>,
  required: boolean,
): Promise<BodyMetadata | undefined> {
  const xml = str(body, "metadata_xml");
  const url = str(body, "metadata_url");
  if (xml && url) throw fail.validation("Only one of metadata_xml or metadata_url needs to be set");
  if (!xml && !url) {
    if (required) throw fail.validation("Either metadata_url or metadata_xml must be specified");
    return undefined;
  }
  const document = url ? await fetchMetadata(ctx, checkMetadataUrl(ctx, url)) : xml!;
  let idp: ParsedIdpMetadata;
  try {
    idp = idpFromMetadata(document);
  } catch (error) {
    const code = error instanceof SamlError ? error.code : "bad_metadata";
    throw fail.validation(`SAML metadata is invalid (${code})`);
  }
  if (metadataExpired(idp)) throw fail.validation("SAML metadata has expired (validUntil)");
  assertIdpEndpoints(ctx, idp);
  return { xml: document, idp, ...(url ? { url } : {}) };
}

/** A config-declared provider already holds this entity id or one of these domains. */
function checkConfigConflicts(ctx: GoTrueContext, entityId: string, domains: string[]): void {
  for (const p of configProviders(ctx)) {
    if (idpFromMetadata(p.metadataXml).entityId === entityId) throw entityExists(entityId);
    const taken = (p.domains ?? []).map((d) => d.toLowerCase()).find((d) => domains.includes(d));
    if (taken) throw domainExists(taken);
  }
}

function entityExists(entityId: string): GoTrueError {
  return new GoTrueError(
    422,
    "saml_idp_already_exists",
    `SAML Identity Provider with this EntityID (${entityId}) already exists`,
  );
}

function domainExists(domain: string): GoTrueError {
  return new GoTrueError(
    400,
    "sso_domain_already_exists",
    `SSO Domain '${domain}' is already assigned to an SSO identity provider`,
  );
}

/** Turn an adapter verdict into the answer (or a refusal). */
function written(verdict: string, record: SsoProviderRecord): void {
  if (verdict === "entity_id_exists") throw entityExists(record.entityId);
  if (verdict === "domain_exists") throw domainExists(record.domains.join(", "));
  if (verdict === "not_found") throw providerNotFound();
}

function requireSaml(body: Record<string, unknown>, required: boolean): void {
  const type = str(body, "type");
  if ((type ?? (required ? "" : "saml")) !== "saml") {
    throw fail.validation("Only 'saml' supported for SSO type");
  }
}

/** `GET /admin/sso/providers` → `{ items }`. */
export async function list(ctx: GoTrueContext): Promise<Response> {
  return ok({ items: (await store(ctx).listSsoProviders()).map(providerJson) });
}

/** `POST /admin/sso/providers` → 201 with the provider. */
export async function create(ctx: GoTrueContext): Promise<Response> {
  const adapter = store(ctx);
  const body = await readJson(ctx);
  requireSaml(body, true);
  const domains = readDomains(body) ?? [];
  const mapping = readMapping(body);
  const nameIdFormat = readNameIdFormat(body);
  const metadata = (await readMetadata(ctx, body, true))!;
  checkConfigConflicts(ctx, metadata.idp.entityId, domains);
  const at = nowSeconds();
  let record: SsoProviderRecord = {
    id: crypto.randomUUID(),
    entityId: metadata.idp.entityId,
    metadataXml: metadata.xml,
    domains,
    createdAt: at,
    updatedAt: at,
  };
  if (metadata.url) record.metadataUrl = metadata.url;
  if (mapping) record.attributeMapping = mapping;
  if (nameIdFormat) record.nameIdFormat = nameIdFormat;
  record = withValidity(record, metadata.idp, at);
  written(await adapter.createSsoProvider(record), record);
  return ok(providerJson(record), 201);
}

async function existing(ctx: GoTrueContext, adapter: SsoAdapter): Promise<SsoProviderRecord> {
  const id = ctx.params.id;
  const record = /^[\w-]{1,128}$/.test(id) ? await adapter.getSsoProvider(id) : undefined;
  if (!record) throw providerNotFound();
  return record;
}

/** `GET /admin/sso/providers/:id`. */
export async function get(ctx: GoTrueContext): Promise<Response> {
  const adapter = store(ctx);
  return ok(providerJson(await existing(ctx, adapter)));
}

/** The record an update body describes (fields it leaves out are kept). */
async function updated(
  ctx: GoTrueContext,
  body: Record<string, unknown>,
  record: SsoProviderRecord,
): Promise<SsoProviderRecord> {
  let next: SsoProviderRecord = { ...record, updatedAt: nowSeconds() };
  const metadata = await readMetadata(ctx, body, false);
  if (metadata) {
    if (metadata.idp.entityId !== record.entityId) {
      throw new GoTrueError(
        400,
        "saml_entity_id_mismatch",
        "SAML Metadata does not contain the same EntityID as the provider; update not supported",
      );
    }
    next.metadataXml = metadata.xml;
    if (metadata.url) next.metadataUrl = metadata.url;
    else delete next.metadataUrl;
    next = withValidity(next, metadata.idp, next.updatedAt);
  }
  const domains = readDomains(body);
  if (domains) next.domains = domains;
  const mapping = readMapping(body);
  if (mapping) next.attributeMapping = mapping;
  const nameIdFormat = readNameIdFormat(body);
  if (nameIdFormat) next.nameIdFormat = nameIdFormat;
  return next;
}

/** `PUT /admin/sso/providers/:id`. */
export async function update(ctx: GoTrueContext): Promise<Response> {
  const adapter = store(ctx);
  const record = await existing(ctx, adapter);
  const body = await readJson(ctx);
  requireSaml(body, false);
  const next = await updated(ctx, body, record);
  checkConfigConflicts(ctx, next.entityId, next.domains);
  written(await adapter.updateSsoProvider(next), next);
  return ok(providerJson(next));
}

/** `DELETE /admin/sso/providers/:id` → the removed provider. */
export async function remove(ctx: GoTrueContext): Promise<Response> {
  const adapter = store(ctx);
  const record = await existing(ctx, adapter);
  if (!(await adapter.deleteSsoProvider(record.id))) throw providerNotFound();
  return ok(providerJson(record));
}
