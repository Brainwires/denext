// The built-in Deno Desktop capabilities (`src/desktop/caps/**`) and the config→caps resolver.
// Handlers are called directly with a fake DesktopCapCtx; the security-critical fs path-scoping
// gets dedicated `..` / absolute / symlink-escape cases (the peer's e2e proves the wire).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type {
  DesktopCapability,
  DesktopCapCtx,
  DesktopPermissions,
} from "../src/desktop/extension.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";
import {
  DESKTOP_CAPABILITIES,
  type DesktopOs,
  desktopPermissionFlags,
} from "../src/build/desktop-capabilities.ts";
import { deviceCapability } from "../src/desktop/caps/device.ts";
import { echoCapability } from "../src/desktop/caps/echo.ts";
import { checkDownloadUrl, fsCapability, isRefusedDownloadHost } from "../src/desktop/caps/fs.ts";
import { sqliteCapability } from "../src/desktop/caps/sqlite.ts";
import {
  isExecutableOpenTarget,
  openPathRefusal,
  runShellTool,
  SHELL_PATH_ENV,
  shellCapability,
  shellPathCommand,
  shellPathEnv,
} from "../src/desktop/caps/shell.ts";
import { keepAwakeCapability } from "../src/desktop/caps/keep-awake.ts";
import {
  runSecureCli as realSecureRun,
  type SecureRunner,
  secureStoreCapability,
  secureStoreCommand,
} from "../src/desktop/caps/secure-store.ts";
import { passkeysCapability } from "../src/desktop/caps/passkeys.ts";
import { clipboardCapability } from "../src/desktop/caps/clipboard.ts";
import { notificationsCapability } from "../src/desktop/caps/notifications.ts";
import { contextMenuCapability } from "../src/desktop/caps/context-menu.ts";
import { shortcutsCapability } from "../src/desktop/caps/shortcuts.ts";
import { launchAtLoginCapability } from "../src/desktop/caps/launch-at-login.ts";
import { PickedPaths } from "../src/desktop/picked-paths.ts";
import { isReservedDataName, refuseReservedDataPath } from "../src/desktop/path-scope.ts";
import {
  DIALOG_NAME_ENV,
  dialogsCapability,
  sanitizeSuggestedName,
} from "../src/desktop/caps/dialogs.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";
import type { DesktopAppDirs } from "../src/desktop/app-dirs.ts";
import { withDenoProps } from "./helpers/deno-stub.ts";

const OS = Deno.build.os as "darwin" | "windows" | "linux";

