// The desktop window lifecycle (src/desktop/window-lifecycle.ts, window-registry.ts,
// window-store.ts): the extensions' onWindowOpened / onWindowClosed / onAppQuit hooks (static on a
// capability, dynamic from a setup host), the runtime-side onBeforeQuit guards and how a quit is
// held for them and for the quit hooks, window keys with their saved frames and the last session
// (`desktop.app.restoreWindows`), and `desktop.app.maxWindows` — all against fake runtime windows
// and a fake `Deno.desktop` whose `quit()` behaves like the pinned runtime's.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  type DesktopCapability,
  DesktopCapError,
  type DesktopExtensionHost,
  type DesktopWindowClosedInfo,
  type DesktopWindowInfo,
} from "../src/desktop/extension.ts";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import { createWindowController } from "../src/desktop/caps/window.ts";
import {
  createWindowRegistry,
  MAX_OPEN_WINDOWS,
  MAX_WINDOWS_LIMIT,
  type RegistryWindow,
  type WindowRegistry,
  type WindowRegistryOptions,
} from "../src/desktop/window-registry.ts";
import {
  clampToScreens,
  openWindowStore,
  WINDOW_STORE_FILE,
  windowKeyProblem,
} from "../src/desktop/window-store.ts";
import { setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import {
  maxWindowsProblem,
  resolveDesktopAppSettings,
  resolveDesktopWindowSettings,
} from "../src/desktop/window-config.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { DESKTOP_DATA_TOKEN, desktopBuildFlags } from "../src/build/desktop-capabilities.ts";
import { registerAppLifecycle } from "../src/desktop/window-lifecycle.ts";
import { installAppUpdateAndRelaunch } from "../src/desktop/app-updater.ts";

/** A runtime window recording its calls, with bounds that follow `setBounds` and the events. */
class FakeWin extends EventTarget implements RegistryWindow {
  static made: FakeWin[] = [];
  calls: string[] = [];
  bounds = { x: 1, y: 2, width: 300, height: 200 };
  hidden = false;
  closedByRuntime = false;
  constructor(readonly options?: Record<string, unknown>) {
    super();
    FakeWin.made.push(this);
    const o = options ?? {};
    for (const key of ["x", "y", "width", "height"] as const) {
      if (typeof o[key] === "number") this.bounds[key] = o[key] as number;
    }
  }
  bind() {}
  navigate(url: string) {
    this.calls.push(`navigate:${url}`);
  }
  show() {
    this.hidden = false;
    this.calls.push("show");
  }
  hide() {
    this.hidden = true;
    this.calls.push("hide");
  }
  focus() {}
  close() {
    this.closedByRuntime = true;
    this.calls.push("close");
  }
  isVisible() {
    return !this.hidden;
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(b: Record<string, number>) {
    Object.assign(this.bounds, b);
  }
  /** The user moved or resized it: the runtime's events. */
  moveTo(x: number, y: number) {
    this.bounds.x = x;
    this.bounds.y = y;
    this.dispatchEvent(new CustomEvent("move", { detail: { x, y } }));
  }
  resizeTo(width: number, height: number) {
    this.bounds.width = width;
    this.bounds.height = height;
    this.dispatchEvent(new CustomEvent("resize", { detail: { width, height } }));
  }
  /** The user closed it (a cancelable close, as the runtime dispatches it). */
  userClose(): boolean {
    const event = new Event("close", { cancelable: true });
    this.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

/** A `Deno.desktop` whose `quit()` is the pinned runtime's: beforequit, then every window's close. */
function quittingApi(windows: () => readonly EventTarget[]) {
  const quits: number[] = [];
  const cancels: number[] = [];
  const api = Object.assign(new EventTarget(), {
    quitOnLastWindowClosed: true,
    screens: () => [{
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
      scaleFactor: 2,
      isPrimary: true,
    }],
    quit: () => {
      const before = new Event("beforequit", { cancelable: true });
      api.dispatchEvent(before);
      if (before.defaultPrevented) return false;
      for (const win of windows()) {
        const close = new Event("close", { cancelable: true });
        win.dispatchEvent(close);
        if (close.defaultPrevented) return false;
      }
      quits.push(1);
      return true;
    },
    cancelQuit: () => {
      cancels.push(1);
      return true;
    },
  }) as DesktopAppApi & EventTarget & { quitOnLastWindowClosed: boolean };
  return { api, quits, cancels };
}

/** Wait for `cond`, up to `ms`. */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 2));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A registry over a fake main window and the quitting API, with runDesktop's main close wiring. */
function registry(
  opts: Partial<Omit<WindowRegistryOptions, "keepAlive" | "api">> & {
    keepAlive?: boolean;
    api?: boolean;
  } = {},
) {
  FakeWin.made = [];
  const main = new FakeWin();
  const exits: number[] = [];
  const warnings: string[] = [];
  const emitted: Array<[string, string, unknown]> = [];
  const { api, quits, cancels } = quittingApi(() => [main, ...FakeWin.made.slice(1)]);
  const { keepAlive, api: withApi, ...rest } = opts;
  const reg: WindowRegistry = createWindowRegistry({
    BrowserWindow: FakeWin,
    ...(withApi === false ? {} : { api }),
    appUrl: (path) => `app://localhost${path}`,
    emit: (cap, event, data) => void emitted.push([cap, event, data]),
    keepAlive: () => keepAlive === true,
    exit: (code) => void exits.push(code),
    warn: (m) => void warnings.push(m),
    lifecycleTimeouts: { quitMs: 100, guardMs: 100 },
    controller: (window, _id, closed) =>
      createWindowController({
        window,
        api: withApi === false ? undefined : api,
        emit: (cap, event, data) => void emitted.push([cap, event, data]),
        closed,
      }),
    ...rest,
  });
  reg.adopt(main, "main");
  main.addEventListener("close", (event) => {
    if (reg.interceptClose("main", event)) return;
    reg.closed("main");
  });
  reg.lifecycle.install();
  return { reg, main, api, quits, cancels, exits, warnings, emitted };
}

/** What a set of hooks saw. */
function recorder() {
  const opened: DesktopWindowInfo[] = [];
  const closed: DesktopWindowClosedInfo[] = [];
  const quit: string[] = [];
  const cap: DesktopCapability = {
    name: "rec",
    methods: {},
    onWindowOpened: (info) => void opened.push(info),
    onWindowClosed: (info) => void closed.push(info),
    onAppQuit: () => void quit.push("quit"),
  };
  return { opened, closed, quit, cap };
}

// --- the hooks -----------------------------------------------------------------------------------

Deno.test("lifecycle: onWindowOpened sees the main window (replayed) and every window after", () => {
  const { reg } = registry();
  const rec = recorder();
  const w1 = reg.open({ url: "/a" });
  reg.lifecycle.addCapabilities([rec.cap]);
  assertEquals(rec.opened, [{ id: "main", kind: "main" }, { id: w1.id, kind: "window" }]);
  const w2 = reg.open({ url: "/b", key: "editor" });
  assertEquals(rec.opened.at(-1), { id: w2.id, kind: "window", key: "editor" });
  // A host subscription (an extension's setup) is replayed too, and unsubscribes.
  const seen: string[] = [];
  const off = reg.lifecycle.onWindowOpened((info) => void seen.push(info.id));
  assertEquals(seen, ["main", w1.id, w2.id]);
  off();
  reg.open({ url: "/c" });
  assertEquals(seen.length, 3);
  assertEquals(reg.lifecycle.windows().map((w) => w.key ?? w.id), [
    "main",
    w1.id,
    "editor",
    "window-3",
  ]);
});

Deno.test("lifecycle: onWindowClosed says whether the app is quitting; a reload never fires it", async () => {
  const { reg, main, exits } = registry();
  const rec = recorder();
  reg.lifecycle.addCapabilities([rec.cap]);
  const w = reg.open({ url: "/a", key: "k" });
  // A reload of the window's page (onPageLoad) is not a close.
  await reg.router.onPageLoad?.(w.id);
  await reg.capability.onPageLoad?.(w.id);
  assertEquals(rec.closed, []);
  // The user closes it while the main window stays: not a quit.
  assert(FakeWin.made.at(-1)!.userClose());
  assertEquals(rec.closed, [{ id: w.id, kind: "window", key: "k", appQuitting: false }]);
  assertEquals(exits, []);
  // The last app window closes without keepAlive: the app quits with it.
  assert(main.userClose());
  await until(() => exits.length > 0);
  assertEquals(rec.closed.at(-1), { id: "main", kind: "main", appQuitting: true });
  assertEquals(rec.quit, ["quit"], "onAppQuit ran before the exit");
  assertEquals(exits, [0]);
});

Deno.test("lifecycle: a kept-alive app's last window closing is not a quit", () => {
  const { reg, main, exits } = registry({ keepAlive: true });
  const rec = recorder();
  reg.lifecycle.addCapabilities([rec.cap]);
  assert(main.userClose());
  assertEquals(rec.closed, [{ id: "main", kind: "main", appQuitting: false }]);
  assertEquals(rec.quit, []);
  assertEquals(exits, []);
});

Deno.test("lifecycle: without quit hooks the last close exits at once, as before", () => {
  const { reg, main, exits } = registry();
  reg.open({ url: "/a" });
  assert(FakeWin.made.at(-1)!.userClose());
  assertEquals(exits, []);
  assert(main.userClose());
  assertEquals(exits, [0], "synchronous");
  // A quit without hooks: the exit on the last close, inside the quit, as before.
  const quit = registry();
  assertEquals(quit.api.quit!(), true);
  assertEquals([quit.exits, quit.quits], [[0], [1]]);
});

Deno.test("lifecycle: onAppQuit is awaited, and bounded by its deadline", async () => {
  const { reg, main, exits, warnings } = registry();
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => (release = r));
  const order: string[] = [];
  reg.lifecycle.onAppQuit(async () => {
    order.push("start");
    await slow;
    order.push("done");
  });
  reg.lifecycle.onAppQuit(() => {
    throw new Error("boom"); // logged, never blocks the exit
  });
  assert(main.userClose());
  await tick();
  assertEquals(order, ["start"]);
  assertEquals(exits, [], "the exit waits for the hook");
  release();
  await until(() => exits.length > 0);
  assertEquals(order, ["start", "done"]);
  assert(
    warnings.some((w) => w.includes("onAppQuit failed") && w.includes("boom")),
    warnings.join(),
  );
  // A hook that never settles: the deadline (100 ms here) ends the wait.
  const hang = registry();
  hang.reg.lifecycle.onAppQuit(() => new Promise(() => {}));
  const at = Date.now();
  assert(hang.main.userClose());
  await until(() => hang.exits.length > 0);
  assert(Date.now() - at >= 90, "waited for the deadline");
  assert(hang.warnings.some((w) => w.includes("before every onAppQuit hook finished")));
});

Deno.test("lifecycle: a quit closes every window (appQuitting), runs onAppQuit once, then quits", async () => {
  const { reg, api, quits, exits } = registry();
  const rec = recorder();
  reg.lifecycle.addCapabilities([rec.cap]);
  const w = reg.open({ url: "/a", key: "k" });
  const opened = FakeWin.made.at(-1)!;
  assertEquals(api.quit!(), false, "the last close is held while the quit hooks run");
  assertEquals(rec.closed.map((c) => [c.id, c.appQuitting]), [["main", true], [w.id, true]]);
  assert(opened.hidden, "the held window looks closed meanwhile");
  await until(() => quits.length > 0);
  assertEquals(rec.quit, ["quit"]);
  assertEquals(quits, [1], "the quit was issued again once, and went through");
  assertEquals(exits, [], "the runtime ends the process after its quit, not Deno.exit");
});

Deno.test("lifecycle: a tray app with no window quits through its hooks from beforequit", async () => {
  const { reg, main, api, quits } = registry({ keepAlive: true });
  const rec = recorder();
  reg.lifecycle.addCapabilities([rec.cap]);
  assert(main.userClose());
  assertEquals(reg.count(), 0);
  assertEquals(api.quit!(), false);
  await until(() => quits.length > 0);
  assertEquals(rec.quit, ["quit"]);
});

Deno.test("lifecycle: with quit hooks the runtime is told not to end the loop on the last close", () => {
  const api = Object.assign(new EventTarget(), { quitOnLastWindowClosed: true }) as
    & DesktopAppApi
    & { quitOnLastWindowClosed: boolean };
  const s = setUpDesktopWindows({ window: new FakeWin(), api, emit: () => {}, wantsTray: false });
  assertEquals(api.quitOnLastWindowClosed, true, "as before, without hooks");
  s.lifecycle!.onAppQuit(() => {});
  assertEquals(api.quitOnLastWindowClosed, false, "the registry exits once the hooks ran");
});

// --- the quit guards ----------------------------------------------------------------------------

Deno.test("guards: onBeforeQuit false cancels the quit (and the OS's session end); true lets it go", async () => {
  const { reg, api, quits, cancels } = registry();
  const rec = recorder();
  reg.lifecycle.addCapabilities([rec.cap]);
  let answer = false;
  const asked: number[] = [];
  reg.lifecycle.onBeforeQuit(async () => {
    asked.push(1);
    await tick();
    return answer;
  });
  assertEquals(api.quit!(), false, "held for the guard");
  await until(() => cancels.length > 0);
  assertEquals([asked.length, quits.length, rec.quit.length], [1, 0, 0]);
  answer = true;
  assertEquals(api.quit!(), false);
  await until(() => quits.length > 0);
  assertEquals([asked.length, cancels.length, rec.quit], [2, 1, ["quit"]]);
});

Deno.test("guards: a throwing guard and one past the deadline do not cancel", async () => {
  const { reg, api, quits, warnings } = registry();
  reg.lifecycle.onBeforeQuit(() => {
    throw new Error("guard broke");
  });
  assertEquals(api.quit!(), false);
  await until(() => quits.length > 0);
  assert(warnings.some((w) => w.includes("onBeforeQuit failed") && w.includes("guard broke")));
  const hang = registry();
  hang.reg.lifecycle.onBeforeQuit(() => new Promise<boolean>(() => {}));
  const at = Date.now();
  assertEquals(hang.api.quit!(), false);
  await until(() => hang.quits.length > 0);
  assert(Date.now() - at >= 90, "the guards' deadline");
  assert(hang.warnings.some((w) => w.includes("gave no answer")));
});

Deno.test("guards: the runtime-side guard is asked before a page's; a page's consent is kept", async () => {
  const { reg, api, quits, emitted } = registry();
  const rec = recorder();
  reg.lifecycle.addCapabilities([rec.cap]);
  const order: string[] = [];
  reg.lifecycle.onBeforeQuit(() => {
    order.push("backend");
    return true;
  });
  // The main window's page guards its close (onCloseRequested).
  const main = reg.get("main")!;
  const ctx = { windowId: "main" } as never;
  await main.controller.capability.methods.setCloseGuard.handler({ enabled: true }, ctx);
  assertEquals(api.quit!(), false);
  await until(() => emitted.some(([, e]) => e === "closeRequested"));
  const request = emitted.find(([, e]) => e === "closeRequested")![2] as {
    id: string;
    reason: string;
  };
  assertEquals([order, request.reason], [["backend"], "quit"]);
  // The page lets the quit go: the lifecycle's hold runs the hooks, then the quit completes
  // without asking the page again.
  const answer = await main.controller.capability.methods.closeRespond.handler(
    { id: request.id, close: true },
    ctx,
  );
  assertEquals(answer, { closing: false }, "held for the quit hooks");
  await until(() => quits.length > 0);
  assertEquals(emitted.filter(([, e]) => e === "closeRequested").length, 1);
  assertEquals(rec.quit, ["quit"]);
  assertEquals(rec.closed, [{ id: "main", kind: "main", appQuitting: true }]);
});

Deno.test("guards: a second quit while the guards are asked waits for their answer", async () => {
  const { reg, api, quits } = registry();
  const asked: number[] = [];
  reg.lifecycle.onBeforeQuit(async () => {
    asked.push(1);
    await tick();
    return true;
  });
  api.quit!();
  api.quit!();
  await until(() => quits.length > 0);
  assertEquals([asked.length, quits.length], [1, 1]);
});

Deno.test("guards: the setup host and DesktopRuntime-shaped subscriptions reach the same guards", async () => {
  const main = new FakeWin();
  const { api, quits, cancels } = quittingApi(() => [main]);
  const exits: number[] = [];
  const s = setUpDesktopWindows({
    window: main,
    api,
    emit: () => {},
    wantsTray: false,
    exit: (c) => void exits.push(c),
  });
  main.addEventListener("close", (e) => {
    if (s.interceptMainClose(e)) return;
    s.mainClosed();
  });
  s.install();
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "x", methods: {}, setup: (h) => (host = h) }], {
    lifecycle: s.lifecycle,
  });
  assertEquals(host!.windows(), [{ id: "main", kind: "main" }]);
  const off = host!.onBeforeQuit(() => false);
  assertEquals(api.quit!(), false);
  await until(() => cancels.length > 0);
  assertEquals(quits, []);
  off();
  assertEquals(api.quit!(), true, "no guard, no quit hook: the quit goes straight through");
  assertEquals(exits, [0], "the last close's exit, as before");
});

