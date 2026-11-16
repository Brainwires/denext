// The window test's "hooks" phase, on the backend: the hooks `desktop.ts` passes to `runDesktop`
// (`onWindowMenuItem`, `onSecondInstance`, `onWillNavigate`) and the ones the `kitchen` extension
// subscribes through its host (`host.onWindowMenuItem`, `host.onSecondInstance`,
// `host.onBeforeQuit` with a `host.confirm` box) record what they saw here, and the page reads it
// back through the extension (`kitchen.hooksLog`). Both sides run in the app's one Deno process, so
// this module is shared state between them.
//
// Only the hooks launch subscribes them (the runner starts it with KITCHEN_SINK_HOOKS=1 and phase
// `hooks` in its state file): the other phases keep the app as it was, with no Window menu, no
// navigation listener and no quit guard.
//
// No denext imports: the pure parts are unit-tested from the repository root
// (tests/desktop-kitchen-sink.test.ts), so the shapes below are structural.

/** The runner's phase (and the page's `PHASE_CHECKS` key) for this launch. */
export const HOOKS_PHASE = "hooks";

/** The variable the runner sets on the hooks launch (read by `desktop.ts` before `runDesktop`). */
export const HOOKS_ENV = "KITCHEN_SINK_HOOKS";

/** The app's own Window-menu item (`desktop.menu.window.items`) the hooks launch configures. */
export const WINDOW_ITEM = { id: "kitchen-window-item", label: "Kitchen window item" } as const;

/** The prefix denext gives the app's own Window-menu items in the native menu. */
export const WINDOW_ITEM_NATIVE_PREFIX = "denext:window:item:";

/** The argument the second launch carries (`<flag>=<nonce>`), so its event is told from others. */
export const SECOND_FLAG = "--kitchen-second";

/** The path on the runner's loopback server the will-navigate check navigates to. */
export const NAVIGATE_PATH = "kitchen-navigate-refused";

/** The quit guard's box: button 0 stays (Return and Escape both land on it), 1 quits. */
export const QUIT_BOX = {
  message: "Quit the kitchen sink?",
  detail:
    "The window test answers this box after the quit guards' 5 s deadline would have run out.",
  buttons: ["Stay", "Quit"],
  defaultId: 0,
  cancelId: 0,
} as const;

/** How long after the box opens the runner answers it: past the guards' 5 s deadline. */
export const QUIT_BOX_ANSWER_AFTER_MS = 8_000;

/** The guards' deadline the box must outlast (denext's `onBeforeQuit` budget). */
export const QUIT_GUARD_DEADLINE_MS = 5_000;

/** The hooks phase's checks, in order (the page runs them; the runner checks the names). */
export const HOOKS_CHECKS = {
  windowMenu:
    "backend hooks: a desktop.menu.window.items click reaches onWindowMenuItem and host.onWindowMenuItem once, with the key window",
  secondInstance:
    "backend hooks: a second launch reaches onSecondInstance and host.onSecondInstance with its args and cwd, and exits",
  willNavigate:
    "backend hooks: onWillNavigate sees a page-started top-level navigation and preventDefault() refuses it",
  caller:
    "backend hooks: ctx.caller is the main frame for the page's call; a sub-frame's call is refused",
  notify:
    "backend hooks: notify() from runDesktop's result and host.notify() post (or reject as documented)",
  quitDeadline:
    "backend hooks: an onBeforeQuit guard's host.confirm box holds the quit past the 5 s guard deadline",
} as const;

/** The check names in order. */
export const HOOKS_CHECK_NAMES: readonly string[] = Object.values(HOOKS_CHECKS);

/** A Window-menu click as a handler saw it. */
export interface MenuRecord {
  /** `runDesktop` (desktop.ts) or `host` (the extension). */
  readonly source: "runDesktop" | "host";
  readonly id: string;
  readonly keyWindow: { readonly id: string; readonly key?: string } | null;
}

/** A second launch as a handler saw it. */
export interface SecondRecord {
  readonly source: "runDesktop" | "host";
  readonly args: readonly string[];
  readonly cwd: string;
}

/** A top-level navigation `onWillNavigate` saw. */
export interface NavigationRecord {
  readonly url: string;
  readonly window: string;
  readonly kind: string;
  readonly prevented: boolean;
}

/** The quit guard's turn (`null` until it ran while armed). */
export interface QuitRecord {
  /** The button index `host.confirm` resolved (`null`: dismissed with no cancel button). */
  readonly answer: number | null;
  /** How long the box was up. */
  readonly boxMs: number;
  /** What the guard answered (`false` keeps the app running). */
  readonly allowed: boolean;
  /** `host.confirm`'s rejection (`<code>: <message>`), when it failed. */
  readonly error: string | null;
}

/** Everything the hooks recorded this launch. */
export interface HookLog {
  readonly menu: MenuRecord[];
  readonly second: SecondRecord[];
  readonly navigation: NavigationRecord[];
  quit: QuitRecord | null;
}

/** A fresh, empty log. */
export function createHookLog(): HookLog {
  return { menu: [], second: [], navigation: [], quit: null };
}

/** The process's log (desktop.ts and the extension share it). */
export const hookLog: HookLog = createHookLog();

/** A backend notification poster (`DesktopRuntime.notify` / `host.notify`), structurally. */
export type BackendNotify = (options: {
  title: string;
  body?: string;
  tag?: string;
}) => Promise<{ tag: string; close(): void }>;

