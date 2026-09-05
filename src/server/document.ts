// Assemble a full HTML document around rendered page content, including <head>
// metadata and the hydration bootstrap script.

import { escapeHtml } from "../jsx/render-to-string.ts";
import type {
  IconDescriptor,
  Metadata,
  OpenGraphImage,
  OpenGraphMedia,
  OpenGraphMetadata,
  RobotsMetadata,
  Viewport,
} from "./types.ts";
import type { RouteParams } from "../router/segments.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import { type IslandPayload, serializeFlight } from "../jsx/render-to-html-flight.ts";
import type { Messages } from "../runtime/i18n-messages.ts";
import { PUBLIC_ENV_ID } from "../runtime/public-env.ts";
import { getImageRuntimeConfig, IMAGE_CONFIG_ID, imageConfigNeedsEmbed } from "../runtime/image.ts";
import type { PendingHole, ShellRender } from "../jsx/render-to-stream.ts";
import { takeSettled } from "../jsx/renderer-base.ts";
import type { FlightShellRender } from "../jsx/render-to-flight-stream.ts";
import { SWAP_RUNTIME } from "./swap-runtime.ts";
import type { ResumedHole } from "../jsx/render-to-ppr.ts";
import { fillFlightHoles, type ResumedFlightHole } from "../jsx/flight-holes.ts";
import { currentContext } from "./request-context.ts";

import { ROOT_ID } from "./root-id.ts";

/** Data serialized into the page for the client runtime to hydrate with. */
export interface HydrationData {
  /** Dynamic route parameters extracted from the request path. */
  params: RouteParams;
  /** Serialized search params as a query string (without leading "?"). */
  searchParams: string;
  /** The request pathname the page was rendered for. */
  pathname: string;
  /** The active locale's message catalog, when i18n messages are configured. */
  messages?: Messages;
  /** The app's basePath (from denext.config), so client `<Link>` can prefix URLs. */
  basePath?: string;
}

/**
 * The JSON envelope for a Flight **soft navigation** response. When a client
 * navigation (`x-denext-nav`) targets a Flight route, the server sends this
 * instead of a full HTML document: the client reconstructs the tree from
 * `flight` (via the app-wide client registry), updates `document.title`, and
 * refreshes the `#__denext_data` island from `data` so route hooks re-read.
 */
export interface FlightNavPayload {
  /** The route's Flight tree, reconstructed client-side via `parseFlight`. */
  flight: FlightNode;
  /** The new document title, applied to `document.title` (omitted when unset). */
  title?: string;
  /** Hydration data for the new route (params/searchParams/messages/basePath). */
  data: HydrationData;
  /**
   * Lazy (`client:*`/resumable) islands of the new route — each island's own Flight
   * keyed by id — so a soft nav can render and wire them up (they ride the route
   * Flight only as empty foreign hosts). Omitted when the route has none.
   */
  islands?: IslandPayload[];
  /** Serialized signal state for the new route's islands. Omitted when none. */
  signalState?: Record<string, unknown>;
}

/**
 * The JSON envelope for an **isomorphic** (non-Flight) soft navigation. Such a route
 * re-renders from its own re-run bundle on a soft nav, so the server-rendered `<body>`
 * would be discarded — the client only needs the title, hydration data, the route's
 * stylesheet hrefs, and the entry module src. Sending just those (instead of the full
 * HTML document) is the isomorphic analogue of {@link FlightNavPayload}.
 */
export interface IsoNavPayload {
  /** The new document title, applied to `document.title` (omitted when unset). */
  title?: string;
  /** Hydration data for the new route (params/searchParams/messages/basePath). */
  data: HydrationData;
  /** The route's client entry module src, re-injected to re-render the new route. */
  entry: string;
  /** The new route's stylesheet hrefs, swapped in place of the old route's. */
  styles?: string[];
}

/**
 * Serialize a {@link FlightNavPayload} to JSON, escaping `<` so the payload is
 * safe to embed and consistent with {@linkcode serializeFlight}'s island form.
 */
export function serializeFlightNav(payload: FlightNavPayload): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