// --- a guard that waits for the user, and a quit asked for again --------------------------------

/** The OS's session end as the runtime starts it: a cancelable `beforequit` with that reason. */
function sessionEnd(api: EventTarget): boolean {
  const event = new Event("beforequit", { cancelable: true });
  Object.defineProperty(event, "reason", { value: "session-end" });
  api.dispatchEvent(event);
  return !event.defaultPrevented;
}

/** Wait `ms`. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("guards: the deadline stops while a guard's message box is up and goes on when it closes", async () => {
  // The guards' deadline is 100 ms here; the user takes longer than that to answer.
  const { reg, api, quits, cancels, warnings } = registry();
  let box = Promise.withResolvers<number>();
  let opened = 0;
  reg.lifecycle.onBeforeQuit(async () => {
    opened++;
    return (await reg.lifecycle.whileGuardAsks(box.promise)) === 0;
  });
  assertEquals(api.quit!(), false, "held for the guard");
  await until(() => opened === 1);
  await wait(250);
  assertEquals([quits.length, cancels.length], [0, 0], "never quit under an unanswered box");
  assert(!warnings.some((w) => w.includes("gave no answer")));
  box.resolve(1); // "Cancel"
  await until(() => cancels.length === 1);
  assertEquals(quits.length, 0);
  box = Promise.withResolvers<number>();
  api.quit!();
  await until(() => opened === 2);
  await wait(250);
  box.resolve(0); // "Quit Anyway"
  await until(() => quits.length === 1);
});

Deno.test("guards: once the box closes the rest of the deadline runs; a box outside the guards' turn changes nothing", async () => {
  const { reg, api, quits, warnings } = registry();
  // Not asking: passed through untouched.
  assertEquals(await reg.lifecycle.whileGuardAsks(Promise.resolve(7)), 7);
  reg.lifecycle.onBeforeQuit(async () => {
    await reg.lifecycle.whileGuardAsks(wait(150));
    return new Promise<boolean>(() => {}); // then never answers
  });
  const at = Date.now();
  api.quit!();
  await until(() => quits.length === 1);
  assert(Date.now() - at >= 230, "the box's time did not count, the rest of the deadline did");
  assert(warnings.some((w) => w.includes("gave no answer")));
});

Deno.test("guards: a session end keeps its bound: a box never pauses its deadline", async () => {
  const { reg, api, quits, warnings } = registry();
  reg.lifecycle.onBeforeQuit(async () => {
    await reg.lifecycle.whileGuardAsks(new Promise<never>(() => {})); // nobody answers
    return true;
  });
  const at = Date.now();
  assertEquals(sessionEnd(api), false, "held for the guard");
  await until(() => quits.length === 1);
  assert(Date.now() - at < 1_000, "the 100 ms deadline ran with the box up");
  assert(warnings.some((w) => w.includes("gave no answer")));
});

Deno.test("guards: a session end during a plain quit's paused deadline makes it count again", async () => {
  const { reg, api, quits } = registry();
  let opened = false;
  reg.lifecycle.onBeforeQuit(async () => {
    opened = true;
    await reg.lifecycle.whileGuardAsks(new Promise<never>(() => {}));
    return true;
  });
  api.quit!();
  await until(() => opened);
  await wait(200);
  assertEquals(quits.length, 0, "paused for the box");
  const at = Date.now();
  assertEquals(sessionEnd(api), false, "held: the guards are deciding");
  await until(() => quits.length === 1);
  assert(Date.now() - at < 1_000, "bounded once the session end arrived");
});

/** Two extensions over the registry's lifecycle, each with the host its `setup` got. */
function twoExtensions(reg: WindowRegistry) {
  const hosts: Record<string, DesktopExtensionHost> = {};
  createDesktopBridge(
    ["a", "b"].map((name) => ({ name, methods: {}, setup: (h) => void (hosts[name] = h) })),
    { lifecycle: reg.lifecycle },
  );
  return hosts;
}

