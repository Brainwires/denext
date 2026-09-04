// DevTools panel: the Render-modes tab — the page's server verdict, the streamed Suspense
// waterfall, and the client-island hydration waterfall.

import { h4, type PanelCtx } from "./ctx.ts";
import { el } from "./styles.ts";

type PageVerdict = ReturnType<PanelCtx["api"]["getPageRenderMode"]>;
type Boundaries = ReturnType<PanelCtx["api"]["getBoundaryTimings"]>;
type Modes = ReturnType<PanelCtx["api"]["getRenderModes"]>;

/** Server-emitted page verdict (static/dynamic/streamed + cache), when present. */
function renderPageVerdict(ctx: PanelCtx, page: NonNullable<PageVerdict>): void {
  const { doc, S, detailPane } = ctx;
  detailPane.append(h4(ctx, true, "Page"));
  const row = el(
    doc,
    "div",
    S.kv,
    el(doc, "span", S.k, "mode"),
    el(doc, "span", S.v + ";" + S.comp, page.mode),
  );
  if (page.cache) row.append(el(doc, "span", S.dim, ` · cache ${page.cache}`));
  detailPane.append(row);
}

/** Per-Suspense-boundary server timeline (streamed pages). */
function renderBoundaryWaterfall(ctx: PanelCtx, boundaries: Boundaries, first: boolean): void {
  const { doc, S, detailPane } = ctx;
  detailPane.append(h4(ctx, first, "Suspense boundaries (live waterfall)"));
  let maxMs = 0;
  for (const b of boundaries) if (b.ms > maxMs) maxMs = b.ms;
  maxMs = maxMs || 0.0001;
  const bul = el(doc, "ul", S.wf);
  for (const b of boundaries) {
    const bar = el(doc, "div", S.rankBar);
    bar.style.width = Math.max(3, Math.round((b.ms / maxMs) * 70)) + "px";
    const li = el(
      doc,
      "li",
      S.wfLi,
      el(doc, "span", S.comp, b.id),
      bar,
      el(doc, "span", S.dim, `${b.ms}ms server`),
    );
    // The client reveal time lands in real time, before the server-resolve island.
    if (b.revealAt != null) {
      li.append(el(doc, "span", S.at, `revealed @${Math.round(b.revealAt)}ms`));
    }
    bul.append(li);
  }
  detailPane.append(bul);
}

function renderIslandWaterfall(ctx: PanelCtx, modes: Modes, first: boolean): void {
  const { doc, S, detailPane } = ctx;
  detailPane.append(h4(ctx, first, "Client islands (hydration waterfall)"));
  const ul = el(doc, "ul", S.wf);
  for (const m of modes) ul.append(islandRow(ctx, m));
  detailPane.append(ul);
}

/** One island's row: `strategy(param)`, its id, and when it hydrated. */
function islandRow(ctx: PanelCtx, m: Modes[number]): ReturnType<typeof el> {
  const { doc, S } = ctx;
  return el(
    doc,
    "li",
    S.wfLi,
    el(doc, "span", S.comp, m.strategy + (m.param ? `(${m.param})` : "")),
    el(doc, "span", S.dim, m.id === "island" ? "" : `#${m.id}`),
    el(doc, "span", S.at, m.hydratedAt != null ? `${m.hydratedAt}ms` : ""),
  );
}

export function renderRenderModes(ctx: PanelCtx): void {
  const { doc, S, api, detailPane } = ctx;
  const page = api.getPageRenderMode();
  if (page) renderPageVerdict(ctx, page);
  const boundaries = api.getBoundaryTimings();
  if (boundaries.length > 0) renderBoundaryWaterfall(ctx, boundaries, !page);
  const modes = api.getRenderModes();
  if (modes.length > 0) return renderIslandWaterfall(ctx, modes, !page && boundaries.length === 0);
  if (boundaries.length === 0) {
    const text = page
      ? "No client islands on this page."
      : "No client islands — this page is server-rendered HTML.";
    detailPane.append(el(doc, "div", S.empty, text));
  }
}
