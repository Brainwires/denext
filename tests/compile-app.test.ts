// `denext build --compile`'s pure parts: the `--allow-*` it bakes, the files it never embeds and
// the `compile` config's validation. tests/integration/compile-app.test.ts compiles and runs an app.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { compileBuildFlags, neverEmbedded } from "../src/build/compile-app.ts";
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