/** Inputs to {@linkcode renderDocument} for assembling the full HTML page. */
export interface DocumentOptions {
  /** Rendered page HTML placed inside the hydration root element. */
  bodyHtml: string;
  /** Metadata used to build the document `<head>`. */
  metadata: Metadata;
  /** Hydration payload; when present (with `clientEntry`) the page hydrates. */
  hydration?: HydrationData;
  /** URL of the client runtime entry script. */
  clientEntry?: string;
  /** Viewport/theme metadata; replaces the default `<meta name="viewport">`. */
  viewport?: Viewport;
  /** Stylesheet URLs to link in `<head>` (extracted CSS for the route). */
  styles?: string[];
  /** Extra script injected before </body> (e.g. dev live-reload). */
  devScript?: string;
  /**
   * URL of an external same-origin script to inject before `</body>` (dev
   * live-reload). Preferred over {@link devScript} because an external
   * `<script src>` is covered by `script-src 'self'` — an inline script would trip
   * the strict CSP.
   */
  devScriptSrc?: string;
  /** Document language for the `<html lang>` attribute; defaults to "en". */
  lang?: string;
  /**
   * Flight payload for a route using the client/server boundary. Embedded as a
   * `#__denext_flight` JSON island the client entry reads to hydrate its islands.
   */
  flight?: FlightNode;
  /**
   * Lazy (`client:*`) islands, embedded as a `#__denext_islands` JSON island
   * (`{ [treePathId]: islandFlight }`). The client entry hydrates each on its
   * strategy instead of at load.
   */
  islands?: IslandPayload[];
  /**
   * Serialized signal state (`useId → value`), embedded as a `#__denext_state`
   * JSON island the client adopts before hydration (resumability).
   */
  signalState?: Record<string, unknown>;
  /**
   * Public (client-exposable) environment variables, embedded as a
   * `#__denext_public_env` JSON island the client `publicEnv()` reads. Only
   * public-prefixed variables are ever passed here; server-only vars never reach
   * the browser through this channel.
   */
  publicEnv?: Record<string, string>;
  /**
   * Pre-rendered `#__denext_render_modes` dev island (see {@link renderModeIsland}),
   * captured synchronously by the streamed-Flight paths whose `renderBodyScripts`
   * runs after the request context has unwound. Buffered/streamed non-Flight paths
   * leave this unset and let `renderBodyScripts` build it from the live context.
   */
  renderModeScript?: string;
}

/**
 * Serialize the dev-only render-mode manifest for the devtools glass-box — the
 * route's mode (static / dynamic / streamed) and its page-cache outcome — as a
 * CSP-safe `#__denext_render_modes` JSON island (a data block, not executed).
 * Reads the live request context; returns `""` in production or outside a request.
 */
function renderModeIsland(pathname?: string): string {
  if (!isDev()) return "";
  const ctx = currentContext();
  if (!ctx) return "";
  const mode = ctx.renderStreamed ? "streamed" : ctx.usedDynamicApi ? "dynamic" : "static";
  const manifest = {
    route: pathname ?? "",
    mode,
    cache: ctx.renderCache ?? null,
  };
  const json = JSON.stringify(manifest).replace(/</g, "\\u003c");
  return `<script id="__denext_render_modes" type="application/json">${json}</script>`;
}

/** Render the complete HTML document as a string. */
/**
 * Render the `<head>` **inner** content (metadata + route stylesheet links). This
 * is the exact head {@link renderDocument} embeds; exposed so a PPR cache hit can
 * rebuild the head per request (its `generateMetadata` may read cookies/headers)
 * and swap it into the cached shell via {@link replaceDocumentHead}.
 */
export function renderHeadContent(
  metadata: Metadata,
  viewport?: Viewport,
  styles?: string[],
): string {
  let head = renderHead(metadata, viewport);
  for (const href of styles ?? []) {
    // `data-dnx-css` marks per-route stylesheets so an isomorphic soft nav can swap
    // them for the new route's (global stylesheets, unmarked, persist across navs).
    head += `<link rel="stylesheet" href="${escapeHtml(href)}" data-dnx-css>`;
  }
  return head;
}

/**
 * The trailing `<body>` scripts (public-env island, hydration data + Flight
 * island + client entry, dev script). Exposed so a streamed PPR response can emit
 * them AFTER the dynamic holes, so the client entry hydrates the complete document.
 */
export function renderBodyScripts(opts: DocumentOptions): string {
  let scripts = "";
  // Public env island: available to any client code, so emitted independently of
  // hydration. Only public-prefixed variables are ever present here.
  if (opts.publicEnv && Object.keys(opts.publicEnv).length > 0) {
    scripts += jsonIsland(PUBLIC_ENV_ID, opts.publicEnv);
  }
  if (opts.hydration && opts.clientEntry) scripts += hydrationScripts(opts, opts.clientEntry);
  // Dev-only render-mode manifest for the devtools glass-box (CSP-safe JSON island).
  // The two streamed-Flight paths pre-capture it (their context has unwound by the
  // time this runs); every other path builds it live here.
  scripts += opts.renderModeScript ?? renderModeIsland(opts.hydration?.pathname);
  return scripts + devScript(opts);
}

/** A `<script type="application/json">` data island (script-safe: `<` escaped). */
function jsonIsland(id: string, value: unknown): string {
  return `<script id="${id}" type="application/json">${
    JSON.stringify(value).replace(/</g, "\\u003c")
  }</script>`;
}

/**
 * The hydration islands + the client entry: the image runtime config (only when it differs
 * from the default optimizing baseline — a page with no client JS never re-renders, so it
 * needs none), the hydration data, the Flight tree, the lazy islands' own Flight trees
 * (keyed by tree-path id, hydrated per-island when each `client:*` strategy fires), and the
 * signal state (`useId → value`, adopted by the client before hydration).
 */
