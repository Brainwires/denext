// `createOwnedResources` over the real window lifecycle (src/desktop/window-registry.ts,
// window-lifecycle.ts, bridge.ts): an extension's `setup(host)` connects a registry to the host
// the bridge hands it (the host IS a `DesktopExtensionHost`, assignable to the structural
// `OwnedResourcesHost`), a window closed by the user detaches its resource, the window reopened
// with the same key finds and takes it back with the replay, and the app's quit disposes
// everything before the quit goes through — against fake runtime windows and a fake `Deno.desktop`.

import { assert, assertEquals } from "@std/assert";
import type { DesktopCapability, DesktopExtensionHost } from "../src/desktop/extension.ts";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import { createWindowController } from "../src/desktop/caps/window.ts";
import { createWindowRegistry, type RegistryWindow } from "../src/desktop/window-registry.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import { createOwnedResources, type OwnedResourcesHost } from "../src/desktop/owned-resources.ts";

// Type-level: the host an extension's `setup` receives is an `OwnedResourcesHost`, so
// `setup: (host) => resources.connect(host)` type-checks with no cast.
const _hostIsOwnedResourcesHost: (host: DesktopExtensionHost) => OwnedResourcesHost = (host) =>
  host;

/** A runtime window that records what it is told. */
class FakeWin extends EventTarget implements RegistryWindow {
  static made: FakeWin[] = [];
  hidden = false;
  constructor(readonly options?: Record<string, unknown>) {
    super();
    FakeWin.made.push(this);
  }
  bind() {}
  navigate() {}
  show() {
    this.hidden = false;
  }
  hide() {
    this.hidden = true;
  }
  focus() {}
  close() {}
  isVisible() {
    return !this.hidden;
  }
  getBounds() {
    return { x: 0, y: 0, width: 800, height: 600 };
  }
  setBounds() {}
  /** The user closed it (the runtime's cancelable close). */
  userClose(): boolean {
    const event = new Event("close", { cancelable: true });
    this.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

/** A `Deno.desktop` whose `quit()` is the pinned runtime's: beforequit, then every window's close. */
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

/** Wait for `cond`, up to `ms`. */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 2));
  }
}

Deno.test("owned resources over the lifecycle: detach on close, reattach by key, dispose on quit", async () => {
  FakeWin.made = [];
  const main = new FakeWin();
  const { api, quits } = quittingApi(() => FakeWin.made);
  const emitted: Array<[string, string, unknown, string | undefined]> = [];
  const warnings: string[] = [];
  const reg = createWindowRegistry({
    BrowserWindow: FakeWin,
    api,
    appUrl: (path) => `app://localhost${path}`,
    emit: (cap, event, data, target) => void emitted.push([cap, event, data, target]),
    keepAlive: () => false,
    exit: () => {},
    warn: (m) => void warnings.push(m),
    lifecycleTimeouts: { quitMs: 500, guardMs: 500 },
    controller: (window, _id, closed) =>
      createWindowController({ window, api, emit: () => {}, closed }),
  });
  reg.adopt(main, "main");
  main.addEventListener("close", (event) => {
    if (reg.interceptClose("main", event)) return;
    reg.closed("main");
  });
  reg.lifecycle.install();

  // The extension: one "session" per window, kept alive when its window closes.
  const disposed: string[] = [];
  const sessions = createOwnedResources<{ name: string }>({
    onOwnerClosed: "detach",
    replay: { maxBytes: 1024 },
    dispose: async (s) => {
      await new Promise((r) => setTimeout(r, 5));
      disposed.push(s.name);
    },
  });
  const ext: DesktopCapability = {
    name: "sessions",
    events: ["data"],
    methods: {},
    setup: (host) => void sessions.connect(host),
  };
  reg.lifecycle.addCapabilities([ext]);
  createDesktopBridge([ext], { lifecycle: reg.lifecycle });

  // A workspace window with a key, and a session it owns.
  const ws = reg.open({ url: "/ws", key: "ws-1" });
  sessions.add("s1", { name: "shell" }, { owner: ws.id });
  sessions.emit("s1", "data", "hello ");
  assertEquals(sessions.owner("s1"), ws.id);

  // The user closes the window: the session survives, detached, remembering the key.
  assert(FakeWin.made.at(-1)!.userClose());
  await until(() => sessions.detached().length === 1);
  assertEquals(reg.byKey("ws-1"), undefined);
  assertEquals(sessions.owner("s1"), undefined);
  assertEquals(disposed, []);
  sessions.emit("s1", "data", "world"); // while nobody owns it: kept for the replay only

  // The window comes back with the same key: it finds the session and takes it over.
  const again = reg.open({ url: "/ws", key: "ws-1" });
  assertEquals(sessions.ownedBy("ws-1"), ["s1"]);
  const { replay } = sessions.attach("s1", again.id);
  assertEquals(replay, [{ event: "data", data: "hello " }, { event: "data", data: "world" }]);
  assertEquals(sessions.owner("s1"), again.id);

  // The app quits: every window closes, the session is disposed within the bound, then the quit
  // goes through.
  assertEquals(api.quit!(), false, "the last close is held while the hooks run");
  await until(() => quits.length > 0);
  assertEquals(disposed, ["shell"]);
  assertEquals(sessions.ownedBy("ws-1"), []);
  assertEquals(warnings, []);
});
