// The production server's resource limits (src/build/resource-limits.ts, `start.limits`): the
// config's validation, the flags each path produces — every `denext start` re-run (only the one
// that serves gets them), the last gate and its stale-marker re-run, the `build --compile` argv and
// the compiled `job` / `db` notice, the Docker image — the stock-Deno gate, and one real chain on
// denext's Deno whose serving process ends at its memory limit with the documented exit code.
// The systemd unit and fly.toml are in tests/deploy-presets.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  currentDenoIdentity,
  FIRST_RESOURCE_LIMITS_RUNTIME,
  isDenextDenoVersion,
  supportsResourceLimits,
} from "../src/build/deno-version.ts";
import {
  bakedLimitsNotice,
  compileLimitFlags,
  configTextLimits,
  configuredLimitFlags,
  handedLimits,
  hopLimits,
  limitFlagsFor,
  LIMITS_APPLIED_ENV,
  pinnedLimitFlags,
  resourceLimitFlags,
  START_LIMITS_ENV,
  withLimitFlags,
} from "../src/build/resource-limits.ts";
import { memoryLimitBytes } from "../src/server/config-validate/limits.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";
import { resolveDocker } from "../src/build/docker-detect.ts";
import { LIMIT_HOPS, startLimits } from "../src/cli/run-verb.ts";
import {
  type LimitsGateDeps,
  maybeReexecForLimits,
  maybeReexecToolchain,
  type ReexecToolchainDeps,
} from "../src/cli/self-exec.ts";
import { entrySource } from "../src/build/compile-app.ts";
import { standaloneVerb } from "../src/standalone/mod.ts";
import { makeTempDirUntilExit } from "./helpers/temp.ts";
import { inChild } from "./helpers/isolated.ts";
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
  // The serving child gets them with the marker naming them; on stock Deno none, an empty marker.
  assertEquals(hopLimits(true, "3.0.0-denext.2", FLAGS), {
    flags: FLAGS,
    env: { [LIMITS_APPLIED_ENV]: FLAGS.join(" "), [START_LIMITS_ENV]: FLAGS.join(" ") },
  });
  assertEquals(hopLimits(true, undefined, FLAGS), {
    flags: [],
    env: { [LIMITS_APPLIED_ENV]: "", [START_LIMITS_ENV]: FLAGS.join(" ") },
  });
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

Deno.test("resource limits: only the hop that serves gets them as flags; the others as data", () => {
  const configured = resourceLimitFlags({ memory: 512, cpuSeconds: 3600, deadlineSeconds: 86400 });
  assertEquals(configured, FLAGS);
  // Each `denext start` re-run, in order: the toolchain re-exec and a compiled `denext`'s pinned
  // child may re-run again; the CSS / module-config child and the limits re-run serve.
  assertEquals(LIMIT_HOPS, {
    toolchain: false,
    pinned: false,
    css: true,
    modules: true,
    limits: true,
  });
  const argv = (hop: keyof typeof LIMIT_HOPS) => {
    const { flags, env } = hopLimits(LIMIT_HOPS[hop], "3.0.0-denext.2", configured);
    return { args: ["run", ...flags, "-A", "cli.ts", "start"], env };
  };
  for (const hop of ["toolchain", "pinned"] as const) {
    const { args, env } = argv(hop);
    assert(!args.some((a) => a.startsWith("--max-")), `${hop}: ${args.join(" ")}`);
    // Handed down as data, and the child is told it runs without them (an inherited marker
    // never speaks for it).
    assertEquals(env, { [LIMITS_APPLIED_ENV]: "", [START_LIMITS_ENV]: FLAGS.join(" ") }, hop);
    assertEquals(handedLimits(env[START_LIMITS_ENV]), FLAGS);
  }
  for (const hop of ["css", "modules", "limits"] as const) {
    const { args, env } = argv(hop);
    assertEquals(args, ["run", ...FLAGS, "-A", "cli.ts", "start"], hop);
    assertEquals(env[LIMITS_APPLIED_ENV], FLAGS.join(" "), hop);
  }
  // A serving child on a runtime that can't take them: no flags, and it is told so.
  assertEquals(hopLimits(true, undefined, configured).flags, []);
  assertEquals(hopLimits(true, "3.0.0-rc.1", configured).env[LIMITS_APPLIED_ENV], "");
  // Nothing configured (every verb but `start`): nothing at all.
  for (const serves of [true, false]) {
    assertEquals(hopLimits(serves, "3.0.0-denext.2", []), {
      flags: [],
      env: {},
    });
  }
  assertEquals(handedLimits(undefined), undefined);
  assertEquals(handedLimits(""), []);
});

