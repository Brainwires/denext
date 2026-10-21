// The direction-split network grant (`--allow-net-connect` / `--allow-net-listen`, denext's Deno
// from 3.0.0-rc.2) wherever denext bakes or derives least-privilege flags: `build --compile`, the
// Docker image, the desktop packaging scripts and `desktop run` / `dev`, a re-exec child, and the
// config that scopes them. Stock Deno and older builds keep the unscoped `--allow-net` (mixing
// the two models on one command line is an error there).

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  NET_SPLIT_RELEASE,
  netSplitFlags,
  splitNetFlag,
  supportsNetSplit,
  toolchainNetSplit,
} from "../src/build/net-permissions.ts";
import {
  compileBuildFlags,
  compilePermissionFlags,
  wantsNetSplit,
} from "../src/build/compile-app.ts";
import { desktopBuildFlags } from "../src/build/desktop-capabilities.ts";
import { desktopNetSplit } from "../src/build/desktop-runtime.ts";
import { withNetHosts } from "../src/build/desktop-launch.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";
import { directionalNetFlags } from "../src/cli/run-verb.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { sidecarListError } from "../src/desktop/sidecar.ts";

Deno.test("supportsNetSplit: denext's Deno from 3.0.0-rc.2 only", () => {
  assertEquals(NET_SPLIT_RELEASE, "3.0.0-rc.2");
  for (const v of ["3.0.0-rc.2", "3.0.0-rc.3", "3.0.0-rc.10", "3.0.0-rc.2+ci.7"]) {
    assert(supportsNetSplit(v), v);
  }
  // Stock Deno, an older fork build, the first own-version rc, nothing known.
  for (const v of ["2.9.7", "2.9.7-denext.22", "3.0.0-rc.1", "3.1.0", "garbage", undefined]) {
    assertFalse(supportsNetSplit(v), String(v));
  }
  assert(toolchainNetSplit("3.0.0-rc.2"));
  assertFalse(toolchainNetSplit("2.9.7-denext.22"));
});

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
  assertEquals(compilePermissionFlags(compile, true, warn, "3.0.0-rc.2").slice(0, 2), [
    "--allow-net-connect",
    "--allow-net-listen=:3000",
  ]);
  assertEquals(warnings, []);
  // `deno compile`'s own denort, an older toolchain, stock Deno: --allow-net and a warning.
  for (
    const [own, version] of [[false, "3.0.0-rc.2"], [true, "2.9.7-denext.22"], [
      true,
      "2.9.7",
    ]] as const
  ) {
    assertEquals(compilePermissionFlags(compile, own, warn, version)[0], "--allow-net");
  }
  assertEquals(warnings.length, 3);
  assert(warnings[0].includes("netConnect / netListen need denext's Deno 3.0.0-rc.2"));
  // Nothing asked for: no warning.
  compilePermissionFlags({ permissions: { sys: ["*"] } }, false, warn, "2.9.7");
  assertEquals(warnings.length, 3);
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

Deno.test("desktopNetSplit: the pinned runtime and a Deno that parses the flags", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  const pin = { version: "3.0.0-rc.2" };
  assert(desktopNetSplit(env({}), "3.0.0-rc.2", pin));
  assert(desktopNetSplit(env({ DENEXT_DESKTOP_RUNTIME: "pinned" }), "3.0.0-rc.2", pin));
  assertFalse(desktopNetSplit(env({ DENEXT_DESKTOP_RUNTIME: "stock" }), "3.0.0-rc.2", pin));
  assertFalse(desktopNetSplit(env({ DENEXT_DESKTOP_RUNTIME_DIR: "/rt" }), "3.0.0-rc.2", pin));
  assertFalse(desktopNetSplit(env({}), "2.9.7", pin), "a stock deno compiles");
  assertFalse(desktopNetSplit(env({}), "3.0.0-rc.2", { version: "2.9.7-denext.22" }));
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
      'CMD ["deno", "run", "--allow-net-connect", "--allow-net-listen=:8080", "--allow-read",',
    ),
    server,
  );
  assert(server.includes("A new port needs its --allow-net-listen changed too."));
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
  const states = (s: Record<string, Deno.PermissionState>) => (name: string) =>
    Promise.resolve(s[name] ?? "prompt");
  // Directional model: `net` reads prompt; each unscoped direction passes on.
  assertEquals(
    await directionalNetFlags(false, states({ "net-connect": "granted", "net-listen": "granted" })),
    ["--allow-net-connect", "--allow-net-listen"],
  );
  assertEquals(
    await directionalNetFlags(false, states({ "net-connect": "denied" })),
    ["--deny-net-connect"],
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