Deno.test("host.quit: a guard that cancelled and asked quits again; its own guard is not asked twice", async () => {
  const { reg, api, quits, cancels } = registry();
  const { a } = twoExtensions(reg);
  const asked: string[] = [];
  a.onBeforeQuit(() => (asked.push("a"), false)); // cancel at once, ask, then quit
  reg.lifecycle.onBeforeQuit(() => (asked.push("other"), true));
  api.quit!();
  await until(() => cancels.length === 1);
  assertEquals(await a.quit(), true);
  assertEquals(asked, ["a", "other", "other"], "a is skipped, the other guard is asked again");
  assertEquals(quits.length, 1);
});

Deno.test("host.quit: two guards that each cancel, ask and quit again end in one quit, not a loop", async () => {
  const { reg, api, quits } = registry();
  const { a, b } = twoExtensions(reg);
  const asked: string[] = [];
  // Each cancels at once and, the first time, asks its user (who says quit), then quits again.
  const guard = (name: string, host: DesktopExtensionHost) => () => {
    asked.push(name);
    if (asked.filter((x) => x === name).length === 1) setTimeout(() => void host.quit(), 0);
    return false;
  };
  a.onBeforeQuit(guard("a", a));
  b.onBeforeQuit(guard("b", b));
  api.quit!();
  await until(() => quits.length === 1);
  await wait(50);
  // The first quit asks both; a's quit asks only b (which refuses again); b's quit asks nobody.
  assertEquals([asked, quits.length], [["a", "b", "b"], 1]);
});

