// Incremental streaming of a page: flush the shell, then stream each Suspense boundary
// as it resolves — for plain HTML routes and, with the Flight renderer, for "use client"
// routes. Streaming is on by default but yields to ISR (a cached route is buffered).

import type { PageContext, PageFlightShellResult } from "./render-page.ts";
import { renderPageFlightShell, renderPageShell } from "./render-page.ts";
import { pageCacheTiming } from "./cache.ts";
import {
  renderDocument,
  renderHeadContent,
  streamFlightDocument,
  streamPageDocument,
} from "./document.ts";
import { type CspSetting, resolveCsp, resolveStreamingCsp } from "./csp.ts";
import {
  augmentPageMetadata,
  documentOptions,
  htmlResponse,
  type PageRequest,
  renderOptions,
  reportBoundaryErrors,
} from "./page-document.ts";

/** Streamed responses are always per-request (never ISR-cached). */
const NO_STORE = { "cache-control": "private, no-store" };

/**
 * A DYNAMIC render that read cookies()/headers() is per-user, so it needs `no-store` +
 * `Vary: Cookie` (M1) — denext never stores such a render in its own ISR cache; this
 * guards an upstream CDN too. A static page stays shared-cacheable.
 */
function dynamicHeaders(pr: PageRequest): Record<string, string> | undefined {
  return pr.state.ctx.usedDynamicApi === true
    ? { "cache-control": "private, no-store", vary: "x-denext-nav, Cookie" }
    : undefined;
}

/**
 * The streamed response. Its CSP is computed from the buffered shell prefix (head +
 * shell): that holds every framework inline `<style>`, and the streamed holes add no
 * inline style/script, while the swap runtime is a hashed constant.
 */
async function streamedResponse(
  pr: PageRequest,
  stream: ReadableStream<Uint8Array>,
  shellPrefix: string,
  routeCsp: CspSetting | undefined,
): Promise<Response> {
  pr.state.ctx.renderStreamed = true; // dev render-mode telemetry: Suspense holes stream
  const csp = await resolveStreamingCsp(shellPrefix, routeCsp, pr.state.app.config.csp);
  return htmlResponse(pr.state, stream, 200, csp, NO_STORE);
}

/**
 * No holes: a fully synchronous page has nothing to stream, so it is served as a
 * complete buffered document (no re-render) with the ordinary buffered headers —
 * streaming would force no-store on every page.
 */
async function bufferedShellResponse(
  pr: PageRequest,
  doc: string,
  routeCsp: CspSetting | undefined,
): Promise<Response> {
  const csp = await resolveCsp(doc, routeCsp, pr.state.app.config.csp);
  return htmlResponse(pr.state, doc, 200, csp, dynamicHeaders(pr));
}

/**
 * A control signal (notFound/forbidden/unauthorized) fired in the shell before any bytes
 * flushed → a buffered signal-UI page with the normal buffered CSP.
 */
async function signalPageResponse(
  pr: PageRequest,
  doc: string,
  status: number,
  routeCsp: CspSetting | undefined,
): Promise<Response> {
  const csp = await resolveCsp(doc, routeCsp, pr.state.app.config.csp);
  return htmlResponse(pr.state, doc, status, csp, NO_STORE);
}

/** Stream an HTML route's shell + holes, or buffer it when the shell has no holes. */
async function streamHtmlRoute(pr: PageRequest, prepared: PageContext): Promise<Response> {
  const { request, ctx } = pr.state;
  const shellResult = await renderPageShell(
    pr.page,
    request,
    pr.pageLoad,
    renderOptions(pr),
    prepared,
  );
  // Report the shell's boundary catches (holes stream after the response, so their
  // late catches are logged by H1, not reported here).
  await reportBoundaryErrors(pr, "server-rendering");
  augmentPageMetadata(pr, shellResult.metadata); // og:image + icon conventions
  const doc = {
    metadata: shellResult.metadata,
    viewport: shellResult.viewport,
    ...documentOptions(pr),
  };
  const routeCsp = prepared.config.csp;
  const { shell } = shellResult;
  if (shell && shell.holes.size > 0) {
    const stream = streamPageDocument({ ...doc, shell, signal: ctx.signal });
    const shellPrefix = renderHeadContent(doc.metadata, doc.viewport, doc.styles) + shell.shell;
    return streamedResponse(pr, stream, shellPrefix, routeCsp);
  }
  if (shell) {
    return bufferedShellResponse(pr, renderDocument({ ...doc, bodyHtml: shell.shell }), routeCsp);
  }
  const signalDoc = renderDocument({ ...doc, bodyHtml: shellResult.html ?? "" });
  return signalPageResponse(pr, signalDoc, shellResult.status, routeCsp);
}

