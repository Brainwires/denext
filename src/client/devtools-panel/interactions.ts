// DevTools panel: everything that binds behaviour to the shell — tab + toolbar clicks, the
// keyboard map, the shared data poller, and the live re-render subscriptions.
//
// The keyboard map is a `Record<string, () => void>` keyed by a normalized chord rather
// than a chain of modifier tests: chords are data, so adding one costs a row. Chords with
// the Meta key are ignored outright (Cmd+… belongs to the browser/OS on macOS), and only
// Ctrl+Shift+D works while the panel is closed.

import type { PanelCtx, TabId } from "./ctx.ts";
import type { HighlightUpdates } from "./highlight.ts";
import { refreshTab } from "./render.ts";
import { type Shell, TABS } from "./shell.ts";

/** How often the open Network/Cache tab re-reads its dev endpoint. */
const POLL_MS = 1000;

/** The tabs the shared poller keeps refreshing while they are open. */
const POLLED_TABS: readonly TabId[] = ["network", "cache"];

/** The one interval behind the live data tabs. */
export interface DataPoller {
  /** Start, stop or leave the interval running to match the current tab + open state. */
  sync(): void;
  /** Stop polling (panel closed / unmounted). */
  stop(): void;
}

/**
 * Create the panel's single data poller.
 *
 * Exactly one interval exists at a time and it runs ONLY while a polled tab is open, so a
 * panel sitting on the Components tab (or closed) costs nothing. Tabs that read once —
 * Routes — are refreshed by the same `sync()` call without an interval.
 *
 * @param ctx The mounted panel context.
 * @returns The poller handle.
 */
export function createDataPoller(ctx: PanelCtx): DataPoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  const sync = (): void => {
    if (!ctx.state.open) return stop();
    if (!POLLED_TABS.includes(ctx.state.tab)) {
      stop();
      refreshTab(ctx); // one-shot for Routes; a no-op for the tabs with no endpoint
      return;
    }
    if (timer !== null) return; // already polling this tab
    refreshTab(ctx);
    timer = setInterval(() => refreshTab(ctx), POLL_MS);
  };
  return { sync, stop };
}

/** What {@link wireInteractions} needs beyond the shell to do its job. */
export interface InteractionDeps {
  picker: { start(): void; stop(): void };
  setOpen: (open: boolean) => void;
  poller: DataPoller;
  highlightUpdates: HighlightUpdates;
}

/** Select a tab, then bring the data poller in line with it. */
function selectTab(ctx: PanelCtx, deps: InteractionDeps, tab: TabId): void {
  ctx.state.tab = tab;
  ctx.render();
  deps.poller.sync();
}

/** Move `delta` tabs along the strip, wrapping at both ends. */
function stepTab(ctx: PanelCtx, deps: InteractionDeps, delta: number): void {
  const at = TABS.findIndex((t) => t.id === ctx.state.tab);
  const next = (at + delta + TABS.length) % TABS.length;
  selectTab(ctx, deps, TABS[next].id);
}

/** Normalize a key event to a chord string like `ctrl+shift+d` or `alt+3`. */
function chordOf(e: KeyboardEvent): string {
  const mods = (e.ctrlKey ? "ctrl+" : "") + (e.altKey ? "alt+" : "") + (e.shiftKey ? "shift+" : "");
  return mods + String(e.key).toLowerCase();
}

/**
 * The chords that only work while the panel is open: `Alt+1…6` pick a tab, `Ctrl+Shift+[`
 * / `]` step through them (both the bracket and the shifted brace the key produces on a
 * US layout), and `Escape` cancels the element picker before it closes the panel.
 */
function openChords(ctx: PanelCtx, deps: InteractionDeps): Record<string, () => void> {
  const map: Record<string, () => void> = {
    "ctrl+shift+[": () => stepTab(ctx, deps, -1),
    "ctrl+shift+{": () => stepTab(ctx, deps, -1),
    "ctrl+shift+]": () => stepTab(ctx, deps, 1),
    "ctrl+shift+}": () => stepTab(ctx, deps, 1),
    escape: () => {
      if (ctx.state.picking) deps.picker.stop();
      else deps.setOpen(false);
    },
  };
  TABS.forEach((tab, i) => {
    map[`alt+${i + 1}`] = () => selectTab(ctx, deps, tab.id);
  });
  return map;
}

/** Toolbar buttons: element picker, name filter, host nodes, highlight updates. */
function wireToolbar(ctx: PanelCtx, shell: Shell, deps: InteractionDeps): void {
  const { S, state } = ctx;
  shell.pickBtn.addEventListener(
    "click",
    () => (state.picking ? deps.picker.stop() : deps.picker.start()),
  );
  shell.searchBox.addEventListener("input", () => {
    state.search = shell.searchBox.value.trim().toLowerCase();
    ctx.render();
    shell.searchBox.focus();
  });
  shell.hostBtn.addEventListener("click", () => {
    state.showHost = !state.showHost;
    shell.hostBtn.style.cssText = state.showHost ? S.iconOn : S.icon;
    ctx.render();
  });
  shell.hlBtn.addEventListener("click", () => {
    state.highlight = !state.highlight;
    shell.hlBtn.style.cssText = state.highlight ? S.iconOn : S.icon;
    deps.highlightUpdates.setEnabled(state.highlight);
    ctx.render();
  });
}

/**
 * Wire the shell: header tabs, toolbar buttons, the keyboard map, and open/close.
 *
 * The keydown listener is registered in the CAPTURE phase so it runs before the element
 * picker's own Escape handler — otherwise Escape while picking would stop the picker AND
 * close the panel.
 *
 * @param ctx The mounted panel context.
 * @param shell The panel's DOM shell.
 * @param deps The picker, open/close, poller and highlight-updates handles.
 */
export function wireInteractions(ctx: PanelCtx, shell: Shell, deps: InteractionDeps): void {
  const { doc, state } = ctx;
  shell.launch.addEventListener("click", () => deps.setOpen(true));
  shell.closeBtn.addEventListener("click", () => deps.setOpen(false));
  for (const tab of TABS) {
    shell.tabs[tab.id].addEventListener("click", () => selectTab(ctx, deps, tab.id));
  }
  wireToolbar(ctx, shell, deps);
  // Ctrl+Shift+D toggles the panel — chosen to avoid Chrome's Alt/Cmd bookmark
  // shortcuts (Cmd+D / Alt+D) on macOS.
  const always: Record<string, () => void> = {
    "ctrl+shift+d": () => deps.setOpen(!state.open),
  };
  const whileOpen = openChords(ctx, deps);
  doc.addEventListener("keydown", (e) => {
    if (e.metaKey) return; // Cmd+… is the browser's / the OS's
    const chord = chordOf(e);
    const run = always[chord] ?? (state.open ? whileOpen[chord] : undefined);
    if (!run) return;
    e.preventDefault();
    run();
  }, true);
}

/** Re-render while open, coalesced to a frame: on every commit, and on streamed-hole reveals. */
export function wireLiveUpdates(ctx: PanelCtx): void {
  const { api, state } = ctx;
  let queued = false;
  const queueRender = (): void => {
    if (!state.open || queued) return;
    queued = true;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16);
    raf(() => {
      queued = false;
      if (state.open) ctx.render();
    });
  };
  api.subscribe(queueRender);
  // A reveal doesn't cause a commit, so the commit subscription wouldn't catch it.
  api.subscribeBoundaries(() => {
    if (state.tab === "render") queueRender();
  });
}
