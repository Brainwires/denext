// The direction-split network grant (`--allow-net-connect` / `--allow-net-listen`, denext's Deno
// from 3.0.0-rc.2, so every runtime denext 5.0 runs on) wherever denext bakes or derives
// least-privilege flags: `build --compile`, the Docker image, the desktop packaging scripts and
// `desktop run` / `dev`, a re-exec child, and the config that scopes them. Only a compile onto a
// runtime `deno compile` picks itself keeps the unscoped `--allow-net`.

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { netSplitFlags, splitNetFlag } from "../src/build/net-permissions.ts";
import {
  compileBuildFlags,
  compilePermissionFlags,
  wantsNetSplit,
} from "../src/build/compile-app.ts";
import { desktopBuildFlags } from "../src/build/desktop-capabilities.ts";
import { desktopPackageFlags } from "../src/build/desktop-capabilities.ts";
import { withNetHosts } from "../src/build/desktop-launch.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";
import { childPermissionFlags, directionalNetFlags } from "../src/cli/run-verb.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { sidecarListError } from "../src/desktop/sidecar.ts";

Deno.test("netSplitFlags / splitNetFlag: the bare --allow-net becomes the pair, nothing else", () => {
  assertEquals(netSplitFlags(undefined, undefined), ["--allow-net-connect", "--allow-net-listen"]);
  assertEquals(netSplitFlags(["b", "a", "a"], [":3000"]), [
    "--allow-net-connect=a,b",
    "--allow-net-listen=:3000",
  ]);
  assertEquals(netSplitFlags(["*", "a"], []), ["--allow-net-connect", "--allow-net-listen"]);
  const start = ["deno", "run", "--allow-net", "--allow-read", "cli.ts", "start", "."];
  assertEquals(splitNetFlag(start, [":3000"]), [
    "deno",
    "run",
    "--allow-net-connect",
    "--allow-net-listen=:3000",
    "--allow-read",
    "cli.ts",
    "start",
    ".",
  ]);
  assertEquals(splitNetFlag(start, undefined, ["db:5432"])[2], "--allow-net-connect=db:5432");
  // The author already said what they meant: a scoped grant, -A, a directional flag, a deny.
  for (
    const words of [
      ["deno", "run", "--allow-net=api.example.com", "x.ts"],
      ["deno", "run", "-A", "x.ts"],
      ["deno", "run", "--allow-net", "--allow-all", "x.ts"],
      ["deno", "run", "--allow-net", "--deny-net=10.0.0.1", "x.ts"],
      ["deno", "run", "--allow-net-listen=:80", "x.ts"],
      ["deno", "task", "start"],
    ]
  ) {
    assertEquals(splitNetFlag(words, [":3000"]), words, words.join(" "));
  }
});

Deno.test("compileBuildFlags: compile.permissions.netConnect / netListen bake the split on the toolchain", () => {
  // Fails before: the network grant was always the unscoped --allow-net.
  const compile = {
    permissions: { netConnect: ["db:5432", "api.example.com"], netListen: [":8080"] },
  };
  assertEquals(compileBuildFlags(compile, { netSplit: true }).slice(0, 2), [
    "--allow-net-connect=api.example.com,db:5432",
    "--allow-net-listen=:8080",
  ]);
  // One direction set: the other is unscoped.
  assertEquals(
    compileBuildFlags({ permissions: { netListen: [":3000"] } }, { netSplit: true }).slice(0, 2),
    ["--allow-net-connect", "--allow-net-listen=:3000"],
  );
  // Without the split runtime, or without a direction asked for, the baseline's --allow-net.
  assertEquals(compileBuildFlags(compile)[0], "--allow-net");
  assertEquals(compileBuildFlags(compile, { netSplit: false })[0], "--allow-net");
  assertEquals(
    compileBuildFlags({ permissions: { sys: ["*"] } }, { netSplit: true })[0],
    "--allow-net",
  );
  assertEquals(compileBuildFlags(undefined, { netSplit: true })[0], "--allow-net");
  assertEquals(compileBuildFlags({ permissions: "all" }, { netSplit: true }), ["--allow-all"]);
  assert(wantsNetSplit({ permissions: { netConnect: [] } }));
  assertFalse(wantsNetSplit({ permissions: "all" }));
  assertFalse(wantsNetSplit(undefined));
});

Deno.test("compilePermissionFlags: the split only on the toolchain's own denort, else a warning", () => {
  const compile = { permissions: { netListen: [":3000"] } };
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  assertEquals(compilePermissionFlags(compile, true, warn).slice(0, 2), [
    "--allow-net-connect",
    "--allow-net-listen=:3000",
  ]);
  assertEquals(warnings, []);
  // `deno compile`'s own denort (a DENEXT_DENO=<path> build of another version, an explicit
  // `deno`): --allow-net and a warning.
  assertEquals(compilePermissionFlags(compile, false, warn)[0], "--allow-net");
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("need the pinned toolchain's own denort"), warnings[0]);
  // Nothing asked for: no warning.
  compilePermissionFlags({ permissions: { sys: ["*"] } }, false, warn);
  assertEquals(warnings.length, 1);
});