/** Recording {@linkcode LimitsGateDeps} of the process about to serve `denext start`. */
function gate(over: Partial<LimitsGateDeps> = {}) {
  const seen = {
    spawned: [] as { flags: readonly string[]; env: Record<string, string> }[],
    exits: [] as number[],
    warned: [] as string[],
  };
  const d: LimitsGateDeps = {
    configured: FLAGS,
    runtime: "3.0.0-denext.2",
    applied: undefined,
    mayRespawn: true,
    pid: 200,
    spawn: (flags, env) => (seen.spawned.push({ flags, env }), Promise.resolve(137)),
    exit: (code) => void seen.exits.push(code),
    warn: (m) => void seen.warned.push(m),
    ...over,
  };
  return { d, seen };
}

Deno.test("resource limits: the process that serves re-runs once with them when it lacks them", async () => {
  // Started without them (directly on the toolchain, or after a hop that handed them down).
  for (const applied of [undefined, ""]) {
    const { d, seen } = gate({ applied });
    assert(await maybeReexecForLimits(d));
    assertEquals(seen.spawned, [{
      flags: FLAGS,
      env: {
        [LIMITS_APPLIED_ENV]: FLAGS.join(" "),
        [START_LIMITS_ENV]: FLAGS.join(" "),
        DENEXT_RUNTIME_FLAGS_FOR: "200", // its toolchain gate does not re-run it again
      },
    }]);
    assertEquals(seen.exits, [137], "the limit's exit code is the CLI's");
    assertEquals(seen.warned, []);
  }
  // Its child — started with exactly the flags this runtime takes — serves: no loop.
  const child = gate({ applied: FLAGS.join(" ") });
  assertEquals(await maybeReexecForLimits(child.d), false);
  assertEquals([child.seen.spawned.length, child.seen.warned.length], [0, 0]);
  // Nothing configured: nothing to do.
  const none = gate({ configured: [] });
  assertEquals(await maybeReexecForLimits(none.d), false);
  assertEquals([none.seen.spawned.length, none.seen.warned.length], [0, 0]);
});

Deno.test("resource limits: a stale marker is compared with the serving process's own flags", async () => {
  // Limits changed since the marker was written (a stale Docker image, an exported variable):
  // re-run with the configured ones.
  const stale = gate({ applied: "--max-time=5" });
  assert(await maybeReexecForLimits(stale.d));
  assertEquals(stale.seen.spawned[0].flags, FLAGS);
  // The same words in another order are not the flags this process was given.
  const reordered = gate({ applied: [...FLAGS].reverse().join(" ") });
  assert(await maybeReexecForLimits(reordered.d));
  // A marker naming the configured flags on a runtime that takes none of them never counts:
  // the comparison is with what this process's runtime takes, here nothing, so a warning.
  const old = gate({ runtime: "3.0.0-rc.1", applied: FLAGS.join(" ") });
  assertEquals(await maybeReexecForLimits(old.d), false);
  assertEquals(old.seen.spawned, []);
  assertStringIncludes(old.seen.warned.join("\n"), "predates runtime 3.0.0-rc.2");
});

