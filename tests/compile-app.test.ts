// `denext build --compile`'s pure parts: the `--allow-*` it bakes, the files it never embeds and
// the `compile` config's validation. tests/integration/compile-app.test.ts compiles and runs an app.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  compileBuildFlags,
  denortBinary,
  neverEmbedded,
  relativeCssRedirects,
  toolchainCompileFlags,
} from "../src/build/compile-app.ts";
import type { DenoToolchainPin } from "../src/build/deno-toolchain.ts";
import { runStandalone, standaloneArgv } from "../src/standalone/mod.ts";
import { runtimeStateDir, standaloneState } from "../src/server/standalone.ts";
import { removeTempDir } from "./helpers/temp.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

Deno.test("compileBuildFlags: the Docker image's least-privilege start by default", () => {
  assertEquals(compileBuildFlags(undefined), [
    "--allow-net",
    "--allow-env",
    "--allow-read",
    "--allow-write=.denext",
  ]);
});

Deno.test("compileBuildFlags: compile.permissions is unioned per kind; * is the whole kind", () => {
  assertEquals(
    compileBuildFlags({
      permissions: { write: ["app.db", ".denext"], sys: ["hostname"], run: ["*"], ffi: ["*"] },
    }),
    [
      "--allow-net",
      "--allow-env",
      "--allow-read",
      "--allow-write=.denext,app.db",
      "--allow-sys=hostname",
      "--allow-run",
      "--allow-ffi",
    ],
  );
  assertEquals(compileBuildFlags({ permissions: { write: ["*"] } })[3], "--allow-write");
});

Deno.test("compileBuildFlags: --allow-all only when the app opts in", () => {
  assertEquals(compileBuildFlags({ permissions: "all" }), ["--allow-all"]);
});

Deno.test("toolchainCompileFlags: the toolchain's npm pruning and runtime flags, none off it", () => {
  assertEquals(toolchainCompileFlags(undefined), []);
  assertEquals(toolchainCompileFlags("2.9.7-denext.21"), [
    "--exclude-unused-npm",
    "--unstable-no-legacy-abort",
  ]);
});

Deno.test("denortBinary: the pinned denort on the toolchain, nothing elsewhere", async () => {
  const artifact = { file: "deno-denort-x.zip", url: "https://example.invalid/x", sha256: "0" };
  const pin: DenoToolchainPin = {
    schema: 1,
    version: "2.9.7-denext.20",
    targets: {},
    denort: { "linux-x86_64": artifact, "darwin-aarch64": artifact },
  };
  const asked: string[] = [];
  const deps = (toolchain: string | undefined, p: DenoToolchainPin = pin) => ({
    toolchain: () => toolchain,
    pin: () => p,
    ensure: (o: { target: string }) => (asked.push(o.target), Promise.resolve({ denort: "/d" })),
  });
  assertEquals(await denortBinary("x86_64-unknown-linux-gnu", deps("2.9.7-denext.20")), "/d");
  assertEquals(await denortBinary("aarch64-apple-darwin", deps("2.9.7-denext.20")), "/d");
  assertEquals(asked, ["linux-x86_64", "darwin-aarch64"]);
  // Windows on Arm (2.9.7-denext.21 on): its own key, when the pin names it.
  const arm = { ...pin, denort: { ...pin.denort, "windows-aarch64": artifact } };
  assertEquals(await denortBinary("aarch64-pc-windows-msvc", deps("2.9.7-denext.20", arm)), "/d");
  assertEquals(asked.splice(2), ["windows-aarch64"]);
  // Off the toolchain, on another toolchain version, an unpinned target or a pin without denort:
  // deno compile picks its own.
  assertEquals(await denortBinary("x86_64-unknown-linux-gnu", deps(undefined)), undefined);
  assertEquals(await denortBinary("x86_64-unknown-linux-gnu", deps("2.9.7-denext.19")), undefined);
  assertEquals(await denortBinary("x86_64-pc-windows-msvc", deps("2.9.7-denext.20")), undefined);
  const old = { ...pin, denort: undefined };
  assertEquals(
    await denortBinary("x86_64-unknown-linux-gnu", deps("2.9.7-denext.20", old)),
    undefined,
  );
  assertEquals(asked.length, 2);
  // A verification failure is not swallowed.
  const failing = {
    ...deps("2.9.7-denext.20"),
    ensure: () => Promise.reject(new Error("SHA-256 mismatch")),
  };
  await assertRejects(() => denortBinary("x86_64-unknown-linux-gnu", failing), Error, "mismatch");
});

