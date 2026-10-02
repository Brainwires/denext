// The page side of the Deno Desktop capabilities (src/desktop/native.ts) that `denext/mobile`
// calls on desktop: what each call sends over the bridge and how it shapes what comes back — the
// runtime's answer is untrusted JSON, so every malformed shape must degrade to a safe default,
// never a crash or a value of the wrong type. Driven through the fake bridge runtime.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  clipboardFormats,
  clipboardRead,
  clipboardReadFormat,
  clipboardWrite,
  clipboardWriteContent,
  deleteDesktopSqlite,
  desktopDeviceFacts,
  dialogOpenFile,
  dialogPickFolder,
  dialogSaveFile,
  fsDeleteFile,
  fsDownload,
  fsListDir,
  fsReadFile,
  fsWriteFile,
  holdDesktopAwake,
  notifyCancel,
  notifyPending,
  notifyPermission,
  notifySchedule,
  notifySetCategories,
  onDesktopDockMenu,
  onDesktopNotificationTap,
  openDesktopSqlite,
  secureDelete,
  secureGet,
  secureSet,
  setDesktopDockMenu,
  shellOpenExternal,
  shellOpenPath,
  shellReveal,
  shellTrash,
  showNativeContextMenu,
  takeDesktopDeepLinks,
  takeDesktopOpenedFiles,
  warnStorageFallback,
} from "../src/desktop/native.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { isDesktopBridgeError } from "../src/desktop/client.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  type FakeRuntime,
  until,
} from "./helpers/desktop-fake-runtime.ts";

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

/** Every call's args, in order. */
const argsOf = (rt: FakeRuntime) => rt.calls.map((c) => c.args);

Deno.test("native: secure store, files and clipboard degrade a non-string answer to a safe default", async () => {
  await inDesktop({
    secureStore: { get: () => 42 },
    fs: {
      readFile: () => ({ bytes: [1] }),
      listDir: () => [
        { name: "a.txt", type: "file", size: 3, mtime: 1700 },
        { name: "sub", type: "directory" },
        { type: "symlink", size: "big", mtime: "yesterday" },
        null,
      ],
      download: () => ({}),
    },
    clipboard: { readText: () => null, read: () => 7, formats: () => ["text/plain", 3, null] },
  }, async () => {
    assertEquals(await secureGet("k"), null);
    assertEquals(await fsReadFile("a.txt", "data", "utf8"), "");
    assertEquals(await fsListDir("", "data"), [
      { name: "a.txt", type: "file", size: 3, mtime: 1700 },
      { name: "sub", type: "directory", size: 0 },
      { name: "", type: "file", size: 0 },
      { name: "", type: "file", size: 0 },
    ]);
    // The runtime normally answers the absolute path; without one, the requested path stands.
    assertEquals(await fsDownload("https://x.example/f", "dl/f.bin", "cache"), {
      path: "dl/f.bin",
    });
    assertEquals(await clipboardRead(), "");
    assertEquals(await clipboardReadFormat("html"), "");
    assertEquals(await clipboardFormats(), ["text/plain"]);
  });
  await inDesktop(
    { fs: { listDir: () => "nope", download: () => ({ path: "/abs/f.bin" }) } },
    async () => {
      assertEquals(await fsListDir("", "data"), []);
      assertEquals(await fsDownload("https://x.example/f", "f.bin", "cache"), {
        path: "/abs/f.bin",
      });
    },
  );
});

