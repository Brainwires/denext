// The automation contract of the React Native app, the same as web/src/bench.ts: logcat
// markers (console.log lands in logcat under the `ReactNativeJS` tag, release builds too),
// an action queue driven by deep links, and a JS-thread FPS meter (off by default).

import { type ActionInfo, type ActionParams, MARKER } from "../../shared/scenarios.ts";

export interface ListHandle {
  scrollToIndex(pos: number): void;
  scrollToEnd(): void;
  scrollToStart(): void;
  isAtEnd(): boolean;
  /** The list keeps the end pinned on append by itself. */
  readonly sticksToEnd?: boolean;
}

export interface BenchController {
  run(action: ActionParams): Promise<ActionInfo>;
}

export function log(marker: keyof typeof MARKER, data: unknown): void {
  console.log(`${MARKER[marker]} ${JSON.stringify(data)}`);
}

export function frames(n = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

// ─── FPS meter (JS thread; no loop while off) ───────────────────────────────────────────

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
  let count = 0, since = -1, worst = 0, last = -1;
  const tick = (t: number) => {
    if (since < 0) since = last = t;
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

// ─── actions ────────────────────────────────────────────────────────────────────────────

let controller: BenchController | null = null;
const queue: { action: ActionParams; resolve: (i: ActionInfo) => void }[] = [];

export function setController(c: BenchController | null): void {
  controller = c;
  while (c && queue.length) {
    const { action, resolve } = queue.shift()!;
    void runAction(action).then(resolve);
  }
}

export async function runAction(action: ActionParams): Promise<ActionInfo> {
  if (action.op === "fps") {
    setFps(action.on ?? true);
    const info: ActionInfo = { op: "fps", ok: true, ms: 0 };
    log("action", info);
    return info;
  }
  if (!controller) return new Promise((resolve) => queue.push({ action, resolve }));
  let info: ActionInfo;
  try {
    info = await controller.run(action);
  } catch (e) {
    info = { op: action.op, ok: false, ms: 0, reason: String((e as Error)?.message ?? e) };
  }
  log("action", info);
  return info;
}

/** Report uncaught JS errors as markers (a fatal one still crashes the app, as in production). */
export function installErrorReporting(): void {
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler(): (e: unknown, fatal?: boolean) => void;
      setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void;
    };
  };
  const eu = g.ErrorUtils;
  if (!eu) return;
  const prev = eu.getGlobalHandler();
  eu.setGlobalHandler((e, fatal) => {
    log("error", { message: String((e as Error)?.message ?? e), fatal: !!fatal });
    prev(e, fatal);
  });
}