Deno.test("desktopBuildFlags: the pinned runtime listens on loopback only and connects where it must", () => {
  // Fails before: one --allow-net held every host, so the app (or a dependency) could listen on
  // any of them.
  const config = {
    spa: { proxy: { target: "https://api.example.com", allowNonLoopback: true } },
    desktop: {
      update: { manifestUrl: "https://updates.example.com/app.json" },
      extraPermissions: { net: ["both.example.com"], netConnect: ["out.example.com"] },
      sidecars: [{
        name: "srv",
        run: { module: "./srv.ts" },
        permissions: { netListen: ["0.0.0.0:7000"] },
      }],
    },
  };
  const split = desktopBuildFlags(config, "linux", { netSplit: true });
  assertEquals(split.slice(0, 2), [
    "--allow-net-connect=127.0.0.1,api.example.com,both.example.com,localhost,out.example.com," +
    "updates.example.com",
    "--allow-net-listen=0.0.0.0:7000,127.0.0.1,both.example.com,localhost",
  ]);
  assertFalse(split.some((f) => /^--allow-net(=|$)/.test(f)), "never both models");
  // The stock runtime: every host in the one --allow-net, as before.
  const stock = desktopBuildFlags(config, "linux");
  assertEquals(
    stock[0],
    "--allow-net=0.0.0.0:7000,127.0.0.1,api.example.com,both.example.com,localhost," +
      "out.example.com,updates.example.com",
  );
  assertFalse(stock.some((f) => f.startsWith("--allow-net-")));
  // "*" (a sidecar that talks to any host) leaves that direction unscoped.
  const any = desktopBuildFlags(
    { desktop: { extraPermissions: { netConnect: ["*"] } } },
    "darwin",
    { netSplit: true },
  );
  assertEquals(any.slice(0, 2), ["--allow-net-connect", "--allow-net-listen=127.0.0.1,localhost"]);
});

Deno.test("withNetHosts: `desktop dev --lan` hosts join --allow-net-connect under the split", () => {
  const split = [
    "--allow-net-connect=127.0.0.1,localhost",
    "--allow-net-listen=127.0.0.1",
    "--allow-read",
  ];
  assertEquals(withNetHosts(split, ["192.168.1.5"]), [
    "--allow-net-connect=127.0.0.1,192.168.1.5,localhost",
    "--allow-net-listen=127.0.0.1",
    "--allow-read",
  ]);
  assertEquals(withNetHosts(["--allow-net-connect", "--allow-net-listen=x"], ["h"]), [
    "--allow-net-connect",
    "--allow-net-listen=x",
  ]);
  // The stock flags keep their behaviour.
  assertEquals(withNetHosts(["--allow-net=127.0.0.1"], ["h"]), ["--allow-net=127.0.0.1,h"]);
});

