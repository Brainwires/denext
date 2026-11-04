/**
 * Refreshing the metadata of `/auth/v1`'s stored SAML providers ahead of use: `refreshSsoMetadata`
 * (call it from a scheduled job) and the opt-in background timer `saml.metadataRefresh` starts.
 *
 * @module
 */

import { activeAuthConfig } from "../mod.ts";
import { resolveAuthOptions } from "../options.ts";
import type { AuthConfig } from "../types.ts";
import type { GoTrueOptions } from "./options.ts";
import { refreshDue, type RefreshOutcome, refreshProvider } from "./sso-metadata.ts";
import { ssoAdapterOf } from "./sso-providers.ts";

/** What {@linkcode refreshSsoMetadata} did. */
export interface SsoMetadataRefreshSummary {
  /** Stored providers registered by a metadata URL. */
  checked: number;
  /** Fetched, and the metadata changed. */
  refreshed: number;
  /** Fetched, and the metadata is the same (its next refresh moved on). */
  unchanged: number;
  /** The fetch (or the fetched document) failed; the stored copy stays while it is valid. */
  failed: number;
  /** Not due yet, or held back by the fetch limiter (a recent fetch or a failure's backoff). */
  skipped: number;
  /** Each provider fetched or held back, and how it went. */
  results: Array<{ id: string; outcome: RefreshOutcome }>;
}

/** Options for {@linkcode refreshSsoMetadata}. */
export interface RefreshSsoMetadataOptions {
  /** Fetch every metadata URL, due or not (the fetch limiter still applies). Default `false`. */
  force?: boolean;
  /** A random pause of up to this many milliseconds before each fetch. Default `0`. */
  jitterMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch the metadata of every stored SSO provider registered by `metadata_url` whose refresh is
 * due (a day after the last fetch, or sooner by its `cacheDuration` / `validUntil`), one at a
 * time — the same single-flight, backed-off fetch a sign-in uses, so a job and the sign-ins
 * never fetch one URL twice in a window. Run it from a scheduled job:
 * `defineJob({ schedule: "0 * * * *", handler: () => refreshSsoMetadata() })`.
 *
 * @param config The auth config (default: the one `denextAuth()` was built with).
 * @param options `force`, `jitterMs`.
 * @returns What happened; a provider's failure is counted and logged, not thrown.
 * @throws {Error} When there is no auth config, or listing the providers fails.
 */
export async function refreshSsoMetadata(
  config?: AuthConfig,
  options: RefreshSsoMetadataOptions = {},
): Promise<SsoMetadataRefreshSummary> {
  const deps = { config: config ?? activeAuthConfig() };
  const summary: SsoMetadataRefreshSummary = {
    checked: 0,
    refreshed: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };
  const store = ssoAdapterOf(deps.config.adapter);
  if (!store) return summary;
  for (const record of await store.listSsoProviders()) {
    if (!record.metadataUrl) continue;
    summary.checked++;
    if (!options.force && !refreshDue(record)) {
      summary.skipped++;
      continue;
    }
    if (options.jitterMs) await sleep(Math.random() * options.jitterMs);
    const { outcome } = await refreshProvider(
      deps,
      record,
      (next) => store.updateSsoProvider(next),
      options.force,
    );
    summary.results.push({ id: record.id, outcome });
    if (outcome === "refreshed" || outcome === "unchanged" || outcome === "failed") {
      summary[outcome]++;
    } else summary.skipped++;
  }
  return summary;
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

/** The default and the smallest background refresh interval, seconds. */
const DEFAULT_INTERVAL = 900;
const MIN_INTERVAL = 60;

function warnRefreshFailed(config: AuthConfig | undefined, error: unknown): void {
  const message = "/auth/v1: the background SAML metadata refresh failed";
  const meta = { error: error instanceof Error ? error.message : String(error) };
  try {
    resolveAuthOptions(config ?? activeAuthConfig()).logger.warn(message, meta);
  } catch {
    console.warn(`[denext] ${message}`, meta);
  }
}

/**
 * One background refresh pass (skipped while the previous one runs); failures are logged.
 *
 * @param config The auth config (default: the active one).
 * @param jitterMs The random pause before each fetch.
 */
export async function ssoMetadataRefreshTick(
  config: AuthConfig | undefined,
  jitterMs = 2000,
): Promise<void> {
  if (running) return;
  running = true;
  try {
    await refreshSsoMetadata(config, { jitterMs });
  } catch (error) {
    warnRefreshFailed(config, error);
  } finally {
    running = false;
  }
}

/**
 * Start (or, with no `saml.metadataRefresh`, stop) the background refresh. The timer never
 * keeps the process alive; {@linkcode stopSsoMetadataRefresh} ends it.
 *
 * @param options The `/auth/v1` options.
 * @param config The auth config (default: the active one, read at each tick).
 */
export function startSsoMetadataRefresh(options: GoTrueOptions, config?: AuthConfig): void {
  stopSsoMetadataRefresh();
  const refresh = options.saml?.metadataRefresh;
  if (!refresh) return;
  const seconds = Math.max(MIN_INTERVAL, refresh.intervalSeconds ?? DEFAULT_INTERVAL);
  const id = setInterval(() => void ssoMetadataRefreshTick(config), seconds * 1000);
  Deno.unrefTimer(id as unknown as number);
  timer = id;
}

/** Stop the background refresh (idempotent). */
export function stopSsoMetadataRefresh(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}

/** Whether the background refresh is running (tests). */
export function ssoMetadataRefreshActive(): boolean {
  return timer !== undefined;
}