Deno.test("native sqlite: blobs travel tagged both ways; results are shaped; a closed driver refuses", async () => {
  const seen: unknown[] = [];
  await inDesktop({
    sqlite: {
      open: () => ({ handle: "db-1" }),
      exec: (a) => void seen.push(a),
      run: (a) => {
        seen.push(a);
        return { changes: "2", lastInsertRowId: 9 };
      },
      query: (a) => {
        seen.push(a);
        return {
          columns: ["id", 2],
          rows: [[1, "x", { $bytes: btoa("\x01\x02") }, true, null], "not a row"],
        };
      },
      inTransaction: () => "yes",
      close: () => null,
      delete: () => null,
    },
  }, async (rt) => {
    const db = await openDesktopSqlite("app.db");
    assertEquals(db.backend, "native");
    await db.exec("CREATE TABLE t (b BLOB)");
    assertEquals(
      await db.run("INSERT INTO t VALUES (?, ?)", [
        new Uint8Array([255]),
        new Uint8Array([7]).buffer,
      ]),
      { changes: 2, lastInsertRowId: 9 },
    );
    await db.run("UPDATE t SET b = :b", { b: new Uint8Array([1]), n: 3 });
    const rows = await db.query("SELECT * FROM t", []);
    assertEquals(rows.columns, ["id", "2"]);
    assertEquals(rows.rows, [[1, "x", new Uint8Array([1, 2]), null, null], []]);
    assertEquals(await db.inTransaction(), false, "only a literal true");
    assertEquals(seen, [
      { handle: "db-1", sql: "CREATE TABLE t (b BLOB)" },
      {
        handle: "db-1",
        sql: "INSERT INTO t VALUES (?, ?)",
        params: [{ $bytes: btoa("\xff") }, { $bytes: btoa("\x07") }],
      },
      { handle: "db-1", sql: "UPDATE t SET b = :b", params: { b: { $bytes: btoa("\x01") }, n: 3 } },
      { handle: "db-1", sql: "SELECT * FROM t", params: [] },
    ]);
    await db.close();
    await db.close(); // idempotent: one close call
    assertEquals(rt.calls.filter((c) => c.method === "close").length, 1);
    const err = await assertRejects(() => db.query("SELECT 1", []));
    assert(isDesktopBridgeError(err) && err.code === "closed");
    await deleteDesktopSqlite("app.db");
    assertEquals(rt.calls.at(-1), { cap: "sqlite", method: "delete", args: { name: "app.db" } });
  });
  await inDesktop(
    { sqlite: { open: () => ({}), run: () => null, query: () => null } },
    async () => {
      const err = await assertRejects(() => openDesktopSqlite("x.db"));
      assert(isDesktopBridgeError(err) && err.code === "bridge_error");
    },
  );
  await inDesktop({
    sqlite: { open: () => ({ handle: "h" }), run: () => null, query: () => ({}) },
  }, async () => {
    const db = await openDesktopSqlite("x.db");
    assertEquals(await db.run("x", []), { changes: 0, lastInsertRowId: 0 });
    assertEquals(await db.query("x", []), { columns: [], rows: [] });
  });
});

Deno.test("native context menu: subtitles join the label; a disabled submenu disables its children", async () => {
  await inDesktop({
    contextMenu: { show: (a) => ({ id: (a as { items: Array<{ id?: string }> }).items[0].id }) },
  }, async (rt) => {
    const picked = await showNativeContextMenu(
      [
        { id: "copy", label: "Copy", subtitle: "⌘C" },
        {
          id: "share",
          label: "Share",
          disabled: true,
          children: [{ id: "mail", label: "Mail" }, { id: "msg", label: "Messages" }],
        },
        { id: "del", label: "Delete", disabled: true },
      ],
      10.4,
      20.6,
      undefined,
    );
    assertEquals(picked, "copy");
    assertEquals(argsOf(rt)[0], {
      items: [
        { id: "copy", label: "Copy — ⌘C", enabled: true },
        {
          label: "Share",
          children: [
            { id: "mail", label: "Mail", enabled: false },
            { id: "msg", label: "Messages", enabled: false },
          ],
        },
        { id: "del", label: "Delete", enabled: false },
      ],
      x: 10,
      y: 21,
    });
  });
  await inDesktop({ contextMenu: { show: () => ({ id: null }) } }, async (rt) => {
    assertEquals(await showNativeContextMenu([{ id: "a", label: "A" }], 0, 0, "Title"), null);
    assertEquals((argsOf(rt)[0] as { title: string }).title, "Title");
  });
});

