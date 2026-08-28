/**
 * `@denext/htmx` — first-class {@link https://htmx.org | htmx} support for denext,
 * shipped as a {@link https://jsr.io/@denext/denext | denext} plugin. Add it to your
 * `denext.config.ts` and drop `<Htmx/>` in your root layout; every `hx-*` attribute
 * then works — server-rendered verbatim, no client denext JS required.
 *
 * ```ts
 * // denext.config.ts
 * import { htmx } from "@denext/htmx";
 * export default { plugins: [htmx()] };
 * ```
 *
 * ```tsx
 * // app/layout.tsx
 * import { Htmx } from "@denext/htmx";
 * export default function Layout({ children }) {
 *   return <html><body>{children}<Htmx /></body></html>;
 * }
 *
 * // app/page.tsx — a page that ships 0 KB of denext JS
 * export default function Page() {
 *   return <button hx-post="/clicked" hx-swap="outerHTML">Click me</button>;
 * }
 *
 * // app/clicked/route.ts — the fragment endpoint
 * import { htmlResponse } from "@denext/htmx";
 * export function POST() {
 *   return htmlResponse(<span>Clicked!</span>, { retarget: "#result" });
 * }
 * ```
 *
 * The vendored htmx runtime (v{@linkcode HTMX_VERSION}) is served from your own
 * origin at {@linkcode HTMX_RUNTIME_PATH} — zero npm, zero CDN, works under a strict
 * `script-src 'self'` CSP. The package version tracks the htmx version it wraps.
 *
 * @module
 */

import { h } from "@denext/denext";
import type { VNode } from "@denext/denext";
import type { DenextPlugin, PluginContext, VNodeChild } from "@denext/denext/server";
import { renderToString } from "@denext/denext";
import { join } from "@std/path";
import type { HtmxAttributes } from "./types.ts";
import { htmxCommand } from "./command.ts";
import { HTMX_RUNTIME_PATH, HTMX_VERSION } from "./constants.ts";

// Re-export the denext types referenced by this package's public API (and their
// transitively-referenced members) so the generated docs are self-contained —
// deno doc --lint requires every type used in a public signature to be exported
// from an entrypoint. `htmx()` returns a `DenextPlugin`, which drags in the whole
// plugin/config/VNode tree; mirrors the same doc-completeness re-exports
// @denext/pages-router ships. Type-only; no runtime effect.
export { FRAGMENT } from "@denext/denext/server";
export type {
  ApiRoute,
  Component,
  CspSetting,
  DenextConfig,
  DenextPlugin,
  Directive,
  ExperimentalConfig,
  HeaderRule,
  HstsConfig,
  I18nConfig,
  ImagesConfig,
  Intercept,
  Key,
  LocalPattern,
  Messages,
  ModuleLoader,
  PageRoute,
  PluginBuildContext,
  PluginBuildStep,
  PluginContext,
  PluginMode,
  PluginRequestHandler,
  PluginTeardown,
  RedirectRule,
  RemotePattern,
  RewriteRule,
  RouteCsp,
  RouteManifest,
  RouteSynthesizer,
  Segment,
  SegmentKind,
  SlotRoutes,
  TailwindConfig,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
} from "@denext/denext/server";
export type { HtmxAttributes, HtmxSwap } from "./types.ts";
export { HTMX_RUNTIME_PATH, HTMX_VERSION } from "./constants.ts";

/** Options for {@linkcode htmx}. */
export interface HtmxOptions {
  /**
   * Override the URL the runtime is served from. Defaults to
   * {@linkcode HTMX_RUNTIME_PATH} (prefixed with the project's `basePath`).
   */
  path?: string;
}

/** Read the vendored htmx runtime bytes (works from a local checkout and from JSR). */
let runtimeBytes: Uint8Array | null = null;
async function readRuntime(): Promise<Uint8Array> {
  if (runtimeBytes) return runtimeBytes;
  // `fetch` of the resolved asset URL works for both `file://` (local/dev) and
  // `https://jsr.io/...` (published) — Deno resolves import.meta-relative URLs for both.
  const res = await fetch(new URL("./vendor/htmx.min.js", import.meta.url));
  runtimeBytes = new Uint8Array(await res.arrayBuffer());
  return runtimeBytes;
}

