// The Deno Desktop branches of the built-in `denext/mobile` capabilities: inside a desktop window
// (`__denext.desktop` + token) each function calls its capability through the bridge; when the
// capability is not enabled (`unavailable`) it keeps its web path; off desktop nothing touches
// the bridge. Driven through the fake runtime gate (tests/helpers/desktop-fake-runtime.ts).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  cancelNotification,
  checkPermission,
  deleteFile,
  deviceInfo,
  downloadToFile,
  listDir,
  moveToTrash,
  onLocalNotificationTapped,
  openExternal,
  openPath,
  openSqlite,
  pendingNotifications,
  pickDocument,
  pickFolder,
  readClipboard,
  readFile,
  requestPermission,
  requestPushPermission,
  revealInFileManager,
  saveFile,
  scheduleNotification,
  secureStore,
  setNotificationCategories,
  showContextMenu,
  writeClipboard,
  writeFile,
} from "../src/mobile/mod.ts";
import { holdAwake } from "../src/mobile/keep-awake.ts";
import { secureStoreIsSecret } from "../src/mobile/secure-store.ts";
import { resetLocalNotificationsForTesting } from "../src/mobile/local-notifications.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { isDesktopBridgeError } from "../src/desktop/client.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";

/** Run `fn` in a fake desktop window with `caps` enabled. */
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
    resetLocalNotificationsForTesting();
    restore();
  }
}

const calls = (rt: ReturnType<typeof createFakeDesktopRuntime>) =>
  rt.calls.map((c) => ({ at: `${c.cap}.${c.method}`, args: c.args }));

Deno.test("secureStore: desktop → the secureStore capability (get/set/delete)", async () => {
  const kv = new Map<string, string>();
  await inDesktop({
    secureStore: {
      get: (a) => kv.get((a as { key: string }).key) ?? null,
      set: (a) => void kv.set((a as { key: string }).key, (a as { value: string }).value),
      delete: (a) => void kv.delete((a as { key: string }).key),
    },
  }, async (rt) => {
    await secureStore.set("refresh", "r1");
    assertEquals(await secureStore.get("refresh"), "r1");
    await secureStore.delete("refresh");
    assertEquals(await secureStore.get("refresh"), null);
    assertEquals(calls(rt)[0], { at: "secureStore.set", args: { key: "refresh", value: "r1" } });
  });
});

Deno.test("secureStore: a biometric-gated value still refuses on desktop (no biometrics)", async () => {
  const kv = new Map<string, string>();
  await inDesktop({
    secureStore: {
      get: (a) => kv.get((a as { key: string }).key) ?? null,
      set: (a) => void kv.set((a as { key: string }).key, (a as { value: string }).value),
    },
  }, async () => {
    await secureStore.set("k", "v", { requireBiometric: true });
    await assertRejects(() => secureStore.get("k"));
  });
});

Deno.test("secureStore: without the capability it falls back (web path) and warns once", async () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => void warnings.push(String(msg));
  try {
    await inDesktop({}, async () => {
      // The web path needs IndexedDB, which Deno lacks: the fallback is taken (and rejects).
      await assertRejects(() => secureStore.get("a"), Error, "IndexedDB");
      await assertRejects(() => secureStore.get("b"), Error, "IndexedDB");
    });
  } finally {
    console.warn = warn;
  }
  const mine = warnings.filter((w) => w.includes('"secureStore"'));
  assertEquals(mine.length, 1, "warns once per capability");
  assert(mine[0].includes("denext desktop add secure-store"));
});

