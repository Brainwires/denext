// The production server's resource limits (src/build/resource-limits.ts, `start.limits`): the
// config's validation, the flags each path produces — the `denext start` child, a server already
// on the toolchain, the `build --compile` argv, the Docker image — the stock-Deno gate, and one
// real run on denext's Deno that ends at its memory limit with the documented exit code.
// The systemd unit and fly.toml are in tests/deploy-presets.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  currentDenoIdentity,
  FIRST_RESOURCE_LIMITS_RUNTIME,
  isDenextDenoVersion,
  supportsResourceLimits,
} from "../src/build/deno-version.ts";
import {
  compileLimitFlags,
  configTextLimits,
  configuredLimitFlags,
  limitFlagsFor,
  LIMITS_APPLIED_ENV,
  pinnedLimitFlags,
  resourceLimitFlags,
  withLimitFlags,
} from "../src/build/resource-limits.ts";
import { memoryLimitBytes } from "../src/server/config-validate/limits.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";
import { resolveDocker } from "../src/build/docker-detect.ts";
import { childLimits, startLimits } from "../src/cli/run-verb.ts";
import { maybeReexecToolchain, type ReexecToolchainDeps } from "../src/cli/self-exec.ts";
import type { DenoToolchainChoice } from "../src/build/deno-toolchain.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import toolchainPin from "../src/build/deno-toolchain-pin.json" with { type: "json" };

const FLAGS = ["--max-memory=512m", "--max-cpu-time=3600", "--max-time=86400"];

Deno.test("resource limits: denext's Deno from 3.0.0-rc.2 takes them", () => {
  assertEquals(FIRST_RESOURCE_LIMITS_RUNTIME, "3.0.0-rc.2");
  for (const v of ["3.0.0-rc.2", "3.0.0-rc.5", "3.0.0-rc.10", "3.0.0-denext.1", "3.0.0-denext.2"]) {
    assert(supportsResourceLimits(v), v);
  }
  for (const v of ["3.0.0-rc.1", "2.9.7-denext.22", "2.9.8", "garbage", ""]) {
    assert(!supportsResourceLimits(v), v);
  }
  // The pinned toolchain takes them (the generated files rely on it).
  assert(supportsResourceLimits(toolchainPin.version));
});

Deno.test("resource limits: the config's values become the runtime's flags", () => {
  assertEquals(
    resourceLimitFlags({ memory: 512, cpuSeconds: 3600, deadlineSeconds: 86400 }),
    FLAGS,
  );
  assertEquals(resourceLimitFlags({ memory: "2G" }), ["--max-memory=2g"]);
  assertEquals(resourceLimitFlags({ memory: " 65536 kb " }), ["--max-memory=65536kb"]);
  assertEquals(resourceLimitFlags({ deadlineSeconds: 60 }), ["--max-time=60"]);
  assertEquals(resourceLimitFlags({}), []);
  assertEquals(resourceLimitFlags(undefined), []);
  // A value the runtime would refuse is never passed (the validator reports it).
  assertEquals(resourceLimitFlags({ memory: 16, cpuSeconds: 0, deadlineSeconds: 1.5 }), []);
  // The runtime's units: binary, a plain number is megabytes, at least 32 MB.
  assertEquals(memoryLimitBytes(32), 32 * 2 ** 20);
  assertEquals(memoryLimitBytes("32768k"), 32 * 2 ** 20);
  assertEquals(memoryLimitBytes("1g"), 2 ** 30);
  for (const bad of [31, "31m", "32767k", "0", -64, 64.5, "64 megs", "", null, true]) {
    assertEquals(memoryLimitBytes(bad), null, String(bad));
  }
});

