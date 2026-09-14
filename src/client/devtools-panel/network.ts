// DevTools panel: the Network tab — the dev server's completed-request log.
//
// The data already exists: the dev black box records `kind:"request"` events, so this tab
// is a read of `/_denext/dev-state`. SPA dev serves no dev-state endpoint, hence the
// "App Router only" state the shared placeholder renders.
//
// Style note: the tab holds no style strings of its own — the status pill's per-class
// colours live in `statusPillStyles()` in ./styles.ts, built inside a function like every
// other style group (esbuild retains top-level object literals even when the only code
// using them is dead, silently shipping them to production).

import {
  type NetworkFilter,
  type NetworkUi,
  type PanelCtx,
  proportionalBar,
  refreshDataTab,
  renderDataPlaceholder,
} from "./ctx.ts";
import { DEV_STATE_PATH } from "./dev-api.ts";
import { el, type PanelStyles } from "./styles.ts";

/** How many recent requests the tab keeps (and asks the endpoint for). */
const MAX_ROWS = 200;

/** How many recent requests the tab asks for (the string form of {@link MAX_ROWS}). */
const REQUEST_LIMIT = "200";

/** One completed request, parsed out of a `kind:"request"` dev event. */
interface RequestRow {
  /** The HTTP method, or `""` when the event's message didn't carry one. */
  method: string;
  /** The request path. */
  path: string;
  /** The response status, or 0 when unknown. */
  status: number;
  /** How long the request took, in milliseconds. */
  durationMs: number;
  /** Epoch milliseconds when the event was recorded, or 0 when unknown. */
  ts: number;
}

/**
 * Draw the Network tab from the last poll.
 *
 * @param ctx The mounted panel context.
 */
export function renderNetworkTab(ctx: PanelCtx): void {
  if (renderDataPlaceholder(ctx, "Network", ctx.state.network)) return;
  const { doc, S, detailPane } = ctx;
  const rows = requestRows(ctx.state.network.data);
  const ui = networkUi(ctx);
  const shown = rows.filter((row) => matchesFilter(row, ui.filter));
  detailPane.append(renderToolbar(ctx, ui, shown.length, rows.length));
  if (ui.focused) ui.box.focus();
  if (shown.length === 0) {
    const why = rows.length === 0 ? "no requests yet" : "no requests match the filter";
    detailPane.append(el(doc, "div", S.empty, why));
    return;
  }
  let maxMs = 0;
  for (const row of shown) if (row.durationMs > maxMs) maxMs = row.durationMs;
  const now = Date.now();
  const body = el(doc, "tbody", "");
  for (const row of shown) body.append(renderRow(ctx, row, maxMs, now));
  detailPane.append(el(doc, "table", S.table, headRow(ctx), body));
}

/**
 * Re-read the request log into {@link PanelCtx.state}. Called by the shared 1 s poller
 * while the tab is open.
 *
 * @param ctx The mounted panel context.
 */
export function refreshNetworkTab(ctx: PanelCtx): void {
  const params = { kind: "request", limit: REQUEST_LIMIT };
  void refreshDataTab(ctx, ctx.state.network, DEV_STATE_PATH, params);
}

/**
 * Parse `/_denext/dev-state`'s payload into rows, newest first and capped.
 *
 * Everything is treated as untrusted shape: an event that carries neither a parseable
 * message nor a URL is skipped rather than rendered as a blank row.
 *
 * @param data The last successful endpoint read.
 * @returns At most {@link MAX_ROWS} rows, most recent first.
 */
