// DevTools panel: the Console tab — what the page logged, threw and failed to load.
//
// The capture lives in the dev-reload script (src/build/dev-server/console-capture-script.ts),
// which runs before the app's entry module, so boot failures land in the buffer even when
// the app never renders. This tab only reads `window.__denextConsole`: level filter, clear,
// copy-all, the boot diagnosis, and a tap-to-expand stack per entry.

import type { ConsoleLevelFilter, PanelCtx } from "./ctx.ts";
import { el, type PanelStyles } from "./styles.ts";

/** One captured entry, as the capture script records it. */
export interface ConsoleEntry {
  id: number;
  ts: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  /** `console`, `uncaught`, `rejection`, `resource` or `diagnosis`. */
  source: string;
  message: string;
  stack: string;
  url: string;
}

/** The boot diagnosis's progress and result. */
export interface ConsoleDiagnosis {
  state: "idle" | "running" | "done";
  checked: number;
  queued: number;
  failures: { url: string; from: string; reason: string }[];
  entry: string;
  note: string;
  capped?: boolean;
}

/** `window.__denextConsole` — the capture script's buffer and controls. */
export interface ConsoleStore {
  entries: ConsoleEntry[];
  errorCount: number;
  importErrorSeen: boolean;
  limit: number;
  readonly diagnosis: ConsoleDiagnosis;
  subscribe(fn: () => void): () => void;
  clear(): void;
  diagnose(why?: string): Promise<ConsoleDiagnosis>;
}

/** The capture script's store, or null when the page wasn't served by a denext dev server. */
export function consoleStore(): ConsoleStore | null {
  const store = (globalThis as { __denextConsole?: ConsoleStore }).__denextConsole;
  return store && Array.isArray(store.entries) ? store : null;
}

/** How many entries one render draws (the newest; the buffer itself holds up to 500). */
const MAX_DRAWN = 300;

const FILTERS: readonly { id: ConsoleLevelFilter; label: string }[] = [
  { id: "all", label: "all" },
  { id: "error", label: "errors" },
  { id: "warn", label: "warnings" },
  { id: "info", label: "info" },
  { id: "log", label: "log" },
];

/**
 * Whether an entry passes the level filter (`log` covers `debug` too).
 *
 * @param entry The captured entry.
 * @param level The active filter.
 * @returns Whether to show it.
 */
function matchesLevel(entry: ConsoleEntry, level: ConsoleLevelFilter): boolean {
  if (level === "all") return true;
  if (level === "log") return entry.level === "log" || entry.level === "debug";
  return entry.level === level;
}

/** `HH:MM:SS.mmm` in local time. */
function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${
    p(d.getMilliseconds(), 3)
  }`;
}

/**
 * Every entry as plain text, oldest first — what "copy" puts on the clipboard.
 *
 * @param entries The entries to serialize.
 * @returns One block per entry, stacks indented.
 */
function consoleText(entries: readonly ConsoleEntry[]): string {
  return entries.map((e) => {
    const head = `${clock(e.ts)} [${e.level}] ${e.source === "console" ? "" : `(${e.source}) `}` +
      e.message;
    return e.stack ? `${head}\n    ${e.stack.split("\n").join("\n    ")}` : head;
  }).join("\n");
}

function rowStyle(S: PanelStyles["S"], level: ConsoleEntry["level"]): string {
  if (level === "error") return S.cRowError;
  if (level === "warn") return S.cRowWarn;
  if (level === "info") return S.cRowInfo;
  if (level === "debug") return S.cRowDebug;
  return S.cRowLog;
}

/** Copy text to the clipboard; falls back to a selectable `<textarea>` in the pane. */
function copyAll(ctx: PanelCtx, text: string, btn: HTMLElement): void {
  const done = (label: string) => {
    btn.textContent = label;
    setTimeout(() => (btn.textContent = "copy"), 1500);
  };
  const clip =
    (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } })
      .navigator?.clipboard;
  if (clip?.writeText) {
    clip.writeText(text).then(() => done("copied"), () => showCopyBox(ctx, text));
  } else showCopyBox(ctx, text);
}

function showCopyBox(ctx: PanelCtx, text: string): void {
  const box = ctx.doc.createElement("textarea") as HTMLTextAreaElement;
  box.style.cssText = `width:100%;height:40vh;box-sizing:border-box;font:inherit;` +
    `background:#0c0e14;color:#e6e9ef;border:1px solid #2a3140`;
  box.value = text;
  ctx.detailPane.prepend(box);
  box.focus();
  box.select();
}

