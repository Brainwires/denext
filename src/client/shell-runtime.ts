// `spa.shell` adoption: keep the prerendered shell painted and interactive while the app renders
// off-screen, then swap the app in at once. Installed by the generated SPA entry (ahead of the
// app's own entry module) ONLY when `spa.shell` is configured, so an app without a shell bundles
// none of this (`installShellSupport` is a tree-shaken re-export of denext/client-runtime).
//
// How the app comes to render off-screen with no change to its `createRoot` call: the install
// inserts a STAGE right before the shell's mount element — a shallow clone of it (same id, class
// and attributes, so the app's `#root` rules apply) that is fixed over the shell's box, hidden and
// inert. `document.getElementById("root")` returns the first element in tree order, the stage, so
// the app's `createRoot(...)` (react-dom's, React Native Web's `AppRegistry`, Expo's
// `registerRootComponent` — all denext's createRoot) mounts there. The swap restores the stage's
// own attributes and removes the shell: the stage already sits where the shell was, so it is one
// DOM change and one frame, with no node moved and the app's container reference still valid.
// The fields' text, selection, focus and scroll carry over in the same task (see applyHandoff).

import { activeRoots } from "./fiber/state.ts";
import { walk } from "./fiber/fiber-utils.ts";
import { hasBit, ShowingFallbackBit } from "./fiber/fiber.ts";
import { type ShellGlobal, shellGlobal, type ShellHandoff } from "./shell-handoff.ts";

/** When the swap happens, as `spa.shell.readyOn` / `maxHoldMs` configure it. */
export interface ShellSupportOptions {
  /**
   * `"first-settled-commit"` (default): the first commit with no Suspense boundary showing its
   * fallback. `"shellReady"`: only when the app calls `shellReady()`.
   */
  readyOn?: "shellReady" | "first-settled-commit";
  /** Swap anyway after this many milliseconds (default 5000). */
  maxHoldMs?: number;
}

/** The attribute marking the shell's mount element (the prerendered `#root`). */
const SHELL_ATTR = "data-denext-shell";
/** The attribute pairing a shell field with the app's field. */
const KEY_ATTR = "data-denext-shell-key";
/** The stage's hiding styles, appended to the mount element's own inline style. */
const HIDDEN = ";position:fixed;margin:0;visibility:hidden;pointer-events:none;overflow:hidden";
/** The default hold before the swap happens without a ready signal. */
const DEFAULT_MAX_HOLD_MS = 5000;

/**
 * Wire the shell adoption into the page: when the document carries a prerendered `spa.shell`,
 * stage the app's mount off-screen and arm the swap. A no-op on a page without one (an export for
 * a platform the shell does not cover). Called by the generated SPA entry, never by app code.
 *
 * @param options When to swap.
 */
export function installShellSupport(options: ShellSupportOptions = {}): void {
  const g = shellGlobal();
  const shell = g && !g.d && !g.ready
    ? globalThis.document?.querySelector<HTMLElement>(`[${SHELL_ATTR}]`)
    : null;
  if (!g || !shell?.parentNode) return;
  const ownStyle = shell.getAttribute("style");
  const stage = stageFor(shell, ownStyle);
  let observer: MutationObserver | undefined;
  let done = false;
  const swap = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    observer?.disconnect();
    // The final capture, while the shell (and its focus) is still in the document. `d` stops
    // the capture script first: removing the focused shell field fires its focusout.
    const state = g.c?.() ?? g.s;
    g.d = 1;
    if (ownStyle === null) stage.removeAttribute("style");
    else stage.setAttribute("style", ownStyle);
    stage.removeAttribute("aria-hidden");
    stage.removeAttribute("inert");
    shell.remove();
    applyHandoff(stage, state, g);
    for (const resolve of g.q?.splice(0) ?? []) resolve();
  };
  const timer = setTimeout(swap, options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS);
  // A call from a render or an effect lands after the commit in progress.
  g.ready = () => queueMicrotask(swap);
  if (g.r) g.ready();
  if (options.readyOn !== "shellReady" && typeof MutationObserver === "function") {
    // Every commit into the stage mutates it; the callback runs after the commit, before paint.
    observer = new MutationObserver(() => {
      if (settled(stage)) swap();
    });
    observer.observe(stage, { childList: true, subtree: true, attributes: true });
  }
}

/** Insert the hidden stage the app mounts into, right before the shell, over its box. */
function stageFor(shell: HTMLElement, ownStyle: string | null): HTMLElement {
  const stage = shell.cloneNode(false) as HTMLElement;
  stage.removeAttribute(SHELL_ATTR);
  const r = shell.getBoundingClientRect();
  stage.setAttribute(
    "style",
    `${
      ownStyle ?? ""
    }${HIDDEN};left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`,
  );
  stage.setAttribute("aria-hidden", "true");
  stage.setAttribute("inert", "");
  shell.parentNode!.insertBefore(stage, shell);
  return stage;
}

/** Whether the root mounted in `stage` has committed a tree with no Suspense fallback showing. */
function settled(stage: Element): boolean {
  for (const handle of activeRoots) {
    if (handle.container !== stage) continue;
    if (handle.current.child === null) return false;
    let pending = false;
    walk(handle.current, (f) => {
      if (f.tag === "suspense" && hasBit(f, ShowingFallbackBit)) pending = true;
    });
    return !pending;
  }
  return false;
}

/** An `<input>` / `<textarea>` (the fields denext fills in itself). */
function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT";
}

/**
 * Set a field's value the way typing does: through the prototype's setter (past any per-instance
 * override a controlled-input tracker installs) and an `input` event, so a controlled field's
 * `onChange` adopts the text into the app's state.
 */
function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  if (field.value === text) return;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  if (setter) setter.call(field, text);
  else field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Carry each shell field over to the app's field with the same key: a text field nobody took is
 * filled in (text, selection, scroll), and the field the user was in is focused, so typing
 * continues where it was. A `contenteditable` (an editor) keeps its state for
 * `consumeShellHandoff` and is only focused.
 */
function applyHandoff(stage: Element, state: Record<string, ShellHandoff>, g: ShellGlobal): void {
  for (const key of Object.keys(state)) {
    const el = stage.querySelector<HTMLElement>(
      `[${KEY_ATTR}="${key.replace(/["\\]/g, "\\$&")}"]`,
    );
    if (!el) continue;
    const s = state[key];
    const field = isTextField(el) && !g.t[key] ? el : null;
    if (field) {
      g.t[key] = 1;
      setFieldValue(field, s.text);
    }
    if (s.focused) el.focus({ preventScroll: true });
    if (field) {
      try {
        field.setSelectionRange(s.selectionStart, s.selectionEnd);
      } catch { /* a field type without a selection (number, email) */ }
      field.scrollTop = s.scrollTop;
    }
  }
}