/**
 * No holes: drain the Flight tail (nothing is enqueued) so the complete buffered Flight
 * document — identical to the buffered Flight path — can embed it inline.
 */
function drainFlightTail(
  flightShell: NonNullable<PageFlightShellResult["flightShell"]>,
  signal: AbortSignal | undefined,
) {
  const sink = { enqueue() {} } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return flightShell.streamHoles(sink, new TextEncoder(), signal);
}

/**
 * Stream a Flight ("use client") route: the same shell-first, holes-stream-in model,
 * rendered with the Flight renderer so the trailing #__denext_flight / #__denext_islands
 * / #__denext_state islands (computed once all holes resolve) hydrate the client
 * boundaries. A hole-less client-island page is served buffered (parity with the HTML
 * branch) so a fully-static Flight route stays CDN-cacheable instead of being forced
 * no-store, and no useless swap runtime is emitted.
 */
async function streamFlightRoute(pr: PageRequest, prepared: PageContext): Promise<Response> {
  const { request, ctx } = pr.state;
  const shellResult = await renderPageFlightShell(
    pr.page,
    request,
    pr.pageLoad,
    renderOptions(pr),
    prepared,
  );
  await reportBoundaryErrors(pr, "react-server-components");
  augmentPageMetadata(pr, shellResult.metadata); // og:image + icon conventions
  const doc = {
    metadata: shellResult.metadata,
    viewport: shellResult.viewport,
    ...documentOptions(pr),
  };
  const routeCsp = prepared.config.csp;
  const { flightShell } = shellResult;
  if (flightShell && flightShell.hasHoles) {
    const stream = streamFlightDocument({ ...doc, flightShell, signal: ctx.signal });
    const shellPrefix = renderHeadContent(doc.metadata, doc.viewport, doc.styles) +
      flightShell.shellHtml;
    return streamedResponse(pr, stream, shellPrefix, routeCsp);
  }
  if (flightShell) {
    const tail = await drainFlightTail(flightShell, ctx.signal);
    const bufferedDoc = renderDocument({
      ...doc,
      bodyHtml: flightShell.shellHtml,
      flight: tail.flight,
      islands: tail.islands,
      signalState: tail.signalState,
    });
    return bufferedShellResponse(pr, bufferedDoc, routeCsp);
  }
  const signalDoc = renderDocument({ ...doc, bodyHtml: shellResult.html ?? "" });
  return signalPageResponse(pr, signalDoc, shellResult.status, routeCsp);
}

/**
 * Incremental streaming, when it applies: on by default, GET only, never for a soft
 * navigation, and yielding to ISR — a route that opts into page caching
 * (revalidate/force-static → non-null timing) is buffered and cached instead (a streamed
 * no-store response would never populate the cache). PPR (cacheComponents) already
 * handled a cacheable route before this; a plain cacheable route falls through to the
 * buffered render (null).
 */
export function serveStreamed(pr: PageRequest, prepared: PageContext): Promise<Response> | null {
  const { config } = pr.state.app;
  const willIsrCache = pr.cacheable && pageCacheTiming(prepared.config) !== null;
  if (config.streaming === false || pr.soft || willIsrCache || pr.state.request.method !== "GET") {
    return null;
  }
  return pr.useFlight ? streamFlightRoute(pr, prepared) : streamHtmlRoute(pr, prepared);
}
