// Serving a matched page's HTML document: the per-page request context, the hydration
// / document options every response shares, the HTML response helper, metadata
// augmentation, and the Cache-Components (PPR) shell-resume streams.

import type { RouteManifest } from "../router/manifest.ts";
import type { PageMatch } from "../router/match.ts";
import type { Metadata, ModuleLoader } from "./types.ts";
import type { Messages } from "../runtime/i18n-messages.ts";
import type { PeeledLocale } from "./i18n.ts";
import type { CachedPage } from "./cache.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import type { IslandPayload } from "../jsx/render-to-html-flight.ts";
import type { PrerenderedFlightPage, PrerenderedPage } from "./render-page.ts";
import type { RequestErrorContext } from "./instrumentation.ts";
import {
  type HydrationData,
  renderHeadContent,
  streamPprDocument,
  streamPprFlightDocument,
} from "./document.ts";
import { type CspSetting, resolveStreamingCsp } from "./csp.ts";
import { resumePageHolesFlightStream, resumePageHolesStream } from "./render-page.ts";
import { absoluteUrl } from "./absolute-url.ts";
import { augmentMetadataConventions } from "./augment-metadata.ts";
import { publicEnv, restrictPublicEnv } from "../runtime/public-env.ts";
import { originOptions, reportRequestError } from "./app-config.ts";
import { finalize, type RequestState } from "./pipeline-state.ts";
import { htmlHeaders } from "./response-headers.ts";

/** What `x-denext-cache` reports about the ISR cache for this response. */
export type CacheState = "HIT" | "STALE" | "MISS";

/** Everything the page-serving stages share for one matched page request. */
export interface PageRequest {
  state: RequestState;
  manifest: RouteManifest;
  /** The matched page, with the i18n locale merged into its params. */
  page: PageMatch;
  localeInfo: PeeledLocale | null;
  /** The active locale (`""` when i18n is off). */
  locale: string;
  /** The active locale's message catalog for useTranslations() (i18n only). */
  messages: Messages | undefined;
  /** A soft (client) navigation — carries `x-denext-nav`, enables interception. */
  soft: boolean;
  useFlight: boolean;
  /** The loader the page renders with (tags client references under Flight). */
  pageLoad: ModuleLoader;
  /** ISR: an impersonal GET that may read and populate the page cache. */
  cacheable: boolean;
  cacheKey: string;
  /** The in-process ISR background-regeneration loopback. */
  isRegen: boolean;
  /** Errors an error.tsx boundary caught during the render, reported after it. */
  boundaryErrors: unknown[];
}

/** The per-navigation data the client hydrates / soft-navigates with. */
export function navData(pr: PageRequest): HydrationData {
  return {
    params: pr.page.params,
    searchParams: pr.state.url.searchParams.toString(),
    pathname: pr.state.pathname,
    messages: pr.messages,
    basePath: pr.state.app.basePath || undefined,
  };
}

/** The hydration island's data — only for a route with a client entry. */
function hydrationFor(pr: PageRequest): HydrationData | undefined {
  return pr.state.app.config.clientEntryFor?.(pr.page.route) ? navData(pr) : undefined;
}

/**
 * The document options every page response shares: hydration island, client entry,
 * stylesheets, dev script, `<html lang>` (the active locale) and the public env.
 */
export function documentOptions(pr: PageRequest) {
  const { config } = pr.state.app;
  return {
    hydration: hydrationFor(pr),
    clientEntry: config.clientEntryFor?.(pr.page.route),
    styles: config.styleHrefsFor?.(pr.page.route),
    devScript: config.devScript,
    devScriptSrc: config.devScriptSrc,
    lang: pr.locale || undefined,
    publicEnv: restrictPublicEnv(publicEnv(), config.publicEnvKeys),
  };
}

/** The render options every page render / prerender / resume takes. */
export function renderOptions(pr: PageRequest) {
  return {
    flight: pr.useFlight,
    messages: pr.messages,
    signal: pr.state.ctx.signal,
    onCaughtError: (e: unknown) => pr.boundaryErrors.push(e),
  };
}

/** A finalized HTML document response. */
export function htmlResponse(
  state: RequestState,
  body: BodyInit | null,
  status: number,
  csp: string | undefined,
  extra?: Record<string, string>,
): Response {
  return finalize(state, new Response(body, { status, headers: htmlHeaders(csp, extra) }));
}

