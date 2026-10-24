// `denext build --compile`'s pure parts: the `--allow-*` it bakes, the files it never embeds and
// the `compile` config's validation. tests/integration/compile-app.test.ts compiles and runs an app.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  compileApp,
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
  // From 3.0.0-rc.5 the new abort is the runtime's default: only the npm pruning.
  assertEquals(toolchainCompileFlags("3.0.0-rc.5"), ["--exclude-unused-npm"]);
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
  for (
    const name of ["backend-keys.json", "stack-20261020.dump", "database.dump", "stack-1.tar.gz"]
  ) assertEquals(neverEmbedded(name), true, name);
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
  ok({ sign: true });
  ok({ sign: { entitlements: "ents.plist", notarize: false, timestampUrl: "http://ts.example" } });
  bad({ sign: "yes" }, "`compile.sign` must be a boolean");
  bad({ sign: { identity: "x" } }, "`compile.sign.identity` is not a key");
  bad({ sign: { entitlements: "" } }, "`compile.sign.entitlements`");
  bad({ sign: { notarize: "auto" } }, "`compile.sign.notarize` must be a boolean");
  bad(
    { sign: { timestampUrl: "ts.example" } },
    "`compile.sign.timestampUrl` must be an http(s) URL",
  );
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

/** A built project whose `.denext/` holds build outputs beside development state and secrets. */
async function builtProjectWithState(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_compile_embed_" });
  const files: Record<string, string> = {
    "deno.json": JSON.stringify({ name: "@acme/embed" }),
    "denext.config.ts": `export default { compile: { include: [".denext/backups"] } };\n`,
    "app/page.tsx": "export default function Page() { return null; }\n",
    ".denext/manifest.json": "{}",
    ".denext/client/app.js": "",
    ".denext/server-copies/app/page.tsx": "",
    ".denext/css-config.json": "{}",
    // Not build outputs: development state, stack backups, the backend's dev keys.
    ".denext/backend-keys.json": `{"secretKey":"sb_secret_TOPSECRET"}`,
    ".denext/backups/stack-20261020.dump": "PGDMP",
    ".denext/backups/stack-20261020.tar.gz": "",
    ".denext/rag/index.json": "{}",
    ".denext/dev.json": "{}",
    ".denext/commands.json": "{}",
    ".denext/mobile-dev-backup.json": "{}",
    ".denext/mystery": "",
  };
  for (const [path, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), text);
  }
  return dir;
}

Deno.test({
  name: "compileApp: only build outputs are embedded, never stack dumps or the backend's keys",
  ignore: Deno.build.os === "windows", // the recording `deno` is a shell script
  async fn() {
    const dir = await builtProjectWithState();
    try {
      // A `deno` that records its argv instead of compiling.
      const record = join(dir, "argv.json");
      const fake = join(dir, "fake-deno.sh");
      await Deno.writeTextFile(
        fake,
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`,
      );
      await Deno.chmod(fake, 0o755);
      const result = await compileApp(dir, { deno: fake, output: join(dir, "dist", "app") });
      const argv = (await Deno.readTextFile(record)).trim().split("\n");
      const flag = (name: string) =>
        argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
      const included = flag("--include");
      const excluded = new Set(flag("--exclude"));
      // What the binary embeds: every included file not excluded.
      const embedded: string[] = [];
      for (const path of included) {
        const abs = join(dir, path);
        if ((await Deno.stat(abs)).isFile) {
          if (!excluded.has(path)) embedded.push(path);
          continue;
        }
        for await (const e of Deno.readDir(abs)) {
          const child = `${path}/${e.name}`;
          if (!excluded.has(child)) embedded.push(child);
        }
      }
      assertEquals(included.includes(".denext"), false, "the build dir is not embedded whole");
      for (const path of [".denext/manifest.json", ".denext/client", ".denext/server-copies"]) {
        assertEquals(included.includes(path), true, path);
      }
      for (const path of embedded) {
        assertEquals(
          /backend-keys|\.dump$|stack-.*\.tar\.gz$|\/rag|dev\.json|commands\.json|mobile-dev-backup/
            .test(path),
          false,
          `${path} must not be embedded`,
        );
      }
      // `compile.include` named the backups directory: its dumps are still excluded.
      assertEquals(excluded.has(".denext/backups/stack-20261020.dump"), true);
      assertEquals(excluded.has(".denext/backups/stack-20261020.tar.gz"), true);
      // An entry the allow-list doesn't know is reported, not embedded; known state is quiet.
      assertEquals(result.skipped, ["mystery"]);
    } finally {
      await removeTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "compileApp: the compile config carries the app's minimumDependencyAge; DENEXT_MIN_DEP_AGE is forwarded",
  ignore: Deno.build.os === "windows", // the stand-in `deno` is a shell script
  fn: async () => {
    // Up to 4.5.0 `.denext/compile/deno.json` dropped the app's `minimumDependencyAge`, so a
    // just-published @denext/denext (which the app's config excludes from the hold) was refused by
    // `deno compile` for 24 h after every release, and the operator's DENEXT_MIN_DEP_AGE never
    // reached it either.
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_compile_age_" }));
    const before = Deno.env.get("DENEXT_MIN_DEP_AGE");
    try {
      const policy = { exclude: ["jsr:@denext/*"] };
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ imports: {}, minimumDependencyAge: policy }),
      );
      await Deno.mkdir(join(dir, ".denext"), { recursive: true });
      // A stand-in `deno` that records its arguments and the config it was handed.
      const record = join(dir, "record.json");
      const fake = join(dir, "fake-deno.sh");
      await Deno.writeTextFile(
        fake,
        `#!/bin/sh\nout=""; prev=""\nfor a in "$@"; do\n  if [ "$prev" = "--config" ]; then cfg="$a"; fi\n` +
          `  if [ "$prev" = "--output" ]; then out="$a"; fi\n  prev="$a"\ndone\n` +
          `printf '%s\\n' "$@" > "${record}.args"\ncp "$cfg" "${record}"\n: > "$out"\n`,
      );
      await Deno.chmod(fake, 0o755);
      const compiled = async () => {
        await compileApp(dir, { deno: fake, output: join(dir, "dist", "app") });
        return {
          config: JSON.parse(await Deno.readTextFile(record)),
          args: (await Deno.readTextFile(`${record}.args`)).trim().split("\n"),
        };
      };
      Deno.env.delete("DENEXT_MIN_DEP_AGE");
      const app = await compiled();
      assertEquals(app.config.minimumDependencyAge, policy);
      assertEquals(app.args.filter((a) => a.startsWith("--min-dep-age")), []);
      Deno.env.set("DENEXT_MIN_DEP_AGE", "0");
      const forced = await compiled();
      assertEquals(forced.config.minimumDependencyAge, "0");
      assertEquals(forced.args.filter((a) => a.startsWith("--min-dep-age")), ["--min-dep-age=0"]);
    } finally {
      if (before === undefined) Deno.env.delete("DENEXT_MIN_DEP_AGE");
      else Deno.env.set("DENEXT_MIN_DEP_AGE", before);
      await removeTempDir(dir);
    }
  },
});