function hydrationScripts(opts: DocumentOptions, clientEntry: string): string {
  let scripts = "";
  if (imageConfigNeedsEmbed()) scripts += jsonIsland(IMAGE_CONFIG_ID, getImageRuntimeConfig());
  scripts += jsonIsland("__denext_data", opts.hydration);
  if (opts.flight !== undefined) {
    scripts += `<script id="__denext_flight" type="application/json">${
      serializeFlight(opts.flight)
    }</script>`;
  }
  if (opts.islands && opts.islands.length > 0) {
    const map: Record<string, unknown> = {};
    for (const island of opts.islands) map[island.id] = island.flight;
    scripts += jsonIsland("__denext_islands", map);
  }
  if (opts.signalState && Object.keys(opts.signalState).length > 0) {
    scripts += jsonIsland("__denext_state", opts.signalState);
  }
  return scripts + `<script type="module" src="${escapeHtml(clientEntry)}"></script>`;
}

/**
 * The dev script: an external same-origin one (CSP-clean) is preferred, falling back to
 * inline. A CLASSIC script (not a module) so it runs during parse — before the deferred
 * hydration module — preserving the pre-hydration `__denextDev` marker.
 */
function devScript(opts: DocumentOptions): string {
  if (opts.devScriptSrc) return `<script src="${escapeHtml(opts.devScriptSrc)}"></script>`;
  if (opts.devScript) return `<script>${opts.devScript}</script>`;
  return "";
}

/** The `data-route` attribute for the hydration root (empty when not hydrating). */
function rootRouteAttr(opts: DocumentOptions): string {
  return opts.hydration ? ` data-route="${escapeHtml(opts.hydration.pathname)}"` : "";
}

/**
 * Render a complete HTML document string: `<!DOCTYPE>` + `<html>` with the head
 * content (metadata/viewport/styles), the hydration root wrapping `bodyHtml`, and
 * the body scripts. The non-streaming counterpart to {@linkcode streamPprDocument}.
 */
