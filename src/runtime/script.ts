// A <Script> component with loading strategies (next/script-style). denext maps
// the strategy to standard attributes rather than a runtime loader:
//
//   beforeInteractive -> a blocking <script> (runs as soon as it is parsed)
//   afterInteractive  -> <script defer> (default; runs after parsing)
//   lazyOnload        -> <script defer> loaded with low priority
//   worker            -> not supported; treated as afterInteractive

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";

/** When a {@link Script} runs relative to page parsing/interactivity. */
export type ScriptStrategy =
  | "beforeInteractive"
  | "afterInteractive"
  | "lazyOnload";

/** Props for {@link Script}. Extra props pass through to the `<script>`. */
export interface ScriptProps {
  /** External script URL. Omit when providing inline `children`. */
  src?: string;
  /** Loading strategy; defaults to `afterInteractive`. */
  strategy?: ScriptStrategy;
  /** Inline script source (injected verbatim; you own its safety). */
  children?: string;
  /** Any other attributes forwarded to the `<script>`. */
  [key: string]: unknown;
}

/** Render a `<script>` with the given loading {@link ScriptStrategy}. */
export function Script(props: ScriptProps): VNode {
  const { strategy = "afterInteractive", children, ...rest } = props;
  const attrs: Record<string, unknown> = { ...rest };
  // `defer` only applies to external scripts; inline scripts run in place.
  if (strategy !== "beforeInteractive" && rest.src) attrs.defer = true;
  if (strategy === "lazyOnload") attrs.fetchpriority = "low";

  if (typeof children === "string" && children.length > 0) {
    return h("script", { ...attrs, dangerouslySetInnerHTML: { __html: children } });
  }
  return h("script", attrs);
}

/**
 * `next/script`'s `handleClientScriptLoad` — imperatively inject a `<script>` from
 * {@link ScriptProps} into the live document (client-only; a no-op during SSR, which has
 * no `document`). Deduplicates by `src`. Used to load a script outside the render tree.
 *
 * @param props The script props (`src`/`children`/attributes; `onLoad`/`onError` wired).
 */
export function handleClientScriptLoad(props: ScriptProps): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return; // SSR: nothing to inject into
  const { strategy: _s, children, src, onLoad, onError, ...rest } = props as ScriptProps & {
    onLoad?: () => void;
    onError?: () => void;
  };
  if (src) {
    try {
      if (doc.querySelector(`script[src="${CSS.escape(src)}"]`)) return; // already loaded
    } catch { /* exotic src → skip dedupe */ }
  }
  const el = doc.createElement("script");
  for (const [k, v] of Object.entries(rest)) {
    if (v != null && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  }
  if (typeof children === "string" && children.length > 0) el.textContent = children;
  if (src) el.setAttribute("src", src);
  if (onLoad) el.addEventListener("load", onLoad);
  if (onError) el.addEventListener("error", onError);
  doc.body?.appendChild(el);
}

/**
 * `next/script`'s `initScriptLoader` — imperatively load an array of scripts at startup
 * (each via {@link handleClientScriptLoad}). Client-only.
 *
 * @param scriptLoaderItems The scripts to inject.
 */
export function initScriptLoader(scriptLoaderItems: ScriptProps[]): void {
  for (const item of scriptLoaderItems ?? []) handleClientScriptLoad(item);
}