function requestRows(data: unknown): RequestRow[] {
  const events = (data as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return [];
  const out: RequestRow[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < MAX_ROWS; i--) {
    const row = parseRequestEvent(events[i]);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Turn one dev event into a row.
 *
 * The method and path come from the recorded message (`"GET /x → 200"`); `url`/`status`
 * are used when the message doesn't parse, so a differently-shaped event still renders.
 *
 * @param event One entry of the endpoint's `events` array.
 * @returns The row, or null when the event carries no request to show.
 */
function parseRequestEvent(event: unknown): RequestRow | null {
  if (typeof event !== "object" || event === null) return null;
  const e = event as {
    message?: unknown;
    url?: unknown;
    status?: unknown;
    durationMs?: unknown;
    ts?: unknown;
  };
  const message = typeof e.message === "string" ? e.message : "";
  const parts = /^([A-Z]+)\s+(\S+)(?:\s+\S\s+(\d{3}))?/.exec(message);
  const path = parts?.[2] ?? (typeof e.url === "string" ? e.url : "");
  if (!path) return null;
  const status = typeof e.status === "number" ? e.status : Number(parts?.[3] ?? 0);
  const durationMs = typeof e.durationMs === "number" ? e.durationMs : 0;
  return {
    method: parts?.[1] ?? "",
    path,
    status: Number.isFinite(status) ? status : 0,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
    ts: typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts : 0,
  };
}

/**
 * Whether a row survives the toolbar's two filters.
 *
 * @param row The parsed request.
 * @param filter The toolbar's current state.
 * @returns Whether the row is shown.
 */
function matchesFilter(row: RequestRow, filter: NetworkFilter): boolean {
  if (filter.errorsOnly && row.status < 400) return false;
  return filter.text === "" || row.path.toLowerCase().includes(filter.text);
}

/**
 * The tab's toolbar + filter, created on first render and reused afterwards.
 *
 * @param ctx The mounted panel context.
 * @returns The live toolbar handle.
 */
function networkUi(ctx: PanelCtx): NetworkUi {
  const state = ctx.state;
  if (state.networkUi) return state.networkUi;
  const { doc, S } = ctx;
  const filter: NetworkFilter = { text: "", errorsOnly: false };
  const box = doc.createElement("input") as HTMLInputElement;
  box.style.cssText = S.search;
  box.setAttribute("type", "text");
  box.setAttribute("placeholder", "filter path");
  const errBtn = el(doc, "button", S.icon, "errors");
  errBtn.setAttribute("type", "button");
  errBtn.setAttribute("title", "Show only responses with status 400 and above");
  const count = el(doc, "span", S.dim, "");
  const ui: NetworkUi = {
    filter,
    toolbar: el(doc, "div", S.toolbar, box, errBtn, count),
    box,
    errBtn,
    count,
    focused: false,
  };
  box.addEventListener("input", () => {
    filter.text = box.value.trim().toLowerCase();
    ctx.render();
  });
  box.addEventListener("focus", () => (ui.focused = true));
  // The 1 s poller re-renders the pane, which detaches this box: a blur fired while the
  // box is out of the document is the panel's doing, not the developer's, so the focus is
  // restored after the toolbar is re-appended instead of being dropped mid-word.
  box.addEventListener("blur", () => {
    if (box.isConnected) ui.focused = false;
  });
  errBtn.addEventListener("click", () => {
    filter.errorsOnly = !filter.errorsOnly;
    ctx.render();
  });
  state.networkUi = ui;
  return ui;
}

/**
 * Bring the reused toolbar in line with the current filter and row counts.
 *
 * @param ctx The mounted panel context.
 * @param ui The live toolbar handle.
 * @param shown How many rows passed the filter.
 * @param total How many rows the last read produced.
 * @returns The toolbar element, ready to re-append.
 */
function renderToolbar(ctx: PanelCtx, ui: NetworkUi, shown: number, total: number): HTMLElement {
  ui.errBtn.style.cssText = ui.filter.errorsOnly ? ctx.S.iconOn : ctx.S.icon;
  ui.count.textContent = shown === total ? `${total} requests` : `${shown} of ${total}`;
  return ui.toolbar;
}

/**
 * The table's header row.
 *
 * @param ctx The mounted panel context.
 * @returns A `<thead>` holding one labelled row.
 */
function headRow(ctx: PanelCtx): HTMLElement {
  const { doc, S } = ctx;
  const tr = el(doc, "tr", "");
  for (const label of ["request", "status", "duration", "when"]) {
    tr.append(el(doc, "th", S.th, label));
  }
  return el(doc, "thead", "", tr);
}

/**
 * One request's row: method + path, the status pill, the duration and its bar, and how
 * long ago it completed.
 *
 * @param ctx The mounted panel context.
 * @param row The parsed request.
 * @param maxMs The slowest visible request, for the bar's scale.
 * @param now Epoch milliseconds this render started (shared by every row).
 * @returns The `<tr>`.
 */
function renderRow(ctx: PanelCtx, row: RequestRow, maxMs: number, now: number): HTMLElement {
  const { doc, S } = ctx;
  const request = el(doc, "td", S.td);
  if (row.method) request.append(el(doc, "span", S.dim, `${row.method} `));
  request.append(el(doc, "span", S.comp, row.path));
  const duration = el(doc, "td", S.tdNum, `${row.durationMs}ms`);
  duration.append(
    proportionalBar(ctx, row.durationMs, maxMs, "display:inline-block;margin-left:6px"),
  );
  return el(
    doc,
    "tr",
    "",
    request,
    el(doc, "td", S.td, statusPill(ctx, row.status)),
    duration,
    el(doc, "td", S.td, el(doc, "span", S.dim, row.ts === 0 ? "" : agoLabel(now - row.ts))),
  );
}

/**
 * A status badge coloured by response class.
 *
 * @param ctx The mounted panel context.
 * @param status The response status, or 0 when unknown.
 * @returns The pill element.
 */
function statusPill(ctx: PanelCtx, status: number): HTMLElement {
  return el(ctx.doc, "span", statusPillStyle(ctx.S, status), status === 0 ? "—" : String(status));
}

/**
 * The finished pill style for a response class (see `statusPillStyles` in ./styles.ts).
 *
 * @param S The panel's style table.
 * @param status The response status, or 0 when unknown.
 * @returns The pill's inline style.
 */
function statusPillStyle(S: PanelStyles["S"], status: number): string {
  if (status >= 500) return S.pill5xx;
  if (status >= 400) return S.pill4xx;
  if (status >= 300) return S.pill3xx;
  if (status >= 200) return S.pill2xx;
  return S.pillUnknown;
}

/**
 * A coarse "how long ago" label.
 *
 * @param deltaMs Milliseconds since the event was recorded.
 * @returns `"2s ago"` / `"3m ago"` / `"1h ago"`.
 */
function agoLabel(deltaMs: number): string {
  const seconds = Math.max(0, Math.round(deltaMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