Deno.test("secureStoreIsSecret: the desktop keychain counts, a missing capability does not", async () => {
  await inDesktop({ secureStore: { get: () => null } }, async () => {
    assertEquals(await secureStoreIsSecret(), true);
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await inDesktop({}, async () => {
      assertEquals(await secureStoreIsSecret(), false);
      // ...so a gated value is refused rather than written to browser storage.
      await assertRejects(
        () => secureStore.set("k", "v", { requireBiometric: true }),
        TypeError,
        "requireBiometric needs a secret store",
      );
    });
  } finally {
    console.warn = warn;
  }
  assertEquals(await secureStoreIsSecret(), false, "the web has no secret store");
});

Deno.test("files: desktop → the fs capability with checked relative paths", async () => {
  await inDesktop({
    fs: {
      readFile: () => "hello",
      writeFile: () => null,
      deleteFile: () => null,
      listDir: () => [
        { name: "b.txt", type: "file", size: 3, mtime: 5 },
        { name: "a", type: "directory", size: 0 },
      ],
      download: () => ({ path: "/Users/me/Library/Application Support/app/data/f.pdf" }),
    },
  }, async (rt) => {
    assertEquals(await readFile("notes/a.md"), "hello");
    await writeFile("notes/a.md", "x", { recursive: true, directory: "cache" });
    await deleteFile("notes/a.md");
    assertEquals((await listDir("")).map((e) => e.name), ["a", "b.txt"]);
    assertEquals(
      (await downloadToFile("https://example.com/f.pdf", "f.pdf")).path,
      "/Users/me/Library/Application Support/app/data/f.pdf",
    );
    assertEquals(calls(rt)[0], {
      at: "fs.readFile",
      args: { path: "notes/a.md", directory: "data", encoding: "utf8" },
    });
    assertEquals(calls(rt)[1].args, {
      path: "notes/a.md",
      data: "x",
      directory: "cache",
      encoding: "utf8",
      recursive: true,
    });
    // `..` never reaches the runtime.
    await assertRejects(() => readFile("../etc/passwd"), TypeError);
    assertEquals(rt.calls.length, 5);
  });
});

Deno.test("openSqlite: desktop → the sqlite capability; blobs travel tagged", async () => {
  await inDesktop({
    sqlite: {
      open: () => ({ handle: "h1" }),
      exec: () => null,
      run: () => ({ changes: 1, lastInsertRowId: 9 }),
      query: () => ({ columns: ["id", "blob"], rows: [[1, { $bytes: "AQID" }]] }),
      inTransaction: () => false,
      close: () => null,
    },
  }, async (rt) => {
    const db = await openSqlite("app.db");
    assertEquals(db.backend, "native");
    await db.exec("CREATE TABLE t (id, blob)");
    assertEquals(await db.run("INSERT INTO t VALUES (?, ?)", [1, new Uint8Array([1, 2, 3])]), {
      changes: 1,
      lastInsertRowId: 9,
    });
    const rows = await db.query<{ id: number; blob: Uint8Array }>("SELECT * FROM t");
    assertEquals(rows[0].blob, new Uint8Array([1, 2, 3]));
    assertEquals(await db.inTransaction(), false);
    await db.close();
    await assertRejects(() => db.exec("SELECT 1"));
    const run = rt.calls.find((c) => c.method === "run")!;
    assertEquals(run.args, {
      handle: "h1",
      sql: "INSERT INTO t VALUES (?, ?)",
      params: [1, { $bytes: "AQID" }],
    });
  });
});

Deno.test("showContextMenu: desktop → the native menu at the anchor; falls back to the popover", async () => {
  await inDesktop({ contextMenu: { show: () => ({ id: "open" }) } }, async (rt) => {
    const anchor = { left: 10.4, bottom: 20.6 } as DOMRect;
    const id = await showContextMenu([
      { id: "open", label: "Open", subtitle: "in a tab" },
      { id: "del", label: "Delete", destructive: true, disabled: true },
      {
        id: "move",
        label: "Move to",
        disabled: true,
        children: [{ id: "inbox", label: "Inbox" }],
      },
    ], { anchor, title: "Row" });
    assertEquals(id, "open");
    // Submenus stay nested (the native menu nests); a disabled parent disables its items.
    assertEquals(rt.calls[0].args, {
      items: [
        { id: "open", label: "Open — in a tab", enabled: true },
        { id: "del", label: "Delete", enabled: false },
        { label: "Move to", children: [{ id: "inbox", label: "Inbox", enabled: false }] },
      ],
      x: 10,
      y: 21,
      title: "Row",
    });
  });
  // Without the capability: the in-DOM popover path (no document in Deno → null).
  await inDesktop({}, async () => {
    assertEquals(await showContextMenu([{ id: "a", label: "A" }], { x: 1, y: 2 }), null);
  });
});

Deno.test("openExternal: desktop → shell.openExternal with the vetted href", async () => {
  await inDesktop({ shell: { openExternal: () => null } }, async (rt) => {
    await openExternal("https://denext.dev/docs");
    assertEquals(calls(rt), [{
      at: "shell.openExternal",
      args: { url: "https://denext.dev/docs" },
    }]);
    await assertRejects(() => openExternal("javascript:alert(1)"), TypeError);
    assertEquals(rt.calls.length, 1);
  });
});

Deno.test("shell: openPath / revealInFileManager / moveToTrash on desktop; unavailable elsewhere", async () => {
  await inDesktop(
    { shell: { openPath: () => null, reveal: () => null, trash: () => null } },
    async (rt) => {
      await openPath("/tmp/a.pdf");
      await revealInFileManager("/tmp/a.pdf");
      await moveToTrash("/tmp/a.pdf");
      assertEquals(rt.calls.map((c) => c.method), ["openPath", "reveal", "trash"]);
    },
  );
  const err = await assertRejects(() => openPath("/tmp/a.pdf"));
  assert(isDesktopBridgeError(err));
  assertEquals(err.code, "unavailable");
  await assertRejects(() => moveToTrash(""), TypeError);
});

Deno.test("dialogs: pickDocument / saveFile / pickFolder on desktop", async () => {
  await inDesktop({
    dialogs: {
      openFile: () => ({
        files: [{ name: "a.pdf", mimeType: "application/pdf", size: 3, path: "/x/a.pdf" }],
      }),
      saveFile: () => ({ path: "/Users/me/export.csv", handle: "h-save" }),
      pickFolder: () => ({ path: "/Users/me/Projects/", handle: "h-folder" }),
    },
  }, async (rt) => {
    assertEquals(await pickDocument({ types: ["application/pdf"] }), {
      name: "a.pdf",
      mimeType: "application/pdf",
      size: 3,
      path: "/x/a.pdf",
    });
    assertEquals(await saveFile("a,b", { suggestedName: "export.csv" }), {
      path: "/Users/me/export.csv",
      name: "export.csv",
      handle: "h-save",
    });
    assertEquals(await pickFolder(), {
      path: "/Users/me/Projects/",
      name: "Projects",
      handle: "h-folder",
    });
    assertEquals(rt.calls[0].args, {
      multiple: false,
      readData: false,
      types: ["application/pdf"],
    });
    assertEquals(rt.calls[1].args, { data: "a,b", encoding: "utf8", suggestedName: "export.csv" });
  });
  await inDesktop(
    { dialogs: { openFile: () => ({ files: [] }), pickFolder: () => ({}) } },
    async () => {
      assertEquals(await pickDocument(), null); // cancelled
      assertEquals(await pickFolder(), null);
    },
  );
});

Deno.test("notifications: desktop schedule / cancel / pending / categories / permission", async () => {
  await inDesktop({
    notifications: {
      schedule: () => ({ id: 5 }),
      cancel: () => null,
      pending: () => [{ id: 5, title: "T", body: "B", extra: { path: "/x" } }],
      setCategories: () => null,
      permission: (a) => ({ state: (a as { request: boolean }).request ? "granted" : "prompt" }),
    },
  }, async (rt) => {
    const at = Date.now() + 60_000;
    const id = await scheduleNotification({
      id: 5,
      title: "T",
      body: "B",
      trigger: { type: "date", date: new Date(at) },
      data: { path: "/x" },
      categoryId: "msg",
    });
    assertEquals(id, 5);
    // The input itself (a Date as ms), not the Capacitor schema.
    assertEquals(rt.calls[0].args, {
      id: 5,
      title: "T",
      body: "B",
      data: { path: "/x" },
      categoryId: "msg",
      trigger: { type: "date", date: at },
    });
    await scheduleNotification({
      id: 6,
      title: "D",
      body: "daily",
      trigger: { type: "daily", hour: 9, minute: 30 },
    });
    assertEquals((rt.calls[1].args as { trigger: unknown }).trigger, {
      type: "daily",
      hour: 9,
      minute: 30,
    });
    await scheduleNotification({ id: 8, title: "Q", body: "quiet", silent: true });
    assertEquals(rt.calls[2].args, { id: 8, title: "Q", body: "quiet", silent: true });
    await cancelNotification([5]);
    assertEquals(rt.calls[3].args, { ids: [5] });
    assertEquals(await pendingNotifications(), [
      { id: 5, title: "T", body: "B", data: { path: "/x" } },
    ]);
    await setNotificationCategories([{
      id: "msg",
      actions: [{ id: "reply", title: "Reply", input: { buttonTitle: "Send" } }],
    }]);
    assertEquals(rt.calls.at(-1)!.args, {
      categories: [{ id: "msg", actions: [{ id: "reply", title: "Reply" }] }],
    });
    assertEquals(await checkPermission("notifications"), "prompt");
    assertEquals(await requestPermission("notifications"), "granted");
    assertEquals(await requestPushPermission(), "granted");
  });
});

Deno.test("notifications: desktop clicks reach onLocalNotificationTapped, the launch click first", async () => {
  const queued: unknown[] = [
    { id: 7, actionId: "tap", title: "Hi", data: { path: "/inbox" }, launch: true },
  ];
  await inDesktop({
    notifications: { take: () => queued.splice(0, queued.length) },
  }, async (rt) => {
    const taps: Array<{ id: number; actionId: string; data: unknown }> = [];
    const stop = onLocalNotificationTapped(
      (tap) =>
        taps.push({ id: tap.notification.id, actionId: tap.actionId, data: tap.notification.data }),
      { route: false },
    );
    await until(() => taps.length === 1);
    assertEquals(taps[0], { id: 7, actionId: "tap", data: { path: "/inbox" } });
    // A later click: queued in the runtime, then the payload-free signal.
    queued.push({ id: 7, actionId: "archive", data: {}, launch: false });
    rt.emit("notifications", "tap", null);
    await until(() => taps.length === 2);
    assertEquals(taps[1].actionId, "archive");
    // A replayed signal takes an empty queue: no repeat.
    rt.emit("notifications", "tap", null);
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(taps.length, 2);
    stop();
  });
});

Deno.test("notifications: without the desktop capability a tap listener stays quiet", async () => {
  await inDesktop({}, async () => {
    const taps: unknown[] = [];
    const stop = onLocalNotificationTapped((tap) => taps.push(tap), { route: false });
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(taps, []);
    stop();
  });
});

Deno.test("keep awake: desktop acquires an id and releases it", async () => {
  await inDesktop({
    keepAwake: { acquire: () => ({ id: "w1" }), release: () => null },
  }, async (rt) => {
    const release = holdAwake();
    await until(() => rt.calls.length === 1);
    release();
    await until(() => rt.calls.length === 2);
    assertEquals(calls(rt), [
      { at: "keepAwake.acquire", args: {} },
      { at: "keepAwake.release", args: { id: "w1" } },
    ]);
  });
});

Deno.test("clipboard + deviceInfo: desktop → the runtime", async () => {
  await inDesktop({
    clipboard: { readText: () => "copied", writeText: () => null },
    device: { info: () => ({ os: "darwin", osVersion: "24.6.0" }) },
  }, async (rt) => {
    assertEquals(await readClipboard(), "copied");
    await writeClipboard("hi");
    assertEquals(rt.calls[1].args, { text: "hi" });
    assertEquals(await deviceInfo(), { platform: "web", model: "Macintosh", osVersion: "24.6.0" });
  });
});

Deno.test("off desktop: no bridge request from any capability function", async () => {
  const prev = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (input) => {
    urls.push(String(input));
    return Promise.reject(new Error("offline"));
  };
  try {
    await readClipboard().catch(() => {});
    await deviceInfo();
    await secureStore.get("x").catch(() => {});
    await readFile("a.txt").catch(() => {});
    await pickFolder().catch(() => {});
    holdAwake()();
    assert(!urls.some((u) => u.includes("/_denext/desktop/")), urls.join(","));
  } finally {
    globalThis.fetch = prev;
  }
});