/** `metadata.title` when it is a plain string (the soft-nav payloads carry only that). */
export function titleOf(metadata: Metadata): string | undefined {
  return typeof metadata.title === "string" ? metadata.title : undefined;
}

/** The render source label instrumentation gets for this page's renders. */
export function renderSourceOf(pr: PageRequest): RequestErrorContext["renderSource"] {
  return pr.useFlight ? "react-server-components" : "server-rendering";
}

/**
 * Report errors an error.tsx boundary caught during the render to onRequestError
 * (routeType "render"). The render succeeded (the boundary shows its fallback), so
 * without this they'd be invisible to instrumentation; H1 already logged them.
 */
export async function reportBoundaryErrors(
  pr: PageRequest,
  renderSource: RequestErrorContext["renderSource"],
): Promise<void> {
  for (const be of pr.boundaryErrors) {
    await reportRequestError(pr.state.app.config, be, pr.state.request, pr.page.route.routePath, {
      routeType: "render",
      renderSource,
    });
  }
}

/**
 * Auto-populate og:image (from a dynamic opengraph-image route) + icon / apple-icon /
 * twitter-image links from the file conventions when the page didn't declare its own.
 * Applied to whichever path serves the page (buffered, streamed shell, or Flight shell)
 * so the metadata is identical regardless of how the document is delivered. The
 * og:image branch may mark the render dynamic: a Host-derived URL is not part of the
 * cache key, whereas a pinned canonical origin is stable and stays cacheable.
 */
export function augmentPageMetadata(pr: PageRequest, metadata: Metadata): void {
  const { config } = pr.state.app;
  const { request, ctx } = pr.state;
  augmentMetadataConventions(metadata, {
    manifest: pr.manifest,
    route: pr.page.route,
    i18n: config.i18n,
    localeInfo: pr.localeInfo,
    absolutize: (path) => absoluteUrl(request, path, originOptions(config)),
    onHostDerived: config.canonicalOrigin ? undefined : () => {
      ctx.usedDynamicApi = true;
    },
  });
}

/**
 * A Cache-Components (PPR) shell — cached or freshly prerendered: the
 * request-independent body with hole placeholders, what a later request needs to rebuild
 * its `<head>`, and for a Flight route the shell's own Flight tree, islands and signal
 * state.
 */
export interface PprShell {
  body: string;
  holeIds: string[];
  headExtras: string | undefined;
  inTreeTitle: string | undefined;
  routeCsp: CspSetting | undefined;
  flight?: {
    shell: FlightNode;
    islands: IslandPayload[];
    signalState: Record<string, unknown>;
  };
}

/** The shell an ISR cache entry with holes carries. */
export function shellFromCache(hit: CachedPage): PprShell {
  return {
    body: hit.body,
    holeIds: hit.holeIds ?? [],
    headExtras: hit.headExtras,
    inTreeTitle: hit.inTreeTitle,
    routeCsp: hit.routeCsp,
    flight: hit.flightShell !== undefined
      ? {
        shell: hit.flightShell,
        islands: hit.flightIslands ?? [],
        signalState: hit.flightSignalState ?? {},
      }
      : undefined,
  };
}

/** The shell a fresh prerender produced (Flight fields only for a Flight route). */
export function shellFromPrerender(
  pre: PrerenderedPage | PrerenderedFlightPage,
  useFlight: boolean,
): PprShell {
  const flightPre = pre as PrerenderedFlightPage;
  return {
    body: pre.shellBody,
    holeIds: pre.holeIds,
    headExtras: pre.headExtras,
    inTreeTitle: pre.inTreeTitle,
    routeCsp: pre.config.csp,
    flight: useFlight
      ? {
        shell: flightPre.flightShell,
        islands: flightPre.flightIslands,
        signalState: flightPre.flightSignalState,
      }
      : undefined,
  };
}

/** Rebuild the shell's cached `<head>` extras + title onto this request's metadata. */
function applyShellHead(metadata: Metadata, shell: PprShell): void {
  if (shell.inTreeTitle !== undefined) metadata.title = shell.inTreeTitle;
  if (shell.headExtras) metadata.head = (metadata.head ?? "") + shell.headExtras;
}

