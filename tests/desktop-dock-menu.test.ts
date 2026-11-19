// The Dock menu and the menu read-back (src/desktop/caps/app.ts, app-windows.ts, app-menus.ts,
// menu-config.ts, native.ts, mobile/quick-actions.ts, desktop/app.ts): the backend's Dock menu
// (`setDockMenu`, `runDesktop({ dockMenu })`) checked and merged before the pages' quick actions,
// colliding ids refused both ways, every click delivered once to the backend's handlers (with no
// window open too) and a page's item to exactly one listening page, `windows.closed()`, the
// application / Dock menu read-back passed through and feature-probed, and the page side's wire —
// against fake runtime windows, a fake `Deno.dock` and the fake bridge.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { DesktopCapability, DesktopCapCtx } from "../src/desktop/extension.ts";
import type { DesktopAppApi, DesktopMenuItem } from "../src/desktop/launch-events.ts";
import type { RegistryWindow } from "../src/desktop/window-registry.ts";
import { noDesktopWindows, setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import { createAppController, type DockLike } from "../src/desktop/caps/app.ts";
import { dockMenuProblem } from "../src/desktop/menu-config.ts";
import { menuSnapshotOf } from "../src/desktop/app-menus.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import type { DesktopExtensionHost } from "../src/desktop/extension.ts";
import { onDesktopDockMenu, setDesktopDockMenu } from "../src/desktop/native.ts";
import { appCapabilities, getAppMenu, getDockMenu } from "../src/desktop/app.ts";
import { setQuickActions } from "../src/mobile/quick-actions.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { isDesktopBridgeError } from "../src/desktop/client.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  type FakeRuntime,
  until,
} from "./helpers/desktop-fake-runtime.ts";
import { withGlobals } from "./helpers/mobile-fakes.ts";

