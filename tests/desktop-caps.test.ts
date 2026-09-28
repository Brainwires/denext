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

// --- resolver ----------------------------------------------------------------

Deno.test("resolver: no desktop config → no capabilities (default deny)", async () => {
  const r = await resolveDesktopCapabilities(undefined);
  assertEquals(r.capabilities, []);
  assert(r.appSupportDir.length > 0);
});

Deno.test("resolver: maps enabled built-ins; echo off unless explicitly true", async () => {
  const r = await resolveDesktopCapabilities({
    desktop: { capabilities: { device: true, fs: true, sqlite: true, shell: true } },
  });
  const names = r.capabilities.map((c) => c.name).sort();
  assertEquals(names, ["device", "fs", "shell", "sqlite"]);
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