Deno.test("desktopPackageFlags: a packaging script bakes the split, whatever deno is on PATH", async () => {
  // denext 5.0 refuses to package on anything but its runtime, which has the split: no probe of
  // the `deno` on PATH, no stock-runtime branch.
  const dir = await Deno.makeTempDir();
  try {
    const flags = await desktopPackageFlags(
      toFileUrl(join(dir, "scripts", "package.ts")).href,
      "linux",
    );
    assert(flags.some((f) => f.startsWith("--allow-net-listen")), flags.join(" "));
    assertFalse(flags.includes("--allow-net"), flags.join(" "));
    // An explicit `false` still gives the single grant (a caller that builds for another runtime).
    const one = await desktopPackageFlags(
      toFileUrl(join(dir, "scripts", "package.ts")).href,
      "linux",
      false,
    );
    assert(
      one.some((f) => f.startsWith("--allow-net")) &&
        !one.some((f) => f.startsWith("--allow-net-")),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderDockerfile: the server listens only on its port; the static server only listens", () => {
  const startCommand = [
    "deno",
    "run",
    "--allow-net",
    "--allow-read",
    "--allow-env",
    "--allow-write=.denext",
    "jsr:@denext/denext@^4.0.0/cli",
    "start",
    ".",
  ];
  const server = renderDockerfile({ mode: "server", port: 8080, startCommand, netSplit: true });
  assert(
    server.includes(
      'CMD ["deno", "run", "--allow-net-connect", "--allow-net-listen=:8080,[::]:8080", "--allow-read",',
    ),
    server,
  );
  assert(server.includes("A new port needs --allow-net-listen changed too."));
  const legacy = renderDockerfile({ mode: "server", port: 8080, startCommand, netSplit: false });
  assert(legacy.includes('CMD ["deno", "run", "--allow-net", "--allow-read",'));
  assertFalse(legacy.includes("--allow-net-listen"));
  const spa = renderDockerfile({ mode: "static", port: 8000, netSplit: true });
  assert(
    spa.includes('CMD ["deno", "run", "--allow-net-listen=0.0.0.0:8000", "--allow-read",'),
    spa,
  );
  assertFalse(spa.includes("--allow-net-connect"), "the file server reaches nothing");
  const spaLegacy = renderDockerfile({ mode: "static", port: 8000, netSplit: false });
  assert(spaLegacy.includes('CMD ["deno", "run", "--allow-net", "--allow-read",'));
});

Deno.test("directionalNetFlags: a re-exec child keeps the parent's split grants", async () => {
  const states = (s: Record<string, Deno.PermissionState | "partial">) => (name: string) =>
    Promise.resolve(
      s[name] === "partial"
        ? { state: "granted" as const, partial: true }
        : { state: s[name] ?? "prompt", partial: false },
    );
  // Directional model: `net` reads prompt; each unscoped direction passes on.
  assertEquals(
    await directionalNetFlags(false, states({ "net-connect": "granted", "net-listen": "granted" })),
    ["--allow-net-connect", "--allow-net-listen"],
  );
  assertEquals(
    await directionalNetFlags(false, states({ "net-connect": "denied" })),
    ["--deny-net-connect"],
  );
  // A direction granted only in part (a deny list beside the allow) is not widened to a bare
  // allow: the child is refused instead.
  assertEquals(
    await directionalNetFlags(false, states({ "net-connect": "partial", "net-listen": "granted" })),
    ["--allow-net-listen"],
  );
  assertEquals(
    await directionalNetFlags(false, states({ "net-connect": "partial", "net-listen": "denied" })),
    ["--deny-net-listen"],
  );
  // The legacy model (granted, or denied) or a Deno without the names: nothing to add.
  assertEquals(await directionalNetFlags(true, states({ "net-connect": "granted" })), []);
  assertEquals(
    await directionalNetFlags(false, states({ net: "denied", "net-connect": "denied" })),
    [],
  );
  assertEquals(await directionalNetFlags(false, () => Promise.reject(new TypeError("name"))), []);
  // This process (stock or the toolchain, run with -A): the legacy model, so none.
  assertEquals(await directionalNetFlags(true), []);
});

Deno.test("childPermissionFlags: a grant held only in part is not widened for the re-exec child", async () => {
  const query = (s: Record<string, "granted" | "partial">) => (name: string) =>
    Promise.resolve(
      s[name] === "partial"
        ? { state: "granted" as const, partial: true }
        : { state: s[name] ?? ("prompt" as const), partial: false },
    );
  // `--allow-net --deny-net=host --allow-read --deny-read=/etc --allow-env`
  assertEquals(
    await childPermissionFlags(query({ net: "partial", read: "partial", env: "granted" })),
    ["--allow-env"],
  );
  assertEquals(
    await childPermissionFlags(query({ net: "granted", read: "granted" })),
    ["--allow-read", "--allow-net"],
  );
  // The real query on this process: a deny list here would have to show up as `partial`.
  const live = await Deno.permissions.query({ name: "net" });
  if (live.partial) assertFalse((await childPermissionFlags()).includes("--allow-net"));
});

Deno.test("config: the network directions are validated, and plain `net` keeps working", () => {
  const ok = (config: unknown) => validateDenextConfig(config as DenextConfig);
  ok({
    compile: { permissions: { netConnect: ["db:5432", "*.example.com"], netListen: [":3000"] } },
  });
  ok({ desktop: { extraPermissions: { net: ["a.example.com"], netListen: ["0.0.0.0:7000"] } } });
  assertThrows(
    () => ok({ compile: { permissions: { netListen: ["http://0.0.0.0:3000"] } } }),
    Error,
    "compile.permissions.netListen",
  );
  assertThrows(
    () => ok({ compile: { permissions: { netConnect: ["a b"] } } }),
    Error,
    "without spaces or commas",
  );
  assertThrows(
    () => ok({ desktop: { extraPermissions: { netConnect: ["https://x.example.com"] } } }),
    Error,
    "not a URL",
  );
  assertThrows(() => ok({ compile: { permissions: { net: ["x"] } } }), Error, "netConnect");
  assertEquals(
    sidecarListError([
      {
        name: "a",
        run: { module: "./a.ts" },
        permissions: { netConnect: ["x"], netListen: [":1"] },
      },
    ]),
    null,
  );
});
