// DevTools panel: the Live views tab — the server-held live views (`defineLiveView`) running on
// the dev server, attached to a socket or parked for a reconnect, each with its model, and the
// recent messages their `update` ran. Read from `/_denext/dev-live-views` (polled while open).
// The MVU tab covers programs running in the browser; this one covers the server's.
//
// Redacted at the source: the dev server reports every string inside a model or a message as
// `string(n)` (src/server/live-devtools.ts), so this tab never receives the data itself.
//
// Style note: every colour below is an inline string built inside a function, never a
// module-scope object literal — see ./styles.ts for why.

import { agoLabel } from "./cache.ts";
import { h4, type PanelCtx, refreshDataTab, renderDataPlaceholder } from "./ctx.ts";
import { DEVTOOLS_LIVE_VIEWS_FEED } from "./dev-api.ts";
import { summarize } from "./mvu.ts";
import { el } from "./styles.ts";

/** A record from the endpoint (untrusted JSON). */
type Rec = Record<string, unknown>;

/** The entries of an untrusted array of records. */
export function records(value: unknown): Rec[] {
  return Array.isArray(value)
    ? value.filter((v): v is Rec => typeof v === "object" && v !== null)
    : [];
}

/** An untrusted field as text. */
export function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** A coloured pill. */
export function pill(ctx: PanelCtx, label: string, colour: string): HTMLElement {
  return el(ctx.doc, "span", `${ctx.S.pill};background:${colour};color:#0c0e14`, label);
}

/**
 * Draw the Live views tab from the last poll.
 *
 * @param ctx The mounted panel context.
 */
export function renderLiveViewsTab(ctx: PanelCtx): void {
  if (renderDataPlaceholder(ctx, "Live views", ctx.state.liveViews)) return;
  const { doc, S, detailPane } = ctx;
  const data = (ctx.state.liveViews.data ?? {}) as Rec;
  const views = records(data.views);
  detailPane.append(h4(ctx, true, `Server-held views · ${views.length}`));
  if (views.length === 0) {
    detailPane.append(el(doc, "div", S.empty, "no live view is mounted"));
  } else {
    const list = el(doc, "ul", S.wf);
    for (const view of views) list.append(viewRow(ctx, view));
    detailPane.append(list);
  }
  const messages = records(data.messages).reverse(); // newest first
  detailPane.append(h4(ctx, false, "Recent messages"));
  if (messages.length === 0) {
    detailPane.append(el(doc, "div", S.empty, "no messages yet"));
    return;
  }
  const now = Date.now();
  const list = el(doc, "ul", S.wf);
  for (const m of messages) {
    list.append(
      el(
        doc,
        "li",
        S.wfLi,
        el(doc, "span", S.comp, text(m.view)),
        el(doc, "span", S.v, summarize(m.msgs)),
        el(doc, "span", S.at, typeof m.at === "number" ? agoLabel(now - m.at) : ""),
      ),
    );
  }
  detailPane.append(list);
}

/** One view: its id, state, revision and sizes, then its model. */
function viewRow(ctx: PanelCtx, view: Rec): HTMLElement {
  const { doc, S } = ctx;
  const attached = view.state === "attached";
  const head = el(
    doc,
    "div",
    "display:flex;gap:8px;align-items:center",
    pill(ctx, attached ? "attached" : "parked", attached ? "#5bd18b" : "#f0b45b"),
    el(doc, "span", S.comp, text(view.view)),
    el(doc, "span", S.dim, `rev ${text(view.rev)} · ${text(view.modelBytes)} B model`),
    el(doc, "span", S.at, text(view.iid).slice(0, 8)),
  );
  const model = el(doc, "div", `${S.v};padding-left:4px`, summarize(view.model, 400));
  return el(doc, "li", `${S.wfLi};flex-direction:column`, head, model);
}

/**
 * Re-read the live views into {@link PanelCtx.state}. Called by the shared 1 s poller while
 * the tab is open.
 *
 * @param ctx The mounted panel context.
 */
export function refreshLiveViewsTab(ctx: PanelCtx): void {
  void refreshDataTab(ctx, ctx.state.liveViews, DEVTOOLS_LIVE_VIEWS_FEED);
}