Deno.test("native dock menu: actions become the menu, [] clears it; only dock clicks reach the listener", async () => {
  let queue: unknown[] = [];
  await inDesktop({
    app: {
      setDockMenu: (a) => ({ applied: (a as { menu: unknown }).menu !== null }),
      take: () => queue.splice(0),
    },
  }, async (rt) => {
    assertEquals(await setDesktopDockMenu([{ id: "new", title: "New Window" }]), true);
    assertEquals(await setDesktopDockMenu([]), false);
    assertEquals(argsOf(rt).slice(0, 2), [
      { menu: [{ id: "new", label: "New Window" }] },
      { menu: null },
    ]);
    const got: string[] = [];
    const stop = onDesktopDockMenu((id) => got.push(id));
    await until(() => rt.openStreams() === 1);
    queue = [{ source: "menu", id: "prefs" }, { source: "dock", id: "new" }];
    rt.emit("app", "action", null);
    await until(() => got.length === 1);
    assertEquals(got, ["new"]);
    stop();
  });
});

Deno.test("native dialogs: picked files, saved paths and folders are shaped; no handle is an error", async () => {
  await inDesktop({
    dialogs: {
      openFile: () => ({
        files: [{
          name: "a.png",
          mimeType: "",
          size: "1",
          path: "/x/a.png",
          handle: "",
          data: "QQ==",
        }],
      }),
      saveFile: () => ({ path: "C:\\Users\\me\\report.pdf", handle: "h-save" }),
      pickFolder: () => ({ path: "/Users/me/Projects/", handle: "h-dir" }),
    },
  }, async (rt) => {
    assertEquals(await dialogOpenFile(["image/png"], true), {
      name: "a.png",
      mimeType: "application/octet-stream",
      size: 0,
      path: "/x/a.png",
      data: "QQ==",
    });
    assertEquals(await dialogSaveFile("data", "utf8", "report.pdf", []), {
      path: "C:\\Users\\me\\report.pdf",
      name: "report.pdf",
      handle: "h-save",
    });
    assertEquals(await dialogPickFolder(), {
      path: "/Users/me/Projects/",
      name: "Projects",
      handle: "h-dir",
    });
    assertEquals(argsOf(rt).slice(0, 2), [
      { multiple: false, readData: true, types: ["image/png"] },
      { data: "data", encoding: "utf8", suggestedName: "report.pdf" },
    ]);
  });
  await inDesktop({
    dialogs: {
      openFile: () => ({ files: "nope" }),
      saveFile: () => ({ path: "/tmp/out.txt", handle: "" }),
      pickFolder: () => ({ path: "/tmp/dir" }),
    },
  }, async () => {
    assertEquals(await dialogOpenFile(undefined, false), null);
    assertEquals(await dialogSaveFile("d", "base64", undefined, undefined), {
      path: "/tmp/out.txt",
      name: "out.txt",
    });
    const err = await assertRejects(() => dialogPickFolder());
    assert(isDesktopBridgeError(err) && err.code === "bridge_error");
  });
  await inDesktop({ dialogs: { saveFile: () => null, pickFolder: () => ({}) } }, async () => {
    assertEquals(await dialogSaveFile("d", "utf8", undefined, undefined), null, "cancelled");
    assertEquals(await dialogPickFolder(), null, "cancelled");
  });
});

Deno.test("native notifications: a Date trigger travels as a timestamp; answers are shaped", async () => {
  await inDesktop({
    notifications: {
      schedule: () => null,
      pending: () => ({ not: "a list" }),
      permission: () => ({ state: 3 }),
    },
  }, async (rt) => {
    const at = new Date(Date.UTC(2030, 0, 1));
    await notifySchedule({ id: 1, title: "T", body: "B", trigger: { type: "date", date: at } });
    await notifySchedule({
      id: 2,
      title: "T",
      body: "B",
      trigger: { type: "daily", hour: 9, minute: 0 },
    });
    await notifySchedule({ id: 3, title: "T", body: "B" });
    assertEquals(argsOf(rt), [
      { id: 1, title: "T", body: "B", trigger: { type: "date", date: at.getTime() } },
      { id: 2, title: "T", body: "B", trigger: { type: "daily", hour: 9, minute: 0 } },
      { id: 3, title: "T", body: "B" },
    ]);
    assertEquals(await notifyPending(), []);
    assertEquals(await notifyPermission(false), "prompt");
  });
});