/** A runtime window that can take the focus, close and read its menu back. */
class FakeWin extends EventTarget implements RegistryWindow {
  static made: FakeWin[] = [];
  menu: unknown = null;
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
  setApplicationMenu() {}
  getApplicationMenu() {
    return this.menu;
  }
  /** It took the focus. */
  focused() {
    this.dispatchEvent(new Event("focus"));
  }
  /** The user closed it. */
  userClose(): boolean {
    const event = new Event("close", { cancelable: true });
    this.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

/** What the fake Dock reads back. */
const READ_BACK = [{
  type: "item",
  label: "read back",
  enabled: true,
  checked: false,
  visible: true,
}];

/** A `Deno.dock` with a menu, its read-back, and the user's clicks. */
class FakeDock extends EventTarget implements DockLike {
  menu: DesktopMenuItem[] | null = null;
  sets = 0;
  setBadge() {}
  bounce() {}
  setMenu(menu: DesktopMenuItem[] | null) {
    this.menu = menu;
    this.sets++;
  }
  getMenu(): unknown {
    return this.menu === null ? null : READ_BACK;
  }
  click(id: string) {
    this.dispatchEvent(new CustomEvent("menuclick", { detail: { id } }));
  }
}

const ctx = (windowId: string) => ({ windowId }) as DesktopCapCtx;

/** A desktop setup over fake windows and a fake Dock, wired as runDesktop wires it. */
function setup(options: {
  os?: string;
  dockMenu?: unknown;
  onDockMenuItem?: (id: string, c: { keyWindow: unknown }) => void;
  api?: Partial<DesktopAppApi>;
  dock?: FakeDock | null;
} = {}) {
  FakeWin.made = [];
  const main = new FakeWin();
  const dock = options.dock === null ? undefined : options.dock ?? new FakeDock();
  const warnings: string[] = [];
  const s = setUpDesktopWindows({
    window: main,
    BrowserWindow: FakeWin,
    api: (options.api ?? {}) as DesktopAppApi,
    ...(dock ? { dock } : {}),
    emit: () => {},
    wantsTray: false,
    os: options.os ?? "darwin",
    exit: () => {},
    warn: (m) => void warnings.push(m),
    appSettings: { keepAlive: true },
    windowSettings: { key: "main-key" },
    ...(options.dockMenu !== undefined ? { dockMenu: options.dockMenu as never } : {}),
    ...(options.onDockMenuItem ? { onDockMenuItem: options.onDockMenuItem } : {}),
  });
  main.addEventListener("close", (e) => {
    if (s.interceptMainClose(e)) return;
    s.mainClosed();
  });
  s.install();
  const app = s.capabilities.find((c) => c.name === "app") as DesktopCapability;
  const rpc = (method: string, args: unknown, windowId = "main") =>
    app.methods[method].handler(args, ctx(windowId));
  return { s, main, dock: dock as FakeDock, app, rpc, warnings };
}

Deno.test("dock menu: the backend's items are checked (ids non-empty and unique on every level)", () => {
  const bad: Array<[unknown, string]> = [
    ["nope", "must be an array"],
    [[{ id: "", label: "A" }], "[0].id"],
    [[{ id: "a", label: "" }], "[0].label"],
    [
      [{ id: "a", label: "A" }, { label: "S", submenu: [{ id: "a", label: "A2" }] }],
      "submenu[0].id",
    ],
    [[{ id: "a", label: "A", checked: "yes" }], "[0].checked"],
    [[{ id: "a", label: "A", enabled: 1 }], "[0].enabled"],
    [[{ type: "role" }], "[0].type"],
    [[{ label: "", submenu: [] }], "[0].label"],
    [[{ label: "S", submenu: "x" }], "[0].submenu"],
    [[7], "[0]"],
  ];
  for (const [items, where] of bad) {
    const problem = dockMenuProblem(items);
    assert(problem, `accepted ${JSON.stringify(items)}`);
    assert(`${problem[0]} ${problem[1]}`.includes(where), `${problem} lacks ${where}`);
  }
  let deep: unknown = [{ id: "leaf", label: "L" }];
  for (let i = 0; i < 9; i++) deep = [{ label: `S${i}`, submenu: deep }];
  assert(dockMenuProblem(deep)?.[1].includes("deep"));
  assert(
    dockMenuProblem(Array.from({ length: 501 }, () => ({ type: "separator" })))?.[1]
      .includes("at most"),
  );
  assertEquals(
    dockMenuProblem([
      { id: "a", label: "A", enabled: false, checked: true },
      { type: "separator" },
      { label: "More", submenu: [{ id: "b", label: "B" }] },
    ]),
    null,
  );
});

Deno.test("dock menu: the backend's items, a separator, then the page's; ids may not collide", async () => {
  const { s, dock, rpc } = setup();
  s.appMenus.setDockMenu([
    { id: "new", label: "New", checked: true },
    { type: "separator" },
    { label: "More", submenu: [{ id: "deep", label: "Deep", enabled: false }] },
  ]);
  assertEquals(dock.menu, [
    { item: { label: "New", id: "new", enabled: true, checked: true } },
    "separator",
    {
      submenu: { label: "More", items: [{ item: { label: "Deep", id: "deep", enabled: false } }] },
    },
  ]);
  assertEquals(await rpc("setDockMenu", { menu: [{ id: "page", label: "Page" }] }), {
    applied: true,
  });
  assertEquals(dock.menu!.length, 5);
  assertEquals(dock.menu![3], "separator");
  assertEquals(dock.menu![4], { item: { label: "Page", id: "page", enabled: true } });
  // A page's id the backend uses: refused, the menu unchanged.
  const err = await assertRejects(async () =>
    await rpc("setDockMenu", { menu: [{ id: "deep", label: "X" }] })
  ) as { code?: string; message: string };
  assertEquals(err.code, "validation");
  assertEquals(dock.menu!.length, 5);
  // The backend's id a page uses: refused.
  assertThrows(() => s.appMenus.setDockMenu([{ id: "page", label: "P" }]), Error, "quick action");
  assertThrows(
    () => s.appMenus.setDockMenu([{ id: "", label: "P" }] as never),
    Error,
    "items[0].id",
  );
  // Clearing the backend's leaves the page's alone; clearing both clears the menu.
  s.appMenus.setDockMenu(null);
  assertEquals(dock.menu, [{ item: { label: "Page", id: "page", enabled: true } }]);
  await rpc("setDockMenu", { menu: [] });
  assertEquals(dock.menu, null);
  s.appMenus.setDockMenu([{ id: "solo", label: "Solo" }]);
  assertEquals(dock.menu, [{ item: { label: "Solo", id: "solo", enabled: true } }]);
  s.appMenus.setDockMenu([]);
  assertEquals(dock.menu, null);
});

Deno.test("dock menu: runDesktop({ dockMenu }) is set at launch; a bad one fails it", () => {
  const { dock } = setup({ dockMenu: [{ id: "a", label: "A" }] });
  assertEquals(dock.menu, [{ item: { label: "A", id: "a", enabled: true } }]);
  assertThrows(() => setup({ dockMenu: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }));
  // Off macOS nothing is set, and nothing throws for a good menu.
  const linux = setup({ os: "linux", dockMenu: [{ id: "a", label: "A" }] });
  assertEquals(linux.dock.sets, 0);
});

Deno.test("dock menu: each click reaches the backend once, with no window open too; never a page for its own", async () => {
  const seen: Array<[string, unknown]> = [];
  const { s, main, dock, rpc } = setup({
    dockMenu: [{ id: "own", label: "Own" }],
    onDockMenuItem: (id, c) => void seen.push([`first:${id}`, c.keyWindow]),
  });
  const stop = s.appMenus.onDockMenuItem((id, c) => void seen.push([`sub:${id}`, c.keyWindow]));
  await rpc("subscribeDockMenu", { on: true });
  main.focused();
  dock.click("own");
  assertEquals(seen, [["first:own", { id: "main", key: "main-key" }], [
    "sub:own",
    { id: "main", key: "main-key" },
  ]]);
  // The backend's own item never reaches a page, even one that listens.
  assertEquals(await rpc("take", {}), []);
  // An id in neither menu is nobody's.
  dock.click("stale");
  assertEquals(seen.length, 2);
  stop();
  // A throwing handler is logged, the click still delivered to the rest.
  s.appMenus.onDockMenuItem(() => {
    throw new Error("boom");
  });
  s.appMenus.onDockMenuItem(() => Promise.reject(new Error("later")));
  // Every window closed (the app kept alive): the click still arrives, keyWindow null.
  assert(main.userClose());
  dock.click("own");
  assertEquals(seen.at(-1), ["first:own", null]);
  await new Promise((r) => setTimeout(r, 0));
});

Deno.test("dock menu: a page's quick action reaches exactly one listening page", async () => {
  const seen: string[] = [];
  const { s, main, dock, rpc } = setup({ onDockMenuItem: (id) => void seen.push(id) });
  const a = s.windows.open({ url: "/a", key: "a" });
  const b = s.windows.open({ url: "/b", key: "b" });
  const [, winA, winB] = FakeWin.made;
  await rpc("setDockMenu", { menu: [{ id: "q", label: "Q" }] });
  const take = async (id: string) => await rpc("take", {}, id) as unknown[];
  // Nobody listens: the backend hears it, no page does.
  dock.click("q");
  assertEquals(seen, ["q"]);
  for (const id of ["main", a.id, b.id]) assertEquals(await take(id), []);
  // a and b listen; b is the key window: only b.
  await rpc("subscribeDockMenu", { on: true }, a.id);
  await rpc("subscribeDockMenu", {}, b.id);
  winA.focused();
  winB.focused();
  dock.click("q");
  assertEquals(await take(b.id), [{ source: "dock", id: "q" }]);
  assertEquals(await take(a.id), []);
  // main is key but does not listen: the most recently focused listener (b).
  main.focused();
  dock.click("q");
  assertEquals(await take(b.id), [{ source: "dock", id: "q" }]);
  assertEquals([await take("main"), await take(a.id)], [[], []]);
  // b stops listening: a (focused before it).
  await rpc("subscribeDockMenu", { on: false }, b.id);
  dock.click("q");
  assertEquals(await take(a.id), [{ source: "dock", id: "q" }]);
  // a's page reloads: its listening goes with it; b listens again but never took the focus
  // since closing and reopening: the last listener is chosen.
  await s.capabilities.find((c) => c.name === "app")!.onPageLoad!(a.id);
  await rpc("subscribeDockMenu", { on: true }, b.id);
  assert(winB.userClose());
  dock.click("q");
  assertEquals(await take(a.id), []);
  // No listener left (b closed): only the backend.
  assertEquals(seen.length, 5);
  // A listener never focused at all still gets it.
  const c = s.windows.open({ url: "/c" });
  await rpc("subscribeDockMenu", { on: true }, c.id);
  dock.click("q");
  assertEquals(await take(c.id), [{ source: "dock", id: "q" }]);
});

Deno.test("dock menu: windows.closed() is the reopen list, live; none without a runtime", () => {
  const { s } = setup();
  assertEquals(s.windows.closed(), []);
  s.windows.open({ url: "/one", key: "one" });
  s.windows.open({ url: "/two", key: "two" });
  assert(FakeWin.made[1].userClose());
  assert(FakeWin.made[2].userClose());
  assertEquals(s.windows.closed(), [{ key: "two", url: "/two" }, { key: "one", url: "/one" }]);
  s.windows.forget("two");
  assertEquals(s.windows.closed(), [{ key: "one", url: "/one" }]);
  assertEquals(noDesktopWindows().windows.closed(), []);
});

Deno.test("menu read-back: the window's, the menu bar's and the Dock's, passed through; null without", () => {
  const bar = [{ type: "submenu", label: "File", enabled: true, checked: false, visible: true }];
  const { s, main, dock } = setup({ api: { getApplicationMenu: () => bar } });
  main.menu = [{ type: "item", label: "Main", enabled: true, checked: false, visible: true }];
  assertEquals(s.appMenus.getApplicationMenu(), bar);
  assertEquals(s.appMenus.getApplicationMenu("main"), main.menu);
  assertEquals(s.appMenus.getApplicationMenu("main-key"), main.menu, "by key too");
  assertThrows(() => s.appMenus.getApplicationMenu("nope"), Error, "no open window");
  assertEquals(s.appMenus.getDockMenu(), null);
  s.appMenus.setDockMenu([{ id: "a", label: "A" }]);
  assertEquals(s.appMenus.getDockMenu(), READ_BACK);
  dock.getMenu = () => {
    throw new Error("closed");
  };
  assertEquals(s.appMenus.getDockMenu(), null);
  // A runtime without the read-back: null everywhere.
  const old = setup({ dock: null });
  Object.defineProperty(old.main, "getApplicationMenu", { value: undefined });
  assertEquals(old.s.appMenus.getApplicationMenu(), null);
  assertEquals(old.s.appMenus.getApplicationMenu("main"), null);
  assertEquals(old.s.appMenus.getDockMenu(), null);
  assertEquals(menuSnapshotOf(() => "not a menu"), null);
  // A launch with no windows (a sidecar's child): null, and setDockMenu throws.
  const none = noDesktopWindows();
  assertEquals([none.getApplicationMenu(), none.getDockMenu()], [null, null]);
  assertThrows(() => none.setDockMenu(null));
  none.onDockMenuItem(() => {})();
});

Deno.test("menu read-back: the page's calls and appCapabilities().menuSnapshot follow the runtime", async () => {
  const dock = new FakeDock();
  const win = Object.assign(new EventTarget(), {
    setApplicationMenu() {},
    getApplicationMenu: () => [{ type: "item", label: "W" }],
  });
  const caps = (snapshot?: boolean, w: unknown = win, d: DockLike | undefined = dock) =>
    createAppController({
      window: w,
      api: { menuCapabilities: () => (snapshot === undefined ? {} : { snapshot }) },
      emit: () => {},
      dock: d,
      os: "darwin",
    }).capability;
  const read = async (cap: DesktopCapability) =>
    (await cap.methods.capabilities.handler({}, ctx("main")) as { menuSnapshot: unknown })
      .menuSnapshot;
  assertEquals(await read(caps(true)), true);
  assertEquals(await read(caps(false)), false);
  assertEquals(await read(caps()), "unknown", "the calls exist, the runtime does not say");
  const noReadBack = Object.assign(new EventTarget(), { setBadge() {}, bounce() {} });
  assertEquals(await read(caps(undefined, new EventTarget(), noReadBack)), false);
  const cap = caps(true);
  assertEquals(await cap.methods.getAppMenu.handler({}, ctx("main")), [{
    type: "item",
    label: "W",
  }]);
  // The calling window's own menu (ctx.window), when the bridge names one.
  const other = { getApplicationMenu: () => [{ type: "item", label: "Other" }] };
  assertEquals(
    await cap.methods.getAppMenu.handler({}, { windowId: "w", window: other } as DesktopCapCtx),
    [{ type: "item", label: "Other" }],
  );
  assertEquals(await cap.methods.getDockMenu.handler({}, ctx("main")), null);
  // An extension's host has the same calls; with no app menus wired they answer null / throw.
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "x", methods: {}, setup: (h) => void (host = h) }]);
  assert(host);
  assertEquals([host.getApplicationMenu(), host.getDockMenu()], [null, null]);
  assertThrows(() => host!.setDockMenu([]));
  host.onDockMenuItem(() => {})();
});