/** `runDesktop`'s result's `notify`, once `desktop.ts` has it (the hooks launch only). */
export const runtimeNotifier: { notify?: BackendNotify } = {};

/** `config` with the hooks launch's Window menu (`desktop.menu.window.items`); never mutated. */
export function withHooksMenu<C extends { desktop?: Record<string, unknown> }>(config: C): C {
  const desktop = config.desktop ?? {};
  return {
    ...config,
    desktop: { ...desktop, menu: { window: { items: [{ ...WINDOW_ITEM }] } } },
  };
}

/** A Window-menu handler recording into `log` as `source`. */
export function windowMenuRecorder(log: HookLog, source: MenuRecord["source"]) {
  return (id: string, ctx: { keyWindow: MenuRecord["keyWindow"] }): void => {
    const key = ctx?.keyWindow ?? null;
    log.menu.push({
      source,
      id,
      keyWindow: key ? { id: key.id, ...(key.key !== undefined ? { key: key.key } : {}) } : null,
    });
  };
}

/** A second-launch handler recording into `log` as `source` (opens nothing). */
export function secondInstanceRecorder(log: HookLog, source: SecondRecord["source"]) {
  return (event: { args: readonly string[]; cwd: string }): undefined => {
    log.second.push({ source, args: [...event.args], cwd: event.cwd });
    return undefined;
  };
}

/** The will-navigate hook: records every navigation, and refuses the armed URL. */
export interface NavigationGuard {
  /** Refuse the next navigations to exactly `url`. */
  arm(url: string): void;
  /** The `onWillNavigate` handler. */
  readonly handler: (event: {
    url: string;
    window: string;
    kind: string;
    preventDefault(): void;
  }) => void;
}

/** Create the will-navigate hook over `log`. */
export function navigationGuard(log: HookLog): NavigationGuard {
  let armed: string | null = null;
  return {
    arm: (url) => {
      armed = url;
    },
    handler: (event) => {
      const prevented = armed !== null && event.url === armed;
      if (prevented) event.preventDefault();
      log.navigation.push({ url: event.url, window: event.window, kind: event.kind, prevented });
    },
  };
}

/** The process's will-navigate hook (`desktop.ts` subscribes it; the extension arms it). */
export const navigation: NavigationGuard = navigationGuard(hookLog);

/** What {@linkcode createQuitGuard} drives. */
export interface QuitGuardOptions {
  /** `host.confirm` (rejects with a `{ code }` error). */
  readonly confirm: (options: typeof QUIT_BOX & { window?: string }) => Promise<number | null>;
  /** Ask the runner to answer the box (called right before it opens). */
  readonly requestAnswer: () => void | Promise<void>;
  /** The clock (tests). */
  readonly now?: () => number;
}

/** The quit guard: one armed quit opens the box; any other quit goes through untouched. */
export interface QuitGuard {
  /** Hold the next quit with the box. */
  arm(): void;
  /** The `host.onBeforeQuit` guard. */
  readonly guard: () => boolean | Promise<boolean>;
}

function errorText(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown };
  return `${String(e?.code ?? "error")}: ${String(e?.message ?? err)}`;
}

/**
 * Create the quit guard over `log`. Armed, it asks the runner to answer, opens the box (owned by
 * the main window) and lets the quit go only for "Quit"; a box that cannot open keeps the app
 * running too (a throw would count as a yes and end the phase without its report).
 */
export function createQuitGuard(log: HookLog, options: QuitGuardOptions): QuitGuard {
  const now = options.now ?? Date.now;
  let armed = false;
  return {
    arm: () => {
      armed = true;
      log.quit = null;
    },
    guard: () => {
      if (!armed) return true;
      armed = false;
      return (async () => {
        const opened = now();
        let answer: number | null = null;
        let error: string | null = null;
        try {
          await options.requestAnswer();
          answer = await options.confirm({ ...QUIT_BOX, window: "main" });
        } catch (err) {
          error = errorText(err);
        }
        const allowed = error === null && answer === 1;
        log.quit = { answer, boxMs: now() - opened, allowed, error };
        return allowed;
      })();
    },
  };
}

/** Why a bridge call from `caller` is refused (a sub-frame's or an unknown frame's), or `null`. */
export function callerRefusal(
  caller: { frame: { kind: string; verified: boolean } },
): string | null {
  const { kind, verified } = caller.frame;
  if (kind === "main") return null;
  return `refused: called from a ${kind} frame (${
    verified ? "verified by the runtime" : "reported by the page"
  })`;
}

/**
 * Whether the main frame's `verified` must be `true`: the runtime marks frames
 * (`Deno.desktop.marksFrames`) and the engine says which frame called (CEF, macOS's WKWebView).
 * Elsewhere (WebView2, WebKitGTK) it is the page's own report, so either is accepted.
 */
export function mainFrameMustBeVerified(
  marksFrames: boolean,
  os: string,
  backend: "webview" | "cef" | null,
): boolean {
  return marksFrames && (backend === "cef" || os === "darwin");
}

/** The second launch's records carrying `nonce` (`<SECOND_FLAG>=<nonce>` among its args). */
export function secondLaunchesWith(
  log: Pick<HookLog, "second">,
  nonce: string,
): SecondRecord[] {
  const arg = `${SECOND_FLAG}=${nonce}`;
  return log.second.filter((r) => r.args.includes(arg));
}