function ctx(overrides: Partial<DesktopCapCtx> = {}): DesktopCapCtx {
  return {
    emit: () => {},
    appSupportDir: "",
    runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
    os: OS,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Call a capability method's handler by name, always via a promise (as the bridge dispatches). */
// deno-lint-ignore no-explicit-any
function call(cap: { methods: Record<string, any> }, method: string, args: unknown, c = ctx()) {
  return Promise.resolve().then(() => cap.methods[method].handler(args, c));
}

// --- device ------------------------------------------------------------------

Deno.test("device.info returns only os/model/osVersion, nothing identifying", async () => {
  const out = await call(deviceCapability, "info", {}) as Record<string, unknown>;
  assertEquals(out.os, OS);
  assertEquals(out.model, { darwin: "Macintosh", windows: "Windows", linux: "Linux" }[OS]);
  // Only these keys — never hostname, user, arch, memory, network, etc.
  assert(
    Object.keys(out).every((k) => k === "os" || k === "model" || k === "osVersion"),
    `device.info leaked keys: ${Object.keys(out).join(",")}`,
  );
});

// --- fs ----------------------------------------------------------------------

async function fsFixture(): Promise<
  { dirs: DesktopAppDirs; root: string; cleanup: () => Promise<void> }
> {
  const root = await Deno.makeTempDir({ prefix: "denext-fs-cap-" });
  const dirs: DesktopAppDirs = {
    data: join(root, "data"),
    cache: join(root, "cache"),
    documents: join(root, "documents"),
  };
  for (const d of Object.values(dirs)) await Deno.mkdir(d, { recursive: true });
  return { dirs, root, cleanup: () => Deno.remove(root, { recursive: true }) };
}

Deno.test("fs: write then read round-trips (utf8 and base64)", async () => {
  const { dirs, cleanup } = await fsFixture();
  try {
    const fs = fsCapability({ dirs, read: new Set(["$APPDATA"]), write: new Set(["$APPDATA"]) });
    await call(fs, "writeFile", {
      path: "note.txt",
      data: "hello",
      directory: "data",
      encoding: "utf8",
    });
    assertEquals(
      await call(fs, "readFile", { path: "note.txt", directory: "data", encoding: "utf8" }),
      "hello",
    );
    // base64 round-trip (bytes 1,2,3 → "AQID")
    await call(fs, "writeFile", {
      path: "b.bin",
      data: "AQID",
      directory: "data",
      encoding: "base64",
    });
    assertEquals(
      await call(fs, "readFile", { path: "b.bin", directory: "data", encoding: "base64" }),
      "AQID",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("fs: recursive write creates parent dirs; listDir reports entries", async () => {
  const { dirs, cleanup } = await fsFixture();
  try {
    const fs = fsCapability({ dirs, read: new Set(["$APPDATA"]), write: new Set(["$APPDATA"]) });
    await call(fs, "writeFile", {
      path: "sub/deep/f.txt",
      data: "x",
      directory: "data",
      encoding: "utf8",
      recursive: true,
    });
    const listing = await call(fs, "listDir", { path: "sub", directory: "data" }) as Array<
      Record<string, unknown>
    >;
    assertEquals(listing.map((e) => e.name), ["deep"]);
    assertEquals(listing[0].type, "directory");
    // "" lists the directory's root (the page's listDir("") sends "", never ".").
    const root = await call(fs, "listDir", { path: "", directory: "data" }) as Array<
      Record<string, unknown>
    >;
    assertEquals(root.map((e) => e.name), ["sub"]);
  } finally {
    await cleanup();
  }
});

Deno.test("fs: deleteFile removes a file and is idempotent", async () => {
  const { dirs, cleanup } = await fsFixture();
  try {
    const fs = fsCapability({ dirs, read: new Set(["$APPDATA"]), write: new Set(["$APPDATA"]) });
    await call(fs, "writeFile", {
      path: "gone.txt",
      data: "x",
      directory: "data",
      encoding: "utf8",
    });
    await call(fs, "deleteFile", { path: "gone.txt", directory: "data" });
    await call(fs, "deleteFile", { path: "gone.txt", directory: "data" }); // no throw on missing
    assertEquals(await call(fs, "listDir", { path: ".", directory: "data" }), []);
  } finally {
    await cleanup();
  }
});

Deno.test("fs SECURITY: `..` traversal is refused", async () => {
  const { dirs, cleanup } = await fsFixture();
  try {
    const fs = fsCapability({ dirs, read: new Set(["$APPDATA"]), write: new Set(["$APPDATA"]) });
    const err = await assertRejects(
      () => call(fs, "readFile", { path: "../../etc/passwd", directory: "data", encoding: "utf8" }),
      DesktopCapError,
    );
    assertEquals(err.code, "forbidden");
  } finally {
    await cleanup();
  }
});

Deno.test("fs SECURITY: an absolute path is refused", async () => {
  const { dirs, cleanup } = await fsFixture();
  try {
    const fs = fsCapability({ dirs, read: new Set(["$APPDATA"]), write: new Set(["$APPDATA"]) });
    const abs = OS === "windows" ? "C:\\Windows\\win.ini" : "/etc/passwd";
    const err = await assertRejects(
      () => call(fs, "readFile", { path: abs, directory: "data", encoding: "utf8" }),
      DesktopCapError,
    );
    assertEquals(err.code, "validation");
  } finally {
    await cleanup();
  }
});

Deno.test("fs SECURITY: a symlink escaping the directory is refused", async () => {
  if (OS === "windows") return; // symlink creation needs elevation on Windows CI
  const { dirs, root, cleanup } = await fsFixture();
  try {
    // A secret outside every app directory, and a symlink inside `data` pointing at it.
    const outside = join(root, "outside");
    await Deno.mkdir(outside);
    await Deno.writeTextFile(join(outside, "secret.txt"), "TOP SECRET");
    await Deno.symlink(outside, join(dirs.data, "escape"));
    const fs = fsCapability({ dirs, read: new Set(["$APPDATA"]), write: new Set(["$APPDATA"]) });
    const err = await assertRejects(
      () =>
        call(fs, "readFile", { path: "escape/secret.txt", directory: "data", encoding: "utf8" }),
      DesktopCapError,
    );
    assertEquals(err.code, "forbidden");
  } finally {
    await cleanup();
  }
});

Deno.test("fs SECURITY: a directory outside the read/write scope is refused", async () => {
  const { dirs, cleanup } = await fsFixture();
  try {
    // fs enabled, but `documents` ($DOCUMENTS) is NOT in scope (the default).
    const fs = fsCapability({
      dirs,
      read: new Set(["$APPDATA", "$CACHE"]),
      write: new Set(["$APPDATA", "$CACHE"]),
    });
    const err = await assertRejects(
      () => call(fs, "readFile", { path: "x.txt", directory: "documents", encoding: "utf8" }),
      DesktopCapError,
    );
    assertEquals(err.code, "forbidden");
  } finally {
    await cleanup();
  }
});

// --- sqlite ------------------------------------------------------------------

async function sqliteFixture() {
  const dir = await Deno.makeTempDir({ prefix: "denext-sql-cap-" });
  return {
    dir,
    sqlite: sqliteCapability(dir),
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

Deno.test("sqlite: open/exec/run/query round-trip with a blob and named params", async () => {
  const { sqlite, cleanup } = await sqliteFixture();
  try {
    const { handle } = await call(sqlite, "open", { name: "app.db" }) as { handle: string };
    await call(sqlite, "exec", {
      handle,
      sql: "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, data BLOB)",
    });
    const run = await call(sqlite, "run", {
      handle,
      sql: "INSERT INTO t(name, data) VALUES(?, ?)",
      params: ["milk", { $bytes: "AQID" }], // wire blob → bytes 1,2,3
    }) as { changes: number; lastInsertRowId: number };
    assertEquals(run.changes, 1);
    assertEquals(run.lastInsertRowId, 1);
    const q = await call(sqlite, "query", {
      handle,
      sql: "SELECT id, name, data FROM t WHERE name = $name",
      params: { $name: "milk" },
    }) as { columns: string[]; rows: unknown[][] };
    assertEquals(q.columns, ["id", "name", "data"]);
    assertEquals(q.rows[0][0], 1);
    assertEquals(q.rows[0][1], "milk");
    assertEquals(q.rows[0][2], { $bytes: "AQID" }); // result blob re-encoded for the wire
    assertEquals(await call(sqlite, "inTransaction", { handle }), false);
    await call(sqlite, "close", { handle });
  } finally {
    await cleanup();
  }
});

Deno.test("sqlite: a call on a closed/unknown handle is `closed`", async () => {
  const { sqlite, cleanup } = await sqliteFixture();
  try {
    const err = await assertRejects(
      () => call(sqlite, "exec", { handle: "nope", sql: "SELECT 1" }),
      DesktopCapError,
    );
    assertEquals(err.code, "closed");
  } finally {
    await cleanup();
  }
});

Deno.test("sqlite SECURITY: a name with a path separator is refused", async () => {
  const { sqlite, cleanup } = await sqliteFixture();
  try {
    for (const name of ["../evil.db", "sub/x.db", "..", ""]) {
      const err = await assertRejects(() => call(sqlite, "open", { name }), DesktopCapError);
      assertEquals(err.code, "validation", `name ${JSON.stringify(name)} should be refused`);
    }
  } finally {
    await cleanup();
  }
});

Deno.test("sqlite SECURITY: ATTACH / VACUUM INTO cannot reach a file outside the app dir", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-sqlite-attach-" });
  const outside = await Deno.makeTempDir({ prefix: "denext-sqlite-outside-" });
  try {
    const cap = sqliteCapability(dir);
    const { handle } = await call(cap, "open", { name: "app.db" }) as { handle: string };
    for (
      const sql of [
        `ATTACH DATABASE '${join(outside, "x.db")}' AS x`,
        `VACUUM INTO '${join(outside, "y.db")}'`,
      ]
    ) {
      const err = await assertRejects(
        () => call(cap, "exec", { handle, sql }),
        DesktopCapError,
      );
      assertEquals(err.code, "forbidden", sql); // a specific code, not a generic `internal`
    }
    assertEquals([...Deno.readDirSync(outside)].length, 0, "nothing was created outside");
    await call(cap, "close", { handle });
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

// CANARY: node:sqlite gives every error the same generic code ("ERR_SQLITE_ERROR", no errcode), so
// the sqlite cap's guardSql keys the ATTACH→`forbidden` mapping off the MESSAGE text. Pin that
// wording here: if a Deno/node:sqlite upgrade changes it, this fails loudly (and guardSql would
// otherwise silently regress the ATTACH refusal to a generic `internal`).
Deno.test("sqlite CANARY: node:sqlite refuses ATTACH with the wording guardSql keys off", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const limits = (db as unknown as { limits?: Record<string, number> }).limits;
  try {
    assert(
      limits && typeof limits === "object" && "attach" in limits,
      "node:sqlite no longer exposes `limits.attach` — revisit confineDatabase()",
    );
    limits.attach = 0;
    const err = assertThrows(() => db.exec("ATTACH DATABASE ':memory:' AS x")) as Error;
    // guardSql matches "attached databas" (limits path) or "not authorized" (authorizer fallback).
    const msg = err.message.toLowerCase();
    assert(
      msg.includes("attached databas") || msg.includes("not authorized"),
      `node:sqlite ATTACH-refusal wording changed to "${err.message}" — update guardSql in sqlite.ts`,
    );
  } finally {
    db.close();
  }
});

Deno.test("fs/shell SECURITY: the updater overlay dir (data/ui-updates) is never page-writable", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-fs-reserved-" });
  try {
    await Deno.mkdir(join(root, "ui-updates"), { recursive: true });
    await Deno.writeTextFile(join(root, "ui-updates", "current.json"), "{}");
    const cap = fsCapability({
      dirs: { data: root, cache: join(root, "c"), documents: join(root, "d") },
      read: new Set(["$APPDATA"]),
      write: new Set(["$APPDATA"]),
    });
    for (
      const path of [
        "ui-updates/current.json",
        "UI-Updates/versions/x/index.html",
        "a/../ui-updates",
      ]
    ) {
      const err = await assertRejects(
        () =>
          call(cap, "writeFile", { path, data: "<script>", directory: "data", recursive: true }),
        DesktopCapError,
      );
      assertEquals(err.code, "forbidden", path);
    }
    await assertRejects(
      () => call(cap, "deleteFile", { path: "ui-updates/current.json", directory: "data" }),
      DesktopCapError,
    );
    // Reading is refused too; a sibling whose name merely starts the same way is fine.
    await assertRejects(
      () => call(cap, "readFile", { path: "ui-updates/current.json", directory: "data" }),
      DesktopCapError,
    );
    await call(cap, "writeFile", { path: "ui-updates-notes.txt", data: "ok", directory: "data" });
    const trashed: string[][] = [];
    const shell = shellCapability({
      dirs: { data: root, cache: join(root, "c"), documents: join(root, "d") },
      config: { openExternal: [], openPath: false, reveal: false, trash: true },
      spawn: (_c, args) => {
        trashed.push(args);
        return Promise.resolve();
      },
    });
    await assertRejects(
      () => call(shell, "trash", { path: join(root, "ui-updates") }),
      DesktopCapError,
    );
    assertEquals(trashed.length, 0);
    assertEquals(await Deno.readTextFile(join(root, "ui-updates", "current.json")), "{}");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fs/shell/drag SECURITY: the engine profile dirs are unreachable for every operation", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-fs-profile-" });
  try {
    for (const dir of ["CEF", "WebKitGTK", "WebView2", "ui-updates"]) {
      await Deno.mkdir(join(root, dir, "Default"), { recursive: true });
      await Deno.writeTextFile(join(root, dir, "Default", "Cookies"), "secret");
    }
    await Deno.writeTextFile(join(root, "notes.txt"), "mine");
    const dirs = { data: root, cache: join(root, "c"), documents: join(root, "d") };
    const cap = fsCapability({
      dirs,
      read: new Set(["$APPDATA"]),
      write: new Set(["$APPDATA"]),
    });
    // Every spelling: the case-folded names (macOS / Windows filesystems ignore case), Windows'
    // trailing dots and spaces, an NTFS stream suffix, and a `..` detour.
    const paths = [
      "CEF/Default/Cookies",
      "cef/Default/Cookies",
      "WEBKITGTK/Default/Cookies",
      "webview2/Default/Cookies",
      "WebView2./Default/Cookies",
      "CEF ./Default/Cookies",
      "CEF::$INDEX_ALLOCATION/Default/Cookies",
      "notes/../CEF/Default/Cookies",
      "UI-UPDATES/Default/Cookies",
    ];
    const refused = async (method: string, args: Record<string, unknown>) => {
      const err = await assertRejects(() => call(cap, method, args), DesktopCapError);
      assertEquals(err.code, "forbidden", `${method} ${JSON.stringify(args)}`);
    };
    for (const path of paths) {
      await refused("readFile", { path, directory: "data" });
      await refused("readFile", { path, directory: "data", encoding: "base64" });
      await refused("writeFile", { path, data: "x", directory: "data", recursive: true });
      await refused("deleteFile", { path, directory: "data" });
    }
    for (const path of ["CEF", "cef/Default", "WebKitGTK", "WEBVIEW2"]) {
      await refused("listDir", { path, directory: "data" });
    }
    // The data root's listing leaves them out; the app's own files stay visible.
    const listed = (await call(cap, "listDir", { path: "", directory: "data" })) as {
      name: string;
    }[];
    assertEquals(listed.map((e) => e.name).sort(), ["notes.txt"]);
    assertEquals(await call(cap, "readFile", { path: "notes.txt", directory: "data" }), "mine");
    assertEquals(await Deno.readTextFile(join(root, "CEF", "Default", "Cookies")), "secret");

    // shell: open / reveal / trash of an absolute path in the profile.
    const spawned: string[][] = [];
    const shell = shellCapability({
      dirs,
      config: { openExternal: [], openPath: true, reveal: true, trash: true },
      spawn: (_c, args) => {
        spawned.push(args);
        return Promise.resolve();
      },
    });
    for (const method of ["openPath", "reveal", "trash"]) {
      for (const p of [join(root, "CEF"), join(root, "webview2", "Default", "Cookies")]) {
        await assertRejects(() => call(shell, method, { path: p }), DesktopCapError);
      }
    }
    assertEquals(spawned.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("path-scope: a reserved dir reached through another spelling of the data dir is refused", async () => {
  if (Deno.build.os === "windows") return;
  const real = await Deno.makeTempDir({ prefix: "denext-reserved-real-" });
  const alias = `${real}-alias`;
  try {
    await Deno.mkdir(join(real, "CEF"));
    await Deno.symlink(real, alias);
    // The data dir as configured is the alias; the page names the real spelling.
    await assertRejects(
      () => refuseReservedDataPath(alias, join(real, "CEF", "Cookies")),
      DesktopCapError,
    );
    await assertRejects(() => refuseReservedDataPath(real, join(alias, "cef")), DesktopCapError);
    await refuseReservedDataPath(alias, join(real, "notes.txt"));
    assert(isReservedDataName("WebView2"));
    assert(!isReservedDataName("cef-notes"));
  } finally {
    await Deno.remove(alias);
    await Deno.remove(real, { recursive: true });
  }
});

Deno.test("fs.download SECURITY: loopback / link-local targets are refused (literal, DNS, redirect)", async () => {
  for (
    const h of [
      "localhost",
      "api.localhost",
      "127.0.0.1",
      "127.9.9.9",
      "0.0.0.0",
      "169.254.169.254",
      "[::1]",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::",
      "fe80::1",
      "[fe80::1%25en0]",
      "::ffff:127.0.0.1",
      "[::ffff:7f00:1]",
      "::ffff:a9fe:a9fe",
    ]
  ) {
    assert(isRefusedDownloadHost(h), h);
  }
  // LAN and public hosts stay allowed (a desktop app downloads from the local network).
  for (const h of ["192.168.1.10", "10.0.0.5", "172.16.0.1", "example.com", "2001:db8::1"]) {
    assert(!isRefusedDownloadHost(h), h);
  }
  // The URL parser normalizes `127.1` / `0x7f.1` to 127.0.0.1 before the check.
  for (const url of ["http://127.1/", "http://0x7f.0.0.1/", "http://[::ffff:127.0.0.1]/x"]) {
    await assertRejects(() => checkDownloadUrl(url), DesktopCapError, "refused", url);
  }
  // A hostname that RESOLVES to loopback is refused; one resolving to a LAN address is not.
  const resolver = (host: string) =>
    Promise.resolve(host === "evil.test" ? ["93.184.216.34", "127.0.0.1"] : ["192.168.0.7"]);
  await assertRejects(() => checkDownloadUrl("https://evil.test/x", resolver), DesktopCapError);
  await checkDownloadUrl("https://nas.test/x", resolver);

  // Redirects are followed by hand and each hop is re-checked: a public URL that 302s to a
  // loopback service is refused BEFORE that service is fetched.
  const root = await Deno.makeTempDir({ prefix: "denext-fs-ssrf-" });
  try {
    const fetched: string[] = [];
    const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      assertEquals(init?.redirect, "manual");
      if (url === "https://files.test/redirect") {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/admin" } }),
        );
      }
      if (url === "https://files.test/hop") {
        return Promise.resolve(
          new Response(null, { status: 301, headers: { location: "/ok.txt" } }),
        );
      }
      if (url === "https://files.test/big") {
        return Promise.resolve(new Response(new Uint8Array(4096))); // no content-length
      }
      return Promise.resolve(new Response("hello"));
    }) as typeof fetch;
    const cap = fsCapability({
      dirs: { data: root, cache: root, documents: root },
      read: new Set(["$APPDATA"]),
      write: new Set(["$APPDATA"]),
      downloadMaxBytes: 1024,
      resolveHost: () => Promise.resolve(["93.184.216.34"]),
      fetch: fakeFetch,
    });
    const dl = (url: string, path: string) =>
      call(cap, "download", { url, path, directory: "data" });
    const redirected = await assertRejects(
      () => dl("https://files.test/redirect", "r"),
      DesktopCapError,
    );
    assertEquals(redirected.code, "forbidden");
    assert(!fetched.some((u) => u.includes("127.0.0.1")), "the loopback hop was never fetched");
    // A same-host relative redirect is followed.
    await dl("https://files.test/hop", "ok.txt");
    assertEquals(await Deno.readTextFile(join(root, "ok.txt")), "hello");
    assertEquals(fetched.slice(-1), ["https://files.test/ok.txt"]);
    // The byte cap: a streamed body over the limit fails and leaves nothing (no .part either).
    const tooBig = await assertRejects(
      () => dl("https://files.test/big", "big.bin"),
      DesktopCapError,
    );
    assertEquals(tooBig.code, "too_large");
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name), ["ok.txt"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fs.download SECURITY: only http(s) URLs are fetched (no file: exfiltration)", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-fs-dl-" });
  try {
    const cap = fsCapability({
      dirs: { data: root, cache: root, documents: root },
      read: new Set(["$APPDATA"]),
      write: new Set(["$APPDATA"]),
    });
    for (const url of ["file:///etc/passwd", "data:text/plain,hi", "blob:x", "not a url"]) {
      const err = await assertRejects(
        () => call(cap, "download", { url, path: "x", directory: "data" }),
        DesktopCapError,
      );
      assert(err.code === "forbidden" || err.code === "validation", `${url} → ${err.code}`);
    }
    assertEquals([...Deno.readDirSync(root)].length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("sqlite: delete removes the file (closing any open handle first)", async () => {
  const { dir, sqlite, cleanup } = await sqliteFixture();
  try {
    const { handle } = await call(sqlite, "open", { name: "d.db" }) as { handle: string };
    await call(sqlite, "exec", { handle, sql: "CREATE TABLE t(x)" });
    await call(sqlite, "delete", { name: "d.db" });
    assertEquals(await Deno.stat(join(dir, "d.db")).then(() => true, () => false), false);
    // The handle is now closed.
    const err = await assertRejects(
      () => call(sqlite, "exec", { handle, sql: "SELECT 1" }),
      DesktopCapError,
    );
    assertEquals(err.code, "closed");
  } finally {
    await cleanup();
  }
});

Deno.test("sqlite: a query that keeps producing rows stops at its time budget", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-sqlite-budget-" });
  try {
    const cap = sqliteCapability(dir, { queryTimeBudgetMs: 5 });
    const { handle } = await call(cap, "open", { name: "b.db" }) as { handle: string };
    // An unbounded recursive CTE: without the budget this would never return.
    const err = await assertRejects(
      () =>
        call(cap, "query", {
          handle,
          sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c",
        }),
      DesktopCapError,
    );
    assertEquals(err.code, "timeout");
    // A bounded query still works on the same handle.
    const ok = await call(cap, "query", { handle, sql: "SELECT 1 AS one" }) as {
      columns: string[];
      rows: unknown[][];
    };
    assertEquals(ok, { columns: ["one"], rows: [[1]] });
    await call(cap, "close", { handle });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- shell -------------------------------------------------------------------

Deno.test("shellPathCommand: per-OS argv passes the path as a discrete arg (no injection)", () => {
  const p = "/app/data/report.pdf";
  assertEquals(shellPathCommand("darwin", "open", p), ["open", [p]]);
  assertEquals(shellPathCommand("darwin", "reveal", p), ["open", ["-R", p]]);
  // macOS trash goes through Finder (recoverable) with the path as an argv item, not interpolated.
  const [tcmd, targs] = shellPathCommand("darwin", "trash", p);
  assertEquals(tcmd, "osascript");
  assertEquals(targs[targs.length - 1], p);
  // Inside a Finder tell, `POSIX file …` is an object specifier Finder cannot resolve (-1728, found
  // in a packaged window): the path must become an alias before the tell.
  assert(
    !targs.some((a) => a.includes('tell application "Finder"') && a.includes("POSIX file")),
    targs.join(" "),
  );
  assertEquals(shellPathCommand("linux", "open", p), ["xdg-open", [p]]);
  assertEquals(shellPathCommand("linux", "trash", p), ["gio", ["trash", p]]);
  assertEquals(shellPathCommand("windows", "open", p), ["explorer.exe", [p]]);
  // Windows trash: `powershell.exe -Command` joins trailing argv into the command TEXT, so the
  // path must never be in argv at all — it travels in an env var the script reads as data.
  const evil = "C:\\app\\data\\a;Start-Process calc;$(calc)";
  const [wcmd, wargs] = shellPathCommand("windows", "trash", evil);
  assertEquals(wcmd, "powershell.exe");
  assert(wargs.every((a) => !a.includes("calc")), "the path is not in the powershell argv");
  assertEquals(shellPathEnv("windows", "trash", evil), { [SHELL_PATH_ENV]: evil });
  assertEquals(shellPathEnv("darwin", "trash", p), undefined);
  // Linux reveal: dbus-send splits `array:string:` on commas, so the path is percent-encoded.
  const [, largs] = shellPathCommand("linux", "reveal", "/app/data/a,b c.txt");
  assert(largs.includes("array:string:file:///app/data/a%2Cb%20c.txt"), largs.join(" "));
});

Deno.test("shell: every spawn gets the bridge deadline's signal; the default spawner kills on abort", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const root = await Deno.makeTempDir({ prefix: "denext-shell-signal-" });
  try {
    await Deno.writeTextFile(join(root, "f.txt"), "x");
    const cap = shellCapability({
      dirs: { data: root, cache: root, documents: root },
      config: { openExternal: ["https:"], openPath: true, reveal: true, trash: true },
      spawn: (_cmd, _args, _env, signal) => {
        signals.push(signal);
        return Promise.resolve();
      },
    });
    const deadline = new AbortController();
    const c = ctx({ signal: deadline.signal });
    await call(cap, "openExternal", { url: "https://example.com" }, c);
    await call(cap, "openPath", { path: join(root, "f.txt") }, c);
    await call(cap, "reveal", { path: join(root, "f.txt") }, c);
    await call(cap, "trash", { path: join(root, "f.txt") }, c);
    assertEquals(signals.length, 4);
    assert(signals.every((s) => s === deadline.signal));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
  if (OS === "windows") return;
  // The real spawner: a hung child is terminated when the deadline aborts.
  const abort = new AbortController();
  const started = Date.now();
  setTimeout(() => abort.abort(), 50);
  const err = await assertRejects(
    () => runShellTool("sleep", ["30"], undefined, abort.signal),
    DesktopCapError,
  );
  assertEquals(err.code, "timeout");
  assert(Date.now() - started < 10_000, "the child did not run to completion");
  await assertRejects(() => runShellTool("sleep", ["1"], undefined, abort.signal), DesktopCapError);
});

Deno.test("shell SECURITY: the Windows trash is spawned with the path in env, never argv", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-shell-wtrash-" });
  try {
    const file = join(root, "a;Start-Process calc.txt");
    await Deno.writeTextFile(file, "x");
    const spawned: Array<[string, string[], Record<string, string> | undefined]> = [];
    const cap = shellCapability({
      dirs: { data: root, cache: root, documents: root },
      config: { openExternal: [], openPath: false, reveal: false, trash: true },
      os: "windows",
      spawn: (cmd, args, env) => {
        spawned.push([cmd, args, env]);
        return Promise.resolve();
      },
    });
    await call(cap, "trash", { path: file });
    assertEquals(spawned.length, 1);
    assert(spawned[0][1].every((a) => !a.includes("Start-Process")));
    assertEquals(spawned[0][2]?.[SHELL_PATH_ENV], file);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shell.openPath SECURITY: programs, scripts and launchers are refused (fs write + open ≠ RCE)", async () => {
  for (const bad of ["x.bat", "X.CMD", "a.vbs", "s.hta", "l.lnk", "t.terminal", "c.command"]) {
    assert(isExecutableOpenTarget(`/app/data/${bad}`), bad);
  }
  assert(isExecutableOpenTarget("C:\\app\\data\\x.bat. . "), "trailing dots/spaces are ignored");
  for (const ok of ["report.pdf", "photo.JPG", "notes.txt", "noext", ".bashrc-like"]) {
    assert(!isExecutableOpenTarget(`/app/data/${ok}`), ok);
  }
  const root = await Deno.makeTempDir({ prefix: "denext-shell-exec-" });
  try {
    await Deno.writeTextFile(join(root, "run.bat"), "calc");
    const spawned: string[][] = [];
    const cap = shellCapability({
      dirs: { data: root, cache: root, documents: root },
      config: { openExternal: [], openPath: true, reveal: true, trash: false },
      spawn: (_cmd, args) => {
        spawned.push(args);
        return Promise.resolve();
      },
    });
    const err = await assertRejects(
      () => call(cap, "openPath", { path: join(root, "run.bat") }),
      DesktopCapError,
    );
    assertEquals(err.code, "forbidden");
    // reveal (show in the file manager) is not an execution and stays allowed.
    await call(cap, "reveal", { path: join(root, "run.bat") });
    assertEquals(spawned.length, 1);
    // A harmless-looking name that is a symlink to a program is judged by its real target too.
    if (OS !== "windows") {
      await Deno.symlink(join(root, "run.bat"), join(root, "doc.pdf"));
      await assertRejects(() => call(cap, "openPath", { path: join(root, "doc.pdf") }));
      // An extension-less file with an execute bit (`open` would run it in Terminal).
      await Deno.writeTextFile(join(root, "tool"), "#!/bin/sh\n");
      await Deno.chmod(join(root, "tool"), 0o755);
      await assertRejects(() => call(cap, "openPath", { path: join(root, "tool") }));
      await Deno.writeTextFile(join(root, "plain"), "x");
      await call(cap, "openPath", { path: join(root, "plain") });
      assertEquals(spawned.length, 2);
    }
    // Windows: an extension-less file is refused (its handler is unpredictable).
    assert(await openPathRefusal(join(root, "run.bat"), "windows"));
    await Deno.writeTextFile(join(root, "noext"), "x");
    assert(await openPathRefusal(join(root, "noext"), "windows"));
    assertEquals(await openPathRefusal(join(root, "noext"), "linux"), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shell.openPath allowlist: openPathAllowExtensions re-allows specific extensions (safely)", async () => {
  // Unit: the allow set removes an extension from the denylist — and ONLY that extension.
  const allow = new Set(["sh", "py"]);
  assert(isExecutableOpenTarget("/app/data/s.sh"), "sh is on the denylist by default");
  assert(!isExecutableOpenTarget("/app/data/s.sh", undefined, allow), "sh opted back in");
  assert(!isExecutableOpenTarget("/app/data/x.SH", undefined, allow), "case-insensitive");
  assert(isExecutableOpenTarget("/app/data/x.bat", undefined, allow), "bat still refused");

  if (OS === "windows") return; // the runtime cases below use Unix symlinks + exec bits
  const root = await Deno.makeTempDir({ prefix: "denext-shell-allow-" });
  try {
    const spawned: string[][] = [];
    const cap = shellCapability({
      dirs: { data: root, cache: root, documents: root },
      config: {
        openExternal: [],
        openPath: true,
        reveal: true,
        trash: false,
        openPathAllowExtensions: ["sh"],
      },
      spawn: (_c, args) => {
        spawned.push(args);
        return Promise.resolve();
      },
    });
    // An allowlisted .sh opens — even with the execute bit set (the user opted in for this ext).
    await Deno.writeTextFile(join(root, "ok.sh"), "#!/bin/sh\necho hi\n");
    await Deno.chmod(join(root, "ok.sh"), 0o755);
    await call(cap, "openPath", { path: join(root, "ok.sh") });
    assertEquals(spawned.length, 1);
    // A NON-allowlisted script is still refused.
    await Deno.writeTextFile(join(root, "no.py"), "print(1)");
    await assertRejects(
      () => call(cap, "openPath", { path: join(root, "no.py") }),
      DesktopCapError,
    );
    // SAFETY: an allowlisted .sh that symlinks to a NON-allowlisted program is refused (the real
    // target is checked too).
    await Deno.writeTextFile(join(root, "run.bat"), "calc");
    await Deno.symlink(join(root, "run.bat"), join(root, "trick.sh"));
    await assertRejects(
      () => call(cap, "openPath", { path: join(root, "trick.sh") }),
      DesktopCapError,
    );
    // SAFETY: an allowlisted extension symlinked to an extension-less executable is still refused
    // (the exec-bit guard keys off the resolved file, whose ext is not allowlisted).
    await Deno.writeTextFile(join(root, "bin"), "#!/bin/sh\n");
    await Deno.chmod(join(root, "bin"), 0o755);
    await Deno.symlink(join(root, "bin"), join(root, "wrap.sh"));
    await assertRejects(
      () => call(cap, "openPath", { path: join(root, "wrap.sh") }),
      DesktopCapError,
    );
    assertEquals(spawned.length, 1, "only the safe .sh opened");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

function shellFixture(config: Partial<Parameters<typeof shellCapability>[0]["config"]> = {}) {
  const spawned: Array<[string, string[]]> = [];
  const cap = shellCapability({
    dirs: { data: "/app/data", cache: "/app/cache", documents: "/app/docs" },
    config: {
      openExternal: ["https:", "mailto:"],
      openPath: true,
      reveal: true,
      trash: true,
      ...config,
    },
    spawn: (cmd, args) => {
      spawned.push([cmd, args]);
      return Promise.resolve();
    },
  });
  return { cap, spawned };
}

Deno.test("shell.openExternal: an allowed scheme launches the browser; others are refused", async () => {
  const { cap, spawned } = shellFixture();
  await call(cap, "openExternal", { url: "https://example.com/x?a=1&b=2" });
  assertEquals(spawned.length, 1);
  assertEquals(spawned[0][1][spawned[0][1].length - 1], "https://example.com/x?a=1&b=2");
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
    const err = await assertRejects(() => call(cap, "openExternal", { url: bad }), DesktopCapError);
    assert(err.code === "forbidden" || err.code === "validation", `${bad} → ${err.code}`);
  }
  assertEquals(spawned.length, 1); // no extra spawns from the refused URLs
});

Deno.test("shell.openPath: confines the path to the app dirs and spawns the opener", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-shell-" });
  try {
    await Deno.writeTextFile(join(root, "f.txt"), "x");
    const spawned: Array<[string, string[]]> = [];
    const cap = shellCapability({
      dirs: { data: root, cache: root, documents: root },
      config: { openExternal: [], openPath: true, reveal: false, trash: false },
      spawn: (cmd, args) => {
        spawned.push([cmd, args]);
        return Promise.resolve();
      },
    });
    await call(cap, "openPath", { path: join(root, "f.txt") });
    assertEquals(spawned.length, 1);
    // A path outside the app dirs is refused.
    const err = await assertRejects(
      () =>
        call(cap, "openPath", {
          path: OS === "windows" ? "C:\\Windows\\notepad.exe" : "/etc/hosts",
        }),
      DesktopCapError,
    );
    assertEquals(err.code, "forbidden");
    // reveal is disabled in this config.
    const err2 = await assertRejects(
      () => call(cap, "reveal", { path: join(root, "f.txt") }),
      DesktopCapError,
    );
    assertEquals(err2.code, "forbidden");
    assertEquals(spawned.length, 1); // neither refusal spawned anything
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- keepAwake ---------------------------------------------------------------

Deno.test("keepAwake: one OS assertion is held while any hold is active (ref-counted)", async () => {
  let starts = 0;
  let stops = 0;
  const cap = keepAwakeCapability({
    driver: {
      permissions: {},
      start: () => {
        starts++;
        return Promise.resolve(() => {
          stops++;
        });
      },
    },
  });
  const a = await call(cap, "acquire", {}) as { id: string };
  const b = await call(cap, "acquire", {}) as { id: string };
  assert(a.id !== b.id, "each hold gets a distinct id");
  assertEquals([starts, stops], [1, 0], "two holds share one assertion");
  await call(cap, "release", { id: a.id });
  assertEquals(stops, 0, "still held by b");
  await call(cap, "release", { id: b.id });
  assertEquals(stops, 1, "released when the last hold drops");
  // A subsequent acquire starts a fresh assertion; an unknown release is a no-op.
  await call(cap, "acquire", {});
  assertEquals(starts, 2);
  await call(cap, "release", { id: "never-held" });
  assertEquals(stops, 1);
});

Deno.test("keepAwake: a new page load releases the previous page's holds", async () => {
  let starts = 0;
  let stops = 0;
  const cap = keepAwakeCapability({
    driver: {
      permissions: {},
      start: () => {
        starts++;
        return Promise.resolve(() => {
          stops++;
        });
      },
    },
  });
  await call(cap, "acquire", {});
  await call(cap, "acquire", {});
  assertEquals([starts, stops], [1, 0]);
  // The page reloads: its releases will never come, so the runtime drops them.
  await cap.onPageLoad?.();
  assertEquals(stops, 1, "the assertion is released on reload");
  // The new page acquires afresh.
  const fresh = await call(cap, "acquire", {}) as { id: string };
  assertEquals(starts, 2);
  await call(cap, "release", { id: fresh.id });
  assertEquals(stops, 2);
  // A page load with nothing held is a no-op.
  await cap.onPageLoad?.();
  assertEquals(stops, 2);
});

Deno.test("keepAwake: the Windows driver passes SetThreadExecutionState a valid u32", async () => {
  const calls: number[] = [];
  // deno-lint-ignore no-explicit-any
  const d = Deno as any;
  const original = d.dlopen;
  d.dlopen = () => ({
    symbols: {
      SetThreadExecutionState: (flags: number) => {
        // Deno FFI rejects anything outside [0, 2^32) for a u32 parameter.
        if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) {
          throw new TypeError("Invalid FFI u32 type, expected unsigned integer");
        }
        calls.push(flags);
        return 0;
      },
    },
    close: () => {},
  });
  try {
    const cap = keepAwakeCapability({ os: "windows" });
    const hold = await call(cap, "acquire", {}) as { id: string };
    await call(cap, "release", { id: hold.id });
  } finally {
    d.dlopen = original;
  }
  assertEquals(calls, [0x80000003, 0x80000000]);
});

// --- secureStore -------------------------------------------------------------

Deno.test("secureStoreCommand: per-OS argv; the secret is stdin on every OS, never argv", () => {
  const mac = secureStoreCommand("darwin", "set", "svc", 'to "k\\', "QjY0");
  assertEquals(mac.cmd, "security");
  assertEquals(mac.args, ["-i"]); // `ps` shows only `security -i`
  assertEquals(
    mac.stdin,
    'add-generic-password -U -a "to \\"k\\\\" -s "svc" -w "QjY0"\n',
  );
  assertEquals(secureStoreCommand("darwin", "get", "svc", "tok").args[0], "find-generic-password");

  const lin = secureStoreCommand("linux", "set", "svc", "tok", "QjY0");
  assertEquals(lin.cmd, "secret-tool");
  assertEquals(lin.args[0], "store");
  assertEquals(lin.stdin, "QjY0"); // secret on stdin, never argv
  assert(!lin.args.includes("QjY0"));
  assertEquals(secureStoreCommand("linux", "get", "svc", "tok").args[0], "lookup");

  // Windows (WinRT PasswordVault via powershell.exe): the script is CONSTANT and every value
  // travels in the stdin JSON — powershell.exe -Command joins trailing argv into the command text,
  // so service/key/secret must never appear in argv.
  const win = secureStoreCommand("windows", "set", "svc", "tok", "QjY0");
  assertEquals(win.cmd, "powershell.exe");
  assert(win.args.includes("-Command"));
  assert(
    !win.args.some((a) => a.includes("svc") || a.includes("tok") || a.includes("QjY0")),
    "no user data in argv",
  );
  assertEquals(JSON.parse(win.stdin!), { op: "set", service: "svc", key: "tok", value: "QjY0" });
});

/** Split a `security -i` command line the way its parser does (double quotes, `\` escapes). */
function securityWords(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) =>
    m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]
  );
}

/** A fake macOS `security` backing an in-memory keychain, for the handler round-trip. `failWrites`
 * mimics `security -i`, which exits 0 even when the command it read failed. */
function darwinKeychain(
  failWrites = false,
): { run: SecureRunner; store: Map<string, string> } {
  const store = new Map<string, string>();
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  const run: SecureRunner = (_cmd, argv, stdin) => {
    const args = argv[0] === "-i" ? securityWords(stdin ?? "") : argv;
    const op = args[0];
    const key = after(args, "-a");
    if (op === "add-generic-password") {
      if (!failWrites) store.set(key, after(args, "-w"));
      return Promise.resolve({ code: 0, stdout: "" });
    }
    if (op === "find-generic-password") {
      return Promise.resolve(
        store.has(key) ? { code: 0, stdout: `${store.get(key)}\n` } : { code: 44, stdout: "" },
      );
    }
    return Promise.resolve({ code: store.delete(key) ? 0 : 44, stdout: "" }); // delete-generic-password
  };
  return { run, store };
}

Deno.test("secureStore: set/get round-trips a value with newlines and unicode (base64-wrapped)", async () => {
  const { run } = darwinKeychain();
  const cap = secureStoreCapability({ service: "com.example.app", os: "darwin", run });
  const secret = 'line1\nline2 🔒 "quotes"';
  await call(cap, "set", { key: "token", value: secret });
  assertEquals(await call(cap, "get", { key: "token" }), secret);
  assertEquals(await call(cap, "get", { key: "absent" }), null);
  await call(cap, "delete", { key: "token" });
  assertEquals(await call(cap, "get", { key: "token" }), null);
  // A key with quotes and backslashes survives the `security -i` quoting.
  await call(cap, "set", { key: 'we ird "k\\', value: "v" });
  assertEquals(await call(cap, "get", { key: 'we ird "k\\' }), "v");
});

Deno.test("secureStore: a macOS write that `security -i` silently dropped is an error", async () => {
  const { run } = darwinKeychain(true);
  const cap = secureStoreCapability({ service: "com.example.app", os: "darwin", run });
  await assertRejects(() => call(cap, "set", { key: "token", value: "v" }), Error, "rejected");
});

Deno.test({
  name: "secureStore (real macOS Keychain): round-trips without the secret in any argv",
  ignore: OS !== "darwin" || Deno.env.get("DENEXT_KEYCHAIN_TEST") !== "1",
  fn: async () => {
    const seen: string[][] = [];
    const cap = secureStoreCapability({
      service: `dev.denext.test.${crypto.randomUUID()}`,
      run: (cmd, args, stdin, signal) => {
        seen.push([cmd, ...args]);
        return realSecureRun(cmd, args, stdin, signal);
      },
    });
    const secret = `s3cret-${crypto.randomUUID()}`;
    const b64 = btoa(secret);
    try {
      await call(cap, "set", { key: 'k "q\\', value: secret });
      assertEquals(await call(cap, "get", { key: 'k "q\\' }), secret);
    } finally {
      await call(cap, "delete", { key: 'k "q\\' });
    }
    assertEquals(await call(cap, "get", { key: 'k "q\\' }), null);
    assert(!seen.flat().some((a) => a.includes(secret) || a.includes(b64)), "secret in argv");
  },
});

/** A fake Windows PasswordVault backed by the stdin JSON payload (an in-memory store), for the
 * handler round-trip. The real WinRT round-trip runs only on the Windows CI. */
function windowsVault(): { run: SecureRunner; store: Map<string, string> } {
  const store = new Map<string, string>();
  const run: SecureRunner = (_cmd, _args, stdin) => {
    const p = JSON.parse(stdin ?? "{}") as {
      op: string;
      service: string;
      key: string;
      value?: string;
    };
    const id = `${p.service}\u0000${p.key}`;
    if (p.op === "set") {
      store.set(id, p.value ?? "");
      return Promise.resolve({ code: 0, stdout: "" });
    }
    if (p.op === "delete") {
      store.delete(id);
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return Promise.resolve(
      store.has(id) ? { code: 0, stdout: store.get(id)! } : { code: 1, stdout: "" },
    );
  };
  return { run, store };
}

Deno.test("secureStore: Windows PasswordVault round-trips via the stdin JSON payload", async () => {
  const { run } = windowsVault();
  const cap = secureStoreCapability({ service: "com.example.app", os: "windows", run });
  const secret = 'k=v\nline2 🔒 "q"';
  await call(cap, "set", { key: "token", value: secret });
  assertEquals(await call(cap, "get", { key: "token" }), secret);
  assertEquals(await call(cap, "get", { key: "absent" }), null);
  await call(cap, "delete", { key: "token" });
  assertEquals(await call(cap, "get", { key: "token" }), null);
});

Deno.test("secureStore SECURITY: a key with a leading '-' or control chars is refused (secret-tool getopt)", async () => {
  const cap = secureStoreCapability({
    service: "svc",
    os: "linux",
    run: () => {
      throw new Error("the runner must not be reached for an invalid key");
    },
  });
  for (const key of ["-x", "--lookup", "-", "a\u0000b", "line\nbreak"]) {
    const err = await assertRejects(
      () => call(cap, "get", { key }),
      DesktopCapError,
    );
    assertEquals(err.code, "validation", key);
  }
  // A normal key with internal dashes is fine (the runner is reached).
  let reached = false;
  const ok = secureStoreCapability({
    service: "svc",
    os: "linux",
    run: () => {
      reached = true;
      return Promise.resolve({ code: 1, stdout: "" });
    },
  });
  await call(ok, "get", { key: "auth-token-2024" });
  assert(reached, "a normal key reaches the runner");
});

// --- picked paths (capability handles) --------------------------------------

Deno.test("PickedPaths: a folder handle grants confined recursive access; escapes are refused", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-picked-" });
  try {
    await Deno.mkdir(join(root, "src"));
    await Deno.writeTextFile(join(root, "src", "app.ts"), "x");
    const picked = new PickedPaths();
    const h = picked.add(await Deno.realPath(root), "folder");
    const { target, root: r } = await picked.resolve(h, "src/app.ts", false);
    assertEquals(target, join(await Deno.realPath(root), "src", "app.ts"));
    assertEquals(r, await Deno.realPath(root));
    // A relative "" resolves to the folder itself (for listDir).
    assertEquals((await picked.resolve(h, "", false)).target, await Deno.realPath(root));
    // `..` escape and an unknown handle are refused.
    assertEquals(
      (await assertRejects(() => picked.resolve(h, "../../etc/passwd", false), DesktopCapError))
        .code,
      "forbidden",
    );
    assertEquals(
      (await assertRejects(() => picked.resolve("forged", "x", false), DesktopCapError)).code,
      "forbidden",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("PickedPaths SECURITY: a symlink out of a picked folder is refused", async () => {
  if (OS === "windows") return;
  const root = await Deno.makeTempDir({ prefix: "denext-picked-" });
  try {
    const outside = join(root, "outside");
    await Deno.mkdir(outside);
    await Deno.writeTextFile(join(outside, "secret"), "s");
    const folder = join(root, "proj");
    await Deno.mkdir(folder);
    await Deno.symlink(outside, join(folder, "escape"));
    const picked = new PickedPaths();
    const h = picked.add(await Deno.realPath(folder), "folder");
    const err = await assertRejects(
      () => picked.resolve(h, "escape/secret", false),
      DesktopCapError,
    );
    assertEquals(err.code, "forbidden");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("PickedPaths: mode gates write; a file handle rejects a sub-path; the set is capped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-picked-" });
  try {
    const real = await Deno.realPath(dir);
    const picked = new PickedPaths(2); // small cap for the eviction check
    const ro = picked.add(join(real, "a.txt"), "read");
    assertEquals(
      (await assertRejects(() => picked.resolve(ro, "", true), DesktopCapError)).code,
      "forbidden",
    );
    assertEquals((await picked.resolve(ro, "", false)).target, join(real, "a.txt"));
    // A file handle rejects a relative sub-path.
    assertEquals(
      (await assertRejects(() => picked.resolve(ro, "sub", false), DesktopCapError)).code,
      "forbidden",
    );
    // Adding past the cap (2) evicts the oldest (ro).
    picked.add(join(real, "b.txt"), "readwrite");
    picked.add(join(real, "c.txt"), "readwrite");
    assertEquals(picked.size, 2);
    assertEquals(
      (await assertRejects(() => picked.resolve(ro, "", false), DesktopCapError)).code,
      "forbidden",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fs: a { picked } directory reads/writes/lists inside a picked folder handle", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-fs-picked-" });
  try {
    await Deno.writeTextFile(join(root, "readme.md"), "hi");
    const picked = new PickedPaths();
    const fs = fsCapability({
      dirs: { data: root, cache: root, documents: root },
      read: new Set(["$APPDATA"]),
      write: new Set(["$APPDATA"]),
      picked,
    });
    const folder = picked.add(await Deno.realPath(root), "folder");
    assertEquals(
      await call(fs, "readFile", {
        path: "readme.md",
        directory: { picked: folder },
        encoding: "utf8",
      }),
      "hi",
    );
    await call(fs, "writeFile", {
      path: "note.txt",
      data: "x",
      directory: { picked: folder },
      encoding: "utf8",
    });
    const names = (await call(fs, "listDir", { path: "", directory: { picked: folder } }) as Array<
      { name: string }
    >)
      .map((e) => e.name).sort();
    assertEquals(names, ["note.txt", "readme.md"]);
    // A read-only file handle refuses a write.
    const ro = picked.add(join(await Deno.realPath(root), "readme.md"), "read");
    const err = await assertRejects(
      () =>
        call(fs, "writeFile", {
          path: "",
          data: "no",
          directory: { picked: ro },
          encoding: "utf8",
        }),
      DesktopCapError,
    );
    assertEquals(err.code, "forbidden");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shell: openPath/trash accept a picked handle (trash needs a writable mode)", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-shell-picked-" });
  try {
    await Deno.writeTextFile(join(root, "f.txt"), "x");
    const picked = new PickedPaths();
    const spawned: Array<[string, string[]]> = [];
    const cap = shellCapability({
      dirs: { data: "/nope", cache: "/nope", documents: "/nope" }, // path (non-handle) can't reach it
      config: { openExternal: [], openPath: true, reveal: true, trash: true },
      picked,
      spawn: (cmd, args) => {
        spawned.push([cmd, args]);
        return Promise.resolve();
      },
    });
    const ro = picked.add(join(await Deno.realPath(root), "f.txt"), "read");
    await call(cap, "openPath", { handle: ro }); // read handle → open OK
    assertEquals(spawned.length, 1);
    // trash on a read-only handle is refused (no destructive access).
    const err = await assertRejects(() => call(cap, "trash", { handle: ro }), DesktopCapError);
    assertEquals(err.code, "forbidden");
    // A readwrite handle may be trashed.
    const rw = picked.add(join(await Deno.realPath(root), "f.txt"), "readwrite");
    await call(cap, "trash", { handle: rw });
    assertEquals(spawned.length, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- dialogs -----------------------------------------------------------------

/** A dialogs cap whose runner records the (cmd, args) it was handed and "chooses" `stdout`. */
function capturingDialogs(os: "darwin" | "windows" | "linux", stdout: string) {
  const calls: Array<[string, string[]]> = [];
  const picked = new PickedPaths();
  const cap = dialogsCapability({
    picked,
    os,
    run: (cmd, args) => {
      calls.push([cmd, args]);
      return Promise.resolve({ code: 0, stdout });
    },
  });
  return { cap, calls, picked };
}

Deno.test("dialogs: per-OS program is spawned with the path/name as discrete args (no injection)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-dialogs-argv-" });
  try {
    const folder = await Deno.realPath(dir);
    // The program the cap spawns, per OS (first candidate).
    const mac = capturingDialogs("darwin", folder);
    await call(mac.cap, "pickFolder", {});
    assertEquals(mac.calls[0], ["osascript", ["-e", "POSIX path of (choose folder)"]]);
    const lin = capturingDialogs("linux", folder);
    await call(lin.cap, "openFile", {});
    assertEquals(lin.calls[0][0], "zenity");
    const win = capturingDialogs("windows", folder);
    await call(win.cap, "openFile", {});
    assertEquals(win.calls[0][0], "powershell.exe");
    // saveFile: the suggested name is its own argv element, never spliced into the script string.
    const out = join(dir, "notes.txt");
    const save = capturingDialogs("darwin", out);
    await call(save.cap, "saveFile", { data: "x", encoding: "utf8", suggestedName: "notes.txt" });
    const [, args] = save.calls[0];
    assertEquals(args[args.length - 1], "notes.txt");
    assert(args.every((a) => a === "notes.txt" || !a.includes("notes.txt")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dialogs SECURITY: a dash-led suggestedName can never become an osascript/kdialog option", async () => {
  // Reproduced on macOS: `osascript -e … <name>` with name `-e<script>` ran the injected script
  // (getopt still parses a dash-led trailing arg). The name now follows `--` and is sanitized.
  const inject = '-eproperty p : (do shell script "touch /tmp/pwned")';
  // Reduced to its last path component, and never dash-led.
  assertEquals(sanitizeSuggestedName(inject), 'pwned")');
  assertEquals(sanitizeSuggestedName("-e do shell script x"), "e do shell script x");
  assertEquals(sanitizeSuggestedName("../../etc/passwd"), "passwd");
  assertEquals(sanitizeSuggestedName("a\nb\u0000c.txt"), "abc.txt");
  assertEquals(sanitizeSuggestedName("---"), undefined);
  assertEquals(sanitizeSuggestedName(42), undefined);
  const dir = await Deno.makeTempDir({ prefix: "denext-dialogs-inject-" });
  try {
    const out = join(dir, "x.txt");
    const mac = capturingDialogs("darwin", out);
    await call(mac.cap, "saveFile", { data: "x", suggestedName: '-edo shell script "id"' });
    const [, margs] = mac.calls[0];
    assertEquals(margs[margs.length - 2], "--");
    assert(!margs[margs.length - 1].startsWith("-"), margs[margs.length - 1]);
    // Linux: kdialog's positional start dir must not be dash-led either.
    const calls: Array<[string, string[]]> = [];
    const lin = dialogsCapability({
      picked: new PickedPaths(),
      os: "linux",
      run: (cmd, args) => {
        calls.push([cmd, args]);
        return Promise.resolve(
          cmd === "zenity" ? { code: null, stdout: "" } : { code: 0, stdout: out },
        );
      },
    });
    await call(lin, "saveFile", { data: "x", suggestedName: "-platformpluginpath" });
    assertEquals(calls[1][0], "kdialog");
    assert(calls[1][1].every((a) => a === "--getsavefilename" || !a.startsWith("-")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dialogs SECURITY: the Windows suggested name travels in env, never the powershell argv", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-dialogs-win-" });
  try {
    const out = join(dir, "x.txt");
    const calls: Array<[string, string[], Record<string, string> | undefined]> = [];
    const cap = dialogsCapability({
      picked: new PickedPaths(),
      os: "windows",
      run: (cmd, args, env) => {
        calls.push([cmd, args, env]);
        return Promise.resolve({ code: 0, stdout: out });
      },
    });
    const name = "a; Start-Process calc; $(calc).txt";
    await call(cap, "saveFile", { data: "x", suggestedName: name });
    assertEquals(calls[0][0], "powershell.exe");
    assert(calls[0][1].every((a) => !a.includes("calc")), "name is not in argv");
    assertEquals(calls[0][2]?.[DIALOG_NAME_ENV], name);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dialogs.openFile: a chosen file returns a read handle (+ data); cancel → no files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-dialogs-" });
  try {
    const file = join(dir, "picked.txt");
    await Deno.writeTextFile(file, "hello");
    const picked = new PickedPaths();
    // A fake dialog program that "chose" `file`.
    const chose = dialogsCapability({
      picked,
      os: "darwin",
      run: () => Promise.resolve({ code: 0, stdout: `${file}\n` }),
    });
    const out = await call(chose, "openFile", { readData: true }) as {
      files: Array<Record<string, unknown>>;
    };
    assertEquals(out.files.length, 1);
    assertEquals(out.files[0].name, "picked.txt");
    assertEquals(out.files[0].data, "aGVsbG8="); // base64("hello")
    // The handle it returned is usable via the picked set (read mode).
    const h = out.files[0].handle as string;
    assertEquals((await picked.resolve(h, "", false)).target, await Deno.realPath(file));
    // Cancel (non-zero exit) → no files.
    const cancel = dialogsCapability({
      picked,
      os: "darwin",
      run: () => Promise.resolve({ code: 1, stdout: "" }),
    });
    assertEquals(await call(cancel, "openFile", {}), { files: [] });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dialogs.saveFile writes the data and returns a readwrite handle; pickFolder → folder handle", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-dialogs-" });
  try {
    const picked = new PickedPaths();
    const out = join(dir, "out.txt");
    const save = dialogsCapability({
      picked,
      os: "darwin",
      run: () => Promise.resolve({ code: 0, stdout: out }),
    });
    const res = await call(save, "saveFile", { data: "saved!", encoding: "utf8" }) as {
      path: string;
      handle: string;
    };
    assertEquals(await Deno.readTextFile(out), "saved!");
    assertEquals(res.path, out);
    // readwrite handle: a write through it is allowed.
    assert((await picked.resolve(res.handle, "", true)).target === await Deno.realPath(out));

    const folder = dialogsCapability({
      picked,
      os: "darwin",
      run: () => Promise.resolve({ code: 0, stdout: dir }),
    });
    const f = await call(folder, "pickFolder", {}) as { path: string; handle: string };
    assertEquals(f.path, dir);
    assertEquals((await picked.resolve(f.handle, "", true)).root, await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dialogs: no dialog program available → unavailable (page falls back to <input type=file>)", async () => {
  const picked = new PickedPaths();
  const none = dialogsCapability({
    picked,
    os: "linux",
    run: () => Promise.resolve({ code: null, stdout: "" }),
  });
  const err = await assertRejects(() => call(none, "pickFolder", {}), DesktopCapError);
  assertEquals(err.code, "unavailable");
});

// --- resolver ----------------------------------------------------------------

Deno.test("resolver: no desktop config → no capabilities (default deny)", async () => {
  const r = await resolveDesktopCapabilities(undefined);
  assertEquals(r.capabilities, []);
  assert(r.appSupportDir.length > 0);
});

Deno.test("resolver: maps enabled built-ins; echo off unless explicitly true", async () => {
  const r = await resolveDesktopCapabilities({
    desktop: {
      // A unique identifier is REQUIRED once a data-storing cap (secureStore/fs/sqlite) is on.
      app: { identifier: "com.example.built-ins-test" },
      capabilities: {
        device: true,
        fs: true,
        sqlite: true,
        shell: true,
        keepAwake: true,
        secureStore: true,
        dialogs: true,
        clipboard: true,
      },
    },
  });
  const names = r.capabilities.map((c) => c.name).sort();
  assertEquals(names, [
    "clipboard",
    "device",
    "dialogs",
    "fs",
    "keepAwake",
    "secureStore",
    "shell",
    "sqlite",
  ]);
  // echo is a diagnostic — only when capabilities.echo === true.
  const withEcho = await resolveDesktopCapabilities({ desktop: { capabilities: { echo: true } } });
  assertEquals(withEcho.capabilities.map((c) => c.name), ["echo"]);
});

Deno.test("resolver CV-3: a data-storing cap without desktop.app.identifier is refused", async () => {
  for (const cap of ["secureStore", "fs", "sqlite"]) {
    const err = await assertRejects(
      () => resolveDesktopCapabilities({ desktop: { capabilities: { [cap]: true } } }),
      Error,
      "desktop.app.identifier",
    );
    assert(String(err).includes("secureStore/fs/sqlite"), `${cap}: names the risk`);
  }
  // A cap that persists nothing (device) needs no identifier.
  const ok = await resolveDesktopCapabilities({ desktop: { capabilities: { device: true } } });
  assertEquals(ok.capabilities.map((c) => c.name), ["device"]);
});

Deno.test("resolver CV-3: two apps get distinct app-support dirs (and keychain services)", async () => {
  const mk = (id: string) =>
    resolveDesktopCapabilities({
      desktop: { app: { identifier: id }, capabilities: { sqlite: true } },
    });
  const a = await mk("com.example.appA");
  const b = await mk("com.example.appB");
  assert(a.appSupportDir !== b.appSupportDir, "distinct app-support dirs");
  assert(a.appSupportDir.includes("com.example.appA"), a.appSupportDir);
  assert(b.appSupportDir.includes("com.example.appB"), b.appSupportDir);
  // secureStore's keychain service is the identifier too, so distinct ids ⇒ distinct services.
});

Deno.test("resolver: authSessionEnabled gates the loopback OAuth endpoint", async () => {
  assertEquals((await resolveDesktopCapabilities(undefined)).authSessionEnabled, false);
  assertEquals(
    (await resolveDesktopCapabilities({ desktop: { capabilities: {} } })).authSessionEnabled,
    false,
  );
  assertEquals(
    (await resolveDesktopCapabilities({ desktop: { capabilities: { authSession: true } } }))
      .authSessionEnabled,
    true,
  );
});

Deno.test("resolver: an extension module is loaded from its default export", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-ext-" });
  try {
    const ext = join(dir, "scanner.ts");
    await Deno.writeTextFile(
      ext,
      `import { defineDesktopExtension } from "${
        new URL("../src/build/desktop.ts", import.meta.url).href
      }";\n` +
        `export default defineDesktopExtension({ name: "scanner", methods: { ping: { handler: () => "pong" } } });\n`,
    );
    const r = await resolveDesktopCapabilities(
      { desktop: { capabilities: { extensions: [new URL(`file://${ext}`).href] } } },
    );
    assertEquals(r.capabilities.map((c) => c.name), ["scanner"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolver: a bad extension path fails fast", async () => {
  await assertRejects(
    () =>
      resolveDesktopCapabilities(
        { desktop: { capabilities: { extensions: ["file:///no/such/module-xyz.ts"] } } },
      ),
    Error,
    "cannot load extension",
  );
});

// --- catalog ⇄ runtime permission drift --------------------------------------

// The `denext desktop add` catalog (src/build/desktop-capabilities.ts) declares the per-OS
// `--allow-*` the package scripts bake in; the runtime caps declare the SAME permissions per
// method (which `doctor` reports). These two must not drift: if a cap's runtime factory starts
// spawning a program its catalog entry doesn't list (or vice-versa), the packaged binary would
// either refuse the call at run time or over-grant. This test builds each runtime cap for each OS
// and asserts the union of its method permissions equals what `desktopPermissionFlags` derives.

/** Catalog caps with NO bridge-cap object, so there are no runtime method permissions to compare
 * against: `auth-session` (a runtime loopback ENDPOINT, not a bridge cap — its opener `--allow-run` is exercised by
 * `handleDesktopAuthSession`, gated by the capability, and covered by the auth-session tests). */
const WEBVIEW_ONLY = new Set(["auth-session"]);

/** A dummy DesktopAppDirs — only the permission DECLARATIONS matter here, no I/O runs. */
const DRIFT_DIRS: DesktopAppDirs = { data: "/a", cache: "/b", documents: "/c" };

/** Build each catalog cap's runtime twin for `os` (injected no-op backends; nothing spawns). */
const DRIFT_FACTORIES: Record<string, (os: DesktopOs) => DesktopCapability> = {
  device: () => deviceCapability,
  passkeys: (os) => passkeysCapability({ os }),
  clipboard: () => clipboardCapability({ api: {} }),
  notifications: () => notificationsCapability({ api: {}, autoTopUp: false }),
  "context-menu": () => contextMenuCapability({ api: {} }),
  "global-shortcuts": () => shortcutsCapability({ api: {} }),
  "launch-at-login": () => launchAtLoginCapability({ api: {} }),
  fs: () => {
    const all = DESKTOP_CAPABILITIES.fs.all!;
    return fsCapability({ dirs: DRIFT_DIRS, read: new Set(all.read), write: new Set(all.write) });
  },
  sqlite: () => sqliteCapability(DRIFT_DIRS.data),
  shell: (os) =>
    shellCapability({
      dirs: DRIFT_DIRS,
      config: { openExternal: ["https:"], openPath: true, reveal: true, trash: true },
      os,
      spawn: () => Promise.resolve(),
    }),
  "keep-awake": (os) => keepAwakeCapability({ os }),
  "secure-store": (os) =>
    secureStoreCapability({
      service: "svc",
      os,
      run: () => Promise.resolve({ code: 0, stdout: "" }),
    }),
  dialogs: (os) =>
    dialogsCapability({
      picked: new PickedPaths(),
      os,
      run: () => Promise.resolve({ code: 0, stdout: "" }),
    }),
};

/**
 * Format the union of `perms` to `--allow-*` flags exactly as `desktopPermissionFlags` does, but
 * excluding `net`: the only net the runtime declares is `fs.download`'s unscoped `net: ["*"]`, and
 * the catalog deliberately omits it (network hosts are the loopback baseline plus the documented
 * per-host `downloadToFile` grant, never `*` baked into the binary). So `net` is out of scope for
 * this drift check; every other kind must match.
 */
function driftFlags(perms: (DesktopPermissions | undefined)[]): string[] {
  const KINDS = ["read", "write", "env", "sys", "run", "ffi"] as const;
  const union = new Map<string, Set<string>>();
  for (const p of perms) {
    for (const kind of KINDS) {
      for (const v of p?.[kind] ?? []) {
        const set = union.get(kind) ?? new Set<string>();
        set.add(v);
        union.set(kind, set);
      }
    }
  }
  return KINDS.filter((k) => union.has(k)).map((kind) => {
    const values = [...union.get(kind)!].sort();
    return values.includes("*") ? `--allow-${kind}` : `--allow-${kind}=${values.join(",")}`;
  });
}

Deno.test("catalog per-OS permissions == the runtime caps' declared method permissions", () => {
  const oses: DesktopOs[] = ["darwin", "windows", "linux"];
  for (const name of Object.keys(DESKTOP_CAPABILITIES)) {
    if (WEBVIEW_ONLY.has(name)) continue;
    const make = DRIFT_FACTORIES[name];
    assert(
      make,
      `catalog cap "${name}" has no runtime factory in the drift test — add it to DRIFT_FACTORIES ` +
        `(or to WEBVIEW_ONLY if it has no runtime cap).`,
    );
    for (const os of oses) {
      const cap = make(os);
      const actual = driftFlags(Object.values(cap.methods).map((m) => m.permissions)).sort();
      const expected = desktopPermissionFlags([name], os)
        .filter((f) => !f.startsWith("--allow-net"))
        .sort();
      assertEquals(
        actual,
        expected,
        `${name} on ${os}: runtime method permissions and the desktop-capabilities catalog have ` +
          `drifted — reconcile src/desktop/caps/${name}.ts with src/build/desktop-capabilities.ts.`,
      );
    }
  }
});

// --- device / echo: the remaining branches -----------------------------------

Deno.test("device.info: osVersion is the OS release, omitted when empty or refused; an unknown OS names itself", async () => {
  const model = { darwin: "Macintosh", windows: "Windows", linux: "Linux" }[OS];
  await withDenoProps({ osRelease: () => "24.6.0" }, async () => {
    assertEquals(await call(deviceCapability, "info", {}), { os: OS, model, osVersion: "24.6.0" });
  });
  const refused = () => {
    throw new Deno.errors.NotCapable('Requires sys access to "osRelease"');
  };
  for (const osRelease of [() => "", refused]) {
    await withDenoProps({ osRelease }, async () => {
      // No `--allow-sys=osRelease` (or an empty answer): the field is left out, never `""`.
      assertEquals(await call(deviceCapability, "info", {}), { os: OS, model });
    });
  }
  // An OS without a coarse model name reports the OS itself (still nothing identifying).
  const other = await call(deviceCapability, "info", {}, ctx({ os: "freebsd" as never })) as {
    model: string;
  };
  assertEquals(other.model, "freebsd");
});

Deno.test("echo: ping echoes its args (null when absent); emitPong pushes a pong event", async () => {
  const emitted: Array<[string, unknown]> = [];
  const c = ctx({ emit: (event, data) => void emitted.push([event, data]) });
  const ping = await call(echoCapability, "ping", { n: 1 }, c) as Record<string, unknown>;
  assertEquals([ping.echo, ping.os, typeof ping.at], [{ n: 1 }, OS, "number"]);
  assertEquals((await call(echoCapability, "ping", undefined, c) as { echo: unknown }).echo, null);
  assertEquals(await call(echoCapability, "emitPong", { hi: true }, c), { emitted: true });
  assertEquals(await call(echoCapability, "emitPong", undefined, c), { emitted: true });
  assertEquals(emitted, [["pong", { hi: true }], ["pong", null]]);
});

// --- sqlite: argument checks and bind/encode edges ---------------------------

/** The error code a call rejects with. */
async function rejectCode(p: Promise<unknown>): Promise<string> {
  const err = await assertRejects(() => p, DesktopCapError);
  return err.code;
}

Deno.test("sqlite: booleans bind as 1/0, unknown bind values as NULL; bigint params pass through", async () => {
  const { sqlite, cleanup } = await sqliteFixture();
  try {
    const { handle } = await call(sqlite, "open", { name: "binds.db" }) as { handle: string };
    await call(sqlite, "exec", { handle, sql: "CREATE TABLE t(a, b, c, d)" });
    await call(sqlite, "run", {
      handle,
      sql: "INSERT INTO t VALUES(?, ?, ?, ?)",
      params: [true, false, { not: "bytes" }, 9007199254740991n],
    });
    // `params: null` binds nothing.
    const q = await call(sqlite, "query", {
      handle,
      sql: "SELECT a, b, c, d, typeof(c) AS tc FROM t",
      params: null,
    }) as { columns: string[]; rows: unknown[][] };
    assertEquals(q.columns, ["a", "b", "c", "d", "tc"]);
    assertEquals(q.rows, [[1, 0, null, 9007199254740991, "null"]]);
    await call(sqlite, "close", { handle });
  } finally {
    await cleanup();
  }
});

Deno.test("sqlite: malformed arguments are `validation`; SQL errors other than ATTACH pass through", async () => {
  const { sqlite, cleanup } = await sqliteFixture();
  try {
    const { handle } = await call(sqlite, "open", { name: "args.db" }) as { handle: string };
    assertEquals(await rejectCode(call(sqlite, "exec", undefined)), "validation");
    assertEquals(await rejectCode(call(sqlite, "run", { handle, sql: 42 })), "validation");
    assertEquals(await rejectCode(call(sqlite, "query", undefined)), "validation");
    assertEquals(
      await rejectCode(call(sqlite, "query", { handle, sql: "SELECT ?", params: "1" })),
      "validation",
    );
    assertEquals(await rejectCode(call(sqlite, "inTransaction", undefined)), "closed");
    assertEquals(await rejectCode(call(sqlite, "open", { name: "a\0b" })), "validation");
    // A plain SQL error is not mistaken for the ATTACH refusal: it surfaces as-is.
    const err = await assertRejects(() => call(sqlite, "exec", { handle, sql: "SELEC 1" }));
    assert(!(err instanceof DesktopCapError), "a syntax error is not a mapped cap error");
    // A transaction is visible through inTransaction.
    await call(sqlite, "exec", { handle, sql: "BEGIN" });
    assertEquals(await call(sqlite, "inTransaction", { handle }), true);
    await call(sqlite, "exec", { handle, sql: "COMMIT" });
    // Closing an unknown or non-string handle is a no-op; the real handle still works after.
    assertEquals(await call(sqlite, "close", { handle: 7 }), { ok: true });
    assertEquals(await call(sqlite, "close", undefined), { ok: true });
    assertEquals(await call(sqlite, "query", { handle, sql: "SELECT 2 AS two" }), {
      columns: ["two"],
      rows: [[2]],
    });
    await call(sqlite, "close", { handle });
  } finally {
    await cleanup();
  }
});

Deno.test("sqlite: deleting a database that was never created is ok; an unusable app dir fails open", async () => {
  const { dir, sqlite, cleanup } = await sqliteFixture();
  try {
    assertEquals(await call(sqlite, "delete", { name: "never.db" }), { ok: true });
    // The app-support "directory" is a file: open cannot create it and says so.
    const file = join(dir, "not-a-dir");
    await Deno.writeTextFile(file, "x");
    await assertRejects(() => call(sqliteCapability(join(file, "sub")), "open", { name: "x.db" }));
  } finally {
    await cleanup();
  }
});

// --- fs: argument checks, listing and download edges -------------------------

Deno.test("fs: bad directory / encoding / path / data / url arguments are `validation`", async () => {
  const { dirs, cleanup } = await fsFixture();
  try {
    const fs = fsCapability({ dirs, read: new Set(["$APPDATA"]), write: new Set(["$APPDATA"]) });
    const cases: Array<[string, unknown]> = [
      ["readFile", { path: "a.txt", directory: "desktop" }],
      ["readFile", { path: "a.txt", directory: "data", encoding: "latin1" }],
      ["readFile", { path: "", directory: "data" }],
      ["readFile", undefined],
      ["writeFile", { path: "a.txt", directory: "data", data: 42 }],
      ["download", { url: 42, path: "a", directory: "data" }],
      // A picked handle with no picked-path set wired in.
      ["listDir", { path: "", directory: { picked: "h1" } }],
    ];
    for (const [method, args] of cases) {
      assertEquals(await rejectCode(call(fs, method, args)), "validation", JSON.stringify(args));
    }
  } finally {
    await cleanup();
  }
});

Deno.test("fs: listDir of a missing dir is empty, of a file errors; a dangling entry still lists", async () => {
  const { dirs, cleanup } = await fsFixture();
  try {
    const fs = fsCapability({ dirs, read: new Set(["$APPDATA"]), write: new Set(["$APPDATA"]) });
    assertEquals(await call(fs, "listDir", { path: "nope", directory: "data" }), []);
    await call(fs, "writeFile", { path: "f.txt", directory: "data", data: "x" });
    await assertRejects(() => call(fs, "listDir", { path: "f.txt", directory: "data" }));
    // Deleting a non-empty directory is a real error (not swallowed like NotFound).
    await call(fs, "writeFile", { path: "d/x", directory: "data", data: "x", recursive: true });
    await assertRejects(() => call(fs, "deleteFile", { path: "d", directory: "data" }));
    if (OS !== "windows") {
      // A symlink to nothing cannot be stat'ed: it is listed with no size/mtime.
      await Deno.symlink(join(dirs.data, "gone"), join(dirs.data, "d", "dangling"));
      const listing = await call(fs, "listDir", { path: "d", directory: "data" }) as Array<
        Record<string, unknown>
      >;
      const dangling = listing.find((e) => e.name === "dangling");
      assertEquals(dangling, { name: "dangling", type: "file", size: 0 });
    }
  } finally {
    await cleanup();
  }
});

Deno.test("fs.download: a non-2xx answer, a declared oversize body and a redirect loop all fail cleanly", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-fs-dl-edges-" });
  try {
    let hops = 0;
    const fakeFetch = ((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/missing")) return Promise.resolve(new Response("no", { status: 404 }));
      if (url.endsWith("/huge")) {
        return Promise.resolve(new Response("x", { headers: { "content-length": "999999" } }));
      }
      hops++;
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: `/loop?${hops}` } }),
      );
    }) as typeof fetch;
    const resolved: string[] = [];
    const cap = fsCapability({
      dirs: { data: root, cache: root, documents: root },
      read: new Set(["$APPDATA"]),
      write: new Set(["$APPDATA"]),
      downloadMaxBytes: 1024,
      downloadTimeoutMs: 5_000,
      resolveHost: (host) => {
        resolved.push(host);
        return Promise.resolve(["93.184.216.34"]);
      },
      fetch: fakeFetch,
    });
    const dl = (url: string) => call(cap, "download", { url, path: "out.bin", directory: "data" });
    assertEquals(await rejectCode(dl("https://files.test/missing")), "download_failed");
    assertEquals(await rejectCode(dl("https://files.test/huge")), "too_large");
    assertEquals(await rejectCode(dl("https://files.test/loop")), "download_failed");
    assertEquals(hops, 6, "the first request plus five followed redirects");
    // An IP-literal host is not looked up in DNS.
    resolved.length = 0;
    assertEquals(await rejectCode(dl("https://93.184.216.34/missing")), "download_failed");
    assertEquals(resolved, []);
    assertEquals([...Deno.readDirSync(root)], [], "no file and no .part left behind");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDownloadUrl: the default resolver checks A/AAAA answers; no DNS permission defers to --allow-net", async () => {
  const asked: string[] = [];
  const answers = (records: Record<string, string[] | Error>) => (host: string, type: string) => {
    asked.push(`${host}/${type}`);
    const r = records[type];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r ?? []);
  };
  // An AAAA answer of loopback is refused even when the A answer is public.
  await withDenoProps(
    { resolveDns: answers({ A: ["93.184.216.34"], AAAA: ["::1"] }) },
    () => assertRejects(() => checkDownloadUrl("https://rebind.test/x"), DesktopCapError),
  );
  assertEquals(asked, ["rebind.test/A", "rebind.test/AAAA"]);
  // NXDOMAIN / no AAAA: nothing to refuse (the fetch itself fails or uses the other family).
  await withDenoProps(
    { resolveDns: answers({ A: new Deno.errors.NotFound("NXDOMAIN"), AAAA: ["2001:db8::1"] }) },
    () => checkDownloadUrl("https://ok.test/x"),
  );
  // No DNS permission: stop resolving at once (the per-host net permission is the gate).
  asked.length = 0;
  await withDenoProps(
    { resolveDns: answers({ A: new Deno.errors.NotCapable("Requires net access") }) },
    () => checkDownloadUrl("https://packaged.test/x"),
  );
  assertEquals(asked, ["packaged.test/A"]);
});

Deno.test("isRefusedDownloadHost: malformed IPv4 and mapped forms are not mistaken for loopback", () => {
  for (const h of ["999.0.0.1", "::ffff:abcd", "::ffff:zz:1", "::ffff:c0a8:1"]) {
    assert(!isRefusedDownloadHost(h), h);
  }
});

// --- secureStore: argv, read-back and the real runner ------------------------

Deno.test("secureStoreCommand: Linux delete is `secret-tool clear`; a missing secret is empty stdin", () => {
  assertEquals(secureStoreCommand("linux", "delete", "svc", "tok"), {
    cmd: "secret-tool",
    args: ["clear", "service", "svc", "account", "tok"],
  });
  assertEquals(secureStoreCommand("linux", "set", "svc", "tok").stdin, "");
  assertEquals(
    secureStoreCommand("darwin", "set", "svc", "tok").stdin,
    'add-generic-password -U -a "tok" -s "svc" -w ""\n',
  );
  assertEquals(secureStoreCommand("darwin", "delete", "svc", "tok").args, [
    "delete-generic-password",
    "-a",
    "tok",
    "-s",
    "svc",
  ]);
});

Deno.test("secureStore: an empty or foreign value reads as absent; a non-string value or failed write is refused", async () => {
  let stdout = "";
  let code = 0;
  const cap = secureStoreCapability({
    service: "svc",
    os: "linux",
    run: () => Promise.resolve({ code, stdout }),
  });
  assertEquals(await call(cap, "get", { key: "k" }), null, "empty stdout");
  stdout = "%%% not base64 %%%";
  assertEquals(await call(cap, "get", { key: "k" }), null, "not written by this cap");
  stdout = `${btoa("v")}\n`;
  assertEquals(await call(cap, "get", { key: "k" }), "v");
  assertEquals(await rejectCode(call(cap, "set", { key: "k", value: 1 })), "validation");
  assertEquals(await rejectCode(call(cap, "get", { key: 1 })), "validation");
  assertEquals(await rejectCode(call(cap, "get", undefined)), "validation");
  // Off macOS the exit code alone decides whether the write landed.
  assertEquals(await call(cap, "set", { key: "k", value: "v" }), { ok: true });
  code = 1;
  assertEquals(await rejectCode(call(cap, "set", { key: "k", value: "v" })), "store_failed");
  assertEquals(await call(cap, "delete", { key: "k" }), { ok: true }, "delete is idempotent");
});

Deno.test({
  name: "runSecureCli: feeds stdin, captures stdout; a missing backend is `backend_unavailable`",
  ignore: OS === "windows",
  fn: async () => {
    // `cat` stands in for the credential CLI: no keychain is touched.
    assertEquals(await realSecureRun("cat", [], "secret on stdin"), {
      code: 0,
      stdout: "secret on stdin",
    });
    assertEquals(await realSecureRun("cat", []), { code: 0, stdout: "" });
    assertEquals(
      await rejectCode(realSecureRun("denext-no-such-credential-cli", ["get"])),
      "backend_unavailable",
    );
  },
});

// --- resolver: config shapes -------------------------------------------------

Deno.test("resolver: an fs scope object narrows read/write; unset lists keep the defaults", async () => {
  const resolve = (fs: unknown) =>
    resolveDesktopCapabilities({
      desktop: { app: { identifier: "com.example.fs-scope" }, capabilities: { fs } },
    } as never);
  const [narrow] = (await resolve({ read: ["$APPDATA"], write: [] })).capabilities;
  assertEquals(narrow.methods.readFile.permissions?.read, ["$APPDATA"]);
  assertEquals(narrow.methods.writeFile.permissions?.write, []);
  // Refused by scope before anything touches the disk.
  assertEquals(
    await rejectCode(call(narrow, "writeFile", { path: "x", directory: "data", data: "x" })),
    "forbidden",
  );
  assertEquals(
    await rejectCode(call(narrow, "readFile", { path: "x", directory: "cache" })),
    "forbidden",
  );
  const [defaults] = (await resolve({})).capabilities;
  assertEquals(defaults.methods.readFile.permissions?.read, ["$APPDATA", "$CACHE"]);
  assertEquals(defaults.methods.writeFile.permissions?.write, ["$APPDATA", "$CACHE"]);
});

Deno.test("resolver: a shell object enables only what it names (least privilege)", async () => {
  const r = await resolveDesktopCapabilities({
    desktop: { capabilities: { shell: { openExternal: ["https:"] } } },
  } as never);
  const [shell] = r.capabilities;
  assertEquals(shell.name, "shell");
  // mailto: is a default of `shell: true`, not of an explicit list.
  assertEquals(
    await rejectCode(call(shell, "openExternal", { url: "mailto:a@example.com" })),
    "forbidden",
  );
  for (const method of ["openPath", "reveal", "trash"]) {
    assertEquals(
      await rejectCode(call(shell, method, { path: join(r.appDirs.data, "f.txt") })),
      "forbidden",
      method,
    );
  }
});

Deno.test("resolver: the pinned-runtime caps map by name; passkeys: true pins no RP ID", async () => {
  const r = await resolveDesktopCapabilities({
    desktop: {
      capabilities: {
        notifications: true,
        contextMenu: true,
        globalShortcuts: true,
        launchAtLogin: true,
        passkeys: true,
      },
    },
  } as never);
  assertEquals(r.capabilities.map((c) => c.name), [
    "passkeys",
    "notifications",
    "contextMenu",
    "globalShortcuts",
    "launchAtLogin",
  ]);
  // No RP allowlist: an arbitrary RP reaches the runtime check (absent here), not `invalid_rp`.
  const passkeys = r.capabilities[0];
  const out = await call(passkeys, "create", {
    optionsJson: JSON.stringify({ rp: { id: "anything.example" } }),
  }) as { ok: boolean; error?: { code: string } };
  assertEquals(out.error?.code, "not_supported");
});

Deno.test("resolver: a relative extension resolves against `base`; a module without a default cap is refused", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-ext-rel-" });
  try {
    await Deno.writeTextFile(
      join(dir, "ok.ts"),
      `export default { name: "relative", methods: { ping: { handler: () => "pong" } } };\n`,
    );
    await Deno.writeTextFile(join(dir, "bad.ts"), `export const notDefault = 1;\n`);
    const base = new URL(`file://${join(dir, "desktop.ts")}`).href;
    const ok = await resolveDesktopCapabilities(
      { desktop: { capabilities: { extensions: ["./ok.ts"] } } },
      { base },
    );
    assertEquals(ok.capabilities.map((c) => c.name), ["relative"]);
    await assertRejects(
      () =>
        resolveDesktopCapabilities(
          { desktop: { capabilities: { extensions: ["./bad.ts"] } } },
          { base },
        ),
      Error,
      "must `export default defineDesktopExtension(...)`",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolver: a non-string desktop.app.origin fails fast", async () => {
  await assertRejects(
    () =>
      resolveDesktopCapabilities({
        desktop: { app: { identifier: "com.example.o", origin: 42 } },
      } as never),
    Error,
    "must be a string",
  );
});