/** Dev render-mode telemetry: a PPR shell serves streamed, with holes. */
function markStreamedFromCache(pr: PageRequest, cacheState: CacheState): void {
  pr.state.ctx.renderStreamed = true;
  pr.state.ctx.renderCache = cacheState;
}

/** The resumed document stream for one shell, plus the head it was built with. */
interface ResumedShell {
  stream: ReadableStream<Uint8Array>;
  metadata: Metadata;
  viewport: Parameters<typeof renderHeadContent>[1];
}

/** Resume an HTML shell: stream each dynamic hole into its placeholder as it resolves. */
async function resumeHtmlShell(
  pr: PageRequest,
  shell: PprShell,
  cacheState: CacheState,
  loader: ModuleLoader,
): Promise<ResumedShell> {
  const { holes, metadata, viewport } = await resumePageHolesStream(
    pr.page,
    pr.state.request,
    loader,
    shell.holeIds,
    { messages: pr.messages, signal: pr.state.ctx.signal },
  );
  applyShellHead(metadata, shell);
  const doc = documentOptions(pr);
  markStreamedFromCache(pr, cacheState);
  const stream = streamPprDocument({
    bodyHtml: shell.body,
    metadata,
    viewport,
    ...doc,
    holes,
    signal: pr.state.ctx.signal,
  });
  return { stream, metadata, viewport };
}

/**
 * Resume a Flight shell: the per-request resume fills the shell's Flight holes with its
 * subtrees and merges islands/signals, emitting the same trailing #__denext_flight /
 * #__denext_islands / #__denext_state payload a non-PPR streamed Flight route emits — so
 * the client is unchanged (it never learns the shell was cached).
 */
async function resumeFlightShell(
  pr: PageRequest,
  shell: PprShell,
  cacheState: CacheState,
  loader: ModuleLoader,
): Promise<ResumedShell> {
  const resume = await resumePageHolesFlightStream(
    pr.page,
    pr.state.request,
    loader,
    shell.holeIds,
    { messages: pr.messages, signal: pr.state.ctx.signal },
  );
  const { metadata, viewport } = resume;
  applyShellHead(metadata, shell);
  const doc = documentOptions(pr);
  markStreamedFromCache(pr, cacheState);
  const flight = shell.flight!;
  const stream = streamPprFlightDocument({
    shellBody: shell.body,
    shellFlight: flight.shell,
    shellIslands: flight.islands,
    shellSignalState: flight.signalState,
    resume: {
      holes: resume.holes,
      islands: resume.islands,
      finishSignals: resume.finishSignals,
    },
    metadata,
    viewport,
    ...doc,
    signal: pr.state.ctx.signal,
  });
  return { stream, metadata, viewport };
}

/**
 * Cache Components / PPR: stream a shell for THIS request. Rebuild its `<head>`
 * (per-request generateMetadata, re-merging the shell's static head extras), then
 * stream each dynamic hole into its placeholder as it resolves, and finally the
 * hydration scripts + client entry — LAST, so the client hydrates the COMPLETE document
 * (same as the buffered path). The streamed response carries the same strict
 * hash-based CSP as a buffered one, computed over the buffered shell prefix (head +
 * shell body), which holds every framework inline `<style>`; the streamed holes add no
 * inline style/script and the swap runtime is a hashed constant, so the policy is
 * complete for the whole document.
 */
export async function servePprShell(
  pr: PageRequest,
  shell: PprShell,
  cacheState: CacheState,
  loader: ModuleLoader,
): Promise<Response> {
  const resumed = shell.flight
    ? await resumeFlightShell(pr, shell, cacheState, loader)
    : await resumeHtmlShell(pr, shell, cacheState, loader);
  const styles = pr.state.app.config.styleHrefsFor?.(pr.page.route);
  const shellPrefix = renderHeadContent(resumed.metadata, resumed.viewport, styles) + shell.body;
  const csp = await resolveStreamingCsp(shellPrefix, shell.routeCsp, pr.state.app.config.csp);
  return htmlResponse(pr.state, resumed.stream, 200, csp, {
    "x-denext-cache": cacheState,
    "cache-control": "private, no-store",
  });
}