Deno.test("native notification taps: parsed, defaulted, malformed ones dropped", async () => {
  let queue: unknown[] = [];
  await inDesktop({ notifications: { take: () => queue.splice(0) } }, async (rt) => {
    const taps: unknown[] = [];
    const stop = onDesktopNotificationTap((t) => taps.push(t));
    await until(() => rt.openStreams() === 1);
    queue = [
      { id: 1, actionId: "reply", title: "Hi", body: "there", data: { thread: 4 }, launch: true },
      { id: 2, data: null, launch: "yes", title: 5 },
      { id: "3" },
      null,
    ];
    rt.emit("notifications", "tap", null);
    await until(() => taps.length === 2);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(taps, [
      { id: 1, actionId: "reply", title: "Hi", body: "there", data: { thread: 4 }, launch: true },
      { id: 2, actionId: "tap", data: {}, launch: false },
    ]);
    stop();
  });
});

Deno.test("native keep awake: released before the runtime answers → the id is released at once", async () => {
  let answer!: (v: unknown) => void;
  await inDesktop({
    keepAwake: {
      acquire: () => new Promise((r) => (answer = r)),
      release: () => null,
    },
  }, async (rt) => {
    const release = holdDesktopAwake(() => {
      throw new Error("must not fall back");
    });
    await until(() => answer !== undefined);
    release();
    release(); // idempotent
    answer({ id: "w-1" });
    await until(() => rt.calls.some((c) => c.method === "release"));
    assertEquals(rt.calls.at(-1)!.args, { id: "w-1" });
    // Held normally: released exactly once, on release.
    const release2 = holdDesktopAwake(() => {});
    await until(() => rt.calls.filter((c) => c.method === "acquire").length === 2);
    answer({ id: "w-2" });
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(rt.calls.filter((c) => c.method === "release").length, 1);
    release2();
    await until(() => rt.calls.filter((c) => c.method === "release").length === 2);
    assertEquals(rt.calls.at(-1)!.args, { id: "w-2" });
  });
});

Deno.test("native keep awake: the page falls back only when the capability is not enabled", async () => {
  await inDesktop({}, async () => {
    let fellBack = 0;
    holdDesktopAwake(() => fellBack++);
    await until(() => fellBack === 1);
    // Released before the refusal arrives: no fallback.
    let late = 0;
    holdDesktopAwake(() => late++)();
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(late, 0);
  });
  await inDesktop({
    keepAwake: {
      acquire: () => {
        throw { code: "internal", message: "inhibitor failed" };
      },
    },
  }, async (rt) => {
    let fellBack = 0;
    holdDesktopAwake(() => fellBack++);
    await until(() => rt.calls.length === 1);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(fellBack, 0, "another failure is not `unavailable`");
  });
});

Deno.test("native device facts: the runtime's model, else one from the OS; unknown OS → no model", async () => {
  for (
    const [answer, expected] of [
      [{ os: "darwin", osVersion: "24.6.0", model: "MacBookPro18,3" }, {
        model: "MacBookPro18,3",
        osVersion: "24.6.0",
      }],
      [{ os: "windows", osVersion: 10 }, { model: "Windows" }],
      [{ os: "linux" }, { model: "Linux" }],
      [{ os: "plan9" }, {}],
      [null, {}],
    ] as const
  ) {
    await inDesktop({ device: { info: () => answer } }, async () => {
      assertEquals(await desktopDeviceFacts(), expected);
    });
  }
});

