// First-party denext DevTools — the in-page panel (dev-only).
//
// A self-contained, vanilla-DOM glass-box: a component tree with per-node props, hooks/
// state (live-editable) and contexts, plus render-mode, profiler and dev-server data
// views. It reads everything through the inspector API (`./devtools-inspect.ts`) and
// renders with plain DOM (its OWN tiny update loop, not the reconciler — so inspecting
// never re-enters the tree it inspects), from DOM APIs only (no innerHTML).
//
// Styling is applied INLINE via CSSOM (`element.style`), never a `<style>` sheet: denext
// serves a strict `style-src 'self'` CSP (no `'unsafe-inline'`/hash for a runtime-injected
// stylesheet), which would silently drop a `<style>` — leaving the panel unstyled. Per-
// element inline styles are CSP-safe.
//
// This module is only the mount seam: `./devtools-panel/` holds the shell, the tab
// dispatch table, the event wiring, the dev-endpoint contract and one module per tab.
//
// Dev-only and DCE-friendly: `installDevtools` is imported ONLY by the dev route/Flight/SPA
// entries, so production never pulls it in; it also no-ops unless `__denextDev`.

import { type DenextDevtoolsApi, installInspector } from "./devtools-inspect.ts";
import { installInspectSink } from "./devtools-inspect-sink.ts";
import { emptyTabCache, type PanelCtx, type PanelState } from "./devtools-panel/ctx.ts";
import {
  createDataPoller,
  wireInteractions,
  wireLiveUpdates,
} from "./devtools-panel/interactions.ts";
import { createHighlighter, createPicker } from "./devtools-panel/picker.ts";
import { installHighlightUpdates } from "./devtools-panel/highlight.ts";
import { renderPanel } from "./devtools-panel/render.ts";
import { buildShell } from "./devtools-panel/shell.ts";
import { buildStyles } from "./devtools-panel/styles.ts";

function isDev(): boolean {
  try {
    return (globalThis as { __denextDev?: boolean }).__denextDev === true;
  } catch {
    return false;
  }
}

/**
 * A freshly mounted panel's state. Exposed for unit tests that drive one pane in
 * isolation; not part of the public API.
 * @internal
 */
export function initialState(): PanelState {
  return {
    open: false,
    tab: "components",
    selected: null,
    picking: false,
    search: "",
    collapsed: new Set(),
    showHost: false,
    expanded: new Set(),
    profilerCommit: null,
    highlight: false,
    network: emptyTabCache(),
    cache: emptyTabCache(),
    routes: emptyTabCache(),
  };
}

/**
 * The panel's SINGLE render-reason hold: enabled while it is open, released when it
 * closes, and never taken twice. `enableRenderReasons` is refcounted (the inspector sink
 * holds one too), so a hold that is taken or released twice would either pin tracking on
 * forever or drop the sink's history — hence the flag rather than a bare call pair.
 *
 * @param api The inspector API.
 * @returns A setter: `true` takes the hold, `false` releases it, repeats are no-ops.
 */
function reasonHold(api: DenextDevtoolsApi): (want: boolean) => void {
  let held = false;
  return (want) => {
    if (want === held) return;
    held = want;
    if (want) api.enableRenderReasons();
    else api.disableRenderReasons();
  };
}

function mount(api: DenextDevtoolsApi, doc: Document): void {
  const { S, S_BADGE } = buildStyles();
  const state = initialState();
  const shell = buildShell(doc, S);
  const hl = createHighlighter(doc, S);
  const ctx: PanelCtx = {
    doc,
    api,
    S,
    S_BADGE,
    state,
    treePane: shell.treePane,
    detailPane: shell.detailPane,
    render: () => renderPanel(ctx, shell),
    selectNode: (id) => {
      if (state.selected !== id) state.expanded.clear();
      state.selected = id;
      ctx.render();
    },
    highlight: hl.highlight,
    hideHighlight: hl.hideHighlight,
  };
  const picker = createPicker(doc, api, S, state, shell.pickBtn, hl, ctx.selectNode);
  const highlightUpdates = installHighlightUpdates(api, hl);
  const poller = createDataPoller(ctx);
  const reasons = reasonHold(api); // "why did this render", accrued while inspecting
  const setOpen = (open: boolean): void => {
    state.open = open;
    shell.panel.style.display = open ? "flex" : "none";
    shell.launch.style.display = open ? "none" : "";
    reasons(open);
    if (open) {
      highlightUpdates.setEnabled(state.highlight);
      ctx.render();
    } else {
      picker.stop();
      hl.hideHighlight();
      highlightUpdates.setEnabled(false);
    }
    poller.sync();
  };
  wireInteractions(ctx, shell, { picker, setOpen, poller, highlightUpdates });
  wireLiveUpdates(ctx);
  const attach = () =>
    (doc.body ?? doc.documentElement).append(shell.launch, shell.panel, hl.overlay, hl.tip);
  if (doc.body) attach();
  else doc.addEventListener("DOMContentLoaded", attach, { once: true });
}

let installed = false;

/**
 * Mount the panel against an explicit document — the {@link installDevtools} internals,
 * exposed for unit tests so a fake document can drive the DOM. Not part of the public API.
 * @internal
 */
export function mountPanel(api: DenextDevtoolsApi, doc: Document): void {
  mount(api, doc);
}

/**
 * Install denext's first-party DevTools (inspector API + in-page panel). Idempotent,
 * and a no-op in production / without a DOM / unless `__denextDev`. Imported ONLY by the
 * dev route/Flight entries, so it never enters a production bundle.
 */
export function installDevtools(): void {
  if (installed || !devtoolsAvailable()) return;
  const api = installInspector();
  if (!api) return;
  installed = true;
  mount(api, document);
  // The MCP bridge: push each settled commit's component tree to the dev server, so
  // `denext_component_tree`/`denext_why_render`/`denext_hook_state` can read this page
  // out-of-process. Independent of the panel — it runs whether or not it is opened.
  installInspectSink(api);
  announceReady();
}

/** Dev only, and only where there is a document to mount into. */
function devtoolsAvailable(): boolean {
  return isDev() && typeof document !== "undefined";
}

function announceReady(): void {
  if (typeof console === "undefined") return;
  console.info(
    "%c[denext] devtools ready",
    "color:#8aa2ff;font-weight:bold",
    "— launcher at bottom-left, or Ctrl+Shift+D",
  );
}
