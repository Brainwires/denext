// `runDesktop` with the desktop windowing settings, against a fake pinned runtime: the hidden,
// kept-alive main window with no Dock icon, the backend tray made from the export's icon with its
// panel registered as a window, pages told to ask for their window token, `openWindow` through the
// bridge, and a page's `window.close()` closing its own window.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { boot, exportDir, get, pageRpc, TOKEN_HEADER } from "./helpers/desktop-run-boot.ts";

/** A pinned-runtime window with bindings, navigation and the overlay setters. */
class Win extends EventTarget {
  static made: Win[] = [];
  bindings = new Map<string, () => unknown>();
  calls: string[] = [];
  visible = true;
  constructor(readonly options?: Record<string, unknown>) {
    super();
    Win.made.push(this);
  }
  bind(name: string, fn: () => unknown) {
    this.bindings.set(name, fn);
  }
  navigate(url: string) {
    this.calls.push(`navigate ${url}`);
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {}
  close() {
    this.calls.push("close");
  }
  isVisible() {
    return this.visible;
  }
  getBounds() {
    return { x: 0, y: 0, width: 800, height: 600 };
  }
  setAlwaysOnTop(...args: unknown[]) {
    this.calls.push(`setAlwaysOnTop ${JSON.stringify(args)}`);
  }
}

/** A tray with a panel (`Tray.attachPanel`) whose window is a {@linkcode Win}. */
class Tray extends EventTarget {
  static made: Tray[] = [];
  icon?: Uint8Array;
  constructor() {
    super();
    Tray.made.push(this);
  }
  setIcon(png: Uint8Array) {
    this.icon = png;
  }
  setTooltip() {}
  setMenu() {}
  getBounds() {
    return null;
  }
  destroy() {}
  attachPanel() {
    const window = new Win();
    let visible = false;
    return {
      window,
      get visible() {
        return visible;
      },
      show: () => void (visible = true),
      hide: () => void (visible = false),
      toggle: () => void (visible = !visible),
    };
  }
}

class Dock extends EventTarget {
  visible: boolean[] = [];
  setBadge() {}
  bounce() {}
  setVisible(v: boolean) {
    this.visible.push(v);
  }
}

Deno.test("runDesktop: a kept-alive, Dock-less app with a backend tray, its panel and more windows", async () => {
  Win.made = [];
  Tray.made = [];
  const outDir = await exportDir();
  await Deno.writeFile(join(outDir, "tray.png"), new Uint8Array([137, 80, 78, 71]));
  const exits: number[] = [];
  const desktop = Object.assign(new EventTarget(), {
    quit: () => true,
    launchUrls: [],
    quitOnLastWindowClosed: true,
  });
  const dock = new Dock();
  try {
    const { runtime, served } = await boot({
      outDir,
      port: 1,
      app: { keepAlive: true, dock: false },
      window: { alwaysOnTop: "status" },
      configTray: {
        icon: "/tray.png",
        panel: { url: "/panel", width: 300, height: 400, hideOnBlur: true },
      },
    }, {
      deno: {
        BrowserWindow: Win,
        Tray,
        dock,
        desktop,
        exit: (code: number) => void exits.push(code),
      },
    });
    const main = Win.made[0];
    assertEquals(desktop.quitOnLastWindowClosed, false, "kept alive");
    assertEquals(main.calls, ['setAlwaysOnTop [true,"status"]']);
    if (Deno.build.os === "darwin") assertEquals(dock.visible, [false]);
    // The tray from the export's icon, its panel a registered window that loads the panel page.
    assert(runtime.tray);
    assertEquals([...Tray.made[0].icon!], [137, 80, 78, 71]);
    const panel = Win.made[1];
    assert(panel.bindings.has("__denextWindow"));
    assertEquals(panel.calls, ["navigate http://127.0.0.1:8000/panel"]);
    assertEquals(runtime.windows.list().map((w) => w.id), ["main", "panel"]);
    // The page is told to ask for its window token; its window's binding answers it.
    const html = await (await served.handler(get("http://127.0.0.1:1/"), {})).text();
    assert(html.includes('"windows":true'));
    const token = /"token":"([^"]+)"/.exec(html)![1];
    const rpc = pageRpc(served, token);
    assertEquals((await rpc("app", "backendTray")).data, { id: "app" });
    const opened = await rpc("windows", "open", { url: "/settings", width: 400 });
    const id = (opened.data as { id: string }).id;
    assertEquals(id, "window-1");
    assertEquals(runtime.windows.get(id)?.kind, "window");
    // The opened window's page closes itself: its window token names it.
    const windowToken = await Win.made[2].bindings.get("__denextWindow")!() as string;
    const quit = await served.handler(
      new Request("http://127.0.0.1:1/_denext/desktop/quit", {
        method: "POST",
        headers: {
          [TOKEN_HEADER]: token,
          origin: "http://127.0.0.1:1",
          "x-denext-desktop-window": windowToken,
        },
      }),
      {},
    );
    assertEquals(quit.status, 204);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(runtime.windows.get(id), undefined);
    assert(Win.made[2].calls.includes("close"));
    // Closing the main window leaves the kept-alive app running.
    main.dispatchEvent(new Event("close", { cancelable: true }));
    assertEquals(exits, []);
    assertEquals(runtime.setDockVisible(true), Deno.build.os === "darwin");
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});