Deno.test("native deep links / opened files: only well-formed entries; launch only when true", async () => {
  await inDesktop({
    deepLinks: {
      take: () => [{ url: "myapp://a", launch: true }, { url: 3 }, null, { url: "myapp://b" }],
    },
    openFiles: {
      take: () => [
        { handle: "h1", name: "a.txt", path: "/a.txt", launch: true },
        { handle: "", name: "x" },
        { handle: "h2" },
      ],
    },
  }, async () => {
    assertEquals(await takeDesktopDeepLinks(), [
      { url: "myapp://a", launch: true },
      { url: "myapp://b", launch: false },
    ]);
    assertEquals(await takeDesktopOpenedFiles(), [
      { handle: "h1", name: "a.txt", path: "/a.txt", launch: true },
      { handle: "h2", name: "", path: "", launch: false },
    ]);
  });
  await inDesktop(
    { deepLinks: { take: () => null }, openFiles: { take: () => ({}) } },
    async () => {
      assertEquals(await takeDesktopDeepLinks(), []);
      assertEquals(await takeDesktopOpenedFiles(), []);
    },
  );
});

Deno.test("native: write-side calls carry exactly their wire arguments", async () => {
  const ok: FakeMethod = () => null;
  await inDesktop({
    secureStore: { set: ok, delete: ok },
    fs: { writeFile: ok, deleteFile: ok },
    shell: { openExternal: ok, openPath: ok, reveal: ok, trash: ok },
    notifications: { cancel: ok, setCategories: ok },
    clipboard: { writeText: ok, write: ok },
  }, async (rt) => {
    await secureSet("token", "s3cret");
    await secureDelete("token");
    await fsWriteFile("notes/a.txt", "hi", "documents", "utf8", true);
    await fsDeleteFile("notes/a.txt", "documents");
    await shellOpenExternal("https://denext.dev");
    await shellOpenPath({ path: "/tmp/a.pdf" });
    await shellReveal({ handle: "h-1" });
    await shellTrash({ path: "/tmp/old" });
    const ids = [1, 2];
    await notifyCancel(ids);
    await notifySetCategories([
      { id: "msg", actions: [{ id: "reply", title: "Reply" }] },
    ]);
    await clipboardWrite("plain");
    await clipboardWriteContent({ html: "<b>x</b>", text: "x" });
    await clipboardWriteContent({ image: "iVBO" });
    assertEquals(rt.calls.map((c) => [`${c.cap}.${c.method}`, c.args]), [
      ["secureStore.set", { key: "token", value: "s3cret" }],
      ["secureStore.delete", { key: "token" }],
      ["fs.writeFile", {
        path: "notes/a.txt",
        data: "hi",
        directory: "documents",
        encoding: "utf8",
        recursive: true,
      }],
      ["fs.deleteFile", { path: "notes/a.txt", directory: "documents" }],
      ["shell.openExternal", { url: "https://denext.dev" }],
      ["shell.openPath", { path: "/tmp/a.pdf" }],
      ["shell.reveal", { handle: "h-1" }],
      ["shell.trash", { path: "/tmp/old" }],
      ["notifications.cancel", { ids: [1, 2] }],
      ["notifications.setCategories", {
        categories: [{ id: "msg", actions: [{ id: "reply", title: "Reply" }] }],
      }],
      ["clipboard.writeText", { text: "plain" }],
      ["clipboard.write", { text: "x", html: "<b>x</b>" }],
      ["clipboard.write", { image: "iVBO" }],
    ]);
  });
});

Deno.test("warnStorageFallback: warns once per capability, naming the `desktop add` verb", () => {
  const warnings: string[] = [];
  const prev = console.warn;
  console.warn = (m: string) => void warnings.push(m);
  try {
    warnStorageFallback("secureStoreTestOnly");
    warnStorageFallback("secureStoreTestOnly");
    assertEquals(warnings.length, 1);
    assert(warnings[0].includes("`denext desktop add secure-store-test-only`"));
  } finally {
    console.warn = prev;
  }
});