Deno.test("resource limits: on stock Deno, an unknown Deno or without --allow-run, a warning", async () => {
  const stock = gate({ runtime: undefined });
  assertEquals(await maybeReexecForLimits(stock.d), false);
  assertEquals(stock.seen.spawned, []);
  assertEquals(stock.seen.warned.length, 1);
  assertStringIncludes(stock.seen.warned[0], "start.limits (--max-memory=512m");
  assertStringIncludes(stock.seen.warned[0], "stock Deno");
  const path = gate({ runtime: "path" });
  assertEquals(await maybeReexecForLimits(path.d), false);
  assertStringIncludes(path.seen.warned.join("\n"), "DENEXT_DENO=<path>");
  const leastPrivilege = gate({ mayRespawn: false });
  assertEquals(await maybeReexecForLimits(leastPrivilege.d), false);
  assertEquals(leastPrivilege.seen.spawned, []);
  assertStringIncludes(leastPrivilege.seen.warned.join("\n"), "after `run` in the start task");
  // The generated Docker image / systemd unit put them on the command line and say so: silent.
  const generated = gate({ mayRespawn: false, applied: FLAGS.join(" ") });
  assertEquals(await maybeReexecForLimits(generated.d), false);
  assertEquals(generated.seen.warned, []);
  // No limits configured: nothing to say.
  const quiet = gate({ runtime: undefined, configured: [] });
  await maybeReexecForLimits(quiet.d);
  assertEquals(quiet.seen.warned, []);
});

Deno.test("resource limits: the toolchain re-exec itself carries none", async () => {
  // `maybeReexecToolchain` knows nothing of the limits; run-verb's spawn adds the hand-off
  // (`LIMIT_HOPS.toolchain`), never the flags, and a server already on the toolchain no longer
  // re-runs for them there (the last gate does).
  const vars: Record<string, string> = {};
  const spawned: string[][] = [];
  const d: ReexecToolchainDeps = {
    env: (k) => vars[k],
    setEnv: (k, v) => void (vars[k] = v),
    denoVersion: "3.0.0-denext.2",
    denext: "3.0.0-denext.2",
    pinnedVersion: "3.0.0-denext.2",
    standalone: () => false,
    resolve: () => Promise.resolve({ kind: "stock" } as DenoToolchainChoice),
    spawn: (deno, marker) => (spawned.push([deno, marker]), Promise.resolve(0)),
    exit: () => {},
    warn: () => {},
    legacyAbort: () => Promise.resolve(false),
    execPath: "/linked/deno",
    pids: { pid: 200, ppid: 100 },
  };
  assertEquals(await maybeReexecToolchain(true, d), false);
  assertEquals(spawned, []);
});

Deno.test("resource limits: a compiled binary bakes them in and says so on `job` and `db`", () => {
  // denort reads the limits only from the binary's metadata (no run-time flag or variable lifts
  // them), so its `job` and `db` run under them too: the generated entry names them, and those
  // verbs print a notice.
  const entry = entrySource("file:///p/.denext/compile/main.ts", "file:///p/", false, FLAGS);
  assertStringIncludes(
    entry,
    `Deno.args, { limitsBaked: ${JSON.stringify(FLAGS)}, limitsLifted });`,
  );
  assertStringIncludes(
    entrySource("file:///p/.denext/compile/main.ts", "file:///p/", true, ["--max-time=60"]),
    'Deno.args, { idleTrimBaked: true, limitsBaked: ["--max-time=60"], limitsLifted });',
  );
  const plain = entrySource("file:///p/.denext/compile/main.ts", "file:///p/");
  assert(!plain.includes("limitsBaked"), plain);
  assert(!plain.includes("disarmResourceLimits"), plain);
  for (const verb of ["job", "db"]) {
    const notice = bakedLimitsNotice("app", verb, ["--max-time=60"]);
    assert(notice !== null);
    assertStringIncludes(notice, `app: this binary enforces the start.limits it was compiled with`);
    assertStringIncludes(notice, `(--max-time=60) on \`${verb}\` too`);
    assertStringIncludes(notice, "`denext job` / `denext db`");
  }
  assertEquals(bakedLimitsNotice("app", "start", ["--max-time=60"]), null);
  assertEquals(bakedLimitsNotice("app", "job", []), null);
});

