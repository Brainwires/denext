/**
 * The metadata of `/auth/v1`'s SAML providers: parsing (memoized), the SSRF-safe fetch of a
 * stored provider's metadata URL, when that URL is fetched again (a day after the last fetch, the
 * metadata's `cacheDuration`, its `validUntil` — whichever comes first), the single-flight,
 * backed-off refresh, and the expiry check every use of a provider passes.
 *
 * @module
 */

import type { SsoProviderRecord } from "../adapter.ts";
import { makeHostPinnedFetch } from "../flow.ts";
import { resolveAuthOptions } from "../options.ts";
import type { AuthConfig } from "../types.ts";
import { safeFetch } from "../../safe-fetch.ts";
import { type ParsedIdpMetadata, parseIdpMetadata } from "../saml/mod.ts";
import { MAX_XML_BYTES } from "../saml/xml.ts";
import { GoTrueError } from "./errors.ts";

/** What the metadata helpers need: the auth config (logger, development switches). */
export interface MetadataDeps {
  /** The auth config. */
  config: AuthConfig;
}

/** Writes a refreshed provider back to the adapter (`"ok"` when it was saved). */
export type SaveProvider = (record: SsoProviderRecord) => Promise<string> | string;

/** How a refresh of one provider ended. */
export type RefreshOutcome = "refreshed" | "unchanged" | "failed" | "not_due" | "backoff";

/** The provider after a refresh attempt, and how the attempt ended. */
export interface Refreshed {
  /** The record to use (the stored one when nothing new was fetched). */
  record: SsoProviderRecord;
  /** How it ended. */
  outcome: RefreshOutcome;
}

/** The longest a fetched metadata document is used before it is fetched again, seconds. */
const METADATA_TTL = 24 * 3600;
/** The shortest time between two fetches of one URL, and the first backoff, seconds. */
const MIN_INTERVAL = 300;
/** The longest backoff after repeated failures, seconds. */
const MAX_BACKOFF = 3600;

let clock: () => number = () => Date.now();

/**
 * Replace the clock the metadata freshness checks read (tests).
 *
 * @param now Epoch milliseconds; omit to restore `Date.now`.
 */
export function setMetadataClock(now?: () => number): void {
  clock = now ?? (() => Date.now());
}

/** The current time, epoch seconds. */
function metadataNow(): number {
  return Math.floor(clock() / 1000);
}

const parsed = new Map<string, ParsedIdpMetadata>();

/**
 * Parse IdP metadata, memoized by its text (a bounded cache).
 *
 * @param xml The metadata.
 * @returns The IdP, with the metadata's `validUntil` / `cacheDuration`.
 */
export function idpFromMetadata(xml: string): ParsedIdpMetadata {
  let idp = parsed.get(xml);
  if (!idp) {
    idp = parseIdpMetadata(xml);
    if (parsed.size >= 256) parsed.delete(parsed.keys().next().value as string);
    parsed.set(xml, idp);
  }
  return idp;
}

/** Whether metadata is past its `validUntil` at `now` (epoch seconds). */
export function metadataExpired(idp: ParsedIdpMetadata, now = metadataNow()): boolean {
  return idp.validUntil !== undefined && now >= idp.validUntil;
}

/**
 * A record with its metadata validity recomputed: `metadataValidUntil` from the metadata, and,
 * for a metadata URL, `metadataRefreshAfter` — the earliest of a day after `fetchedAt`, the
 * metadata's `cacheDuration` after it and its `validUntil`, but never sooner than five minutes
 * after the fetch (one fetch per URL per five minutes at most).
 *
 * @param record The provider record (its `metadataXml` already the new document).
 * @param idp That document, parsed.
 * @param fetchedAt When it was read, epoch seconds.
 * @returns The new record.
 */
export function withValidity(
  record: SsoProviderRecord,
  idp: ParsedIdpMetadata,
  fetchedAt: number,
): SsoProviderRecord {
  const next = { ...record };
  delete next.metadataValidUntil;
  delete next.metadataRefreshAfter;
  if (idp.validUntil !== undefined) next.metadataValidUntil = idp.validUntil;
  if (next.metadataUrl) {
    const due = Math.min(
      fetchedAt + METADATA_TTL,
      fetchedAt + (idp.cacheDuration ?? METADATA_TTL),
      idp.validUntil ?? Infinity,
    );
    next.metadataRefreshAfter = Math.max(fetchedAt + MIN_INTERVAL, due);
  }
  return next;
}

/** Whether a stored provider's metadata URL is due to be fetched again. */
export function refreshDue(record: SsoProviderRecord, now = metadataNow()): boolean {
  if (!record.metadataUrl) return false;
  return now >= (record.metadataRefreshAfter ?? record.updatedAt + METADATA_TTL);
}

// ---- expiry -------------------------------------------------------------------------------

const warned = new Set<string>();

/** 400 `saml_metadata_expired`. */
function metadataExpiredError(): GoTrueError {
  return new GoTrueError(
    400,
    "saml_metadata_expired",
    "The SAML metadata of this identity provider has expired",
  );
}

/**
 * Refuse a provider whose metadata is past its `validUntil` (fail closed), warning once per
 * provider and `validUntil`.
 *
 * @param deps The auth config.
 * @param providerId The provider.
 * @param idp Its metadata.
 * @throws {GoTrueError} 400 `saml_metadata_expired`.
 */