Deno.test("host.quit: a quit from anywhere else asks every guard again; another guard's refusal is false", async () => {
  const { reg, api, cancels, quits } = registry();
  const { a, b } = twoExtensions(reg);
  let aAsked = 0;
  let bAnswer = false;
  a.onBeforeQuit(() => (aAsked++, false));
  b.onBeforeQuit(() => bAnswer);
  api.quit!();
  await until(() => cancels.length === 1);
  assertEquals(await a.quit(), false, "b refused");
  assertEquals(aAsked, 1);
  // The user quits again: a's approval is gone, so a is asked.
  bAnswer = true;
  api.quit!();
  await until(() => cancels.length === 3);
  assertEquals([aAsked, quits.length], [2, 0]);
});

Deno.test("host.quit: from inside its own guard it is refused; while the guards are asked it waits for them", async () => {
  // b holds its answer for as long as the test needs: the guards' deadline must not end the
  // wait on a loaded machine (past it the quit goes on by design, which has its own test).
  const { reg, api, quits, warnings } = registry({
    lifecycleTimeouts: { quitMs: 100, guardMs: 60_000 },
  });
  const { a, b } = twoExtensions(reg);
  let inside: unknown;
  a.onBeforeQuit(async () => {
    inside = await a.quit().then(() => "resolved", (err) => err);
    return true;
  });
  const slow = Promise.withResolvers<boolean>();
  b.onBeforeQuit(() => slow.promise);
  api.quit!();
  await until(() => inside !== undefined);
  assert(inside instanceof DesktopCapError && inside.code === "conflict");
  // Another quit asked for meanwhile waits for the guards' answer, which lets the quit go.
  let waited: boolean | undefined;
  void reg.lifecycle.requestQuit().then((v) => (waited = v));
  // A stall longer than the default test deadline (100 ms), as a busy CI runner gives (a timer
  // jitter run once failed here), then a full macrotask turn, so every microtask the second quit
  // could settle on has run. Only b's answer may end its wait.
  const start = performance.now();
  while (performance.now() - start < 150) { /* descheduled */ }
  await tick();
  assertEquals([waited, quits.length], [undefined, 0]);
  slow.resolve(true);
  await until(() => waited !== undefined);
  assertEquals([waited, quits.length], [true, 1]);
  assert(!warnings.some((w) => w.includes("gave no answer")), "b answered; no deadline ran out");
});