Deno.test("resource limits: the compiled entry lifts them for `job` and `db` where the runtime can", async () => {
  // Runtime 3.0.0-denext.8's Deno.disarmResourceLimits() works only from the main module's own top
  // level, so the generated entry calls it before dispatching; a stub stands in for the runtime
  // function and for denext/standalone (the real standaloneVerb).
  const dir = makeTempDirUntilExit("denext-disarm-");
  const source = entrySource(
    toFileUrl(join(dir, "main.ts")).href,
    toFileUrl(dir + "/").href,
    false,
    ["--max-time=60"],
  ).replace(/from "[^"]+";/, 'from "./standalone.ts";');
  await Deno.writeTextFile(join(dir, "main.ts"), source);
  await Deno.writeTextFile(
    join(dir, "standalone.ts"),
    [
      // The real one is src/standalone/mod.ts's (tested below); this stand-in keeps the child light.
      "export const standaloneVerb = (args: string[]) =>",
      '  args.includes("--help") ? undefined : args.find((a) => ["start", "job", "db"].includes(a)) ?? "start";',
      'const mode = Deno.env.get("DISARM");',
      'if (mode) Object.defineProperty(Deno, "disarmResourceLimits", { value: () => {',
      '  console.log("disarm");',
      '  if (mode === "throw") throw new Error("NotCapable");',
      '  return mode === "true";',
      "} });",
      "export function runStandalone(_url: URL, args: string[], options: unknown) {",
      "  console.log(JSON.stringify({ args, options }));",
      "}",
    ].join("\n"),
  );
  const run = async (args: string[], disarm?: string) => {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-lock", join(dir, "main.ts"), ...args],
      env: disarm ? { DISARM: disarm } : {},
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    assert(out.success, new TextDecoder().decode(out.stderr));
    const lines = text.trim().split("\n");
    return { disarmed: lines.includes("disarm"), options: JSON.parse(lines.at(-1)!).options };
  };
  for (const verb of [["job", "cleanup"], ["db", "migrate"], ["--cwd", ".", "job", "x"]]) {
    const lifted = await run(verb, "true");
    assertEquals(lifted.disarmed, true, verb.join(" "));
    assertEquals(lifted.options, { limitsBaked: ["--max-time=60"], limitsLifted: true });
  }
  // The server (and help) keeps them; nothing is called.
  for (const args of [[], ["start", "--port", "1"], ["--port", "1"], ["--help"]]) {
    const kept = await run(args, "true");
    assertEquals(kept.disarmed, false, args.join(" "));
    assertEquals(kept.options.limitsLifted, false);
  }
  // An older runtime (no function), or one that refuses: the limits stay and the verb says so.
  assertEquals((await run(["job", "x"])).options.limitsLifted, false);
  for (const disarm of ["false", "throw"]) {
    const refused = await run(["job", "x"], disarm);
    assertEquals([refused.disarmed, refused.options.limitsLifted], [true, false]);
  }
});

