// The `pty` capability over the real window lifecycle (src/desktop/caps/pty.ts connected through
// the host the bridge hands its `setup`, over src/desktop/window-registry.ts and
// window-lifecycle.ts): the host's `onWindowClosed` / `onAppQuit` / `windows()` are the ones the
// adapter uses, so closing a window kills its terminals under `onWindowClose: "kill"` and detaches
// them under `"detach"` (a window reopened with the same key lists and attaches them), and the
// app's quit disposes them all before the quit goes through — against fake runtime windows, a fake
// `Deno.desktop` and a fake `Deno.openPty`.

import { assert, assertEquals } from "@std/assert";
import type { DesktopCapCtx } from "../src/desktop/extension.ts";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import { createWindowController } from "../src/desktop/caps/window.ts";
import { createWindowRegistry, type RegistryWindow } from "../src/desktop/window-registry.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import {
  type DenoPty,
  type DenoPtyOptions,
  type DenoPtyStatus,
  ptyCapability,
} from "../src/desktop/caps/pty.ts";
import { resolvePtyConfig } from "../src/desktop/pty-config.ts";

/** A runtime window. */
class FakeWin extends EventTarget implements RegistryWindow {
  static made: FakeWin[] = [];
  constructor(readonly options?: Record<string, unknown>) {
    super();
    FakeWin.made.push(this);
  }
  bind() {}
  navigate() {}
  show() {}
  hide() {}
  focus() {}
  close() {}
  isVisible() {
    return true;
  }
  getBounds() {
    return { x: 0, y: 0, width: 800, height: 600 };
  }
  setBounds() {}
  /** The user closed it. */
  userClose(): boolean {
    const event = new Event("close", { cancelable: true });
    this.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

/** A `Deno.desktop` whose `quit()` closes every window like the pinned runtime's. */
function quittingApi(windows: () => readonly EventTarget[]) {
  const quits: number[] = [];
  const api = Object.assign(new EventTarget(), {
    quitOnLastWindowClosed: true,
    screens: () => [],
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
  }) as DesktopAppApi & EventTarget;
  return { api, quits };
}

/** A fake terminal: what the capability did to it. */
interface FakeTerm {
  readonly pty: DenoPty;
  readonly kills: string[];
}

/** A fake `Deno.openPty` whose terminals end on SIGHUP. */
function fakeOpenPty() {
  const terms: FakeTerm[] = [];
  let pid = 100;
  const openPty = (_options: DenoPtyOptions): DenoPty => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
    const writable = new WritableStream<Uint8Array>({ write: () => {} });
    let settle!: (s: DenoPtyStatus) => void;
    const status = new Promise<DenoPtyStatus>((r) => (settle = r));
    let ended = false;
    const kills: string[] = [];
    const pty: DenoPty = {
      pid: ++pid,
      readable,
      writable,
      status,
      resize: () => {},
      kill: (signal = "SIGHUP") => {
        kills.push(signal);
        if (ended) return;
        ended = true;
        try {
          ctl.close();
        } catch { /* closed */ }
        settle({ success: false, code: 129, signal });
      },
    };
    terms.push({ pty, kills });
    return pty;
  };
  return { openPty, terms };
}

const ENV: Record<string, string> = { HOME: "/home/u", SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };

/** A registry with the lifecycle live, the `pty` capability set up through the bridge's host. */
function setup(onWindowClose: "kill" | "detach") {
  FakeWin.made = [];
  const main = new FakeWin();
  const { api, quits } = quittingApi(() => FakeWin.made);
  const reg = createWindowRegistry({
    BrowserWindow: FakeWin,
    api,
    appUrl: (path) => `app://localhost${path}`,
    emit: () => {},
    keepAlive: () => true,
    exit: () => {},
    warn: () => {},
    lifecycleTimeouts: { quitMs: 2000, guardMs: 500 },
    controller: (window, _id, closed) =>
      createWindowController({ window, api, emit: () => {}, closed }),
  });
  reg.adopt(main, "main");
  main.addEventListener("close", (event) => {
    if (reg.interceptClose("main", event)) return;
    reg.closed("main");
  });
  reg.lifecycle.install();
  const fake = fakeOpenPty();
  const cap = ptyCapability({
    config: resolvePtyConfig({ onWindowClose, replayBytes: 65536 }, "linux"),
    os: "linux",
    openPty: fake.openPty,
    env: { get: (k) => ENV[k], toObject: () => ({ ...ENV }) },
    isDirectory: () => Promise.resolve(true),
    readTextFile: () => Promise.resolve(""),
    readLink: () => Promise.resolve("/home/u"),
    flushMs: 5,
    killGraceMs: 50,
    exitGraceMs: 10,
  });
  reg.lifecycle.addCapabilities([cap]);
  createDesktopBridge([cap], { lifecycle: reg.lifecycle });
  const ctx = (windowId: string): DesktopCapCtx => ({
    emit: () => {},
    appSupportDir: "",
    runOnMainThread: () => Promise.reject(new Error("no UI thread")),
    pickedPath: () => {
      throw new Error("no picked paths");
    },
    os: "linux",
    windowId,
    signal: new AbortController().signal,
  });
  const call = (method: string, args: unknown, windowId: string) =>
    Promise.resolve().then(() => cap.methods[method].handler(args, ctx(windowId)));
  return { reg, main, api, quits, terms: fake.terms, call };
}

/** Wait for `cond`, up to `ms`. */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 2));
  }
}