Deno.test("host.quit: false with no runtime to quit", async () => {
  const { reg } = registry({ api: false });
  assertEquals(await twoExtensions(reg).a.quit(), false);
});

Deno.test("updater: an install held for the quit hooks is issued again as the install, not a plain quit", async () => {
  const { reg, api, quits, cancels } = registry();
  const rec = recorder();
  reg.lifecycle.addCapabilities([rec.cap]);
  const unregister = registerAppLifecycle(reg.lifecycle);
  // The runtime's applyAndRelaunch dispatches beforequit + closes like quit() (the fake delegates).
  const relaunches: unknown[] = [];
  const had = Object.getOwnPropertyDescriptor(Deno, "desktop");
  Object.defineProperty(Deno, "desktop", {
    value: {
      updater: {
        applyAndRelaunch: (o: unknown) => {
          relaunches.push(o);
          return { quitting: api.quit!() };
        },
      },
    },
    configurable: true,
  });
  try {
    assertEquals(
      installAppUpdateAndRelaunch(),
      { quitting: true },
      "held for the hooks: it goes on",
    );
    await until(() => quits.length > 0);
    assertEquals(relaunches, [{}, {}], "issued again as the install once the hooks ran");
    assertEquals(rec.quit, ["quit"]);
    // A refusing guard: the install stands down (no plain quit either).
    const refused = registry();
    refused.reg.lifecycle.onBeforeQuit(() => false);
    registerAppLifecycle(refused.reg.lifecycle);
    relaunches.length = 0;
    (Deno as unknown as { desktop: { updater: { applyAndRelaunch: (o: unknown) => unknown } } })
      .desktop.updater.applyAndRelaunch = (o) => {
        relaunches.push(o);
        return { quitting: refused.api.quit!() };
      };
    assertEquals(installAppUpdateAndRelaunch({ force: true }), { quitting: true });
    await until(() => refused.cancels.length > 0);
    assertEquals([relaunches, refused.quits, cancels], [[{ force: true }], [], []]);
  } finally {
    unregister();
    if (had) Object.defineProperty(Deno, "desktop", had);
    else delete (Deno as unknown as Record<string, unknown>).desktop;
  }
});

// --- keys and frames ----------------------------------------------------------------------------

