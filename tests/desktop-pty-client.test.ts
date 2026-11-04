// The page side of the `pty` capability (src/desktop/pty-client.ts, from `denext/desktop/client`)
// against the fake runtime gate: each function's bridge call, `onPtyData`'s `seq` guard against a
// replayed stream, `onPtyExit` once per terminal, `attachPty`'s replay shape, and off desktop.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  attachPty,
  isDesktopBridgeError,
  killPty,
  listPtys,
  onPtyData,
  onPtyExit,
  ptyInfo,
  resizePty,
  spawnPty,
  writePty,
} from "../src/desktop/client.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { createFakeDesktopRuntime, until } from "./helpers/desktop-fake-runtime.ts";

Deno.test("pty client: each function calls the pty capability with its arguments", async () => {
  const rt = createFakeDesktopRuntime({
    pty: {
      spawn: () => ({ id: "t1", pid: 7, shell: "/bin/zsh", cwd: "/home/u" }),
      write: () => null,
      resize: () => null,
      kill: () => null,
      info: () => ({ pid: 7, process: "vim" }),
      attach: () => ({
        replay: [
          { event: "data", data: { seq: 1, data: "hi" } },
          { event: "exit", data: { exitCode: 0, signal: null } },
          { event: "other", data: {} },
        ],
      }),
      list: () => [],
    },
  });
  const restore = rt.install();
  try {
    assertEquals(await spawnPty({ cols: 80, rows: 24, cwd: "/srv" }), {
      id: "t1",
      pid: 7,
      shell: "/bin/zsh",
      cwd: "/home/u",
    });
    await writePty("t1", "ls\r");
    await writePty("t1", "\x1b[M", { binary: true });
    await resizePty("t1", 100, 30);
    await killPty("t1");
    await killPty("t1", "SIGKILL");
    assertEquals(await ptyInfo("t1"), { pid: 7, process: "vim" });
    assertEquals(await attachPty("t1"), {
      replay: [
        { event: "data", seq: 1, data: "hi" },
        { event: "exit", exitCode: 0, signal: null },
      ],
    });
    assertEquals(await listPtys(), []);
    assertEquals(rt.calls.map((c) => [c.method, c.args]), [
      ["spawn", { cols: 80, rows: 24, cwd: "/srv" }],
      ["write", { id: "t1", data: "ls\r" }],
      ["write", { id: "t1", data: "\x1b[M", binary: true }],
      ["resize", { id: "t1", cols: 100, rows: 30 }],
      ["kill", { id: "t1" }],
      ["kill", { id: "t1", signal: "SIGKILL" }],
      ["info", { id: "t1" }],
      ["attach", { id: "t1" }],
      ["list", {}],
    ]);
  } finally {
    restore();
  }
});

Deno.test("pty client: onPtyData drops a repeated seq; onPtyExit fires once per terminal", async () => {
  const rt = createFakeDesktopRuntime({});
  const restore = rt.install();
  try {
    const data: string[] = [];
    const exits: unknown[] = [];
    const stopData = onPtyData(({ id, seq, data: d }) => data.push(`${id}:${seq}:${d}`));
    const stopExit = onPtyExit((e) => exits.push(e));
    await until(() => rt.openStreams() === 1);
    rt.emit("pty", "data", { id: "a", data: { seq: 1, data: "x" } });
    rt.emit("pty", "data", { id: "a", data: { seq: 2, data: "y" } });
    rt.emit("pty", "data", { id: "a", data: { seq: 1, data: "x" } }); // a replayed frame
    rt.emit("pty", "data", { id: "b", data: { seq: 1, data: "z" } });
    rt.emit("pty", "exit", { id: "a", data: { exitCode: 0, signal: null } });
    rt.emit("pty", "exit", { id: "a", data: { exitCode: 0, signal: null } });
    rt.emit("pty", "exit", { id: "b", data: { exitCode: 129, signal: "SIGHUP" } });
    await until(() => exits.length === 2);
    await rt.settled();
    assertEquals(data, ["a:1:x", "a:2:y", "b:1:z"]);
    assertEquals(exits, [
      { id: "a", exitCode: 0, signal: null },
      { id: "b", exitCode: 129, signal: "SIGHUP" },
    ]);
    stopData();
    stopExit();
    await until(() => rt.openStreams() === 0);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});

Deno.test("pty client: off desktop every call rejects unavailable", async () => {
  const err = await assertRejects(() => spawnPty({ cols: 80, rows: 24 }));
  assert(isDesktopBridgeError(err));
  assertEquals(err.code, "unavailable");
  const stop = onPtyData(() => {});
  stop();
});