// ---------------------------------------------------------------------------------------------
// Page side
// ---------------------------------------------------------------------------------------------

/** Run `fn` against a fake runtime serving `caps`. */
async function inDesktop(
  caps: Record<string, Record<string, FakeMethod>>,
  fn: (rt: FakeRuntime) => Promise<void>,
): Promise<void> {
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  try {
    await fn(rt);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
}

Deno.test("dock menu page: setQuickActions sends separators, submenus, enabled and checked", async () => {
  const menus: unknown[] = [];
  await inDesktop({
    app: { setDockMenu: (a) => (menus.push((a as { menu: unknown }).menu), { applied: true }) },
  }, async () => {
    await setQuickActions([
      { id: "new", title: "New", subtitle: "phone only", icon: "plus", checked: true },
      { type: "separator" },
      { title: "More", submenu: [{ id: "off", title: "Off", enabled: false }] },
    ]);
    await setQuickActions([]);
    await assertRejects(
      () =>
        setQuickActions([{ id: "a", title: "A" }, {
          title: "S",
          submenu: [{ id: "a", title: "B" }],
        }]),
      TypeError,
      "unique",
    );
    await assertRejects(() => setQuickActions([{ title: "", submenu: [] }]), TypeError, "submenu");
    await assertRejects(() => setQuickActions([{ id: "", title: "A" }]), TypeError, "id");
    await assertRejects(() => setQuickActions([{ id: "a", title: "" }]), TypeError, "title");
  });
  assertEquals(menus, [
    [
      { id: "new", label: "New", checked: true },
      "separator",
      { label: "More", children: [{ id: "off", label: "Off", enabled: false }] },
    ],
    null,
  ]);
  assertEquals(await setDesktopDockMenu([]).catch((e) => isDesktopBridgeError(e)), true);
});

Deno.test("dock menu page: on iOS / Android separators are left out and a submenu is refused", async () => {
  const sets: unknown[] = [];
  const plugin = {
    set: (o: unknown) => (sets.push(o), Promise.resolve()),
    clear: () => (sets.push("clear"), Promise.resolve()),
    addListener: () => ({ remove: () => Promise.resolve() }),
  };
  await withGlobals({
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      Plugins: { AppShortcuts: plugin },
    },
  }, async () => {
    await setQuickActions([
      { id: "a", title: "A", checked: true, enabled: false },
      { type: "separator" },
      { id: "b", title: "B" },
    ]);
    await setQuickActions([{ type: "separator" }]);
    await assertRejects(
      () => setQuickActions([{ title: "S", submenu: [{ id: "c", title: "C" }] }]),
      TypeError,
      "Dock menu",
    );
  });
  assertEquals(sets, [{ shortcuts: [{ id: "a", title: "A" }, { id: "b", title: "B" }] }, "clear"]);
});