Deno.test("keys: unique among the open windows, found by key, on the ref, the info and the events", () => {
  const { reg, emitted } = registry();
  const w = reg.open({ url: "/a", key: "editor" });
  assertEquals(w.key, "editor");
  assertEquals(reg.byKey("editor")?.id, w.id);
  assertEquals(reg.byKey("nope"), undefined);
  let code = "";
  try {
    reg.open({ url: "/b", key: "editor" });
  } catch (err) {
    code = String((err as { code?: unknown }).code);
  }
  assertEquals(code, "validation", "a duplicate key");
  const list = reg.capability.methods.list.handler({}, undefined as never) as { key?: string }[];
  assertEquals(list.map((i) => i.key), [undefined, "editor"]);
  assert(
    emitted.some(([cap, e, d]) =>
      cap === "windows" && e === "opened" && (d as { key?: string }).key === "editor"
    ),
  );
  // Closed: the key is free again.
  reg.close(w.id);
  assertEquals(reg.byKey("editor"), undefined);
  assertEquals(reg.open({ url: "/b", key: "editor" }).key, "editor");
});

Deno.test("keys: a key is checked wherever it comes from (a page's open too)", () => {
  const { reg } = registry();
  for (const key of ["", "a/b", "..\\x", "a".repeat(65), ".hidden", 5, { k: 1 }, "with space"]) {
    let code = "";
    try {
      reg.capability.methods.open.handler({ url: "/x", key }, undefined as never);
    } catch (err) {
      code = String((err as { code?: unknown }).code);
    }
    assertEquals(code, "validation", JSON.stringify(key));
  }
  assertEquals(windowKeyProblem("win-1.main:a_b"), null);
  assertStringIncludes(windowKeyProblem("a/b")!, "letters, digits");
  assertEquals(windowKeyProblem(undefined), "key must be a string");
});

