// DevTools panel: the MVU tab — every `denext/mvu` program running on the page (`useMvu`,
// `MvuView`), its recorded steps (the message and the model it produced), and time travel:
// clicking a step puts that step's model on screen. `denext/mvu` records the steps in dev into
// `globalThis.__denextMvu`; this tab only reads that registry and calls each program's `jump`.

import { h4, type PanelCtx } from "./ctx.ts";
import { el } from "./styles.ts";

/** One recorded step. */
interface MvuStep {
  msg: unknown;
  model: unknown;
  at: number;
}

/** What `denext/mvu` records per running program in dev. */
export interface MvuDevRecord {
  id: number;
  name: string;
  steps: MvuStep[];
  /** The step on screen. */
  cursor: number;
  /** Put step `index`'s model on screen. */
  jump(index: number): void;
}

/** The page's registry of running programs (empty outside `denext dev`). */
function pageRegistry(): ReadonlyMap<number, MvuDevRecord> {
  return (globalThis as { __denextMvu?: Map<number, MvuDevRecord> }).__denextMvu ?? new Map();
}

/** How much of a message or a model a row shows. */
const SUMMARY_CHARS = 80;

/** How much of the selected step's model the detail shows. */
const MODEL_CHARS = 4000;

/**
 * A value as one line of JSON, cut to `max` characters.
 *
 * @param value A message or a model.
 * @param max The longest result.
 * @returns The summary.
 */
export function summarize(value: unknown, max = SUMMARY_CHARS): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value); // a cycle, a BigInt
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One step's row: its index and message; clicking it travels there. */
function stepRow(ctx: PanelCtx, rec: MvuDevRecord, index: number): HTMLElement {
  const { doc, S } = ctx;
  const row = el(
    doc,
    "li",
    index === rec.cursor ? S.rowSel : S.row,
    el(doc, "span", S.count, `#${index}`),
    el(doc, "span", S.comp, summarize(rec.steps[index].msg)),
  );
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  row.title = "Show the model after this message";
  row.addEventListener("click", () => {
    rec.jump(index);
    ctx.render();
  });
  return row;
}

/** One program: its name, its steps, and the model of the step on screen. */
function renderProgram(ctx: PanelCtx, rec: MvuDevRecord, first: boolean): void {
  const { doc, S, detailPane } = ctx;
  detailPane.append(h4(ctx, first, `${rec.name} · ${rec.steps.length} steps`));
  const list = el(doc, "ul", S.wf);
  rec.steps.forEach((_, i) => list.append(stepRow(ctx, rec, i)));
  detailPane.append(list);
  const shown = rec.steps[rec.cursor];
  if (!shown) return;
  let model: string;
  try {
    model = JSON.stringify(shown.model, null, 2) ?? String(shown.model);
  } catch {
    model = String(shown.model);
  }
  detailPane.append(
    el(doc, "div", S.dim, `model after step #${rec.cursor}`),
    el(doc, "pre", S.v, model.length > MODEL_CHARS ? `${model.slice(0, MODEL_CHARS)}…` : model),
  );
}

/**
 * Draw the MVU tab.
 *
 * @param ctx The mounted panel context.
 * @param registry The running programs (default: the page's).
 */
export function renderMvuTab(
  ctx: PanelCtx,
  registry: ReadonlyMap<number, MvuDevRecord> = pageRegistry(),
): void {
  const { doc, S, detailPane } = ctx;
  if (registry.size === 0) {
    detailPane.append(
      el(doc, "div", S.empty, "No Model–View–Update program is running (useMvu / MvuView)."),
    );
    return;
  }
  let first = true;
  for (const rec of registry.values()) {
    renderProgram(ctx, rec, first);
    first = false;
  }
}
