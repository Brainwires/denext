// The automation surface of the web app: logcat markers, `window.__bench`, the deep-link
// action queue and the FPS meter. The React Native app implements the same contract
// (native/src/bench.ts), so the adb harness drives both identically.

import {
  type ActionInfo,
  type ActionParams,
  MARKER,
  type ReadyInfo,
} from "../../shared/scenarios.ts";

/** What each impl registers so the runner can drive it without knowing the library. */
export interface ListHandle {
  scrollToIndex(pos: number): void;
  scrollToEnd(): void;
  scrollToStart(): void;
  /** Scrolled to (within a few px of) the end. */
  isAtEnd(): boolean;
  /** The impl keeps the end pinned on append by itself (else the runner scrolls to the end). */
  readonly sticksToEnd?: boolean;
  /** Called right before a prepend is committed (e.g. to remember the first visible row). */
  beforePrepend?(): void;
  /** Called after a prepend of `k` entries is committed and painted. */
  afterPrepend?(k: number): void;
}

/** The runner's side of an action (installed by app.tsx while a list is on screen). */
export interface BenchController {
  run(action: ActionParams): Promise<ActionInfo>;
}

export interface BenchApi {
  ready: boolean;
  info: ReadyInfo | null;
  scrollToIndex(i: number): Promise<ActionInfo>;
  appendItems(k: number): Promise<ActionInfo>;
  prependItems(k: number): Promise<ActionInfo>;
  scrollToEnd(): Promise<ActionInfo>;
  scrollToStart(): Promise<ActionInfo>;
  fps(on: boolean): Promise<ActionInfo>;
  run(action: ActionParams): Promise<ActionInfo>;
}

declare global {
  /** `window.__bench`: the automation hooks (installed by main.tsx). */
  var __bench: BenchApi;
}

export function log(marker: keyof typeof MARKER, data: unknown): void {
  console.log(`${MARKER[marker]} ${JSON.stringify(data)}`);
}

/** Resolve after `n` animation frames (2 = the frame after the next commit has painted). */
export function frames(n = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

/** Every row root rows.tsx renders, whatever the impl wraps it in. */
const ROW_SELECTOR = ".sb-fixed,.sb-header,.sb-chat,.sb-image";
export const countMounted = (): number => document.querySelectorAll(ROW_SELECTOR).length;

/** A handle over a plain scroll container (the DOM impls, and the defaults of the others). */
export function scrollerHandle(el: () => HTMLElement | null): ListHandle {
  return {
    scrollToIndex(pos) {
      const row = el()?.children[pos] as HTMLElement | undefined;
      row?.scrollIntoView({ block: "start" });
    },
    scrollToEnd() {
      const e = el();
      if (e) e.scrollTop = e.scrollHeight;
    },
    scrollToStart() {
      const e = el();
      if (e) e.scrollTop = 0;
    },
    isAtEnd() {
      const e = el();
      return !!e && e.scrollTop + e.clientHeight >= e.scrollHeight - 4;
    },
  };
}

// ─── FPS meter (off by default: when off, no rAF loop runs at all) ─────────────────────

let fpsFrame = 0;
let fpsListener: ((text: string) => void) | null = null;

export function setFpsListener(fn: ((text: string) => void) | null): void {
  fpsListener = fn;
}

export function setFps(on: boolean): void {
  if (!on) {
    cancelAnimationFrame(fpsFrame);
    fpsFrame = 0;
    fpsListener?.("");
    return;
  }
  if (fpsFrame) return;
  let count = 0, since = performance.now(), worst = 0, last = since;
  const tick = (t: number) => {
    count++;
    worst = Math.max(worst, t - last);
    last = t;
    if (t - since >= 500) {
      fpsListener?.(
        `${Math.round((count * 1000) / (t - since))} fps · worst ${Math.round(worst)} ms`,
      );
      count = 0;
      since = t;
      worst = 0;
    }
    fpsFrame = requestAnimationFrame(tick);
  };
  fpsFrame = requestAnimationFrame(tick);
}

// ─── window.__bench ─────────────────────────────────────────────────────────────────────

let controller: BenchController | null = null;
const queue: { action: ActionParams; resolve: (i: ActionInfo) => void }[] = [];

export function setController(c: BenchController | null): void {
  controller = c;
  while (c && queue.length) {
    const { action, resolve } = queue.shift()!;
    void runAction(action).then(resolve);
  }
}

function fpsAction(on: boolean | undefined): ActionInfo {
  setFps(on ?? true);
  const info: ActionInfo = { op: "fps", ok: true, ms: 0 };
  log("action", info);
  return info;
}

const failed = (op: ActionParams["op"], e: unknown): ActionInfo => ({
  op,
  ok: false,
  ms: 0,
  reason: String((e as Error)?.message ?? e),
});

async function execute(c: BenchController, action: ActionParams): Promise<ActionInfo> {
  const info = await c.run(action).catch((e) => failed(action.op, e));
  log("action", info);
  return info;
}

/** Run one action (queued until a list is ready) and log its marker. */
export function runAction(action: ActionParams): Promise<ActionInfo> {
  if (action.op === "fps") return Promise.resolve(fpsAction(action.on));
  if (!controller || !bench.ready) {
    return new Promise((resolve) => queue.push({ action, resolve }));
  }
  return execute(controller, action);
}

export const bench: BenchApi = {
  ready: false,
  info: null,
  scrollToIndex: (i) => runAction({ op: "scrollToIndex", i }),
  appendItems: (k) => runAction({ op: "append", k }),
  prependItems: (k) => runAction({ op: "prepend", k }),
  scrollToEnd: () => runAction({ op: "scrollToEnd" }),
  scrollToStart: () => runAction({ op: "scrollToStart" }),
  fps: (on) => runAction({ op: "fps", on }),
  run: runAction,
};

/** Report uncaught errors as markers so the harness can tell a crashed cell from a slow one. */
export function installErrorReporting(): void {
  addEventListener("error", (e) => {
    const message = String(e.message ?? e);
    // Chromium reports a ResizeObserver callback that resized observed elements again as a
    // window error; it is a notification, not a failure (the next frame delivers them).
    if (message.includes("ResizeObserver loop")) return;
    log("error", { message });
  });
  addEventListener(
    "unhandledrejection",
    (e) =>
      log("error", {
        message: String((e.reason as Error)?.message ?? e.reason),
      }),
  );
}