export function renderDocument(opts: DocumentOptions): string {
  const { bodyHtml, metadata } = opts;
  const lang = opts.lang ?? "en";

  // Extracted route stylesheets are linked after metadata so page CSS can override.
  const head = renderHeadContent(metadata, opts.viewport, opts.styles);
  const scripts = renderBodyScripts(opts);

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>${head}</head>
<body><div id="${ROOT_ID}"${rootRouteAttr(opts)}>${bodyHtml}</div>${scripts}</body>
</html>`;
}

/**
 * Whether this process is in dev (enables the in-hole inline-`<style>` warning).
 */
function isDev(): boolean {
  return (globalThis as { __denextDev?: boolean }).__denextDev === true;
}

/**
 * Drain a set of {@link PendingHole}s into `controller`, framing each resolved hole
 * as a `<template data-dnx-r="id">` (revealed client-side by the one
 * {@link SWAP_RUNTIME}). Shared by {@linkcode streamPageDocument} and
 * {@linkcode streamPprDocument} so their hole handling — ordering, per-hole error
 * skipping, abort — can't drift apart.
 *
 * A hole resolves (never rejects) to `{ id, html, ok }`: on `ok:false` its shell
 * fallback is left in place and the hole is skipped, so ONE failing hole can never
 * reject the race and truncate the document. Aborts when `signal` fires.
 *
 * A streamed hole must not introduce an inline `<style>`/`<script>`: the streaming
 * CSP is computed over the buffered shell prefix only, so an in-hole inline `<style>`
 * would be unhashed (and blocked), and any in-hole inline `<script>` is blocked by
 * `script-src`. In dev, warn once-ish if a hole carries an inline `<style>`.
 */
async function streamHoles<H extends Awaited<PendingHole>>(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  active: Set<Promise<H>>,
  signal?: AbortSignal,
  onHole?: (hole: H) => void,
): Promise<void> {
  const timings: Array<{ id: string; ms: number }> = [];
  while (active.size > 0) {
    if (signal?.aborted) break;
    const hole = await takeSettled(active);
    const { id, html, ok, ms } = hole;
    const timed = isDev() && ms !== undefined;
    if (timed) timings.push({ id, ms: Math.round(ms! * 100) / 100 });
    if (!ok) continue; // leave the shell fallback for this hole
    onHole?.(hole);
    if (isDev() && /<style\b/i.test(html)) {
      console.warn(
        `denext: streamed hole "${id}" contains an inline <style> — it is not covered ` +
          `by the streaming CSP (which hashes only the buffered shell) and will be ` +
          `blocked. Move the style into a stylesheet or the shell.`,
      );
    }
    // In dev, stamp the server resolve time so the swap runtime can build a real-time
    // reveal timeline (attributes don't affect the swap-runtime script's CSP hash).
    const msAttr = timed ? ` data-dnx-ms="${Math.round(ms! * 100) / 100}"` : "";
    controller.enqueue(
      encoder.encode(`<template data-dnx-r="${id}"${msAttr}>${html}</template>`),
    );
  }
  // Dev-only per-boundary timeline: a CSP-safe JSON data block (not executed).
  if (isDev() && timings.length > 0) {
    const json = JSON.stringify(timings).replace(/</g, "\\u003c");
    controller.enqueue(
      encoder.encode(
        `<script type="application/json" id="__denext_boundary_timing">${json}</script>`,
      ),
    );
  }
}

/**
 * Build the non-rejecting {@link PendingHole} set for a PPR document's per-request
 * holes: each resolves to `{ id, html, ok:true }`, or logs and resolves `ok:false`
 * on failure so a resume error leaves the hole's shell fallback in place.
 */
function pprHoles(holes: ResumedHole[]): Set<PendingHole> {
  return new Set(
    holes.map((h) =>
      Promise.resolve(h.html)
        .then((html) => ({ id: h.id, html, ok: true }))
        .catch((err) => {
          console.error("denext: PPR hole failed to resume:", h.id, err);
          return { id: h.id, html: "", ok: false };
        })
    ),
  );
}

/**
 * Stream a PPR document: flush the cached shell (its `<head>` rebuilt per request)
 * with each dynamic hole showing its fallback, then stream each hole's real content
 * as a `<template data-dnx-r>` as it resolves (revealed by the one {@link SWAP_RUNTIME}
 * emitted after the shell), and finally the hydration scripts + client entry —
 * emitted LAST so the client hydrates the COMPLETE (holes-filled) document, exactly
 * as the buffered path did.
 *
 * @param opts Document options; `bodyHtml` is the cached shell body (with
 *   `data-dnx-b` hole placeholders), `holes` are the per-request holes (each `html`
 *   may still be resolving), and `signal` aborts a disconnected stream.
 */
export function streamPprDocument(
  opts: DocumentOptions & { holes: ResumedHole[]; signal?: AbortSignal },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lang = opts.lang ?? "en";
  const head = renderHeadContent(opts.metadata, opts.viewport, opts.styles);
  const prefix = `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>${head}</head>
<body><div id="${ROOT_ID}"${rootRouteAttr(opts)}>${opts.bodyHtml}</div>${SWAP_RUNTIME}`;
  const tail = `${renderBodyScripts(opts)}</body>
</html>`;
  const active = pprHoles(opts.holes);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(prefix));
        await streamHoles(controller, encoder, active, opts.signal);
        controller.enqueue(encoder.encode(tail));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Stream a live (non-PPR) page document: flush `<head>` + the already-rendered
 * shell (its Suspense boundaries showing fallbacks), then stream each boundary's
 * real content as a `<template data-dnx-r>` as it resolves (revealed by the one
 * {@link SWAP_RUNTIME} emitted after the shell), then the hydration scripts LAST so
 * the client hydrates the complete document — the incremental-streaming counterpart
 * to {@linkcode renderDocument}.
 *
 * The shell is passed **already rendered** (via `renderShell`) so a control signal
 * thrown during it was handled by the caller before any bytes flush. The caller
 * computes the streamed response's CSP from the buffered shell prefix via
 * {@linkcode resolveStreamingCsp} (the swap runtime is a hashed constant), so a
 * streamed document carries the same strict CSP as a buffered one.
 *
 * @param opts Document options (minus `bodyHtml`) plus the rendered `shell` and an
 *   optional abort `signal`. `metadata` should already include any in-tree
 *   `<title>`/head tags the shell hoisted.
 */
export function streamPageDocument(
  opts: Omit<DocumentOptions, "bodyHtml"> & {
    shell: ShellRender;
    signal?: AbortSignal;
  },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lang = opts.lang ?? "en";
  const head = renderHeadContent(opts.metadata, opts.viewport, opts.styles);
  // rootRouteAttr/renderBodyScripts read only head/hydration/script fields, never
  // bodyHtml — cast to satisfy the shared DocumentOptions shape.
  const docOpts = opts as unknown as DocumentOptions;
  const prefix = `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>${head}</head>
<body><div id="${ROOT_ID}"${rootRouteAttr(docOpts)}>${opts.shell.shell}</div>${SWAP_RUNTIME}`;
  const tail = `${renderBodyScripts(docOpts)}</body>
</html>`;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(prefix));
        await streamHoles(controller, encoder, opts.shell.holes, opts.signal);
        controller.enqueue(encoder.encode(tail));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Stream a Flight (`"use client"`) page document: flush `<head>` + the Flight shell
 * (Suspense boundaries as fallbacks), stream each boundary as a `<template data-dnx-r>`
 * revealed by the one {@link SWAP_RUNTIME}, then emit the trailing Flight/islands/
 * signal-state islands (computed once all holes resolve) followed by the client entry
 * — LAST, so the client hydrates the COMPLETE tree with its islands wired up. The
 * Flight analogue of {@linkcode streamPageDocument}; the caller applies the streaming
 * CSP (the swap runtime is a hashed constant).
 *
 * @param opts Document options (minus `bodyHtml`/`flight`/`islands`/`signalState`,
 *   which come from the streamed tail) plus the rendered `flightShell` and an
 *   optional abort `signal`.
 */
export function streamFlightDocument(
  opts: Omit<DocumentOptions, "bodyHtml" | "flight" | "islands" | "signalState"> & {
    flightShell: FlightShellRender;
    signal?: AbortSignal;
  },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lang = opts.lang ?? "en";
  const head = renderHeadContent(opts.metadata, opts.viewport, opts.styles);
  const docOpts = opts as unknown as DocumentOptions;
  // Capture the dev render-mode island now, while the request context is still live —
  // renderBodyScripts below runs inside the stream's async start(), after it unwinds.
  const renderModeScript = renderModeIsland(docOpts.hydration?.pathname);
  const prefix = `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>${head}</head>
<body><div id="${ROOT_ID}"${
    rootRouteAttr(docOpts)
  }>${opts.flightShell.shellHtml}</div>${SWAP_RUNTIME}`;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(prefix));
        // Drain the holes (each streamed as a <template>) and collect the tail: the
        // complete Flight tree + islands + signal state.
        const flightTail = await opts.flightShell.streamHoles(controller, encoder, opts.signal);
        // Merge the tail into the body scripts so renderBodyScripts emits the Flight/
        // islands/state islands BEFORE the client entry (its documented order).
        const tailOpts: DocumentOptions = {
          ...docOpts,
          flight: flightTail.flight,
          islands: flightTail.islands,
          signalState: flightTail.signalState,
          renderModeScript,
        };
        controller.enqueue(encoder.encode(`${renderBodyScripts(tailOpts)}</body>\n</html>`));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Stream a Flight ("use client") PPR document: flush `<head>` + the **cached** shell
 * body (dynamic holes showing fallbacks), stream each hole's real content as a
 * `<template data-dnx-r>` as it resolves (revealed by the one {@link SWAP_RUNTIME}),
 * then — once every hole has drained — fill the cached shell Flight tree with the
 * resume subtrees, merge the shell + resume islands and signal state, and emit the
 * trailing #__denext_flight / #__denext_islands / #__denext_state payload + client
 * entry LAST. This is the union of {@linkcode streamPprDocument} (cached shell + swap
 * holes) and {@linkcode streamFlightDocument} (trailing Flight tail): the client sees
 * exactly the tail a non-PPR streamed Flight route emits, so it never learns the shell
 * was cached. The caller applies the streaming CSP (the swap runtime is a hashed
 * constant).
 *
 * @param opts Document options plus the cached shell (`shellBody`/`shellFlight`/
 *   `shellIslands`/`shellSignalState`), the per-request `resume` (unawaited holes +
 *   live island accumulator + `finishSignals`), and an optional abort `signal`.
 */
export function streamPprFlightDocument(
  opts:
    & Omit<DocumentOptions, "bodyHtml" | "flight" | "islands" | "signalState">
    & {
      shellBody: string;
      shellFlight: FlightNode;
      shellIslands: IslandPayload[];
      shellSignalState: Record<string, unknown>;
      resume: {
        holes: ResumedFlightHole[];
        islands: IslandPayload[];
        finishSignals(): Record<string, unknown>;
      };
      signal?: AbortSignal;
    },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lang = opts.lang ?? "en";
  const head = renderHeadContent(opts.metadata, opts.viewport, opts.styles);
  const docOpts = opts as unknown as DocumentOptions;
  // Capture the dev render-mode island now (context is live); the tail below runs
  // inside the stream's async start(), after the request context has unwound.
  const renderModeScript = renderModeIsland(docOpts.hydration?.pathname);
  const prefix = `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>${head}</head>
<body><div id="${ROOT_ID}"${rootRouteAttr(docOpts)}>${opts.shellBody}</div>${SWAP_RUNTIME}`;
  const active = settlingHoles(opts.resume.holes);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Close signal collection exactly once (success or failure) so the module-global
      // collector never leaks into a later render. The success path uses its result.
      let signalMap: Record<string, unknown> | null = null;
      const finish = () => (signalMap ??= opts.resume.finishSignals());
      try {
        controller.enqueue(encoder.encode(prefix));
        const holeFlights = await streamResumedHoles(active, controller, opts.signal);
        // All holes drained: fill the cached shell Flight, merge islands + signal state.
        const flight = fillFlightHoles(opts.shellFlight, holeFlights);
        const islands = [...opts.shellIslands, ...opts.resume.islands];
        const signalState = { ...opts.shellSignalState, ...finish() };
        const tailOpts: DocumentOptions = {
          ...docOpts,
          flight,
          islands: islands.length > 0 ? islands : undefined,
          signalState: Object.keys(signalState).length > 0 ? signalState : undefined,
          renderModeScript,
        };
        controller.enqueue(encoder.encode(`${renderBodyScripts(tailOpts)}</body>\n</html>`));
        controller.close();
      } catch (err) {
        finish(); // reset the collector even on failure
        controller.error(err);
      }
    },
  });
}

/** One resumed hole once both its HTML and Flight subtree have settled. */
interface SettledHole {
  id: string;
  html: string;
  flight: FlightNode;
  ok: boolean;
}

/**
 * Non-rejecting holes: each resolves to `{ id, html, flight, ok }`. A failed hole
 * streams nothing (its shell fallback stays) and its Flight hole fills with `null`.
 */
function settlingHoles(holes: ResumedFlightHole[]): Set<Promise<SettledHole>> {
  return new Set(
    holes.map((hole) =>
      Promise.all([Promise.resolve(hole.html), Promise.resolve(hole.flight)])
        .then(([html, flight]) => ({ id: hole.id, html, flight, ok: true }))
        .catch((err) => {
          console.error("denext: Flight PPR hole failed to resume:", hole.id, err);
          return { id: hole.id, html: "", flight: null as FlightNode, ok: false };
        })
    ),
  );
}

/**
 * Stream each resumed hole as it settles (via {@link streamHoles}: completion order,
 * per-hole error skipping, abort) and collect the resolved Flight subtree per hole id.
 */
async function streamResumedHoles(
  active: Set<Promise<SettledHole>>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Map<string, FlightNode>> {
  const holeFlights = new Map<string, FlightNode>();
  await streamHoles(controller, new TextEncoder(), active, signal, (hole) => {
    holeFlights.set(hole.id, hole.flight);
  });
  return holeFlights;
}

/** Resolve a possibly-relative URL against `metadataBase`. */
function resolveMetaUrl(url: string, base?: string | URL): string {
  if (!base) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/**
 * Serialize a JSON-LD object for embedding in a `<script type="application/ld+json">`.
 * Uses `JSON.stringify` (NOT `escapeHtml`, which would corrupt the JSON), then
 * neutralizes only the sequences that could terminate the script element or break
 * the parser: `<`, `>`, `&`, and the U+2028/U+2029 line separators. Escape codes are
 * matched by code point (no invisible characters in source).
 */
function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => {
    switch (c.charCodeAt(0)) {
      case 0x3c:
        return "\\u003c";
      case 0x3e:
        return "\\u003e";
      case 0x26:
        return "\\u0026";
      case 0x2028:
        return "\\u2028";
      default:
        return "\\u2029";
    }
  });
}

/** Serialize a robots directive (string passthrough or structured object). */
function robotsContent(robots: string | RobotsMetadata): string {
  if (typeof robots === "string") return robots;
  const parts = [
    robots.index === false ? "noindex" : "index",
    robots.follow === false ? "nofollow" : "follow",
  ];
  if (robots.noarchive) parts.push("noarchive");
  return parts.join(", ");
}

/** Build the `<meta name="viewport">` content string. */
function viewportContent(v?: Viewport): string {
  if (!v) return "width=device-width, initial-scale=1";
  const parts = [
    `width=${v.width ?? "device-width"}`,
    `initial-scale=${v.initialScale ?? 1}`,
  ];
  if (v.maximumScale !== undefined) {
    parts.push(`maximum-scale=${v.maximumScale}`);
  }
  if (v.minimumScale !== undefined) parts.push(`minimum-scale=${v.minimumScale}`);
  if (v.userScalable === false) parts.push("user-scalable=no");
  if (v.viewportFit) parts.push(`viewport-fit=${v.viewportFit}`);
  if (v.interactiveWidget) parts.push(`interactive-widget=${v.interactiveWidget}`);
  return parts.join(", ");
}

/** `<meta name="theme-color">` — one color, or one tag per media-query descriptor. */
function themeColorTags(tc: Viewport["themeColor"]): string {
  let head = "";
  for (const item of list(tc)) {
    if (typeof item === "string") head += nameTag("theme-color", item);
    else if (item.media) {
      head += `<meta name="theme-color" media="${escapeHtml(item.media)}" content="${
        escapeHtml(item.color)
      }">`;
    } else head += nameTag("theme-color", item.color);
  }
  return head;
}