export function assertMetadataFresh(
  deps: MetadataDeps,
  providerId: string,
  idp: ParsedIdpMetadata,
): void {
  if (!metadataExpired(idp)) return;
  const key = `${providerId}|${idp.validUntil}`;
  if (!warned.has(key)) {
    if (warned.size >= 1024) warned.clear();
    warned.add(key);
    resolveAuthOptions(deps.config).logger.warn(
      "/auth/v1: the SAML metadata of an SSO provider has expired; its sign-ins and logouts " +
        "are refused until fresh metadata is stored",
      { provider: providerId, validUntil: new Date(idp.validUntil! * 1000).toISOString() },
    );
  }
  throw metadataExpiredError();
}

// ---- metadata URLs -----------------------------------------------------------------------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Refuse a metadata URL that is not HTTPS (http only for loopback, in development).
 *
 * @param deps The auth config.
 * @param raw The URL.
 * @returns The parsed URL.
 * @throws {GoTrueError} 400 `validation_failed`.
 */
export function checkMetadataUrl(deps: MetadataDeps, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GoTrueError(400, "validation_failed", "metadata_url is not a valid URL");
  }
  const devLoopback = url.protocol === "http:" && LOOPBACK.has(url.hostname) &&
    deps.config.dangerouslyAllowInsecureProviders === true;
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
 * @param deps The auth config.
 * @param url The (checked) URL.
 * @returns The metadata XML.
 * @throws {GoTrueError} 400 `saml_metadata_fetch_failed`.
 */
export async function fetchMetadata(deps: MetadataDeps, url: URL): Promise<string> {
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
    resolveAuthOptions(deps.config).logger.warn("/auth/v1: SAML metadata fetch failed", {
      host: url.host,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new GoTrueError(400, "saml_metadata_fetch_failed", "Unable to fetch SAML metadata");
  }
}

// ---- refresh ------------------------------------------------------------------------------

/**
 * Per provider: consecutive failures, when the next fetch may start (epoch seconds) and, after a
 * success, the record it produced (for callers still holding the record read before it).
 */
interface FetchState {
  failures: number;
  notBefore: number;
  record?: SsoProviderRecord;
}

const backoff = new Map<string, FetchState>();
const inflight = new Map<string, Promise<Refreshed>>();

function remember(id: string, state: FetchState): void {
  if (!backoff.has(id) && backoff.size >= 4096) backoff.delete(backoff.keys().next().value!);
  backoff.set(id, state);
}

/** Back off after a failure: five minutes, doubling up to an hour. */
function recordFailure(id: string, now: number): void {
  const failures = (backoff.get(id)?.failures ?? 0) + 1;
  const wait = Math.min(MIN_INTERVAL * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF);
  remember(id, { failures, notBefore: now + wait });
}

/** Inside a window: the newer of the caller's record and the last fetch's. */
function heldBack(state: FetchState, record: SsoProviderRecord): Refreshed {
  const newer = state.record && state.record.updatedAt >= record.updatedAt;
  return { record: newer ? state.record! : record, outcome: "backoff" };
}

/**
 * Fetch a stored provider's metadata URL again when it is due (or `force`), at most one fetch
 * in flight per provider, none within five minutes of the last one, and none while a failure's
 * backoff lasts (five minutes, doubling to an hour). A failure, or a document that is invalid, expired or for another entity, keeps the
 * stored copy — usable only while it is within its own `validUntil`.
 *
 * @param deps The auth config.
 * @param record The stored provider.
 * @param save Writes a refreshed record back.
 * @param force Fetch even when the stored copy is not due (the backoff still applies).
 * @returns The record to use and how the attempt ended. Never throws.
 */
export function refreshProvider(
  deps: MetadataDeps,
  record: SsoProviderRecord,
  save: SaveProvider,
  force = false,
): Promise<Refreshed> {
  const now = metadataNow();
  if (!record.metadataUrl || (!force && !refreshDue(record, now))) {
    return Promise.resolve({ record, outcome: "not_due" });
  }
  const state = backoff.get(record.id);
  if (state && now < state.notBefore) return Promise.resolve(heldBack(state, record));
  let pending = inflight.get(record.id);
  if (!pending) {
    pending = refetch(deps, record, save).finally(() => inflight.delete(record.id));
    inflight.set(record.id, pending);
  }
  return pending;
}

/** The fetched document as the provider's new metadata, or a refusal. */
function acceptFetched(
  record: SsoProviderRecord,
  xml: string,
  now: number,
): { next: SsoProviderRecord; changed: boolean } {
  const idp = idpFromMetadata(xml);
  if (idp.entityId !== record.entityId) throw new Error("the entity id changed");
  if (metadataExpired(idp, now)) throw new Error("the fetched metadata has expired");
  const changed = xml !== record.metadataXml;
  const base = { ...record, metadataXml: xml, updatedAt: changed ? now : record.updatedAt };
  return { next: withValidity(base, idp, now), changed };
}

async function refetch(
  deps: MetadataDeps,
  record: SsoProviderRecord,
  save: SaveProvider,
): Promise<Refreshed> {
  const now = metadataNow();
  try {
    const xml = await fetchMetadata(deps, checkMetadataUrl(deps, record.metadataUrl!));
    const { next, changed } = acceptFetched(record, xml, now);
    if ((await save(next)) !== "ok") throw new Error("the provider could not be saved");
    remember(record.id, { failures: 0, notBefore: now + MIN_INTERVAL, record: next });
    return { record: next, outcome: changed ? "refreshed" : "unchanged" };
  } catch (error) {
    recordFailure(record.id, now);
    resolveAuthOptions(deps.config).logger.warn(
      "/auth/v1: SAML metadata refresh failed; the stored copy stays in use while it is valid",
      { provider: record.id, error: error instanceof Error ? error.message : String(error) },
    );
    return { record, outcome: "failed" };
  }
}

/** Forget every provider's backoff (tests). */
export function resetMetadataBackoff(): void {
  backoff.clear();
  warned.clear();
}
