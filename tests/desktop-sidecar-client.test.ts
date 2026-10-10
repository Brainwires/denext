// The page side of sidecars (`denext/desktop/client`: sidecarStatus, onSidecarStatus,
// restartSidecar, sidecarInfo), against the fake runtime gate (tests/helpers/desktop-fake-runtime.ts)
// serving the host's real `sidecars` capability.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  isDesktopBridgeError,
  onSidecarStatus,
  restartSidecar,
  sidecarInfo,
  sidecarStatus,
} from "../src/desktop/client.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { createFakeDesktopRuntime, until } from "./helpers/desktop-fake-runtime.ts";
import type { SidecarStatus } from "../src/desktop/sidecar.ts";

/** A status as the host reports it. */
const status = (name: string, state: SidecarStatus["state"]): SidecarStatus => ({
  name,
  state,
  attempts: 0,
  restarts: 0,
  since: 1,
  port: 4100,
});

Deno.test("sidecar client: status, info and restart call the sidecars capability", async () => {
  const rt = createFakeDesktopRuntime({
    sidecars: {
      status: (args) => status((args as { name: string }).name, "ready"),
      info: (args) => ({
        name: (args as { name: string }).name,
        state: "ready",
        port: 4100,
        url: "http://127.0.0.1:4100",
        values: { token: "t" },
      }),
      restart: (args) => status((args as { name: string }).name, "starting"),
    },
  });
  const restore = rt.install();
  try {
    assertEquals((await sidecarStatus("server")).state, "ready");
    assertEquals((await sidecarInfo("server")).values, { token: "t" });
    assertEquals((await restartSidecar("server")).state, "starting");
    assertEquals(rt.calls.map((c) => [c.cap, c.method, c.args]), [
      ["sidecars", "status", { name: "server" }],
      ["sidecars", "info", { name: "server" }],
      ["sidecars", "restart", { name: "server" }],
    ]);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});

Deno.test("sidecar client: onSidecarStatus gets only that sidecar's statuses", async () => {
  const rt = createFakeDesktopRuntime({});
  const restore = rt.install();
  try {
    const seen: string[] = [];
    const stop = onSidecarStatus("server", (s) => seen.push(s.state));
    await until(() => rt.openStreams() === 1);
    rt.emit("sidecars", "status", status("other", "failed"));
    rt.emit("sidecars", "status", status("server", "backoff"));
    rt.emit("sidecars", "status", status("server", "ready"));
    await until(() => seen.length === 2);
    assertEquals(seen, ["backoff", "ready"]);
    stop();
    await until(() => rt.openStreams() === 0);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});

Deno.test("sidecar client: off desktop every call rejects unavailable", async () => {
  const err = await assertRejects(() => sidecarStatus("server"));
  assert(isDesktopBridgeError(err));
  assertEquals(err.code, "unavailable");
});