Deno.test("standaloneVerb: the verb runStandalone dispatches", () => {
  assertEquals(standaloneVerb([]), "start");
  assertEquals(standaloneVerb(["--port", "8080"]), "start");
  assertEquals(standaloneVerb(["job", "cleanup"]), "job");
  assertEquals(standaloneVerb(["db", "migrate"]), "db");
  assertEquals(standaloneVerb(["--cwd", ".", "job", "x"]), "job");
  assertEquals(standaloneVerb(["--help"]), undefined);
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

// The one real run: a `denext start`-shaped chain on denext's Deno. A parent started WITHOUT the
// flags (as every CLI hop now is) reaches the last gate with `start: { limits: { memory: 32 } }`
// handed down, re-runs itself once with them, and its child — the one that serves, here a program
// that grows its heap without bound — ends at the limit with exit code 137 and the runtime's
// message, which the parent exits with. Each process records its own command line: only the
// child's carries the flag. Only on denext's Deno from runtime 3.0.0-rc.2.
const runtime = currentDenoIdentity();
const onLimitsRuntime = isDenextDenoVersion(runtime) && supportsResourceLimits(runtime.deno);

/** The chain's script: the gate, then (in the process that serves) unbounded heap growth. */
const CHAIN = `
import { maybeReexecForLimits, ownCommandLine } from ${
  JSON.stringify(
    new URL("../src/cli/self-exec.ts", import.meta.url).href,
  )
};
import { handedLimits, START_LIMITS_ENV, LIMITS_APPLIED_ENV } from ${
  JSON.stringify(
    new URL("../src/build/resource-limits.ts", import.meta.url).href,
  )
};
const [out] = Deno.args;
const role = Deno.env.get(LIMITS_APPLIED_ENV) ? "server" : "hop";
await Deno.writeTextFile(out + "." + role, JSON.stringify(await ownCommandLine()));
const reran = await maybeReexecForLimits({
  configured: handedLimits(Deno.env.get(START_LIMITS_ENV)) ?? [],
  runtime: Deno.version.deno,
  applied: Deno.env.get(LIMITS_APPLIED_ENV),
  mayRespawn: true,
  pid: Deno.pid,
  spawn: (flags, env) =>
    new Deno.Command(Deno.execPath(), {
      args: ["run", ...flags, "-A", "--config", ${
  JSON.stringify(
    fromFileUrl(new URL("../deno.json", import.meta.url)),
  )
}, import.meta.filename!, out],
      env,
      stdout: "null",
      stderr: "inherit",
    }).spawn().status.then((s) => s.code),
  exit: (code) => Deno.exit(code),
  warn: (m) => console.error(m),
});
if (!reran) {
  const a: unknown[] = [];
  for (;;) a.push(new Array(1e5).fill({ x: Math.random() }));
}
`;

Deno.test({
  name: "resource limits: only the serving process runs with them, and exits 137 at the limit",
  ignore: !onLimitsRuntime,
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      const script = join(dir, "chain.ts");
      const out = join(dir, "argv");
      await Deno.writeTextFile(script, CHAIN);
      const configured = resourceLimitFlags({ memory: 32 });
      assertEquals(configured, ["--max-memory=32m"]);
      // The hop: started as the toolchain re-exec starts its child (the limits as data).
      const handOff = hopLimits(LIMIT_HOPS.toolchain, runtime.deno, configured);
      assertEquals(handOff.flags, []);
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...handOff.flags,
          "-A",
          "--config",
          fromFileUrl(new URL("../deno.json", import.meta.url)),
          script,
          out,
        ],
        env: handOff.env,
        stdout: "null",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 137);
      assertStringIncludes(new TextDecoder().decode(result.stderr), "Memory limit exceeded");
      const hop = JSON.parse(await Deno.readTextFile(`${out}.hop`)) as string[] | null;
      const server = JSON.parse(await Deno.readTextFile(`${out}.server`)) as string[] | null;
      if (hop && server) { // where the OS lets a process read its command line
        assert(!hop.some((a) => a.startsWith("--max-")), hop.join(" "));
        assert(server.includes("--max-memory=32m"), server.join(" "));
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/**
 * `runVerb` for a core `start` whose run records the hand-off variables, in a child (it may exit,
 * and it re-runs the CLI entry, here `entry.ts`, which records what it was started with).
 */
async function startThroughRunVerb(
  env: Record<string, string | undefined>,
  { prelude = "", config }: { prelude?: string; config?: string } = {},
) {
  const dir = await Deno.makeTempDir({ prefix: "denext-limits-gate-" });
  try {
    if (config) await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
    const out = join(dir, "entry.json");
    const entry = join(dir, "entry.ts");
    await Deno.writeTextFile(
      entry,
      `await Deno.writeTextFile(${JSON.stringify(out)}, JSON.stringify({
  applied: Deno.env.get(${JSON.stringify(LIMITS_APPLIED_ENV)}),
  handed: Deno.env.get(${JSON.stringify(START_LIMITS_ENV)}),
  reranFor: Deno.env.get("DENEXT_RUNTIME_FLAGS_FOR"),
}));
Deno.exit(7);
`,
    );
    const { value } = await inChild<{
      exits: number[];
      ran: Record<string, string | null> | null;
    }>({
      imports: `import { runVerb } from "@repo/src/cli/run-verb.ts";`,
      body: `
const exits: number[] = [];
// The limits re-run ends the CLI with its child's code: kept here instead.
Object.defineProperty(Deno, "exit", { value: (code: number) => void exits.push(code) });
${prelude}
let ran: Record<string, string | null> | null = null;
const read = (name: string) => Deno.env.get(name) ?? null;
await runVerb(${JSON.stringify(toFileUrl(entry).href)}, {
  name: "start",
  summary: "",
  run: () => {
    ran = { applied: read(${JSON.stringify(LIMITS_APPLIED_ENV)}), handed: read(${
        JSON.stringify(START_LIMITS_ENV)
      }) };
  },
}, {
  positionals: [],
  flags: {},
  global: { cwd: ${JSON.stringify(dir)}, json: false, verbose: false, quiet: false },
  rest: [],
}, ${JSON.stringify(dir)});
return { exits, ran };
`,
      env,
      cwd: dir,
    });
    let entryRun: Record<string, string | undefined> | null = null;
    try {
      entryRun = JSON.parse(await Deno.readTextFile(out));
    } catch { /* not re-run */ }
    return { ...value, entryRun };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name: "resource limits: `denext start`'s last gate serves with them, else re-runs the CLI once",
  ignore: !onLimitsRuntime,
  async fn() {
    const wanted = limitFlagsFor(runtime.deno, ["--max-memory=512m"]).join(" ");
    assert(wanted.length > 0);
    // Started with them (the marker names exactly them): it serves, and neither hand-off variable
    // is left for what the server starts.
    const serving = await startThroughRunVerb({
      [START_LIMITS_ENV]: "--max-memory=512m",
      [LIMITS_APPLIED_ENV]: wanted,
    });
    assertEquals(serving.exits, []);
    assertEquals(serving.ran, { applied: null, handed: null });
    assertEquals(serving.entryRun, null, "no re-run");
    // Handed them as data (a hop before it): the CLI re-runs once with them and exits with its
    // child's code; the child is the one that serves.
    for (const moduleActive of [undefined, "1"]) {
      const hop = await startThroughRunVerb({
        [START_LIMITS_ENV]: "--max-memory=512m",
        [LIMITS_APPLIED_ENV]: undefined,
        DENEXT_MODULE_ACTIVE: moduleActive,
      });
      assertEquals(hop.exits, [7], "the child's exit code");
      assertEquals(hop.ran, null, "the verb ran in the child, not here");
      assertEquals(hop.entryRun?.applied, wanted);
      assertEquals(hop.entryRun?.handed, "--max-memory=512m");
      assert(hop.entryRun?.reranFor, "its toolchain gate does not re-run it again");
    }
    // Run with less than every permission (no --allow-ffi): the re-run gets the grants this
    // process holds, not -A.
    const scoped = await startThroughRunVerb({
      [START_LIMITS_ENV]: "--max-memory=512m",
      [LIMITS_APPLIED_ENV]: undefined,
    }, { prelude: `await Deno.permissions.revoke({ name: "ffi" });` });
    assertEquals(scoped.exits, [7]);
    assertEquals(scoped.entryRun?.applied, wanted);
    // Without the env grant for the hand-off variables they read as absent: the limits come from
    // the project's config, and the server still runs under them.
    const unreadable = await startThroughRunVerb({
      [START_LIMITS_ENV]: "--max-memory=1m",
      [LIMITS_APPLIED_ENV]: undefined,
    }, {
      config: "export default { start: { limits: { memory: 512 } } };\n",
      prelude: `const get = Deno.env.get.bind(Deno.env);
Deno.env.get = (name: string) => {
  if (name === ${JSON.stringify(START_LIMITS_ENV)} || name === ${
        JSON.stringify(LIMITS_APPLIED_ENV)
      }) {
    throw new Deno.errors.NotCapable(\`Requires env access to "\${name}"\`);
  }
  return get(name);
};`,
    });
    assertEquals(unreadable.exits, [7]);
    assertEquals(unreadable.entryRun?.applied, wanted);
    assertEquals(
      unreadable.entryRun?.handed,
      "--max-memory=512m",
      "the config's, not the variable's",
    );
  },
});
