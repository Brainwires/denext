// DevTools panel: the Live tab — what the dev server's Live hub holds: each socket and what it
// subscribes to (`<Live>` boundaries and their tags, `useLive` / `defineSubscription` data
// subscriptions, `useApi({ tags })` watches, channel keys, presence rooms), the recent channel
// pushes it fanned out, and the recent cache entries written. Read from `/_denext/dev-live`
// (polled while open); the Cache tab keeps the counters and the invalidations.
//
// Redacted at the source: subscription arguments are never sent, and every string inside a
// channel payload arrives as `string(n)` (src/server/live-devtools.ts).
//
// Style note: every colour below is an inline string built inside a function, never a
// module-scope object literal — see ./styles.ts for why.

import { agoLabel } from "./cache.ts";
import { h4, type PanelCtx, refreshDataTab, renderDataPlaceholder } from "./ctx.ts";
import { DEVTOOLS_LIVE_FEED } from "./dev-api.ts";
import { pill, records, text } from "./live-views.ts";
import { summarize } from "./mvu.ts";
import { el } from "./styles.ts";

/** A record from the endpoint (untrusted JSON). */
type Rec = Record<string, unknown>;

/** Untrusted tags as one comma-separated line. */
function tagList(value: unknown): string {
  return Array.isArray(value) ? value.map(text).join(", ") : "";
}

/**
 * Draw the Live tab from the last poll.
 *
 * @param ctx The mounted panel context.
 */
export function renderLiveTab(ctx: PanelCtx): void {
  if (renderDataPlaceholder(ctx, "Live", ctx.state.live)) return;
  const data = (ctx.state.live.data ?? {}) as Rec;
  const now = Date.now();
  section(
    ctx,
    true,
    "Connections",
    records(data.connections),
    "no Live socket is open",
    (c) => connectionRow(ctx, c),
  );
  section(
    ctx,
    false,
    "Channel pushes",
    records(data.channelPushes).reverse(),
    "no pushes yet",
    (p) => pushRow(ctx, p, now),
  );
  section(
    ctx,
    false,
    "Cache entries written",
    records(data.cacheEntries).reverse(),
    "none yet",
    (e) => entryRow(ctx, e, now),
  );
}

/** A heading with its count, then the rows (or what an empty list means). */
function section(
  ctx: PanelCtx,
  first: boolean,
  title: string,
  rows: Rec[],
  empty: string,
  row: (r: Rec) => HTMLElement,
): void {
  const { doc, S, detailPane } = ctx;
  detailPane.append(h4(ctx, first, `${title} · ${rows.length}`));
  if (rows.length === 0) return void detailPane.append(el(doc, "div", S.empty, empty));
  const list = el(doc, "ul", S.wf);
  for (const r of rows) list.append(row(r));
  detailPane.append(list);
}

/** A line per subscription a socket holds. */
function subscriptionLines(c: Rec): string[] {
  const rooms = Array.isArray(c.rooms) ? c.rooms : [];
  return [
    ...records(c.boundaries).map((b) => `<Live> ${text(b.id)} ← ${tagList(b.tags)}`),
    ...records(c.data).map((d) => `data ${text(d.action)} ← ${tagList(d.tags)}`),
    ...records(c.tags).map((t) => `tags ${tagList(t.tags)}`),
    ...records(c.channels).map((ch) => `channel ${text(ch.channel)} / ${text(ch.key)}`),
    ...rooms.map((room) => `presence ${text(room)}`),
    ...(typeof c.views === "number" && c.views > 0 ? [`${c.views} live view(s)`] : []),
  ];
}

/** One socket: its page and peer, then a line per subscription kind it holds. */
function connectionRow(ctx: PanelCtx, c: Rec): HTMLElement {
  const { doc, S } = ctx;
  const lines = subscriptionLines(c);
  const head = el(
    doc,
    "div",
    "display:flex;gap:8px",
    el(doc, "span", S.comp, text(c.path) || "/"),
    el(doc, "span", S.at, text(c.peer).slice(0, 8)),
  );
  const body = lines.map((line) => el(doc, "div", `${S.v};padding-left:8px`, line));
  if (body.length === 0) body.push(el(doc, "div", S.dim, "no subscriptions"));
  return el(doc, "li", `${S.wfLi};flex-direction:column`, head, ...body);
}

/** One channel push: kind, channel / key, subscribers, the redacted payload. */
function pushRow(ctx: PanelCtx, p: Rec, now: number): HTMLElement {
  const { doc, S } = ctx;
  return el(
    doc,
    "li",
    S.wfLi,
    pill(ctx, text(p.kind) || "publish", p.kind === "revoke" ? "#ff6b6b" : "#8aa2ff"),
    el(doc, "span", S.comp, `${text(p.channel)} / ${text(p.key)}`),
    el(doc, "span", S.dim, `→ ${text(p.subscribers)}`),
    el(doc, "span", S.v, summarize(p.payload)),
    el(doc, "span", S.at, typeof p.at === "number" ? agoLabel(now - p.at) : ""),
  );
}

/** One cache entry written: kind, key, tags, size. */
function entryRow(ctx: PanelCtx, e: Rec, now: number): HTMLElement {
  const { doc, S } = ctx;
  return el(
    doc,
    "li",
    S.wfLi,
    pill(ctx, text(e.kind) || "data", e.kind === "page" ? "#8aa2ff" : "#f0b45b"),
    el(doc, "span", S.v, text(e.key)),
    el(doc, "span", S.dim, `${tagList(e.tags)} · ${text(e.bytes)} B`),
    el(doc, "span", S.at, typeof e.at === "number" ? agoLabel(now - e.at) : ""),
  );
}

/**
 * Re-read the Live hub's state into {@link PanelCtx.state}. Called by the shared 1 s poller
 * while the tab is open.
 *
 * @param ctx The mounted panel context.
 */
export function refreshLiveTab(ctx: PanelCtx): void {
  void refreshDataTab(ctx, ctx.state.live, DEVTOOLS_LIVE_FEED);
}
