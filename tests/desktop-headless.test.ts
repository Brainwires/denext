// Headless runs (src/desktop/headless.ts): `DENEXT_DESKTOP_HEADLESS=1` / `denext desktop run
// --headless` keep every window of the app hidden while its pages run. Proved on fakes — no window
// is ever created on the machine running the tests: the main window is hidden when the windows
// are set up, a window opened later is created with `show: false`, nothing (a page's `show` /
// `focus`, the Dock's reopen, a `desktop.ts` ref) can show or focus one, the Dock gets no icon or
// bounce, and `desktop run --headless` launches with the switch and the accessory policy.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DESKTOP_HEADLESS_ENV,
  desktopHeadless,
  desktopHeadlessLaunchEnv,
  headlessDock,
  headlessWindow,
  headlessWindowConstructor,
} from "../src/desktop/headless.ts";
import { setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import type { DesktopCapCtx } from "../src/desktop/extension.ts";
import { DESKTOP_RUNTIME_ENV } from "../src/build/desktop-runtime-env.ts";
import { desktopCommand } from "../src/cli/commands/desktop.ts";
import type { CommandContext } from "../src/cli/command.ts";

/** A fake `BrowserWindow` recording every call that could put it on screen. */
class FakeWin extends EventTarget {
  static made: FakeWin[] = [];
  calls: string[] = [];
  visible = true;
  constructor(readonly options?: Record<string, unknown>) {
    super();
    this.visible = options?.show !== false;
    FakeWin.made.push(this);
  }
  bind() {}
  navigate(url: string) {
    this.calls.push(`navigate ${url}`);
  }
  show() {
    this.visible = true;
    this.calls.push("show");
  }
  hide() {
    this.visible = false;
    this.calls.push("hide");
  }
  focus() {
    this.calls.push("focus");
  }
  maximize() {
    this.calls.push("maximize");
  }
  restore() {
    this.calls.push("restore");
  }
  setFullScreen(on: boolean) {
    this.calls.push(`setFullScreen ${on}`);
  }
  close() {
    this.calls.push("close");
  }
  isVisible() {
    return this.visible;
  }
}

/** A fake `Deno.dock`. */
class FakeDock extends EventTarget {
  calls: string[] = [];
  setBadge() {}
  bounce(critical?: boolean) {
    this.calls.push(`bounce ${critical === true}`);
  }
  setVisible(visible: boolean) {
    this.calls.push(`setVisible ${visible}`);
  }
  setActivationPolicy(policy: string) {
    this.calls.push(`setActivationPolicy ${policy}`);
    return true;
  }
}

/** The calls that would show, raise or activate a window. */
const SURFACING = /^(show|focus|maximize|restore|setFullScreen)/;

Deno.test("desktopHeadless: 1 or true turns it on; anything else (or nothing) does not", () => {
  for (const on of ["1", "true", "TRUE", " 1 "]) assert(desktopHeadless(on), on);
  for (const off of [undefined, "", "0", "false", "yes"]) assert(!desktopHeadless(off), `${off}`);
  assertEquals(DESKTOP_HEADLESS_ENV, "DENEXT_DESKTOP_HEADLESS");
  // A strict app's scoped --allow-env lets runDesktop read it.
  assert(DESKTOP_RUNTIME_ENV.includes(DESKTOP_HEADLESS_ENV));
});

Deno.test("headlessWindow: hidden at once; show, focus, maximize, restore, full screen do nothing", () => {
  const win = new FakeWin();
  assertEquals(headlessWindow(win), win, "the same window, changed in place");
  assertEquals(win.calls, ["hide"]);
  win.show();
  win.focus();
  win.maximize();
  win.restore();
  win.setFullScreen(true);
  win.navigate("app://localhost/");
  assertEquals(win.calls, ["hide", "navigate app://localhost/"]);
  assert(!win.isVisible());
  headlessWindow(win); // once only
  assertEquals(win.calls.filter((c) => c === "hide").length, 1);
  assertEquals(headlessWindow(undefined), undefined);
});

Deno.test("headlessWindowConstructor: every window is created with show: false and stays hidden", () => {
  FakeWin.made = [];
  const Ctor = headlessWindowConstructor(FakeWin);
  const w = new Ctor({ url: "/panel", show: true, width: 300 });
  assert(w instanceof FakeWin, "instanceof still holds");
  assertEquals(w.options, { url: "/panel", show: false, width: 300 });
  w.show();
  w.focus();
  assertEquals(w.calls.filter((c) => SURFACING.test(c)), []);
  assertEquals(Ctor.prototype, FakeWin.prototype);
  assertEquals(FakeWin.made.length, 1);
});

Deno.test("headlessDock: accessory at once; no bounce, no icon, no other policy", () => {
  const dock = new FakeDock();
  headlessDock(dock);
  assertEquals(dock.calls, ["setActivationPolicy accessory"]);
  dock.bounce(true);
  assertEquals(dock.setActivationPolicy("regular"), false);
  dock.setVisible(true);
  assertEquals(dock.setActivationPolicy("accessory"), true);
  dock.setVisible(false);
  assertEquals(dock.calls, [
    "setActivationPolicy accessory",
    "setActivationPolicy accessory",
    "setVisible false",
  ]);
  // A runtime without the policy hides the icon instead.
  const old = Object.assign(new EventTarget(), {
    calls: [] as string[],
    setVisible(v: boolean) {
      this.calls.push(`setVisible ${v}`);
    },
  });
  headlessDock(old);
  assertEquals(old.calls, ["setVisible false"]);
});

/** A handler context for the `window` capability, as the main window's page calls it. */
const ctx = { windowId: "main", emit: () => {} } as unknown as DesktopCapCtx;

Deno.test("setUpDesktopWindows({ headless }): no window of the app is ever shown or focused", async () => {
  FakeWin.made = [];
  const main = new FakeWin();
  const dock = new FakeDock();
  const s = setUpDesktopWindows({
    window: main,
    BrowserWindow: FakeWin,
    dock,
    os: "darwin",
    emit: () => {},
    wantsTray: false,
    appSettings: { keepAlive: true, activationPolicy: "regular", dock: "while-window-open" },
    headless: true,
  });
  s.install();
  assertEquals(main.calls, ["hide"], "the main window is hidden when the windows are set up");
  assert(dock.calls.includes("setActivationPolicy accessory"));

  // A page asks for its window to come forward.
  const windowCap = s.capabilities.find((c) => c.name === "window")!;
  for (const m of ["show", "focus", "maximize", "restore"]) {
    await windowCap.methods[m]?.handler({}, ctx);
  }
  try {
    await windowCap.methods.setFullScreen?.handler({ fullScreen: true }, ctx);
  } catch { /* a validation error is fine: it must not show the window either */ }

  // desktop.ts opens windows, asks them to show, and the Dock is clicked.
  const opened = s.windows.open({ url: "/second", show: true } as never);
  s.windows.get(opened.id)?.show();
  s.windows.get(opened.id)?.focus();
  dock.dispatchEvent(new CustomEvent("reopen", { detail: { hasVisibleWindows: false } }));
  await s.app?.capability.methods.bounce?.handler({ critical: true }, ctx);

  for (const w of FakeWin.made) {
    assertEquals(w.calls.filter((c) => SURFACING.test(c)), [], `window ${w.options?.url}`);
    assert(!w.isVisible(), "never visible");
  }
  const second = FakeWin.made.find((w) => w !== main)!;
  assertEquals(second.options?.show, false, "created hidden");
  assert(second.calls.some((c) => c.startsWith("navigate")), "its page still loads");
  assert(!dock.calls.some((c) => c.startsWith("bounce")), "no Dock bounce");
  assert(!dock.calls.includes("setActivationPolicy regular"), "no Dock icon");
});

Deno.test("setUpDesktopWindows without headless still shows what it is asked to", () => {
  FakeWin.made = [];
  const main = new FakeWin();
  const dock = new FakeDock();
  const s = setUpDesktopWindows({ window: main, dock, emit: () => {}, wantsTray: false });
  s.install();
  main.visible = false;
  dock.dispatchEvent(new CustomEvent("reopen", { detail: { hasVisibleWindows: false } }));
  assertEquals(main.calls, ["show", "focus"]);
});

/** Run `denext desktop <positionals>` in `dir` with `flags`; its exit code and stderr. */
async function runVerb(positionals: string[], dir: string, flags: Record<string, unknown>) {
  const errs: string[] = [];
  const prevErr = console.error;
  const prevExit = Deno.exit;
  let code = 0;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  (Deno as { exit: (c?: number) => never }).exit = ((c?: number) => {
    code = c ?? 0;
    throw new Error("__exit__");
  }) as never;
  try {
    await desktopCommand.run({
      positionals,
      flags,
      global: { cwd: dir },
      rest: [],
    } as unknown as CommandContext);
  } catch (e) {
    if (!String(e).includes("__exit__")) throw e;
  } finally {
    console.error = prevErr;
    (Deno as { exit: typeof prevExit }).exit = prevExit;
  }
  return { code, err: errs.join("\n") };
}

Deno.test("denext desktop --headless: run only; the launch env carries the switch and the accessory policy", async () => {
  assertEquals(desktopHeadlessLaunchEnv(), {
    DENEXT_DESKTOP_HEADLESS: "1",
    LAUFEY_ACTIVATION_POLICY: "accessory",
  });
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_headless_" });
  try {
    const out = await runVerb(["build"], dir, { headless: true });
    assertEquals(out.code, 1);
    assertStringIncludes(out.err, "--headless applies to `denext desktop run` only");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
