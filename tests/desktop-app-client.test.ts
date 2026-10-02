// `denext/desktop/app` (page side) and the desktop branch of `setQuickActions` / `onQuickAction`:
// each call goes through the bridge to the `app`, `globalShortcuts` and `launchAtLogin`
// capabilities; clicks and presses are taken from the runtime's queues once per signal and fan out
// to every listener. Driven through the fake runtime gate (tests/helpers/desktop-fake-runtime.ts).

import { assertEquals, assertRejects } from "@std/assert";
import {
  appCapabilities,
  bounce,
  createTray,
  getLaunchAtLogin,
  listShortcuts,
  onAppMenuItem,
  registerShortcut,
  setAppMenu,
  setBadge,
  setLaunchAtLogin,
  unregisterAllShortcuts,
  unregisterShortcut,
} from "../src/desktop/app.ts";
import {
  onQuickAction,
  resetQuickActionsForTesting,
  setQuickActions,
} from "../src/mobile/quick-actions.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";

async function inDesktop(
  caps: Record<string, Record<string, FakeMethod>>,
  fn: (rt: ReturnType<typeof createFakeDesktopRuntime>) => Promise<void>,
): Promise<void> {
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  try {
    await fn(rt);
  } finally {
    resetDesktopBridgeForTesting();
    resetQuickActionsForTesting();
    restore();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("setAppMenu: submenus, roles, accelerators on the wire; onAppMenuItem gets each click once", async () => {
  const queued: unknown[] = [];
  await inDesktop({
    app: {
      setAppMenu: () => null,
      take: () => queued.splice(0),
      capabilities: () => ({ appMenu: true, accelerators: true, tray: true, dockMenu: false }),
    },
  }, async (rt) => {
    await setAppMenu([
      {
        label: "File",
        submenu: [
          { id: "new", label: "New", accelerator: "CommandOrControl+N" },
          "separator",
          { role: "quit" },
        ],
      },
      { id: "help", label: "Help", disabled: true, checked: true, tooltip: "?" },
    ]);
    assertEquals(rt.calls[0].args, {
      menu: [
        {
          label: "File",
          children: [
            { id: "new", label: "New", enabled: true, accelerator: "CommandOrControl+N" },
            "separator",
            { role: "quit" },
          ],
        },
        { id: "help", label: "Help", enabled: false, checked: true, tooltip: "?" },
      ],
    });
    const a: string[] = [];
    const b: string[] = [];
    const stopA = onAppMenuItem((id) => a.push(id));
    const stopB = onAppMenuItem((id) => b.push(id));
    queued.push({ source: "menu", id: "new" }, { source: "dock", id: "ignored-here" });
    rt.emit("app", "action", null);
    await until(() => a.length === 1 && b.length === 1);
    rt.emit("app", "action", null); // a replayed signal: nothing new
    await sleep(30);
    assertEquals([a, b], [["new"], ["new"]]);
    stopA();
    stopB();
    const caps = await appCapabilities();
    assertEquals([caps.appMenu, caps.accelerators, caps.tray, caps.dockMenu, caps.badge], [
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

Deno.test("badge, bounce and trays go to the app capability", async () => {
  const queued: unknown[] = [];
  await inDesktop({
    app: {
      setBadge: () => null,
      bounce: () => null,
      createTray: () => ({ id: "1" }),
      updateTray: () => null,
      destroyTray: () => null,
      trayBounds: () => ({ x: 1, y: 2, width: 3, height: 4 }),
      take: () => queued.splice(0),
    },
  }, async (rt) => {
    await setBadge(3);
    await setBadge(0);
    await bounce({ critical: true });
    const tray = await createTray({
      icon: new Uint8Array([1, 2, 3]),
      tooltip: "Acme",
      menu: [{ id: "show", label: "Show" }],
    });
    await tray.update({ tooltip: null, iconDark: "AAAA" });
    assertEquals(await tray.getBounds(), { x: 1, y: 2, width: 3, height: 4 });
    assertEquals(rt.calls.map((c) => [c.method, c.args]), [
      ["setBadge", { text: "3" }],
      ["setBadge", { text: null }],
      ["bounce", { critical: true }],
      ["createTray", {
        icon: "AQID",
        tooltip: "Acme",
        menu: [{ id: "show", label: "Show", enabled: true }],
      }],
      ["updateTray", { id: "1", tooltip: null, iconDark: "AAAA" }],
      ["trayBounds", { id: "1" }],
    ]);
    const clicks: string[] = [];
    const items: string[] = [];
    const stopClick = tray.onClick((e) => clicks.push(e));
    const stopItem = tray.onMenuItem((id) => items.push(id));
    queued.push(
      { source: "tray", tray: "1", event: "doubleClick" },
      { source: "trayMenu", tray: "1", id: "show" },
      { source: "trayMenu", tray: "2", id: "other-tray" },
    );
    rt.emit("app", "action", null);
    await until(() => clicks.length === 1 && items.length === 1);
    assertEquals([clicks, items], [["doubleClick"], ["show"]]);
    stopClick();
    stopItem();
    await tray.destroy();
  });
});

Deno.test("global shortcuts: register, presses reach the handler, unregister; errors keep their code", async () => {
  const held = new Set<string>();
  const queued: unknown[] = [];
  await inDesktop({
    globalShortcuts: {
      register: (a) => {
        const acc = (a as { accelerator: string }).accelerator;
        if (acc === "Taken") throw { code: "conflict", message: "held by another app" };
        const canonical = acc.replace("CommandOrControl", "Ctrl");
        held.add(canonical);
        return { accelerator: canonical };
      },
      unregister: (a) => ({
        // The runtime takes any spelling.
        removed: held.delete(
          (a as { accelerator: string }).accelerator.replace("CommandOrControl", "Ctrl"),
        ),
      }),
      unregisterAll: () => void held.clear(),
      canonicalize: (a) => ({
        accelerator: (a as { accelerator: string }).accelerator.replace("CommandOrControl", "Ctrl"),
      }),
      list: () => [...held],
      take: () => queued.splice(0),
    },
  }, async (rt) => {
    let pressed = 0;
    const s = await registerShortcut("CommandOrControl+K", () => pressed++);
    assertEquals(s.accelerator, "Ctrl+K");
    assertEquals(await listShortcuts(), ["Ctrl+K"]);
    queued.push({ accelerator: "Ctrl+K" }, { accelerator: "Ctrl+J" });
    rt.emit("globalShortcuts", "pressed", null);
    await until(() => pressed === 1);
    const err = await assertRejects(() => registerShortcut("Taken", () => {}));
    assertEquals((err as { code?: string }).code, "conflict");
    await s.unregister();
    assertEquals(held.size, 0);
    await registerShortcut("CommandOrControl+L", () => {});
    assertEquals(await unregisterShortcut("CommandOrControl+L"), true);
    await registerShortcut("CommandOrControl+M", () => {});
    await unregisterAllShortcuts();
    assertEquals(held.size, 0);
  });
});

Deno.test("launch at login: get / set states", async () => {
  let state = "disabled";
  await inDesktop({
    launchAtLogin: {
      get: () => ({ state }),
      set: (a) => {
        state = (a as { enabled: boolean }).enabled ? "requires-approval" : "disabled";
        return { state };
      },
    },
  }, async () => {
    assertEquals(await getLaunchAtLogin(), "disabled");
    assertEquals(await setLaunchAtLogin(true), "requires-approval");
    state = "bogus";
    assertEquals(await getLaunchAtLogin(), "not-supported");
  });
});

Deno.test("off desktop: every call rejects unavailable without a request", async () => {
  for (const p of [setAppMenu([]), setBadge(1), getLaunchAtLogin(), listShortcuts()]) {
    const err = await assertRejects(() => p);
    assertEquals((err as { code?: string }).code, "unavailable");
  }
  const stop = onAppMenuItem(() => {});
  stop();
});

Deno.test("setQuickActions on desktop: the Dock menu; onQuickAction gets its clicks", async () => {
  const queued: unknown[] = [];
  await inDesktop({
    app: { setDockMenu: () => ({ applied: true }), take: () => queued.splice(0) },
  }, async (rt) => {
    await setQuickActions([{ id: "new-chat", title: "New chat", subtitle: "ignored" }]);
    assertEquals(rt.calls[0].args, { menu: [{ id: "new-chat", label: "New chat" }] });
    await setQuickActions([]);
    assertEquals(rt.calls[1].args, { menu: null });
    const got: string[] = [];
    const stop = onQuickAction((id) => got.push(id));
    queued.push({ source: "dock", id: "new-chat" }, { source: "menu", id: "not-a-quick-action" });
    await sleep(20);
    rt.emit("app", "action", null);
    await until(() => got.length === 1);
    assertEquals(got, ["new-chat"]);
    stop();
  });
});