/** Simple `<meta name>` fields copied straight from the metadata object. */
const NAME_FIELDS: Array<[keyof Metadata, string]> = [
  ["applicationName", "application-name"],
  ["generator", "generator"],
  ["referrer", "referrer"],
  ["creator", "creator"],
  ["publisher", "publisher"],
  ["category", "category"],
  ["classification", "classification"],
];

const nameTag = (name: string, content?: string): string =>
  content == null ? "" : `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
const propTag = (property: string, content?: string): string =>
  content == null
    ? ""
    : `<meta property="${escapeHtml(property)}" content="${escapeHtml(content)}">`;
const linkTag = (rel: string, href?: string): string =>
  href == null ? "" : `<link rel="${escapeHtml(rel)}" href="${escapeHtml(href)}">`;
const list = <T>(v?: T | T[]): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Charset, viewport, theme, title, description, keywords, robots. */
function headBasics(metadata: Metadata, viewport?: Viewport): string {
  let head = `<meta charset="utf-8">`;
  head += `<meta name="viewport" content="${escapeHtml(viewportContent(viewport))}">`;
  head += themeColorTags(viewport?.themeColor);
  head += nameTag("color-scheme", viewport?.colorScheme);
  // `title` is resolved to a string by mergeMetadata; handle the object form
  // defensively in case a title reaches here unmerged.
  const titleStr = typeof metadata.title === "string"
    ? metadata.title
    : metadata.title?.absolute ?? metadata.title?.default;
  if (titleStr !== undefined) head += `<title>${escapeHtml(titleStr)}</title>`;
  head += nameTag("description", metadata.description);
  const keywords = list(metadata.keywords);
  if (keywords.length) head += nameTag("keywords", keywords.join(", "));
  for (const k of NAME_FIELDS) head += nameTag(k[1], metadata[k[0]] as string | undefined);
  if (metadata.robots !== undefined) head += nameTag("robots", robotsContent(metadata.robots));
  if (typeof metadata.robots === "object" && metadata.robots.googleBot) {
    head += nameTag("googlebot", metadata.robots.googleBot);
  }
  return head;
}

/** Authors, site verification, canonical + language alternates, icons. */
function headLinks(metadata: Metadata): string {
  const base = metadata.metadataBase;
  let head = "";
  for (const a of list(metadata.authors)) {
    head += nameTag("author", a.name) + linkTag("author", a.url);
  }
  // Site verification (e.g. `google` → `google-site-verification`).
  for (const [k, v] of Object.entries(metadata.verification ?? {})) {
    head += nameTag(`${k}-site-verification`, v);
  }
  const canonical = metadata.alternates?.canonical ?? metadata.canonical;
  if (canonical) head += linkTag("canonical", resolveMetaUrl(canonical, base));
  for (const [lang, url] of Object.entries(metadata.alternates?.languages ?? {})) {
    head += `<link rel="alternate" hreflang="${escapeHtml(lang)}" href="${
      escapeHtml(resolveMetaUrl(url, base))
    }">`;
  }
  for (const [media, url] of Object.entries(metadata.alternates?.media ?? {})) {
    head += `<link rel="alternate" media="${escapeHtml(media)}" href="${
      escapeHtml(resolveMetaUrl(url, base))
    }">`;
  }
  for (const [type, url] of Object.entries(metadata.alternates?.types ?? {})) {
    head += `<link rel="alternate" type="${escapeHtml(type)}" href="${
      escapeHtml(resolveMetaUrl(url, base))
    }">`;
  }
  head += linkTag("manifest", metadata.manifest);
  for (const rel of ["archives", "assets", "bookmarks"] as const) {
    for (const href of list(metadata[rel])) head += linkTag(rel, href);
  }
  return head + headIcons(metadata);
}