Deno.test("neverEmbedded: env files, SQLite databases and locks stay out of the binary", () => {
  for (const name of [".env", ".env.local", ".env.production", "app.db", "x.sqlite-wal"]) {
    assertEquals(neverEmbedded(name), true, name);
  }
  assertEquals(neverEmbedded(".denext-lock-build"), true);
  for (const name of ["env.ts", "page.tsx", "manifest.json", "db.ts"]) {
    assertEquals(neverEmbedded(name), false, name);
  }
});

Deno.test("validateDenextConfig: compile", () => {
  const ok = (compile: unknown) => validateDenextConfig({ compile } as DenextConfig);
  const bad = (compile: unknown, msg: string) => assertThrows(() => ok(compile), Error, msg);
  ok(undefined);
  ok({ include: ["lib/data.json"], permissions: { write: ["app.db"] } });
  ok({ permissions: "all" });
  bad([], "`compile` must be an object");
  bad({ include: "lib" }, "`compile.include`");
  bad({ include: ["../secrets"] }, "must stay inside the project");
  bad({ include: ["/etc/passwd"] }, "must stay inside the project");
  bad({ permissions: "most" }, "`compile.permissions`");
  bad({ permissions: { net: ["x.com"] } }, "`compile.permissions.net`");
  bad({ permissions: { write: ["a,b"] } }, "`compile.permissions.write`");
});

Deno.test("standaloneArgv: a verb or help as given, else start with the flags", () => {
  assertEquals(standaloneArgv([]), ["start"]);
  assertEquals(standaloneArgv(["--port", "8080"]), ["start", "--port", "8080"]);
  assertEquals(standaloneArgv(["job", "ping"]), ["job", "ping"]);
  assertEquals(standaloneArgv(["db", "migrate"]), ["db", "migrate"]);
  assertEquals(standaloneArgv(["--help"]), ["--help"]);
});

Deno.test("runStandalone: records the embedded project and the state dir, then dispatches", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_standalone_" }));
  const env = ["DENEXT_ENV", "NODE_ENV", "DENEXT_STATE_DIR"];
  const saved = env.map((k) => Deno.env.get(k));
  const slot = Symbol.for("denext.standalone");
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    for (const k of env) Deno.env.delete(k);
    Deno.env.set("DENEXT_STATE_DIR", join(dir, "state"));
    await Deno.mkdir(join(dir, "jobs"));
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(dir, "jobs", "ping.ts"),
      `export default { __denextJob: true, handler: () => "pong" };\n`,
    );
    await runStandalone(toFileUrl(dir + "/"), ["--help"]);
    assertStringIncludes(logs.join("\n"), "job <name>");
    assertEquals(standaloneState()?.projectDir, dir);
    assertEquals(runtimeStateDir("/build/.denext"), join(dir, "state"));
    assertEquals(Deno.env.get("NODE_ENV"), "production");
    await runStandalone(toFileUrl(dir), ["job", "--list"]);
    assertStringIncludes(logs.join("\n"), "1 job(s)");
  } finally {
    console.log = log;
    delete (globalThis as Record<symbol, unknown>)[slot];
    env.forEach((k, i) => saved[i] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[i]!));
    await removeTempDir(dir);
  }
});

Deno.test("relativeCssRedirects: stylesheet redirects name the embedded copies, relative to the config", () => {
  // A Pages Router page has no server copy: the binary imports its stylesheet at the binary's own
  // path, which only a key relative to the embedded config matches.
  const config = "file:///work/app/.denext/compile/deno.json";
  assertEquals(
    relativeCssRedirects({
      "file:///work/app/styles/globals.css": "file:///work/app/.denext/css-shims/css_0.js",
      "file:///work/app/pages/about.module.css": "file:///work/app/.denext/css-shims/css_1.js",
      "https://cdn.example/x.css": "file:///work/app/.denext/css-shims/css_2.js",
    }, config),
    {
      "../../styles/globals.css": "../css-shims/css_0.js",
      "../../pages/about.module.css": "../css-shims/css_1.js",
      "https://cdn.example/x.css": "../css-shims/css_2.js",
    },
  );
  // Each relative key resolves back to its stylesheet against the config.
  assertEquals(
    new URL("../../styles/globals.css", config).href,
    "file:///work/app/styles/globals.css",
  );
});
