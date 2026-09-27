/**
 * The offline screen for `denext/mobile`: {@linkcode installOfflineScreen} covers the page with a
 * full-screen notice while the device has no connection, and takes it away (optionally reloading)
 * when the connection returns. It follows the native `Network` plugin in the shell
 * (`denext mobile add network`), else `navigator.onLine`.
 *
 * It is one half of `denext mobile add offline-screen`; the other is Capacitor's
 * `server.errorPath`, which shows the bundled `offline.html` when the app cannot load at all.
 * An app that stays usable offline (cached data, drafts) should show its own UI instead.
 *
 * @module
 */

import { watchNetwork } from "./network.ts";

/** Options for {@linkcode installOfflineScreen}. */
export interface OfflineScreenOptions {
  /** The heading (default "You're offline"). */
  readonly title?: string;
  /** The line under it. */
  readonly message?: string;
  /** The button's label (default "Try again"). */
  readonly retryLabel?: string;
  /** Reload the page when the connection returns (default false: just hide the notice). */
  readonly reloadOnReconnect?: boolean;
}

/** The overlay element's id (one per page). */
const OVERLAY_ID = "denext-offline-screen";

/** The overlay's styles, scoped to its id. */
const STYLE = `#${OVERLAY_ID}{position:fixed;inset:0;z-index:2147483647;display:flex;` +
  "align-items:center;justify-content:center;padding:env(safe-area-inset-top) 24px " +
  "env(safe-area-inset-bottom);background:Canvas;color:CanvasText;color-scheme:light dark;" +
  "font:17px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center}" +
  `#${OVERLAY_ID} h1{font-size:22px;margin:0 0 8px}#${OVERLAY_ID} p{opacity:.7;margin:0 0 24px}` +
  `#${OVERLAY_ID} button{font:inherit;font-weight:600;min-height:44px;padding:12px 28px;` +
  "border:0;border-radius:12px;background:CanvasText;color:Canvas}";

/** The overlay: a dialog with a heading, a line and a retry button. */
function buildOverlay(doc: Document, opts: OfflineScreenOptions): HTMLElement {
  const root = doc.createElement("div");
  root.id = OVERLAY_ID;
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-live", "assertive");
  const style = doc.createElement("style");
  style.textContent = STYLE;
  const box = doc.createElement("div");
  const title = doc.createElement("h1");
  title.textContent = opts.title ?? "You're offline";
  const message = doc.createElement("p");
  message.textContent = opts.message ??
    "Check Wi-Fi or mobile data. The app continues when the connection is back.";
  const retry = doc.createElement("button");
  retry.type = "button";
  retry.textContent = opts.retryLabel ?? "Try again";
  retry.addEventListener("click", () => globalThis.location?.reload());
  box.append(title, message, retry);
  root.append(style, box);
  return root;
}

/**
 * Show a full-screen offline notice whenever the device loses its connection. Idempotent per
 * page: a second call replaces the first. A no-op without a DOM (SSR, workers).
 *
 * @param opts Text, and whether to reload on reconnect.
 * @returns Stops watching and removes the notice.
 * @example
 * ```ts
 * import { installOfflineScreen } from "denext/mobile";
 * const dispose = installOfflineScreen({ reloadOnReconnect: true });
 * ```
 */
export function installOfflineScreen(opts: OfflineScreenOptions = {}): () => void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body) return () => {};
  doc.getElementById(OVERLAY_ID)?.remove();
  let overlay: HTMLElement | null = null;
  let wasOffline = false;
  const stop = watchNetwork(({ connected }) => {
    if (!connected && !overlay) {
      overlay = buildOverlay(doc, opts);
      doc.body.append(overlay);
    } else if (connected && overlay) {
      overlay.remove();
      overlay = null;
      if (wasOffline && opts.reloadOnReconnect) globalThis.location?.reload();
    }
    wasOffline = !connected;
  });
  return () => {
    stop();
    overlay?.remove();
    overlay = null;
  };
}