Deno.test("dock menu page: onQuickAction's listening is announced once, and withdrawn with the last", async () => {
  const subs: unknown[] = [];
  await inDesktop({
    app: {
      subscribeDockMenu: (a) => (subs.push((a as { on: unknown }).on), null),
      take: () => [],
    },
  }, async (rt) => {
    const stop1 = onDesktopDockMenu(() => {});
    const stop2 = onDesktopDockMenu(() => {});
    stop1();
    stop1();
    stop2();
    await rt.settled();
  });
  assertEquals(subs, [true, false]);
});

Deno.test("menu read-back page: getAppMenu / getDockMenu pass the runtime's menu; menuSnapshot parsed", async () => {
  const menu = [{ type: "item", label: "A", enabled: true, checked: false, visible: true }];
  await inDesktop({
    app: {
      getAppMenu: () => menu,
      getDockMenu: () => null,
      capabilities: () => ({ menuSnapshot: true }),
    },
  }, async () => {
    assertEquals(await getAppMenu(), menu);
    assertEquals(await getDockMenu(), null);
    assertEquals((await appCapabilities()).menuSnapshot, true);
  });
  await inDesktop({
    app: { getAppMenu: () => "junk", getDockMenu: () => menu, capabilities: () => ({}) },
  }, async () => {
    assertEquals(await getAppMenu(), null);
    assertEquals(await getDockMenu(), menu);
    assertEquals((await appCapabilities()).menuSnapshot, "unknown");
  });
  // Off desktop: unavailable.
  const err = await assertRejects(() => getAppMenu());
  assert(isDesktopBridgeError(err) && err.code === "unavailable");
  await until(() => true);
});
