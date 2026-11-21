// ptyInfoOf / ptyInfoSupport (src/desktop/pty-info.ts, exported from denext/desktop): an app with
// its own PTY backend gets the `pty` capability's PtyInfo for a Deno.Pty — the runtime's
// foreground() and ttyName where it has them, Linux's /proc otherwise — or for a bare process id;
// a throwing or null foreground() reads as nothing; bad input is a TypeError.

import { assertEquals, assertRejects } from "@std/assert";
import {
  type PtyForegroundProcess,
  ptyInfoOf,
  type PtyInfoSource,
  ptyInfoSupport,
} from "../src/build/desktop.ts";

/** A fake `/proc` with one terminal: shell 100 in group 100, vim (200) in the foreground. */
function fakeProc() {
  const files: Record<string, string> = {
    "/proc/100/stat": "100 (zsh (login)) S 1 100 100 34816 200 4194304",
    "/proc/200/comm": "vim\n",
  };
  const links: Record<string, string> = { "/proc/200/cwd": "/home/u/src" };
  return {
    os: "linux",
    readTextFile: (p: string) =>
      p in files ? Promise.resolve(files[p]) : Promise.reject(new Error("gone")),
    readLink: (p: string) =>
      p in links ? Promise.resolve(links[p]) : Promise.reject(new Error("gone")),
  };
}

const FG: PtyForegroundProcess = {
  pgid: 4242,
  pid: 4242,
  name: "vim",
  argv: ["vim", "notes.md"],
  cwd: "/Users/u/src",
};

Deno.test("ptyInfoOf: a Deno.Pty with foreground() and ttyName answers every field", async () => {
  const pty: PtyInfoSource = { pid: 77, ttyName: "/dev/ttys004", foreground: () => FG };
  assertEquals(await ptyInfoOf(pty, { os: "darwin" }), {
    pid: 77,
    tty: "/dev/ttys004",
    process: "vim",
    foregroundPid: 4242,
    foregroundGroup: 4242,
    argv: ["vim", "notes.md"],
    cwd: "/Users/u/src",
  });
  assertEquals(ptyInfoSupport(pty, "darwin"), {
    foreground: true,
    ttyName: true,
    procFallback: false,
  });
});

Deno.test("ptyInfoOf: Windows (no tty, no process group) and fields the OS refuses are left out", async () => {
  const pty: PtyInfoSource = {
    pid: 9,
    ttyName: null,
    foreground: () => ({ pgid: null, pid: 12, name: "vim.exe", argv: null, cwd: null }),
  };
  assertEquals(await ptyInfoOf(pty, { os: "windows" }), {
    pid: 9,
    process: "vim.exe",
    foregroundPid: 12,
  });
  assertEquals(ptyInfoSupport(pty, "windows").ttyName, true);
});

Deno.test("ptyInfoOf: foreground() returning null or throwing reads as nothing (no /proc fallback)", async () => {
  const proc = fakeProc();
  assertEquals(await ptyInfoOf({ pid: 100, foreground: () => null }, proc), { pid: 100 });
  const throwing: PtyInfoSource = {
    pid: 100,
    foreground: () => {
      throw new Error("ended");
    },
  };
  assertEquals(await ptyInfoOf(throwing, proc), { pid: 100 });
});

Deno.test("ptyInfoOf: a runtime without foreground() falls back to /proc on Linux only", async () => {
  const proc = fakeProc();
  assertEquals(await ptyInfoOf({ pid: 100 }, proc), {
    pid: 100,
    process: "vim",
    cwd: "/home/u/src",
  });
  assertEquals(await ptyInfoOf({ pid: 100 }, { ...proc, os: "darwin" }), { pid: 100 });
  assertEquals(ptyInfoSupport({ pid: 100 }, "linux"), {
    foreground: false,
    ttyName: false,
    procFallback: true,
  });
  assertEquals(ptyInfoSupport(undefined, "darwin"), {
    foreground: false,
    ttyName: false,
    procFallback: false,
  });
});

Deno.test("ptyInfoOf: a bare process id gets /proc's answer, and a process that is gone just its pid", async () => {
  const proc = fakeProc();
  assertEquals(await ptyInfoOf(100, proc), { pid: 100, process: "vim", cwd: "/home/u/src" });
  assertEquals(await ptyInfoOf(555, proc), { pid: 555 });
  assertEquals(await ptyInfoOf(100, { os: "windows" }), { pid: 100 });
});

Deno.test("ptyInfoOf: anything but a Deno.Pty or a positive process id is a TypeError", async () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assertRejects(() => ptyInfoOf(bad), TypeError, "positive integer");
  }
  await assertRejects(
    () => ptyInfoOf({ pid: "x" } as unknown as PtyInfoSource),
    TypeError,
    "Deno.Pty",
  );
  await assertRejects(() => ptyInfoOf(null as unknown as number), TypeError, "Deno.Pty");
});

Deno.test("ptyInfoOf: this process's own pid on the running OS answers at least its pid", async () => {
  const info = await ptyInfoOf(Deno.pid);
  assertEquals(info.pid, Deno.pid);
});