/** Icons (shorthand + structured descriptors with sizes/type/media/rel). */
function headIcons(metadata: Metadata): string {
  let head = linkTag("icon", metadata.icon);
  for (const i of list(metadata.icons?.icon)) head += iconTag("icon", i);
  for (const i of list(metadata.icons?.shortcut)) head += iconTag("shortcut icon", i);
  for (const i of list(metadata.icons?.apple)) head += iconTag("apple-touch-icon", i);
  for (const i of list(metadata.icons?.other)) head += iconTag(i.rel ?? "icon", i);
  return head;
}

function iconTag(rel: string, icon: string | IconDescriptor): string {
  if (typeof icon === "string") return linkTag(rel, icon);
  let tag = `<link rel="${escapeHtml(icon.rel ?? rel)}" href="${escapeHtml(icon.url)}"`;
  if (icon.sizes) tag += ` sizes="${escapeHtml(icon.sizes)}"`;
  if (icon.type) tag += ` type="${escapeHtml(icon.type)}"`;
  if (icon.media) tag += ` media="${escapeHtml(icon.media)}"`;
  if (icon.color) tag += ` color="${escapeHtml(icon.color)}"`;
  return tag + ">";
}

/** Open Graph + Twitter Card tags. */
function headSocial(metadata: Metadata): string {
  const base = metadata.metadataBase;
  let head = "";
  const og = metadata.openGraph;
  if (og) {
    head += propTag("og:title", og.title) + propTag("og:description", og.description) +
      propTag("og:type", og.type) + propTag("og:url", og.url) +
      propTag("og:site_name", og.siteName) + propTag("og:locale", og.locale) +
      propTag("og:determiner", og.determiner) + propTag("og:country_name", og.countryName) +
      propTag("og:ttl", og.ttl?.toString());
    for (const l of list(og.alternateLocale)) head += propTag("og:locale:alternate", l);
    for (const img of list(og.images)) head += mediaTags("og:image", img, base);
    for (const v of list(og.videos)) head += mediaTags("og:video", v, base);
    for (const a of list(og.audio)) head += mediaTags("og:audio", a, base);
    head += ogArticleTags(og) + ogContactTags(og);
  }
  return head + headTwitter(metadata.twitter, base);
}