Deno.test("resource limits: `start.limits` is validated when the config loads", () => {
  const error = (config: unknown) => {
    try {
      validateDenextConfig(config as DenextConfig);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  assertEquals(error({ start: { limits: {} } }), "");
  assertEquals(
    error({ start: { limits: { memory: "1g", cpuSeconds: 1, deadlineSeconds: 9 } } }),
    "",
  );
  assertEquals(error({ start: { idleTrim: false, limits: { memory: 64 } } }), "");
  assertStringIncludes(error({ start: { limits: 512 } }), "`start.limits` must be an object");
  assertStringIncludes(
    error({ start: { limits: { memory: "16m" } } }),
    "`start.limits.memory` must be at least 32 MB",
  );
  assertStringIncludes(
    error({ start: { limits: { cpuSeconds: 0 } } }),
    "`start.limits.cpuSeconds` must be a whole number of seconds, at least 1",
  );
  assertStringIncludes(
    error({ start: { limits: { deadlineSeconds: "1h" } } }),
    "`start.limits.deadlineSeconds` must be a whole number of seconds",
  );
  assertStringIncludes(error({ start: { limits: { maxMemory: 64 } } }), "`start.limits.maxMemory`");
});

Deno.test("resource limits: never passed to a runtime that would refuse them", () => {
  assertEquals(limitFlagsFor("3.0.0-denext.2", FLAGS), FLAGS);
  assertEquals(limitFlagsFor("3.0.0-rc.2", FLAGS), FLAGS);
  // Stock Deno, a DENEXT_DENO=<path> binary of unknown version, an older toolchain.
  for (const runtime of [undefined, "path", "3.0.0-rc.1", "2.9.7-denext.22"]) {
    assertEquals(limitFlagsFor(runtime, FLAGS), [], String(runtime));
  }
  assertEquals(pinnedLimitFlags(FLAGS), FLAGS);
  assertEquals(pinnedLimitFlags(FLAGS, "3.0.0-rc.1"), []);
  // The start child gets them with the marker naming them; none, no marker.
  assertEquals(childLimits("3.0.0-denext.2", FLAGS), {
    flags: FLAGS,
    env: { [LIMITS_APPLIED_ENV]: FLAGS.join(" ") },
  });
  assertEquals(childLimits(undefined, FLAGS), { flags: [], env: {} });
});

Deno.test("resource limits: inserted after `run` of a `deno run` command only", () => {
  assertEquals(
    withLimitFlags(["deno", "run", "--allow-net", "jsr:@denext/denext/cli", "start"], [
      "--max-time=5",
    ]),
    ["deno", "run", "--max-time=5", "--allow-net", "jsr:@denext/denext/cli", "start"],
  );
  assertEquals(withLimitFlags(["/srv/.deno/bin/deno", "run", "x.ts"], ["--max-time=5"]), [
    "/srv/.deno/bin/deno",
    "run",
    "--max-time=5",
    "x.ts",
  ]);
  // `deno serve` and `deno task` refuse them; another program isn't Deno.
  assertEquals(withLimitFlags(["deno", "serve", "main.ts"], ["--max-time=5"]), null);
  assertEquals(withLimitFlags(["deno", "task", "start"], ["--max-time=5"]), null);
  assertEquals(withLimitFlags(["node", "run", "x"], ["--max-time=5"]), null);
});

Deno.test("resource limits: a compiled executable gets them baked in, off the toolchain a warning", () => {
  const limits = { memory: "256m", cpuSeconds: 60 };
  const warned: string[] = [];
  const warn = (m: string) => void warned.push(m);
  assertEquals(compileLimitFlags(limits, "3.0.0-denext.2", warn), [
    "--max-memory=256m",
    "--max-cpu-time=60",
  ]);
  assertEquals(warned, []);
  assertEquals(compileLimitFlags(limits, undefined, warn), []);
  assertEquals(compileLimitFlags(limits, "3.0.0-rc.1", warn), []);
  assertEquals(warned.length, 2);
  assertStringIncludes(warned[0], "start.limits (--max-memory=256m --max-cpu-time=60) are not");
  // Nothing configured: nothing to say.
  assertEquals(compileLimitFlags(undefined, undefined, warn), []);
  assertEquals(warned.length, 2);
});

Deno.test("resource limits: read from the text before a build, from the manifest after", async () => {
  // Only `start`'s own `limits`, literal values, comments ignored.
  assertEquals(
    configTextLimits(`export default {
      live: { limits: { maxConnectionsPerIp: 10 } },
      start: { idleTrim: false, limits: { memory: "1g", cpuSeconds: 60 /* , deadlineSeconds: 9 */ } },
    };`),
    { memory: "1g", cpuSeconds: 60 },
  );
  assertEquals(configTextLimits("export default { live: { limits: { memory: 64 } } };"), undefined);
  assertEquals(configTextLimits("export default { start: { idleTrim: true } };"), undefined);
  assertEquals(
    configTextLimits("// start: { limits: { memory: 64 } }\nexport default {};"),
    undefined,
  );
  assertEquals(configTextLimits("export default { start: { limits: { memory: 64 } } };"), {
    memory: 64,
  });

  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await configuredLimitFlags(dir), []);
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "export default { start: { limits: { memory: 128, deadlineSeconds: 30 } } };\n",
    );
    assertEquals(await configuredLimitFlags(dir), ["--max-memory=128m", "--max-time=30"]);
    // After a build, the evaluated config wins over the text, an empty list included.
    await Deno.mkdir(join(dir, ".denext"));
    const manifest = join(dir, ".denext", "deploy-manifest.json");
    await Deno.writeTextFile(manifest, JSON.stringify({ server: { limits: ["--max-time=5"] } }));
    assertEquals(await configuredLimitFlags(dir), ["--max-time=5"]);
    await Deno.writeTextFile(manifest, JSON.stringify({ server: { limits: [] } }));
    assertEquals(await configuredLimitFlags(dir), []);
    // A manifest from before the field: the text again.
    await Deno.writeTextFile(manifest, JSON.stringify({ server: {} }));
    assertEquals(await configuredLimitFlags(dir), ["--max-memory=128m", "--max-time=30"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resource limits: only the `start` verb asks for them", async () => {
  const dir = await Deno.makeTempDir();
  const verb = (name: string, source?: "core" | "plugin" | "project") => ({
    name,
    summary: "",
    run: () => {},
    ...(source ? { source } : {}),
  });
  try {
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "export default { start: { limits: { memory: 64 } } };\n",
    );
    assertEquals(await startLimits(verb("start"), dir), ["--max-memory=64m"]);
    for (const name of ["dev", "profile", "test", "job", "build", "export"]) {
      assertEquals(await startLimits(verb(name), dir), [], name);
    }
    assertEquals(await startLimits(verb("start", "project"), dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Recording {@linkcode ReexecToolchainDeps} for a `denext start` with limits configured. */
function deps(
  choice: DenoToolchainChoice,
  over: Partial<ReexecToolchainDeps> & { vars?: Record<string, string> } = {},
) {
  const vars: Record<string, string> = { ...over.vars };
  const seen = { spawned: [] as string[][], exits: [] as number[], warned: [] as string[] };
  const d: ReexecToolchainDeps = {
    env: (k) => vars[k],
    setEnv: (k, v) => void (vars[k] = v),
    denoVersion: "2.9.8",
    pinnedVersion: "3.0.0-denext.2",
    standalone: () => false,
    resolve: () => Promise.resolve(choice),
    spawn: (deno, marker, env) => (
      seen.spawned.push([deno, marker, JSON.stringify(env ?? {})]), Promise.resolve(137)
    ),
    exit: (code) => void seen.exits.push(code),
    warn: (m) => void seen.warned.push(m),
    limits: FLAGS,
    ...over,
  };
  return { d, seen };
}

const TOOLCHAIN: DenoToolchainChoice = {
  kind: "toolchain",
  deno: "/cache/deno",
  version: "3.0.0-denext.2",
};

/** Seams of `denext start` already on the pinned toolchain. */
const onToolchain = (over: Partial<ReexecToolchainDeps> & { vars?: Record<string, string> } = {}) =>
  deps(TOOLCHAIN, {
    denoVersion: "3.0.0-denext.2",
    denext: "3.0.0-denext.2",
    execPath: "/linked/deno",
    pids: { pid: 200, ppid: 100 },
    legacyAbort: () => Promise.resolve(false),
    ...over,
  });

Deno.test("resource limits: `denext start` from stock Deno spawns the toolchain child (which adds them)", async () => {
  const { d, seen } = deps(TOOLCHAIN);
  assert(await maybeReexecToolchain(true, d));
  assertEquals(seen.spawned.map((s) => s.slice(0, 2)), [["/cache/deno", "3.0.0-denext.2"]]);
  assertEquals(seen.exits, [137], "the limit's exit code is the CLI's");
  assertEquals(seen.warned, []);
});

Deno.test("resource limits: on stock Deno they are not passed, and a warning says so", async () => {
  const stock = deps({ kind: "stock" } as DenoToolchainChoice);
  assertEquals(await maybeReexecToolchain(true, stock.d), false);
  assertEquals(stock.seen.spawned, []);
  assertEquals(stock.seen.warned.length, 1);
  assertStringIncludes(stock.seen.warned[0], "start.limits (--max-memory=512m");
  assertStringIncludes(stock.seen.warned[0], "stock Deno");
  // A DENEXT_DENO=<path> child: its version is unknown.
  const path = deps(TOOLCHAIN, { vars: { DENEXT_TOOLCHAIN_ACTIVE: "path" } });
  assertEquals(await maybeReexecToolchain(true, path.d), false);
  assertStringIncludes(path.seen.warned.join("\n"), "DENEXT_DENO=<path>");
  // No limits configured: nothing to say.
  const quiet = deps({ kind: "stock" } as DenoToolchainChoice, { limits: [] });
  await maybeReexecToolchain(true, quiet.d);
  assertEquals(quiet.seen.warned, []);
});

Deno.test("resource limits: a server already on the toolchain without them re-runs once with them", async () => {
  const { d, seen } = onToolchain();
  assert(await maybeReexecToolchain(true, d));
  assertEquals(seen.spawned, [[
    "/linked/deno",
    "3.0.0-denext.2",
    JSON.stringify({ DENEXT_RUNTIME_FLAGS_FOR: "200" }),
  ]]);
  // Its child: told by its parent, or naming the limits it runs under — no second re-run.
  const told: Record<string, string>[] = [
    { DENEXT_RUNTIME_FLAGS_FOR: "100" },
    { [LIMITS_APPLIED_ENV]: FLAGS.join(" ") },
  ];
  for (const vars of told) {
    const child = onToolchain({ vars });
    assertEquals(await maybeReexecToolchain(true, child.d), false);
    assertEquals([child.seen.spawned.length, child.seen.warned.length], [0, 0]);
  }
  // Limits changed since the marker was written (a stale Docker image): re-run with the new ones.
  const stale = onToolchain({ vars: { [LIMITS_APPLIED_ENV]: "--max-time=5" } });
  assert(await maybeReexecToolchain(true, stale.d));
  // No limits: as before, nothing (the legacy abort is off on this runtime).
  const none = onToolchain({ limits: [] });
  assertEquals(await maybeReexecToolchain(true, none.d), false);
});

Deno.test("resource limits: on the toolchain without --allow-run, or an older one, a warning", async () => {
  const leastPrivilege = onToolchain({ legacyAbort: undefined });
  assertEquals(await maybeReexecToolchain(true, leastPrivilege.d), false);
  assertEquals(leastPrivilege.seen.spawned, []);
  assertStringIncludes(leastPrivilege.seen.warned.join("\n"), "after `run` in the start task");
  // The generated Docker image / systemd unit put them on the command line and say so: silent.
  const generated = onToolchain({
    legacyAbort: undefined,
    vars: { [LIMITS_APPLIED_ENV]: FLAGS.join(" ") },
  });
  assertEquals(await maybeReexecToolchain(true, generated.d), false);
  assertEquals(generated.seen.warned, []);
  // A toolchain from before runtime 3.0.0-rc.2 can't take them: no re-run, a warning.
  const old = onToolchain({
    denoVersion: "3.0.0-rc.1",
    denext: undefined,
    pinnedVersion: "3.0.0-rc.1",
  });
  assertEquals(await maybeReexecToolchain(true, old.d), false);
  assertEquals(old.seen.spawned, []);
  assertStringIncludes(old.seen.warned.join("\n"), "predates runtime 3.0.0-rc.2");
});

Deno.test("resource limits: the Docker server image runs its start command under them", async () => {
  const start = ["deno", "run", "--allow-net", "--allow-read", "jsr:@denext/denext/cli", "start"];
  const text = renderDockerfile({
    mode: "server",
    startCommand: start,
    netSplit: false,
    limits: ["--max-memory=384m", "--max-time=86400"],
  });
  assertStringIncludes(
    text,
    'CMD ["deno", "run", "--max-memory=384m", "--max-time=86400", "--allow-net", "--allow-read",',
  );
  assertStringIncludes(text, 'ENV DENEXT_LIMITS_APPLIED="--max-memory=384m --max-time=86400"\n');
  assert(text.indexOf("DENEXT_LIMITS_APPLIED") < text.indexOf("\nCMD "), text);
  // None: unchanged.
  assertEquals(
    renderDockerfile({ mode: "server", startCommand: start, netSplit: false, limits: [] }),
    renderDockerfile({ mode: "server", startCommand: start, netSplit: false }),
  );
  // The `deno task start` fallback can't carry them: a comment, no marker.
  const fallback = renderDockerfile({ mode: "server", limits: ["--max-time=5"] });
  assertStringIncludes(fallback, "# start.limits (--max-time=5) are not applied");
  assert(!fallback.includes("ENV DENEXT_LIMITS_APPLIED"), fallback);

  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ tasks: { start: "deno run --allow-net jsr:@denext/denext/cli start" } }),
    );
    assertEquals((await resolveDocker(dir, { target: "server" })).options.limits, undefined);
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "export default { start: { limits: { memory: 384 } } };\n",
    );
    const server = await resolveDocker(dir, { target: "server" });
    assertEquals(server.options.limits, pinnedLimitFlags(["--max-memory=384m"]));
    assertEquals(server.warnings.filter((w) => w.includes("start.limits")), []);
    assertEquals((await resolveDocker(dir, { target: "spa" })).options.limits, undefined);
    // A start task with shell syntax runs through `deno task`: a warning.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ tasks: { start: "PORT=1 deno run -A jsr:@denext/denext/cli start" } }),
    );
    const shell = await resolveDocker(dir, { target: "server" });
    assertStringIncludes(shell.warnings.join("\n"), "start.limits are not applied");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// The one real run: a program that grows its heap without bound, started with the flags
// `denext start`'s toolchain child gets for `start: { limits: { memory: 32 } }`, ends at the limit
// with exit code 137 and the runtime's message. Only on denext's Deno from runtime 3.0.0-rc.2.
const runtime = currentDenoIdentity();
const onLimitsRuntime = isDenextDenoVersion(runtime) && supportsResourceLimits(runtime.deno);

Deno.test({
  name: "resource limits: a server over its memory limit exits 137 on denext's Deno",
  ignore: !onLimitsRuntime,
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      const script = join(dir, "grow.ts");
      await Deno.writeTextFile(
        script,
        "const a: unknown[] = []; for (;;) a.push(new Array(1e5).fill({ x: Math.random() }));\n",
      );
      const { flags, env } = childLimits(runtime.deno, resourceLimitFlags({ memory: 32 }));
      assertEquals(flags, ["--max-memory=32m"]);
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", ...flags, "--no-config", script],
        env,
        stdout: "null",
        stderr: "piped",
      }).output();
      assertEquals(out.code, 137);
      assertStringIncludes(new TextDecoder().decode(out.stderr), "Memory limit exceeded");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
