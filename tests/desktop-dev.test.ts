// `denext desktop dev`: the loopback-target rule (invariant 3) and the session lifecycle
// (invariant 5 — the dev server is stopped only when this verb started it). Every edge is
// injected: no dev server starts and no window spawns.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  type DesktopDevDeps,
  type DesktopDevServer,
  desktopDevTarget,
  type DesktopWindow,
  runDesktopDev,
} from "../src/build/desktop-dev.ts";
import { devChildEnv, REEXEC_GUARD_ENV, waitForShutdownSignal } from "../src/cli/dev-attach.ts";

// ---- the target: loopback-only unless --lan (invariant 3) ------------------------------------

Deno.test("desktopDevTarget: loopback by default; a non-loopback host is refused without --lan", () => {
  assertEquals(desktopDevTarget({ port: 3000 }), {
    host: "localhost",
    url: "http://localhost:3000",
  });
  assertEquals(desktopDevTarget({ host: "127.0.0.1", port: 5000 }), {
    host: "127.0.0.1",
    url: "http://127.0.0.1:5000",
  });
  assertThrows(
    () => desktopDevTarget({ host: "192.168.1.5", port: 3000 }),
    Error,
    "refusing a non-loopback",
  );
});

Deno.test("desktopDevTarget --lan picks the LAN IPv4, and rejects --host / no address", () => {
  assertEquals(
    desktopDevTarget({ lan: true, port: 3000 }, () => "192.168.1.5"),
    { host: "192.168.1.5", url: "http://192.168.1.5:3000" },
  );
  assertThrows(
    () => desktopDevTarget({ lan: true, host: "x", port: 3000 }, () => "192.168.1.5"),
    Error,
    "drop --host",
  );
  assertThrows(
    () => desktopDevTarget({ lan: true, port: 3000 }, () => null),
    Error,
    "no LAN IPv4",
  );
});

Deno.test("desktopDevTarget brackets an IPv6 loopback host", () => {
  assertEquals(desktopDevTarget({ host: "::1", port: 3000 }), {
    host: "::1",
    url: "http://[::1]:3000",
  });
});

// ---- the session lifecycle (invariant 5) -----------------------------------------------------

/** A controllable dev server and window, recording how often each was stopped. */
function fakes(attached: boolean, windowFinished: Promise<void> = new Promise(() => {})) {
  let serverStopped = 0;
  let windowStopped = 0;
  let spawnedUrl: string | undefined;
  const server: DesktopDevServer = {
    url: "http://localhost:3000",
    attached,
    finished: new Promise(() => {}),
    stop: () => {
      serverStopped++;
      return Promise.resolve();
    },
  };
  const window: DesktopWindow = {
    finished: windowFinished,
    stop: () => {
      windowStopped++;
      return Promise.resolve();
    },
  };
  const lines: string[] = [];
  const deps: DesktopDevDeps = {
    startServer: () => Promise.resolve(server),
    spawnWindow: (url) => {
      spawnedUrl = url;
      return Promise.resolve(window);
    },
    waitForStop: () => Promise.resolve(), // Ctrl-C immediately
    log: (l) => lines.push(l),
    os: "darwin",
  };
  return {
    deps,
    lines,
    serverStopped: () => serverStopped,
    windowStopped: () => windowStopped,
    spawnedUrl: () => spawnedUrl,
  };
}

Deno.test("desktop dev opens the window against the dev server and stops both on Ctrl-C", async () => {
  const f = fakes(false);
  await runDesktopDev(f.deps);
  // The window names its OS, so the dev server serves it the `.macos` / `.desktop` files.
  assertEquals(
    f.spawnedUrl(),
    "http://localhost:3000/?__denext_platform=macos",
    "the window proxies to the dev server",
  );
  assertEquals(f.windowStopped(), 1);
  assertEquals(f.serverStopped(), 1, "a dev server this verb started is stopped");
  assertStringIncludes(f.lines.join("\n"), "the window loads http://localhost:3000");
});

Deno.test("desktop dev leaves an attached dev server running on exit (invariant 5)", async () => {
  const f = fakes(true);
  await runDesktopDev(f.deps);
  assertEquals(f.windowStopped(), 1);
  assertEquals(f.serverStopped(), 0, "an attached dev server is never stopped");
  assertStringIncludes(f.lines.join("\n"), "attached to the running dev server");
});

Deno.test("desktop dev stops a started dev server when the window closes itself", async () => {
  const f = fakes(false, Promise.resolve()); // the window exits on its own
  let until: AbortSignal | undefined;
  const deps = {
    ...f.deps,
    waitForStop: (signal: AbortSignal) => { // no Ctrl-C
      until = signal;
      return new Promise<void>(() => {});
    },
  };
  await runDesktopDev(deps);
  assertEquals(f.windowStopped(), 1);
  assertEquals(f.serverStopped(), 1);
  assertEquals(until?.aborted, true, "the session stops listening for Ctrl-C when it ends");
});

Deno.test("desktop dev stops listening for Ctrl-C when the dev server fails to start", async () => {
  const f = fakes(false);
  let until: AbortSignal | undefined;
  await assertRejects(
    () =>
      runDesktopDev({
        ...f.deps,
        startServer: () => Promise.reject(new Error("no dev server")),
        waitForStop: (signal) => {
          until = signal;
          return new Promise<void>(() => {});
        },
      }),
    Error,
    "no dev server",
  );
  assertEquals(until?.aborted, true);
});

Deno.test("waitForShutdownSignal removes its signal listeners once `until` aborts", async () => {
  // Under the op / resource sanitizers a listener left registered fails this test: it keeps the
  // event loop alive and would swallow the next Ctrl-C after the session ended.
  const ac = new AbortController();
  let settled = false;
  waitForShutdownSignal(ac.signal).then(() => settled = true);
  ac.abort();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(settled, false, "an ended session's wait never settles");
  // Already aborted: nothing is registered at all.
  waitForShutdownSignal(ac.signal).then(() => settled = true);
});

// ---- the dev server child: never the parent's re-exec guards --------------------------------

Deno.test("devChildEnv: the dev server child drops the CSS / module re-exec guards", () => {
  // `desktop dev` itself runs under its CSS config (DENEXT_CSS_ACTIVE set). A `denext dev` child
  // that inherited the guard skipped its own re-exec and failed every stylesheet project's page
  // with `Import "denext/…" not a dependency`.
  const parent = {
    PATH: "/usr/bin",
    DENEXT_CSS_ACTIVE: "1",
    DENEXT_MODULE_ACTIVE: "1",
    DENEXT_TOOLCHAIN_ACTIVE: "2.9.7-denext.21",
  };
  const env = devChildEnv(parent, { DENEXT_DEV_TOKEN: "ab".repeat(32) });
  for (const name of REEXEC_GUARD_ENV) assertEquals(env[name], undefined, name);
  assertEquals(env.PATH, "/usr/bin");
  assertEquals(env.DENEXT_TOOLCHAIN_ACTIVE, "2.9.7-denext.21");
  assertEquals(env.DENEXT_DEV_TOKEN, "ab".repeat(32));
  assertEquals(parent.DENEXT_CSS_ACTIVE, "1", "the parent's environment is not changed");
  assertEquals(devChildEnv({ A: "1" }), { A: "1" });
});
