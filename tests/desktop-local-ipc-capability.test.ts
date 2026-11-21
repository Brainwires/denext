// The `local-ipc` desktop capability (desktop.capabilities.localIpc, `denext desktop add
// local-ipc`): the packaged app bakes read and write of the default socket folder `<app data>/ipc`
// alone — `$DENO_DESKTOP_DATA/ipc` where the runtime expands the token, with
// desktop.app.identifier — and nothing on Windows (named pipes are no file of the app's folders).
// The per-socket `unix:` network grant cannot be expressed by a released runtime (it expands no
// token in a network grant), so it is baked only with `unixSocketTokens`, exactly one socket per
// listed channel. The config check, the launch-time identifier requirement and `desktop add`.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  addDesktopCapabilities,
  DESKTOP_CAPABILITIES,
  desktopBuildFlags,
} from "../src/build/desktop-capabilities.ts";
import {
  localIpcChannels,
  localIpcConfigProblem,
  localIpcNameError,
} from "../src/desktop/local-ipc-config.ts";
import { localIpcNameError as reexported } from "../src/desktop/local-ipc.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";

const ID = { identifier: "com.example.term" };

/** The flags for `localIpc` on `os` with the given runtime facts. */
function flags(
  localIpc: unknown,
  os: "darwin" | "linux" | "windows",
  options: { dataScope?: boolean; unixSocketTokens?: boolean; app?: unknown } = {},
): string[] {
  const { app = ID, ...rest } = options;
  return desktopBuildFlags({ desktop: { app, capabilities: { localIpc } } }, os, {
    netSplit: true,
    dataScope: true,
    ...rest,
  });
}

Deno.test("local-ipc: the catalog entry bakes the socket folder alone on macOS and Linux", () => {
  const cap = DESKTOP_CAPABILITIES["local-ipc"];
  assertEquals(cap.key, "localIpc");
  assertEquals(cap.trust, "scoped");
  assertEquals(cap.os?.darwin, { read: ["$APPDATA/ipc"], write: ["$APPDATA/ipc"] });
  assertEquals(cap.os?.linux, { read: ["$APPDATA/ipc"], write: ["$APPDATA/ipc"] });
  assertEquals(cap.os?.windows, undefined);
  assert(cap.manual?.some((m) => m.includes("unix:<socket path>")));
});

Deno.test("local-ipc: write is scoped to $DENO_DESKTOP_DATA/ipc where the runtime expands it", () => {
  for (const os of ["darwin", "linux"] as const) {
    const f = flags(true, os);
    assert(f.includes("--allow-write=$DENO_DESKTOP_DATA/ipc"), `${os}: ${f.join(" ")}`);
    // No network grant for a socket: no released runtime expands the token there.
    assert(!f.some((x) => x.includes("unix:")), f.join(" "));
  }
  // A runtime without the token (or no identifier): the broad write, as for fs.
  assert(flags(true, "darwin", { dataScope: false }).includes("--allow-write"));
  assert(flags(true, "linux", { app: {} }).includes("--allow-write"));
  // Windows: nothing beyond the baseline.
  assert(!flags(true, "windows").some((x) => x.startsWith("--allow-write")));
  // Disabled: nothing.
  assert(!flags(false, "darwin").some((x) => x.startsWith("--allow-write")));
});

Deno.test("local-ipc: strict mode reads the socket folder alone (beside the app folders)", () => {
  const f = desktopBuildFlags(
    { desktop: { app: ID, permissions: "strict", capabilities: { localIpc: true } } },
    "linux",
    { netSplit: true, dataScope: true },
  );
  const read = f.find((x) => x.startsWith("--allow-read="));
  assert(read?.split("=")[1].split(",").includes("$DENO_DESKTOP_DATA/ipc"), read);
});

Deno.test("local-ipc: with unixSocketTokens each channel is one exact socket grant, both directions", () => {
  const f = flags({ channels: ["control", "events", "control"] }, "darwin", {
    unixSocketTokens: true,
  });
  const sockets =
    "unix:$DENO_DESKTOP_DATA/ipc/control.sock,unix:$DENO_DESKTOP_DATA/ipc/events.sock";
  assert(f.includes(`--allow-net-connect=127.0.0.1,localhost,${sockets}`), f.join(" "));
  assert(f.includes(`--allow-net-listen=127.0.0.1,localhost,${sockets}`), f.join(" "));
  // Never without the folder scope (an unexpanded token is no path), nor on Windows.
  const noScope = flags({ channels: ["control"] }, "darwin", {
    unixSocketTokens: true,
    dataScope: false,
  });
  assert(!noScope.some((x) => x.includes("unix:")), noScope.join(" "));
  assert(
    !flags({ channels: ["c"] }, "windows", { unixSocketTokens: true }).some((x) =>
      x.includes("unix:")
    ),
  );
  // `true` lists no channel: no socket grant.
  assert(!flags(true, "linux", { unixSocketTokens: true }).some((x) => x.includes("unix:")));
});

Deno.test("local-ipc: a bad value fails the build and the config check", () => {
  assertThrows(() => flags({ channels: ["../x"] }, "linux"), Error, "channel name");
  assertEquals(localIpcConfigProblem(undefined), null);
  assertEquals(localIpcConfigProblem(true), null);
  assertEquals(localIpcConfigProblem({ channels: ["a", "b.c_d-e"] }), null);
  assertEquals(localIpcConfigProblem([])?.[0], "desktop.capabilities.localIpc");
  assertEquals(localIpcConfigProblem({ dir: "/x" })?.[0], "desktop.capabilities.localIpc.dir");
  assertEquals(
    localIpcConfigProblem({ channels: "a" })?.[0],
    "desktop.capabilities.localIpc.channels",
  );
  assertEquals(
    localIpcConfigProblem({ channels: ["a b"] })?.[0],
    "desktop.capabilities.localIpc.channels",
  );
  assertEquals(localIpcChannels(true), []);
  assertEquals(localIpcChannels({ channels: ["a", "a", "b"] }), ["a", "b"]);
  assertThrows(
    () =>
      validateDenextConfig(
        { desktop: { capabilities: { localIpc: { channels: [""] } } } } as unknown as DenextConfig,
      ),
    Error,
    "desktop.capabilities.localIpc.channels",
  );
  // The name rule moved with the config check; local-ipc.ts re-exports the same function.
  assertEquals(reexported, localIpcNameError);
});

Deno.test("local-ipc: the app needs desktop.app.identifier at launch (it names the socket folder)", async () => {
  await assertRejects(
    () => resolveDesktopCapabilities({ desktop: { capabilities: { localIpc: true } } }),
    Error,
    "localIpc",
  );
  const ok = await resolveDesktopCapabilities({
    desktop: { app: ID, capabilities: { localIpc: true } },
  } as never);
  assert(Array.isArray(ok.capabilities));
});

Deno.test("local-ipc: `denext desktop add local-ipc` writes localIpc: true", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-local-ipc-add-" });
  try {
    const report = await addDesktopCapabilities({ capabilities: ["local-ipc"], dir });
    assertEquals(report.added, ["local-ipc"]);
    const text = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assert(/localIpc: true/.test(text), text);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
