// The cell runner's logic, kept out of the component: the action table the automation drives
// (deep links / window.__bench) and the ready sequence (rows painted → positioned → marker).

import type { BenchList, Kind } from "../../shared/data.ts";
import {
  type ActionInfo,
  type ActionOp,
  type ActionParams,
  ANCHOR,
  findImpl,
  type ReadyInfo,
  type RunParams,
} from "../../shared/scenarios.ts";
import {
  bench,
  type BenchController,
  countMounted,
  frames,
  type ListHandle,
  log,
  setController,
} from "./bench.ts";
import { implNotes } from "./impls/index.ts";

/** What the runner component hands the controller. */
export interface RunnerContext {
  handle: () => ListHandle | null;
  list: () => BenchList;
  /** Commit a list change; resolves once it is committed. */
  commit: (next: (l: BenchList) => BenchList) => Promise<void>;
}

/** One action: resolves to a failure reason, or null when it was carried out. */
type Op = (a: ActionParams, h: ListHandle, ctx: RunnerContext) => Promise<string | null>;

const DEFAULT_K = 50;
const clamp = (l: BenchList, i: number) => Math.max(0, Math.min(l.count - 1, i));
const done = (run: () => void): Promise<null> => {
  run();
  return Promise.resolve(null);
};

/** Streaming append: if the list was at its end, keep it there (unless the impl does). */
async function append(a: ActionParams, h: ListHandle, ctx: RunnerContext): Promise<null> {
  const atEnd = h.isAtEnd();
  await ctx.commit((x) => x.withAppended(a.k ?? DEFAULT_K));
  if (atEnd && !h.sticksToEnd) h.scrollToEnd();
  return null;
}

/** History prepend: the impl keeps the visible rows in place if it can. */
async function prepend(a: ActionParams, h: ListHandle, ctx: RunnerContext): Promise<null> {
  h.beforePrepend?.();
  await ctx.commit((x) => x.withPrepended(a.k ?? DEFAULT_K));
  h.afterPrepend?.(a.k ?? DEFAULT_K);
  return null;
}

const growable = (op: Op): Op => (a, h, ctx) =>
  ctx.list().canGrow ? op(a, h, ctx) : Promise.resolve(`${ctx.list().kind} cannot grow`);

const OPS: Partial<Record<ActionOp, Op>> = {
  append: growable(append),
  prepend: growable(prepend),
  scrollToIndex: (a, h, ctx) => done(() => h.scrollToIndex(clamp(ctx.list(), a.i ?? 0))),
  scrollToEnd: (_a, h) => done(() => h.scrollToEnd()),
  scrollToStart: (_a, h) => done(() => h.scrollToStart()),
};

/** The controller `window.__bench` / deep-link actions run through. */
export function createController(ctx: RunnerContext): BenchController {
  return {
    async run(a: ActionParams): Promise<ActionInfo> {
      const start = performance.now();
      const h = ctx.handle();
      const op = OPS[a.op];
      const reason = !h ? "no list mounted" : !op ? "unsupported" : await op(a, h, ctx);
      if (reason) return { op: a.op, ok: false, ms: 0, reason };
      await frames(2);
      const ms = Math.round(performance.now() - start);
      return { op: a.op, ok: true, ms, count: ctx.list().count };
    },
  };
}

/** Resolves true once the impl registered its handle and rows are in the DOM. */
async function waitForRows(
  handle: () => ListHandle | null,
  cancelled: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const t0 = performance.now();
  const hasRows = () => handle() !== null && countMounted() > 0;
  const giveUp = () => cancelled() || performance.now() - t0 > timeoutMs;
  while (!hasRows()) {
    if (giveUp()) return false;
    await frames(1);
  }
  return !cancelled();
}

/** Chat opens at its newest message: scroll to the end, let it measure, scroll again. */
async function positionAtAnchor(kind: Kind, handle: () => ListHandle | null): Promise<void> {
  if (ANCHOR[kind] !== "end") return;
  handle()?.scrollToEnd();
  await frames(2);
  handle()?.scrollToEnd();
}

function readyInfo(params: RunParams): ReadyInfo {
  return {
    app: "denext",
    list: params.list,
    kind: params.kind,
    n: params.n,
    ms: Math.round(performance.now()),
    mounted: countMounted(),
    data: findImpl("denext", params.list)?.data,
    notes: implNotes(params.list, params.kind),
  };
}

/**
 * The ready sequence of a cell: rows painted → positioned → two frames → SCROLLBENCH_READY,
 * then the controller takes actions. SCROLLBENCH_ERROR if no row is painted within 60 s.
 */
export async function startCell(
  params: RunParams,
  handle: () => ListHandle | null,
  cancelled: () => boolean,
  controller: BenchController,
): Promise<void> {
  if (!(await waitForRows(handle, cancelled, 60_000))) {
    if (!cancelled()) log("error", { app: "denext", ...params, message: "no rows within 60 s" });
    return;
  }
  await positionAtAnchor(params.kind, handle);
  await frames(2);
  if (cancelled()) return;
  const info = readyInfo(params);
  bench.ready = true;
  bench.info = info;
  log("ready", info);
  setController(controller);
}