/**
 * Create the htmx plugin. Place it in your `denext.config.ts` `plugins`. It serves
 * the vendored htmx runtime from your origin (so a strict `script-src 'self'` CSP
 * needs no change) and, at build time, emits it into the export output so static
 * sites serve it too.
 *
 * @param options Optional overrides (e.g. a custom runtime path).
 */
export function htmx(options: HtmxOptions = {}): DenextPlugin {
  return {
    name: "@denext/htmx",
    setup(ctx: PluginContext) {
      const basePath = ctx.config.basePath ?? "";
      const servePath = basePath + (options.path ?? HTMX_RUNTIME_PATH);
      const etag = `"htmx-${HTMX_VERSION}"`;

      // Serve the runtime in dev and prod (the core router never matches
      // `/_denext/htmx/*`, so this handler always gets first refusal at it).
      ctx.addRequestHandler(async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== servePath) return null;
        // Conditional GET: htmx.min.js is immutable per version.
        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        const body = await readRuntime();
        return new Response(body as BodyInit, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "public, max-age=3600",
            etag,
          },
        });
      });

      // Build/export: emit the runtime to disk so `denext start` / a static export
      // serves it as a plain file (no server handler in play for static output).
      ctx.addBuildStep(async ({ outDir }) => {
        const dest = join(outDir, ...servePath.split("/").filter(Boolean));
        await Deno.mkdir(join(dest, ".."), { recursive: true });
        await Deno.writeFile(dest, await readRuntime());
      });

      // Contribute the `denext htmx` verb (info / eject).
      ctx.addCommand(htmxCommand);
    },
  };
}

export { htmxCommand } from "./command.ts";

/** Props for {@linkcode Htmx}. */
export interface HtmxScriptProps {
  /**
   * Override the runtime URL (must match the {@linkcode htmx} plugin's `path`).
   * Defaults to {@linkcode HTMX_RUNTIME_PATH}.
   */
  src?: string;
  /** CSP nonce, if your policy uses per-response nonces instead of `'self'`. */
  nonce?: string;
}

/**
 * The `<script>` tag that loads the htmx runtime. Place it once, near the end of
 * `<body>` in your root layout. It loads as a classic (non-module) deferred script,
 * which is what htmx expects, and needs no nonce under `script-src 'self'`.
 */
export function Htmx(props: HtmxScriptProps = {}): VNode {
  return h("script", {
    src: props.src ?? HTMX_RUNTIME_PATH,
    defer: true,
    ...(props.nonce ? { nonce: props.nonce } : {}),
  });
}

/**
 * Turn the ergonomic {@linkcode HtmxAttributes} bag into real `hx-*` attributes,
 * for typed, autocompleting, typo-safe authoring:
 *
 * ```tsx
 * <button {...hx({ post: "/clicked", swap: "outerHTML", target: "#result" })}>Go</button>
 * ```
 *
 * Equivalent to writing `hx-post="/clicked" hx-swap="outerHTML" hx-target="#result"`
 * by hand — those raw attributes always work too; this is purely for DX.
 */
export function hx(attrs: HtmxAttributes): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "on" && value && typeof value === "object") {
      for (const [event, script] of Object.entries(value as Record<string, string>)) {
        out[`hx-on:${event}`] = script;
      }
      continue;
    }
    // camelCase → kebab-case (swapOob → swap-oob, pushUrl → push-url).
    const attr = "hx-" + key.replace(/([A-Z])/g, "-$1").toLowerCase();
    out[attr] = value === true ? "true" : String(value);
  }
  return out;
}

/** The htmx request headers, parsed from an incoming {@linkcode Request}. */
export interface HtmxRequestInfo {
  /** True if this request was issued by htmx (`HX-Request: true`). */
  isHtmx: boolean;
  /** True if the request came from an `hx-boost`ed element (`HX-Boosted`). */
  boosted: boolean;
  /** The URL of the browser when the request was made (`HX-Current-URL`). */
  currentUrl: string | null;
  /** True if this is a history-restore fetch (`HX-History-Restore-Request`). */
  historyRestore: boolean;
  /** The user's response to an `hx-prompt` (`HX-Prompt`). */
  prompt: string | null;
  /** The `id` of the target element (`HX-Target`). */
  target: string | null;
  /** The `id` of the triggering element (`HX-Trigger`). */
  triggerId: string | null;
  /** The `name` of the triggering element (`HX-Trigger-Name`). */
  triggerName: string | null;
}

