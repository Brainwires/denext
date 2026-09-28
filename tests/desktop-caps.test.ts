// The built-in Deno Desktop capabilities (`src/desktop/caps/**`) and the config→caps resolver.
// Handlers are called directly with a fake DesktopCapCtx; the security-critical fs path-scoping
// gets dedicated `..` / absolute / symlink-escape cases (the peer's e2e proves the wire).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DesktopCapCtx } from "../src/desktop/extension.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";
import { deviceCapability } from "../src/desktop/caps/device.ts";
import { fsCapability } from "../src/desktop/caps/fs.ts";
import { sqliteCapability } from "../src/desktop/caps/sqlite.ts";
import { shellCapability, shellPathCommand } from "../src/desktop/caps/shell.ts";
import { keepAwakeCapability } from "../src/desktop/caps/keep-awake.ts";
import {
  type SecureRunner,
  secureStoreCapability,
  secureStoreCommand,
} from "../src/desktop/caps/secure-store.ts";
import { PickedPaths } from "../src/desktop/picked-paths.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";
import type { DesktopAppDirs } from "../src/desktop/app-dirs.ts";

const OS = Deno.build.os as "darwin" | "windows" | "linux";

function ctx(overrides: Partial<DesktopCapCtx> = {}): DesktopCapCtx {
  return {
    emit: () => {},
    appSupportDir: "",
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

// --- shell -------------------------------------------------------------------

Deno.test("shellPathCommand: per-OS argv passes the path as a discrete arg (no injection)", () => {
  const p = "/app/data/report.pdf";
  assertEquals(shellPathCommand("darwin", "open", p), ["open", [p]]);
  assertEquals(shellPathCommand("darwin", "reveal", p), ["open", ["-R", p]]);
  // macOS trash goes through Finder (recoverable) with the path as an argv item, not interpolated.
  const [tcmd, targs] = shellPathCommand("darwin", "trash", p);
  assertEquals(tcmd, "osascript");
  assertEquals(targs[targs.length - 1], p);
  assertEquals(shellPathCommand("linux", "open", p), ["xdg-open", [p]]);
  assertEquals(shellPathCommand("linux", "trash", p), ["gio", ["trash", p]]);
  assertEquals(shellPathCommand("windows", "open", p), ["explorer.exe", [p]]);
  // Windows trash: the path is the trailing scriptblock argument, not spliced into the script.
  const [wcmd, wargs] = shellPathCommand("windows", "trash", p);
  assertEquals(wcmd, "powershell.exe");
  assertEquals(wargs[wargs.length - 1], p);
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

// --- secureStore -------------------------------------------------------------

Deno.test("secureStoreCommand: per-OS argv; the secret is argv on macOS, stdin on Linux", () => {
  const mac = secureStoreCommand("darwin", "set", "svc", "tok", "QjY0");
  assertEquals(mac.cmd, "security");
  assert(mac.args.includes("add-generic-password") && mac.args.includes("-U"));
  assertEquals(mac.args[mac.args.indexOf("-w") + 1], "QjY0");
  assertEquals(mac.stdin, undefined);
  assertEquals(secureStoreCommand("darwin", "get", "svc", "tok").args[0], "find-generic-password");

  const lin = secureStoreCommand("linux", "set", "svc", "tok", "QjY0");
  assertEquals(lin.cmd, "secret-tool");
  assertEquals(lin.args[0], "store");
  assertEquals(lin.stdin, "QjY0"); // secret on stdin, never argv
  assert(!lin.args.includes("QjY0"));
  assertEquals(secureStoreCommand("linux", "get", "svc", "tok").args[0], "lookup");
});

/** A fake macOS `security` backing an in-memory keychain, for the handler round-trip. */
function darwinKeychain(): { run: SecureRunner; store: Map<string, string> } {
  const store = new Map<string, string>();
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  const run: SecureRunner = (_cmd, args) => {
    const op = args[0];
    const key = after(args, "-a");
    if (op === "add-generic-password") {
      store.set(key, after(args, "-w"));
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
});

Deno.test("secureStore SECURITY: Windows fails closed (never a plaintext fallback)", async () => {
  const cap = secureStoreCapability({
    service: "svc",
    os: "windows",
    run: () => {
      throw new Error("the runner must not be called on the unsupported platform");
    },
  });
  for (
    const [m, a] of [["get", { key: "k" }], ["set", { key: "k", value: "v" }], ["delete", {
      key: "k",
    }]] as const
  ) {
    const err = await assertRejects(() => call(cap, m, a), DesktopCapError);
    assertEquals(err.code, "unsupported_platform");
  }
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

// --- resolver ----------------------------------------------------------------

Deno.test("resolver: no desktop config → no capabilities (default deny)", async () => {
  const r = await resolveDesktopCapabilities(undefined);
  assertEquals(r.capabilities, []);
  assert(r.appSupportDir.length > 0);
});

Deno.test("resolver: maps enabled built-ins; echo off unless explicitly true", async () => {
  const r = await resolveDesktopCapabilities({
    desktop: {
      capabilities: {
        device: true,
        fs: true,
        sqlite: true,
        shell: true,
        keepAwake: true,
        secureStore: true,
      },
    },
  });
  const names = r.capabilities.map((c) => c.name).sort();
  assertEquals(names, ["device", "fs", "keepAwake", "secureStore", "shell", "sqlite"]);
  // echo is a diagnostic — only when capabilities.echo === true.
  const withEcho = await resolveDesktopCapabilities({ desktop: { capabilities: { echo: true } } });
  assertEquals(withEcho.capabilities.map((c) => c.name), ["echo"]);
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