Deno.test("frames: saved as the window moves and closes, restored for the bounds a call leaves out", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-windows-" });
  try {
    const first = registry({ appSupportDir: dir });
    const w = first.reg.open({ url: "/a", key: "editor", width: 640, height: 480 });
    const win = FakeWin.made.at(-1)!;
    win.moveTo(100, 120);
    win.resizeTo(800, 600);
    assert(win.userClose());
    const saved = JSON.parse(await Deno.readTextFile(join(dir, WINDOW_STORE_FILE)));
    assertEquals(saved.bounds.editor, { x: 100, y: 120, width: 800, height: 600 });
    assertEquals(first.reg.get(w.id), undefined);

    // The next launch: the saved frame, for the bounds the call leaves out.
    const next = registry({ appSupportDir: dir });
    next.reg.open({ url: "/a", key: "editor" });
    assertEquals(FakeWin.made.at(-1)!.options, { x: 100, y: 120, width: 800, height: 600 });
    next.reg.close(next.reg.byKey("editor")!.id);
    next.reg.open({ url: "/a", key: "editor", width: 300, height: 200 });
    assertEquals(FakeWin.made.at(-1)!.options, { x: 100, y: 120, width: 300, height: 200 });
    next.reg.close(next.reg.byKey("editor")!.id);
    next.reg.open({ url: "/a", key: "editor", restoreBounds: false });
    assertEquals(FakeWin.made.at(-1)!.options, {});
    // Explicit bounds everywhere: nothing restored, nothing clamped.
    next.reg.close(next.reg.byKey("editor")!.id);
    next.reg.open({ url: "/a", key: "editor", x: 5, y: 6, width: 7, height: 8 });
    assertEquals(FakeWin.made.at(-1)!.options, { x: 5, y: 6, width: 7, height: 8 });
    // A window with no key is never saved.
    next.reg.open({ url: "/b" });
    FakeWin.made.at(-1)!.moveTo(9, 9);
    assert(FakeWin.made.at(-1)!.userClose());
    assertEquals(
      Object.keys(JSON.parse(await Deno.readTextFile(join(dir, WINDOW_STORE_FILE))).bounds),
      ["editor"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("frames: a saved frame off every display is clamped onto one; a corrupt store is the defaults", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-windows-" });
  try {
    await Deno.writeTextFile(
      join(dir, WINDOW_STORE_FILE),
      JSON.stringify({
        version: 1,
        bounds: {
          gone: { x: 5000, y: 5000, width: 400, height: 300 },
          big: { x: 0, y: 0, width: 9000, height: 9000 },
          bad: { x: "1", y: 2 },
          "a/b": { x: 1, y: 1, width: 1, height: 1 },
        },
        session: [],
      }),
    );
    const { reg, warnings } = registry({ appSupportDir: dir });
    reg.open({ url: "/a", key: "gone" });
    assertEquals(FakeWin.made.at(-1)!.options, { x: 1040, y: 600, width: 400, height: 300 });
    reg.open({ url: "/a", key: "big" });
    assertEquals(FakeWin.made.at(-1)!.options, { x: 0, y: 0, width: 1440, height: 875 });
    reg.open({ url: "/a", key: "bad" });
    assertEquals(FakeWin.made.at(-1)!.options, {}, "a bad entry was dropped");
    assertEquals(warnings, []);

    await Deno.writeTextFile(join(dir, WINDOW_STORE_FILE), "{ not json");
    const corrupt = registry({ appSupportDir: dir });
    corrupt.reg.open({ url: "/a", key: "gone" });
    assertEquals(FakeWin.made.at(-1)!.options, {});
    assertEquals(corrupt.warnings.length, 1);
    assertStringIncludes(corrupt.warnings[0], "corrupt");
    assertEquals(corrupt.reg.lastSession(), []);

    await Deno.writeTextFile(join(dir, WINDOW_STORE_FILE), "[]");
    assertEquals(registry({ appSupportDir: dir }).warnings.length, 1);
    // Missing: the defaults, quietly.
    await Deno.remove(join(dir, WINDOW_STORE_FILE));
    assertEquals(registry({ appSupportDir: dir }).warnings, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clampToScreens: on a display stays; off every display moves to the nearest; no displays: as is", () => {
  const screens = [
    {
      id: 1,
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
      workArea: { x: 0, y: 20, width: 1000, height: 780 },
      scaleFactor: 1,
      isPrimary: true,
    },
    {
      id: 2,
      bounds: { x: 1000, y: 0, width: 1000, height: 800 },
      workArea: { x: 1000, y: 0, width: 1000, height: 800 },
      scaleFactor: 1,
      isPrimary: false,
    },
  ];
  const on = { x: 900, y: 100, width: 400, height: 300 }; // straddles both: visible
  assertEquals(clampToScreens(on, screens), on);
  const edge = { x: 950, y: 100, width: 400, height: 300 }; // 50 px on the first, enough on the second
  assertEquals(clampToScreens(edge, screens), edge);
  const sliver = { x: -380, y: 100, width: 400, height: 300 }; // 20 px showing: moved
  assertEquals(clampToScreens(sliver, screens), { x: 0, y: 100, width: 400, height: 300 });
  const far = { x: 2500, y: 900, width: 400, height: 300 }; // nearest the second
  assertEquals(clampToScreens(far, screens), { x: 1600, y: 500, width: 400, height: 300 });
  assertEquals(clampToScreens(far, []), far);
});

Deno.test("store: a write that is refused is reported once, and the frames stay in memory", () => {
  const warnings: string[] = [];
  let writes = 0;
  const store = openWindowStore("/nowhere", {
    warn: (m) => void warnings.push(m),
    read: () => {
      throw new Error("missing");
    },
    write: () => {
      writes++;
      throw new Deno.errors.NotCapable("no --allow-write");
    },
  });
  store.setBounds("a", { x: 1, y: 2, width: 3, height: 4 });
  store.flush();
  store.setBounds("b", { x: 1, y: 2, width: 3, height: 4 });
  store.flush();
  assertEquals(writes, 2);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "--allow-write");
  assertEquals(store.bounds("a"), { x: 1, y: 2, width: 3, height: 4 });
  // No folder at all: memory only, never written.
  const memory = openWindowStore(undefined, { warn: () => {} });
  memory.setBounds("a", { x: 1, y: 2, width: 3, height: 4 });
  memory.flush();
  assertEquals(memory.lastSession(), []);
});

Deno.test("session: the keyed windows open at exit, minus the ones the user closed; restoreWindows reopens them", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-windows-" });
  try {
    const first = registry({ appSupportDir: dir });
    const rec = recorder();
    first.reg.lifecycle.addCapabilities([rec.cap]);
    assertEquals(first.reg.lastSession(), []);
    first.reg.open({ url: "/a", key: "left" });
    const right = first.reg.open({ url: "/b", key: "right" });
    first.reg.open({ url: "/c" }); // no key: never in the session
    first.reg.navigate(right.id, "/b2");
    FakeWin.made[1].moveTo(50, 60);
    // The user closes "left"; the quit closes the rest.
    assert(FakeWin.made[1].userClose());
    first.api.quit!();
    await until(() => first.quits.length > 0);

    const next = registry({ appSupportDir: dir });
    assertEquals(next.reg.lastSession(), [{
      key: "right",
      url: "/b2",
      bounds: { x: 1, y: 2, width: 300, height: 200 },
    }]);
    assertEquals(next.reg.byKey("right"), undefined);

    // `desktop.app.restoreWindows` reopens them, keyed, at their frames; one opened already stays.
    FakeWin.made = [];
    const main = new FakeWin();
    const api = quittingApi(() => FakeWin.made).api;
    const s = setUpDesktopWindows({
      window: main,
      BrowserWindow: FakeWin,
      api,
      emit: () => {},
      wantsTray: false,
      appSettings: { restoreWindows: true },
      appSupportDir: dir,
    });
    s.setAppUrl((p) => `app://localhost${p}`);
    assertEquals(s.windows.lastSession().map((w) => w.key), ["right"]);
    assertEquals(s.restoreSession(), 1);
    const reopened = s.windows.byKey("right")!;
    assertEquals([reopened.key, reopened.kind], ["right", "window"]);
    assertEquals(FakeWin.made.at(-1)!.calls, ["navigate:app://localhost/b2"]);
    assertEquals(FakeWin.made.at(-1)!.options, { x: 1, y: 2, width: 300, height: 200 });
    assertEquals(s.restoreSession(), 0, "open already");
    // Off by default.
    const off = setUpDesktopWindows({
      window: new FakeWin(),
      BrowserWindow: FakeWin,
      emit: () => {},
      wantsTray: false,
      appSupportDir: dir,
    });
    assertEquals(off.restoreSession(), 0);
    assertEquals(off.windows.byKey("right"), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("session: a last-session window that cannot be reopened is a warning, not a throw", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-windows-" });
  try {
    await Deno.writeTextFile(
      join(dir, WINDOW_STORE_FILE),
      JSON.stringify({
        version: 1,
        bounds: {},
        session: [{ key: "a", url: "/a" }, { key: "b", url: "/b" }],
      }),
    );
    const warnings: string[] = [];
    const s = setUpDesktopWindows({
      window: new FakeWin(),
      BrowserWindow: FakeWin,
      emit: () => {},
      wantsTray: false,
      appSettings: { restoreWindows: true, maxWindows: 1 },
      appSupportDir: dir,
      warn: (m) => void warnings.push(m),
    });
    assertEquals(s.restoreSession(), 1);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], '"b"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("main window key: desktop.window.key restores the main frame, names it, and holds its key", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-windows-" });
  try {
    await Deno.writeTextFile(
      join(dir, WINDOW_STORE_FILE),
      JSON.stringify({
        version: 1,
        bounds: { workspace: { x: 200, y: 150, width: 1200, height: 800 } },
        session: [{ key: "workspace", url: "/" }],
      }),
    );
    FakeWin.made = [];
    const main = new FakeWin();
    const { api, quits } = quittingApi(() => FakeWin.made);
    const s = setUpDesktopWindows({
      window: main,
      BrowserWindow: FakeWin,
      api,
      emit: () => {},
      wantsTray: false,
      windowSettings: { key: "workspace", width: 1000 },
      appSettings: { restoreWindows: true },
      appSupportDir: dir,
      exit: () => {},
    });
    main.addEventListener("close", (e) => {
      if (s.interceptMainClose(e)) return;
      s.mainClosed();
    });
    s.install();
    // The saved position; the configured width wins over the saved one (a frame on the fake's
    // 1440x875 display is kept as it is).
    assertEquals(main.bounds, { x: 200, y: 150, width: 1000, height: 800 });
    assertEquals(s.windows.get("main")?.key, "workspace");
    assertEquals(s.windows.byKey("workspace")?.id, "main");
    assertEquals(s.lifecycle!.windows(), [{ id: "main", kind: "main", key: "workspace" }]);
    assertEquals(s.restoreSession(), 0, "the main window is open already");
    assertThrows(() => s.windows.open({ url: "/x", key: "workspace" }), Error, "open already");
    // Moved, then the app quits: the frame and the session are saved.
    main.moveTo(300, 200);
    s.lifecycle!.onAppQuit(() => {});
    api.quit!();
    await until(() => quits.length > 0);
    const saved = JSON.parse(await Deno.readTextFile(join(dir, WINDOW_STORE_FILE)));
    assertEquals(saved.bounds.workspace, { x: 300, y: 200, width: 1000, height: 800 });
    assertEquals(saved.session, [{ key: "workspace", url: "/" }]);
    // A bad key is refused where the config is checked.
    assertThrows(
      () => resolveDesktopWindowSettings({ window: { key: "a/b" } }),
      Error,
      "window.key",
    );
    assertEquals(resolveDesktopWindowSettings({ window: { key: "ws" } }), { key: "ws" });
    assertThrows(
      () => validateDenextConfig({ desktop: { window: { key: "" } } } as DenextConfig),
      Error,
      "desktop.window.key",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- maxWindows and the config --------------------------------------------------------------------

Deno.test("maxWindows: the configured most windows replaces the default of 8", () => {
  const { reg } = registry({ maxWindows: 2 });
  reg.open({ url: "/a" });
  reg.open({ url: "/b" });
  let code = "";
  try {
    reg.open({ url: "/c" });
  } catch (err) {
    code = String((err as { code?: unknown }).code);
  }
  assertEquals(code, "validation");
  const caps = reg.capability.methods.capabilities.handler({}, undefined as never) as {
    max: number;
  };
  assertEquals(caps.max, 2);
  assertEquals(MAX_OPEN_WINDOWS, 8);
  assertEquals(MAX_WINDOWS_LIMIT, 64);
  assertEquals(
    (registry().reg.capability.methods.capabilities.handler({}, undefined as never) as {
      max: number;
    }).max,
    8,
  );
});

Deno.test("config: desktop.app.restoreWindows and maxWindows are checked at launch and by the validator", () => {
  assertEquals(resolveDesktopAppSettings({ app: { restoreWindows: true, maxWindows: 12 } }), {
    restoreWindows: true,
    maxWindows: 12,
  });
  assertThrows(
    () => resolveDesktopAppSettings({ app: { restoreWindows: 1 } }),
    Error,
    "app.restoreWindows",
  );
  for (const bad of [0, 65, 2.5, "8", -1]) {
    assertThrows(
      () => resolveDesktopAppSettings({ app: { maxWindows: bad } }),
      Error,
      "app.maxWindows",
    );
  }
  assertEquals(maxWindowsProblem(64), null);
  const validate = (desktop: Record<string, unknown>) =>
    validateDenextConfig({ desktop } as DenextConfig);
  validate({ app: { restoreWindows: true, maxWindows: 64 } });
  assertThrows(
    () => validate({ app: { restoreWindows: "yes" } }),
    Error,
    "desktop.app.restoreWindows",
  );
  assertThrows(() => validate({ app: { maxWindows: 65 } }), Error, "desktop.app.maxWindows");
  assertThrows(() => validate({ app: { maxWindows: 0 } }), Error, "desktop.app.maxWindows");
});

Deno.test("packaging: desktop.app.restoreWindows bakes the app-support folder write", () => {
  const writeOf = (flags: string[]) => flags.filter((f) => f.startsWith("--allow-write"));
  const app = (restoreWindows?: boolean) => ({
    desktop: {
      app: {
        identifier: "com.example.app",
        ...(restoreWindows !== undefined ? { restoreWindows } : {}),
      },
    },
  });
  assertEquals(
    writeOf(desktopBuildFlags(app(), "darwin", { dataScope: true, cacheScope: true })),
    [],
  );
  assertEquals(
    writeOf(desktopBuildFlags(app(true), "darwin", { dataScope: true, cacheScope: true })),
    [`--allow-write=${DESKTOP_DATA_TOKEN}`],
  );
  assertEquals(
    writeOf(desktopBuildFlags(app(true), "linux", { dataScope: false, cacheScope: false })),
    ["--allow-write"],
    "an older runtime: broad",
  );
});