Deno.test('pty over the lifecycle: closing a window kills its terminals under "kill"; a quit kills them all', async () => {
  const { reg, call, terms, api, quits } = setup("kill");
  const w = reg.open({ url: "/term", key: "t1" });
  const a = await call("spawn", { cols: 80, rows: 24 }, w.id) as { id: string };
  const b = await call("spawn", { cols: 80, rows: 24 }, "main") as { id: string };
  assertEquals(terms.length, 2);
  // The user closes the window: its terminal is killed (the host's onWindowClosed is wired);
  // the main window's is not.
  assert(FakeWin.made.at(-1)!.userClose());
  await until(() => terms[0].kills.length > 0);
  assertEquals(terms[0].kills, ["SIGHUP"]);
  assertEquals(terms[1].kills, []);
  const listed = await call("list", {}, "main") as { id: string }[];
  assertEquals(listed.map((t) => t.id), [b.id]);
  assert(!listed.some((t) => t.id === a.id));
  // The app quits: every terminal is killed before the quit goes through (onAppQuit is wired).
  assertEquals(api.quit!(), false, "the last close is held while the terminals end");
  await until(() => quits.length > 0);
  assertEquals(terms[1].kills, ["SIGHUP"]);
});

Deno.test('pty over the lifecycle: under "detach" a closed window\'s terminals survive for the key that reopens', async () => {
  const { reg, call, terms, api, quits } = setup("detach");
  const w = reg.open({ url: "/term", key: "t1" });
  const spawned = await call("spawn", { cols: 80, rows: 24 }, w.id) as { id: string };
  assert(FakeWin.made.at(-1)!.userClose());
  await until(() => reg.byKey("t1") === undefined);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(terms[0].kills, [], "detached, not killed");
  // The window comes back with the same key (the host's windows() gave the adapter the key): it
  // lists the detached terminal and attaches it.
  const again = reg.open({ url: "/term", key: "t1" });
  const listed = await call("list", {}, again.id) as { id: string; detached: boolean }[];
  assertEquals(listed.map((t) => [t.id, t.detached]), [[spawned.id, true]]);
  const attached = await call("attach", { id: spawned.id }, again.id) as { replay?: unknown };
  assert(attached !== undefined);
  const mine = await call("list", {}, again.id) as { id: string; detached: boolean }[];
  assertEquals(mine.map((t) => t.detached), [false]);
  // The quit disposes it whatever the policy.
  assertEquals(api.quit!(), false);
  await until(() => quits.length > 0);
  assertEquals(terms[0].kills, ["SIGHUP"]);
});