function toolbar(ctx: PanelCtx, store: ConsoleStore): HTMLElement {
  const { doc, S, state } = ctx;
  const bar = el(doc, "div", S.cToolbar);
  for (const f of FILTERS) {
    const b = el(doc, "button", state.consoleLevel === f.id ? S.cBtnOn : S.cBtn, f.label);
    b.setAttribute("type", "button");
    b.addEventListener("click", () => {
      state.consoleLevel = f.id;
      ctx.render();
    });
    bar.append(b);
  }
  const clear = el(doc, "button", S.cBtn, "clear");
  clear.setAttribute("type", "button");
  clear.addEventListener("click", () => {
    state.consoleExpanded.clear();
    store.clear();
    ctx.render();
  });
  const copy = el(doc, "button", S.cBtn, "copy");
  copy.setAttribute("type", "button");
  copy.addEventListener("click", () => {
    const shown = store.entries.filter((e) => matchesLevel(e, state.consoleLevel));
    copyAll(ctx, consoleText(shown), copy);
  });
  const diag = el(doc, "button", S.cBtn, "diagnose boot");
  diag.setAttribute("type", "button");
  diag.setAttribute(
    "title",
    "Walk the module graph from the entry and report the module that fails",
  );
  diag.addEventListener("click", () => {
    void store.diagnose("manual");
    ctx.render();
  });
  bar.append(clear, copy, diag);
  return bar;
}

function diagnosisLine(ctx: PanelCtx, d: ConsoleDiagnosis): HTMLElement | null {
  if (d.state === "idle") return null;
  if (d.state === "running") {
    return el(
      ctx.doc,
      "div",
      ctx.S.cDiag,
      `boot diagnosis running… ${d.checked} module(s) checked, ${d.queued} pending`,
    );
  }
  if (d.failures.length === 0) {
    return el(
      ctx.doc,
      "div",
      ctx.S.cDiag,
      d.entry
        ? `boot diagnosis: ${d.checked} module(s) checked, none failed to load`
        : `boot diagnosis: ${d.note}`,
    );
  }
  const box = el(ctx.doc, "div", ctx.S.cRowError);
  box.append(`boot diagnosis: ${d.failures.length} failing module(s)`);
  for (const f of d.failures.slice(0, 10)) {
    box.append(
      el(
        ctx.doc,
        "div",
        ctx.S.cStack,
        `${f.url}\n  ${f.reason}${f.from ? `\n  imported by ${f.from}` : ""}`,
      ),
    );
  }
  return box;
}

function entryRow(ctx: PanelCtx, e: ConsoleEntry): HTMLElement {
  const { doc, S, state } = ctx;
  const row = el(doc, "div", rowStyle(S, e.level));
  row.append(el(doc, "span", S.cTime, clock(e.ts)));
  if (e.source !== "console") row.append(el(doc, "span", S.cSource, e.source));
  row.append(e.message);
  if (e.stack) {
    const open = state.consoleExpanded.has(e.id);
    row.append(el(doc, "span", S.cSource, open ? "  ▾ stack" : "  ▸ stack"));
    if (open) row.append(el(doc, "div", S.cStack, e.stack));
    row.addEventListener("click", () => {
      if (open) state.consoleExpanded.delete(e.id);
      else state.consoleExpanded.add(e.id);
      ctx.render();
    });
  }
  return row;
}

/**
 * Draw the Console tab.
 *
 * @param ctx The mounted panel context.
 */
export function renderConsoleTab(ctx: PanelCtx): void {
  const { doc, S, detailPane, state } = ctx;
  const store = consoleStore();
  if (!store) {
    detailPane.append(
      el(
        doc,
        "div",
        S.empty,
        "console capture is not installed (the dev-reload script did not run)",
      ),
    );
    return;
  }
  const pane = detailPane as HTMLElement & {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  };
  const atBottom = !(pane.scrollHeight > 0) ||
    pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  detailPane.append(toolbar(ctx, store));
  const diag = diagnosisLine(ctx, store.diagnosis);
  if (diag) detailPane.append(diag);
  const shown = store.entries.filter((e) => matchesLevel(e, state.consoleLevel));
  if (shown.length === 0) {
    detailPane.append(
      el(
        doc,
        "div",
        S.empty,
        store.entries.length ? "nothing at this level" : "no console output yet",
      ),
    );
    return;
  }
  if (shown.length > MAX_DRAWN) {
    detailPane.append(
      el(
        doc,
        "div",
        S.empty,
        `${shown.length - MAX_DRAWN} older entries hidden (copy includes them)`,
      ),
    );
  }
  for (const e of shown.slice(-MAX_DRAWN)) detailPane.append(entryRow(ctx, e));
  if (atBottom && typeof pane.scrollHeight === "number") pane.scrollTop = pane.scrollHeight;
}
