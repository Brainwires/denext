// A <Script> component with loading strategies (next/script-style). denext maps
// the strategy to standard attributes rather than a runtime loader:
//
//   beforeInteractive -> a blocking <script> (runs as soon as it is parsed)
//   afterInteractive  -> <script defer> (default; runs after parsing)
//   lazyOnload        -> <script defer> loaded with low priority
//   worker            -> off the main thread through Partytown, as Next does, once
//                        `nextScriptWorkers` is on and the app installed
//                        `@qwik.dev/partytown` (or `@builder.io/partytown`): a
//                        `<script type="text/partytown">` after the same-origin boot script
//                        the server serves (src/build/partytown.ts). Without either it runs
//                        on the main thread (as afterInteractive), with a dev warning naming
//                        the fix.

import { Fragment, h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { renderScope } from "./render-scope.ts";

/** When a {@link Script} runs relative to page parsing/interactivity. */
export type ScriptStrategy =
  | "beforeInteractive"
  | "afterInteractive"
  | "lazyOnload"
  | "worker";

/**
 * Where `strategy="worker"` scripts go, on a process-wide slot: the server sets it from
 * `nextScriptWorkers` (`lib` when the Partytown package was found, `missing` when it was not),
 * and in the browser the boot script sets it (with the page's nonce) before any module runs, so
 * a hydrating client component renders what the server did. Unset: the option is off.
 */
type ScriptWorkersSlot = { lib?: string; missing?: boolean; nonce?: string };
const slot = globalThis as {
  __denextScriptWorkers?: ScriptWorkersSlot;
  __denextDev?: boolean;
  /** Server bridge: whether this render's output outlives the response (a `"use cache"` body, a PPR shell). */
  __denextScriptWorkersShared?: () => boolean;
};

/**
 * Set (or clear, with `undefined`) where `strategy="worker"` scripts go. The servers call it
 * at startup from `nextScriptWorkers` and the Partytown files they found.
 *
 * @param value `{ lib }` — the public path Partytown is served under (ends with `/`);
 *   `{ missing: true }` — the option is on but the package is not installed; `undefined` — off.
 */
export function setScriptWorkers(value: ScriptWorkersSlot | undefined): void {
  slot.__denextScriptWorkers = value;
}

/**
 * The CSP nonce that authorizes this response's worker scripts, or null when Partytown is not
 * published. One per response (the request's render scope), so the document's CSP carries it
 * and Partytown's boot runs only the `text/partytown` scripts that hold it: an injected one
 * cannot know it. In the browser it is the nonce the boot script validated. Null as well where
 * the output outlives the response — a `"use cache"` body or a PPR shell is combined with
 * later renders, so a nonce in it would be public and reusable; worker scripts there take the
 * main-thread fallback.
 */
export function scriptWorkerNonce(): string | null {
  const workers = slot.__denextScriptWorkers;
  if (!workers?.lib) return null;
  if (workers.nonce !== undefined) return workers.nonce || null; // the browser: the boot's
  if (slot.__denextScriptWorkersShared?.()) return null;
  const scope = renderScope();
  if (!scope.scriptNonce) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    scope.scriptNonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return scope.scriptNonce;
}

/**
 * The worker-script nonce this response's render already minted (a `<Script strategy="worker">`
 * rendered with Partytown published), or null — never minting one. What a CSP computed after the
 * render lists, so a page without a worker script carries no nonce, and what a cache store checks
 * before keeping a document whose nonce would be replayed to every visitor.
 */
export function mintedScriptWorkerNonce(): string | null {
  if (!slot.__denextScriptWorkers?.lib) return null;
  return renderScope().scriptNonce ?? null;
}

const warnedWorkerStrategy = new Set<string>();

/** Why a worker script took the main-thread fallback, and the fix (dev warning text). */
const WORKER_FALLBACK = {
  off: "set `nextScriptWorkers: true` in denext.config.ts and install `@qwik.dev/partytown` " +
    "to run it in a web worker.",
  missing: "`nextScriptWorkers` is on but Partytown is not installed. Install " +
    "`@qwik.dev/partytown` into node_modules (`deno add npm:@qwik.dev/partytown` with " +
    '`"nodeModulesDir": "auto"`, or your package manager) and restart.',
  shared: 'it renders inside a `"use cache"` body or a PPR shell, which outlives the response, ' +
    "so it cannot carry the response's nonce. Render it outside the cached part.",
};

/** Dev-warn (once per cause) that `strategy="worker"` runs on the main thread, naming the fix. */
function warnWorkerStrategy(cause: keyof typeof WORKER_FALLBACK): void {
  if (warnedWorkerStrategy.has(cause) || slot.__denextDev !== true) return;
  warnedWorkerStrategy.add(cause);
  console.warn(
    'denext: <Script strategy="worker"> runs on the MAIN thread (as afterInteractive): ' +
      WORKER_FALLBACK[cause],
  );
}

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
  if (strategy === "worker") {
    const workers = slot.__denextScriptWorkers;
    const nonce = scriptWorkerNonce();
    if (workers?.lib && nonce) return workerScript(workers.lib, nonce, rest, children);
    // The main-thread fallback (as afterInteractive).
    warnWorkerStrategy(workers?.lib ? "shared" : workers?.missing ? "missing" : "off");
  }
  const attrs: Record<string, unknown> = { ...rest };
  // `defer` only applies to external scripts; inline scripts run in place. `worker`
  // degrades to afterInteractive semantics (deferred external, or inline in place).
  if (strategy !== "beforeInteractive" && rest.src) attrs.defer = true;
  if (strategy === "lazyOnload") attrs.fetchpriority = "low";

  if (typeof children === "string" && children.length > 0) {
    return h("script", { ...attrs, dangerouslySetInnerHTML: { __html: children } });
  }
  return h("script", attrs);
}

/**
 * A `strategy="worker"` script for Partytown: the boot script (same-origin and external, so
 * the strict CSP allows it; idempotent, so every worker script may carry it), then the script
 * as `type="text/partytown"`, which the browser does not run and Partytown runs in its worker.
 * Both carry the response's nonce: the boot runs only the scripts whose nonce the page's CSP
 * allows. The boot is a plain blocking script so it has set the slot before any module runs.
 */
function workerScript(
  lib: string,
  nonce: string,
  attrs: Record<string, unknown>,
  children?: string,
): VNode {
  const props = { ...attrs, type: "text/partytown", nonce };
  const script = typeof children === "string" && children.length > 0
    ? h("script", { ...props, dangerouslySetInnerHTML: { __html: children } })
    : h("script", props);
  return h(Fragment, null, h("script", { src: `${lib}boot.js`, nonce }), script);
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
  if (src && alreadyLoaded(doc, src)) return;
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

/** Whether a `<script src>` for `src` is already in the document (an exotic src skips dedupe). */
function alreadyLoaded(doc: Document, src: string): boolean {
  try {
    return doc.querySelector(`script[src="${CSS.escape(src)}"]`) !== null;
  } catch {
    return false;
  }
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