/** True if the request was issued by htmx (has an `HX-Request: true` header). */
export function isHtmxRequest(request: Request): boolean {
  return request.headers.get("hx-request") === "true";
}

/** Parse the incoming htmx request headers into {@linkcode HtmxRequestInfo}. */
export function htmxRequest(request: Request): HtmxRequestInfo {
  const h = request.headers;
  return {
    isHtmx: h.get("hx-request") === "true",
    boosted: h.get("hx-boosted") === "true",
    currentUrl: h.get("hx-current-url"),
    historyRestore: h.get("hx-history-restore-request") === "true",
    prompt: h.get("hx-prompt"),
    target: h.get("hx-target"),
    triggerId: h.get("hx-trigger"),
    triggerName: h.get("hx-trigger-name"),
  };
}

/** Response-side htmx directives, set as `HX-*` headers by {@linkcode htmlResponse}. */
export interface HtmxResponseInit extends ResponseInit {
  /** Client-side redirect without a full reload (`HX-Location`). */
  location?: string;
  /** Push a new URL into history (`HX-Push-Url`); `false` disables the push. */
  pushUrl?: string | false;
  /** Replace the current URL in history (`HX-Replace-Url`); `false` disables it. */
  replaceUrl?: string | false;
  /** Client-side redirect via a full page reload (`HX-Redirect`). */
  redirect?: string;
  /** Force a full page refresh (`HX-Refresh`). */
  refresh?: boolean;
  /** Override how the response is swapped in (`HX-Reswap`). */
  reswap?: string;
  /** Override which element the response is swapped into (`HX-Retarget`). */
  retarget?: string;
  /** Choose which part of the response to swap (`HX-Reselect`). */
  reselect?: string;
  /** Trigger client events immediately (`HX-Trigger`) — a name or a JSON map. */
  trigger?: string | Record<string, unknown>;
  /** Trigger client events after the swap settles (`HX-Trigger-After-Settle`). */
  triggerAfterSettle?: string | Record<string, unknown>;
  /** Trigger client events after the swap (`HX-Trigger-After-Swap`). */
  triggerAfterSwap?: string | Record<string, unknown>;
}

const HX_HEADER: Record<string, string> = {
  location: "HX-Location",
  pushUrl: "HX-Push-Url",
  replaceUrl: "HX-Replace-Url",
  redirect: "HX-Redirect",
  refresh: "HX-Refresh",
  reswap: "HX-Reswap",
  retarget: "HX-Retarget",
  reselect: "HX-Reselect",
  trigger: "HX-Trigger",
  triggerAfterSettle: "HX-Trigger-After-Settle",
  triggerAfterSwap: "HX-Trigger-After-Swap",
};

/**
 * Render a denext `VNode` (or ready HTML string) to an HTML fragment `Response`,
 * applying any htmx response directives as `HX-*` headers. The workhorse for a
 * `route.ts` handler that answers an `hx-get`/`hx-post`:
 *
 * ```ts
 * export function POST() {
 *   return htmlResponse(<li>New item</li>, { reswap: "beforeend", retarget: "#list" });
 * }
 * ```
 */
export async function htmlResponse(
  body: VNodeChild | string,
  init: HtmxResponseInit = {},
): Promise<Response> {
  const html = typeof body === "string" ? body : await renderToString(body as VNode);
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  for (const [key, header] of Object.entries(HX_HEADER)) {
    const value = (init as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (value === false) continue;
    if (value === true) headers.set(header, "true");
    else if (typeof value === "object") headers.set(header, JSON.stringify(value));
    else headers.set(header, String(value));
  }
  return new Response(html, { status: init.status ?? 200, statusText: init.statusText, headers });
}
