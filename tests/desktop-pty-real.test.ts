// The `pty` capability (src/desktop/caps/pty.ts) over the runtime's REAL `Deno.openPty`, on the OS
// the test runs on: a terminal starts one of the default shells, its output reaches the owner
// window as `data` events, and its exit as an `exit` event. On Windows that terminal is a ConPTY,
// which denext's runtime has from FIRST_WINDOWS_PTY_RUNTIME (before it `Deno.openPty` threw
// `NotSupported` there and the capability answered `unsupported`). Skipped on a Deno without
// `Deno.openPty` (the stock runtime).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { DesktopCapCtx, DesktopExtensionHost } from "../src/desktop/extension.ts";
import { type OpenPty, ptyCapability } from "../src/desktop/caps/pty.ts";
import { type PtyOs, resolvePtyConfig } from "../src/desktop/pty-config.ts";

const openPty = (Deno as unknown as { openPty?: OpenPty }).openPty;
const os = Deno.build.os as PtyOs;
const MARK = "DENEXT_PTY_REAL_OK";

/** One event the capability emitted. */
interface Sent {
  readonly event: string;
  readonly data: { id: string; data: Record<string, unknown> };
  readonly window: string | undefined;
}

/** An extension host that records what the capability emits. */
function recordingHost(sent: Sent[]): { host: DesktopExtensionHost; quit: () => Promise<void> } {
  const quitHooks = new Set<() => void | Promise<void>>();
  const host = {
    emit: (event: string, data: unknown, options?: { window?: string }) =>
      void sent.push({ event, data: data as Sent["data"], window: options?.window }),
    pickedPath: () => {
      throw new Error("no picked paths");
    },
    appSupportDir: "",
    os,
    onWindowClosed: () => () => {},
    onAppQuit: (fn: () => void | Promise<void>) => {
      quitHooks.add(fn);
      return () => quitHooks.delete(fn);
    },
    windows: () => [{ id: "main", kind: "main" as const, key: "main" }],
  };
  return {
    host: host as unknown as DesktopExtensionHost,
    quit: async () => {
      for (const fn of [...quitHooks]) await fn();
    },
  };
}

function ctx(): DesktopCapCtx {
  return {
    emit: () => {},
    appSupportDir: "",
    runOnMainThread: () => Promise.reject(new Error("no UI thread")),
    secureStore: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    pickedPath: () => {
      throw new Error("no picked paths");
    },
    os,
    windowId: "main",
    signal: new AbortController().signal,
  };
}

/** Wait until `cond` holds, or fail after `ms`. */
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

Deno.test({
  name: "pty over the real Deno.openPty: a default shell's output and exit reach the window",
  ignore: typeof openPty !== "function",
  // The capability's coalescing timers and the terminal's streams end with the quit below.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const config = resolvePtyConfig(true, os);
    // Windows: `cmd.exe` from the defaults (PowerShell is slow to start); elsewhere `/bin/sh`.
    const shell = os === "windows"
      ? config.shells.find((s) => s.toLowerCase().endsWith("\\cmd.exe"))
      : config.shells.find((s) => s === "/bin/sh");
    assert(shell, `a default shell for ${os}: ${config.shells.join(", ")}`);
    const args = os === "windows" ? ["/d", "/c", `echo ${MARK}`] : ["-c", `echo ${MARK}`];
    const sent: Sent[] = [];
    const { host, quit } = recordingHost(sent);
    const cap = ptyCapability({ config, os });
    cap.setup!(host);
    try {
      const started = await cap.methods.spawn.handler(
        { cols: 80, rows: 24, shell, args },
        ctx(),
      ) as { id: string; pid: number; shell: string };
      assertEquals(started.shell, shell);
      assert(started.pid > 0);
      const output = () =>
        sent.filter((s) => s.event === "data" && s.data.id === started.id)
          .map((s) => String(s.data.data.data)).join("");
      await until(() => output().includes(MARK), 20_000, `"${MARK}" in the output`);
      await until(
        () => sent.some((s) => s.event === "exit" && s.data.id === started.id),
        20_000,
        "the exit event",
      );
      const exit = sent.find((s) => s.event === "exit" && s.data.id === started.id)!;
      assertEquals(exit.window, "main", "to the owner window");
      assertEquals(exit.data.data.exitCode, 0);
      assertStringIncludes(output(), MARK);
    } finally {
      await quit();
    }
  },
});