/** `article:*` tags (Next emits them for `type: "article"` fields). */
function ogArticleTags(og: OpenGraphMetadata): string {
  let head = propTag("article:published_time", og.publishedTime) +
    propTag("article:modified_time", og.modifiedTime) +
    propTag("article:expiration_time", og.expirationTime) +
    propTag("article:section", og.section);
  for (const a of list(og.authors)) head += propTag("article:author", a);
  for (const t of list(og.tags)) head += propTag("article:tag", t);
  return head;
}

function ogContactTags(og: OpenGraphMetadata): string {
  let head = "";
  for (const e of list(og.emails)) head += propTag("og:email", e);
  for (const n of list(og.phoneNumbers)) head += propTag("og:phone_number", n);
  for (const n of list(og.faxNumbers)) head += propTag("og:fax_number", n);
  return head;
}

/** `og:image`/`og:video`/`og:audio` (+ `:width`/`:height`/`:alt`/`:type`) for one entry. */
function mediaTags(
  prop: string,
  media: string | OpenGraphImage | OpenGraphMedia,
  base: Metadata["metadataBase"],
): string {
  if (typeof media === "string") return propTag(prop, resolveMetaUrl(media, base));
  return propTag(prop, resolveMetaUrl(media.url, base)) +
    propTag(`${prop}:width`, media.width?.toString()) +
    propTag(`${prop}:height`, media.height?.toString()) +
    propTag(`${prop}:alt`, (media as OpenGraphImage).alt) +
    propTag(`${prop}:type`, media.type);
}

