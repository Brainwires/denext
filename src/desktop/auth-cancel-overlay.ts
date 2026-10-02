/**
 * The page-side cancel affordance of a Deno Desktop sign-in that runs in the system browser: a
 * small modal ("Finish signing in in your browser." + Cancel) over the app while `openAuthSession`
 * waits. The browser reports no cancellation on Windows and Linux (and in the loopback flow
 * anywhere), so without it the only end of a sign-in the user walked away from is the timeout.
 * macOS's OS auth session brings its own sheet with a Cancel button, so it is not shown there.
 *
 * Client-only: web APIs, no Deno APIs. Built with DOM calls and CSSOM styles (no `innerHTML`, no
 * `style` attribute), so it renders under denext's strict default CSP. Nothing runs at import.
 *
 * @module
 */

import type { AuthCancelOverlayText } from "../mobile/auth-session.ts";

const DEFAULT_MESSAGE = "Finish signing in in your browser.";
const DEFAULT_CANCEL = "Cancel";
/** The overlay's DOM id (one at a time). */
const OVERLAY_ID = "denext-auth-cancel";

/** The minimal DOM this module touches (a structural type, so tests can pass a fake). */
interface OverlayDocument {
  createElement(tag: string): HTMLElement;
  readonly body: { appendChild(node: unknown): unknown } | null;
  getElementById?(id: string): { remove(): void } | null;
}

/**
 * Show the cancel overlay. Clicking Cancel or pressing Escape calls `onCancel` once and removes the
 * overlay; the returned function removes it without cancelling (the sign-in finished). Without a
 * DOM (a server render, a worker) it does nothing.
 *
 * @param onCancel Called once when the user cancels.
 * @param text The message and button label.
 * @returns A function that removes the overlay (idempotent).
 */
export function showAuthCancelOverlay(
  onCancel: () => void,
  text: AuthCancelOverlayText = {},
): () => void {
  const doc = (globalThis as { document?: OverlayDocument }).document;
  if (!doc?.body || typeof doc.createElement !== "function") return () => {};
  doc.getElementById?.(OVERLAY_ID)?.remove(); // a stale one from an earlier session

  const root = doc.createElement("div");
  root.id = OVERLAY_ID;
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0, 0, 0, 0.4)",
  });
  const card = doc.createElement("div");
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", `${OVERLAY_ID}-msg`);
  Object.assign(card.style, {
    colorScheme: "light dark",
    background: "Canvas",
    color: "CanvasText",
    font: "15px/1.4 system-ui, sans-serif",
    padding: "20px 24px",
    borderRadius: "10px",
    boxShadow: "0 8px 30px rgba(0, 0, 0, 0.3)",
    maxWidth: "min(360px, calc(100vw - 32px))",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    alignItems: "flex-start",
  });
  const message = doc.createElement("p");
  message.id = `${OVERLAY_ID}-msg`;
  message.textContent = text.message ?? DEFAULT_MESSAGE;
  message.style.margin = "0";
  const button = doc.createElement("button");
  button.setAttribute("type", "button");
  button.textContent = text.cancelLabel ?? DEFAULT_CANCEL;
  button.style.alignSelf = "flex-end";
  card.appendChild(message);
  card.appendChild(button);
  root.appendChild(card);

  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    root.removeEventListener("keydown", onKey);
    root.remove();
  };
  const cancel = () => {
    if (!open) return;
    close();
    onCancel();
  };
  function onKey(event: Event): void {
    if ((event as KeyboardEvent).key === "Escape") cancel();
  }
  button.addEventListener("click", cancel);
  root.addEventListener("keydown", onKey);
  doc.body.appendChild(root);
  button.focus?.();
  return close;
}