function headTwitter(t: Metadata["twitter"], base: Metadata["metadataBase"]): string {
  if (!t) return "";
  let head = nameTag("twitter:card", t.card) + nameTag("twitter:site", t.site) +
    nameTag("twitter:site:id", t.siteId) + nameTag("twitter:creator", t.creator) +
    nameTag("twitter:creator:id", t.creatorId) + nameTag("twitter:title", t.title) +
    nameTag("twitter:description", t.description);
  for (const img of list(t.images)) {
    if (typeof img === "string") head += nameTag("twitter:image", resolveMetaUrl(img, base));
    else {
      head += nameTag("twitter:image", resolveMetaUrl(img.url, base)) +
        nameTag("twitter:image:alt", img.alt) +
        nameTag("twitter:image:width", img.width?.toString()) +
        nameTag("twitter:image:height", img.height?.toString());
    }
  }
  return head;
}

/**
 * Free-form `meta`, JSON-LD (each object its own script, script-safe — see serializeJsonLd),
 * and the raw `metadata.head` escape hatch last. L6: `metadata.head` is the one <head> sink
 * injected verbatim (no escaping) — an author-controlled escape hatch for raw tags. Warn in
 * dev that untrusted input here is an injection vector, mirroring warnDangerousHtml; gated
 * on `__denextDev` so production SSR pays nothing, and de-duplicated by content so a STATIC
 * head warns once while a head interpolating changing data — the risky case — keeps warning.
 */
function headExtras(metadata: Metadata): string {
  let head = "";
  for (const [name, content] of Object.entries(metadata.meta ?? {})) head += nameTag(name, content);
  for (const [name, content] of Object.entries(metadata.other ?? {})) {
    for (const v of list(content)) head += nameTag(name, String(v));
  }
  for (const [prop, content] of Object.entries(metadata.itemProp ?? {})) {
    head += `<meta itemprop="${escapeHtml(prop)}" content="${escapeHtml(content)}">`;
  }
  head += appleWebAppTags(metadata.appleWebApp) + formatDetectionTag(metadata.formatDetection) +
    appLinkTags(metadata.appLinks);
  for (const item of list(metadata.jsonLd)) {
    if (item == null) continue;
    head += `<script type="application/ld+json">${serializeJsonLd(item)}</script>`;
  }
  if (metadata.head) {
    if ((globalThis as { __denextDev?: boolean }).__denextDev === true) {
      warnRawHeadOnce(metadata.head);
    }
    head += metadata.head;
  }
  return head;
}

/** `apple-mobile-web-app-*` tags + startup images. */
function appleWebAppTags(a: Metadata["appleWebApp"]): string {
  if (!a) return "";
  const cfg = a === true ? {} : a;
  let head = nameTag("mobile-web-app-capable", "yes");
  head += nameTag("apple-mobile-web-app-capable", cfg.capable === false ? "no" : "yes");
  head += nameTag("apple-mobile-web-app-title", cfg.title);
  head += nameTag("apple-mobile-web-app-status-bar-style", cfg.statusBarStyle);
  for (const img of list(cfg.startupImage)) {
    const { url, media } = typeof img === "string" ? { url: img, media: undefined } : img;
    head += `<link rel="apple-touch-startup-image" href="${escapeHtml(url)}"${
      media ? ` media="${escapeHtml(media)}"` : ""
    }>`;
  }
  return head;
}

/** `<meta name="format-detection" content="telephone=no, …">` for the disabled kinds. */
function formatDetectionTag(fd: Metadata["formatDetection"]): string {
  if (!fd) return "";
  const off = Object.entries(fd).filter(([, v]) => v === false).map(([k]) => `${k}=no`);
  return off.length ? nameTag("format-detection", off.join(", ")) : "";
}

/** `al:<platform>:<key>` app-link tags. */
function appLinkTags(links: Metadata["appLinks"]): string {
  let head = "";
  for (const [platform, entries] of Object.entries(links ?? {})) {
    for (const entry of list(entries)) {
      for (const [k, v] of Object.entries(entry)) {
        head += propTag(
          `al:${platform}:${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`,
          String(v),
        );
      }
    }
  }
  return head;
}

function renderHead(metadata: Metadata, viewport?: Viewport): string {
  return headBasics(metadata, viewport) + headLinks(metadata) + headSocial(metadata) +
    headExtras(metadata);
}

/** Distinct `metadata.head` bodies already warned about this process (dev only). */
const warnedHeads = new Set<string>();

/** Warn once per distinct raw-`<head>` body (see {@link renderHead}). */
function warnRawHeadOnce(headHtml: string): void {
  if (warnedHeads.has(headHtml)) return;
  // Bound the set so a per-request-varying head can't leak memory; it still re-warns
  // (that head is the risky one). 256 distinct bodies is far past any real app.
  if (warnedHeads.size >= 256) warnedHeads.clear();
  warnedHeads.add(headHtml);
  console.warn(
    "denext: metadata.head is injected into <head> as raw HTML — sanitize " +
      "any untrusted input to avoid injection. (dev-only warning)",
  );
}
