// The CLI side of denext's managed Deno toolchain: which verbs switch to it, the re-exec decision
// driven through its process seams (loop prevention, opt-outs, a compiled binary handing it to its
// children), and the real CLI spawned with the toolchain pointed at a recording wrapper script —
// argv, exit code and the marker passed through, `denext deno` verbatim, and `denext toolchain`
// against a pin served from a local HTTP server.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, resolve } from "@std/path";
import {
  handsToolchainToChildren,
  maybeReexecToolchain,
  type ReexecToolchainDeps,
  runsProjectCode,
  toolchainApplies,
} from "../src/cli/self-exec.ts";
import { buildRegistry } from "../src/cli/register.ts";
import {
  DENO_TOOLCHAIN,
  denoToolchainCacheRoot,
  type DenoToolchainChoice,
  type DenoToolchainPin,
  DenoToolchainRequiredError,
} from "../src/build/deno-toolchain.ts";
import { denoCacheDir } from "../src/build/desktop-runtime.ts";
import { sha256Hex } from "./_archive-fixtures.ts";
import { boundedOutput } from "./helpers/bounded-command.ts";

const CLI = fromFileUrl(new URL("../cli.ts", import.meta.url));
const ROOT = fromFileUrl(new URL("..", import.meta.url));

Deno.test("runsProjectCode: the serve/build/test verbs, desktop + mobile build actions, project verbs", () => {
  const reg = buildRegistry();
  const on = (name: string, action?: string) => runsProjectCode(reg.get(name)!, action);
  for (const name of ["dev", "build", "export", "start", "test", "check", "job", "doctor"]) {
    assert(on(name), `${name} runs project code`);
  }
  assert(on("analyze") && on("profile"));
  // `task` is Deno's now: it runs `deno task` on the toolchain itself, never a CLI re-exec.
  assert(!on("task"), "task forwards to deno task");
  for (const action of [undefined, "run", "dev", "build", "package"]) {
    assert(on("desktop", action), `desktop ${action ?? "(default run)"}`);
  }
  assert(on("mobile", "dev") && on("mobile", "build"));
  for (
    const [name, action] of [
      ["desktop", "add"],
      ["desktop", "doctor"],
      ["mobile", "add"],
      ["mobile", undefined],
    ] as const
  ) {
    assert(!on(name, action), `${name} ${action} does not`);
  }
  for (
    const name of [
      "toolchain",
      "deno",
      "upgrade",
      "create",
      "init",
      "generate",
      "migrate",
      "lint",
      "fmt",
      "add",
      "ui",
      "mcp",
      "completions",
    ]
  ) {
    assert(!on(name), `${name} stays on the Deno that started the CLI`);
  }
  assert(runsProjectCode({ name: "seed", source: "project" }, undefined));
  assert(runsProjectCode({ name: "openapi", source: "plugin" }, undefined));
});

/** A recording set of {@linkcode ReexecToolchainDeps}. */
function deps(
  choice: DenoToolchainChoice,
  over: Partial<ReexecToolchainDeps> & { vars?: Record<string, string> } = {},
) {
  const vars: Record<string, string> = { ...over.vars };
  const seen = {
    resolved: 0,
    spawned: [] as string[][],
    exits: [] as number[],
    warned: [] as string[],
  };
  const d: ReexecToolchainDeps = {
    env: (k) => vars[k],
    setEnv: (k, v) => void (vars[k] = v),
    denoVersion: "2.9.6",
    pinnedVersion: "2.9.7-denext.15",
    standalone: () => false,
    resolve: () => (seen.resolved++, Promise.resolve(choice)),
    spawn: (deno, marker) => (seen.spawned.push([deno, marker]), Promise.resolve(42)),
    exit: (code) => void seen.exits.push(code),
    warn: (m) => void seen.warned.push(m),
    ...over,
  };
  return { d, seen, vars };
}

const TOOLCHAIN: DenoToolchainChoice = { deno: "/cache/deno", version: "2.9.7-denext.15" };

/** A resolver that refuses as the real one does for `DENEXT_DENO=stock` (denext 5.0). */
const refuseStock = () =>
  Promise.reject(
    new DenoToolchainRequiredError("denext: DENEXT_DENO=stock is no longer supported"),
  );

Deno.test("maybeReexecToolchain: re-runs the invocation under the toolchain and exits with its code", async () => {
  const { d, seen } = deps(TOOLCHAIN);
  assert(await maybeReexecToolchain(true, d));
  assertEquals(seen.spawned, [["/cache/deno", "2.9.7-denext.15"]]);
  assertEquals(seen.exits, [42]);
  assertEquals(seen.warned, []);
});

Deno.test("maybeReexecToolchain never loops: the marker on its own version, or the pinned Deno", async () => {
  for (
    const over of [
      { vars: { DENEXT_TOOLCHAIN_ACTIVE: "2.9.7-denext.15" }, denoVersion: "2.9.7-denext.15" },
      // A DENEXT_DENO=<path> build's child: the marker is that build's own version.
      {
        vars: { DENEXT_TOOLCHAIN_ACTIVE: "3.0.0-rc.6" },
        denoVersion: "3.0.0-rc.6",
        denext: "3.0.0-rc.6",
      },
      { denoVersion: "2.9.7-denext.15" },
    ]
  ) {
    const { d, seen } = deps(TOOLCHAIN, over);
    assertEquals(await maybeReexecToolchain(true, d), false);
    assertEquals([seen.resolved, seen.spawned.length], [0, 0], "not even resolved");
  }
  const { d, seen } = deps(TOOLCHAIN);
  assertEquals(await maybeReexecToolchain(false, d), false, "a verb that runs no project code");
  assertEquals(seen.resolved, 0);
});

Deno.test("maybeReexecToolchain: a leaked marker or a stale -denext.N build re-execs onto the pin", async () => {
  for (
    const over of [
      // an absolute-path upstream deno inside `denext task` inherits the marker
      { vars: { DENEXT_TOOLCHAIN_ACTIVE: "2.9.7-denext.15" }, denoVersion: "2.9.6" },
      // a `toolchain link` left on an older toolchain
      { denoVersion: "2.9.7-denext.14" },
      // the retired "path" marker names no version: not the toolchain
      { vars: { DENEXT_TOOLCHAIN_ACTIVE: "path" } },
    ]
  ) {
    const { d, seen } = deps(TOOLCHAIN, over);
    assert(await maybeReexecToolchain(true, d));
    assertEquals(seen.spawned, [["/cache/deno", "2.9.7-denext.15"]]);
  }
});

Deno.test("maybeReexecToolchain: upstream Deno of the pinned version is not the toolchain", async () => {
  // Upstream Deno releases a 3.0.0-rc.N / 3.0.0 too: from 3.0.0-rc.3 the toolchain says it is
  // denext's with Deno.build.denext, and a Deno without it re-execs onto the pin.
  const pinned: DenoToolchainChoice = { deno: "/cache/deno", version: "3.0.0-rc.3" };
  for (
    const over of [
      { denoVersion: "3.0.0-rc.3" },
      { vars: { DENEXT_TOOLCHAIN_ACTIVE: "3.0.0-rc.3" }, denoVersion: "3.0.0-rc.3" },
    ]
  ) {
    const { d, seen } = deps(pinned, { pinnedVersion: "3.0.0-rc.3", ...over });
    assert(await maybeReexecToolchain(true, d), JSON.stringify(over));
    assertEquals(seen.spawned, [["/cache/deno", "3.0.0-rc.3"]]);
  }
  // The toolchain itself, by its marker: no re-exec.
  for (
    const over of [
      { denoVersion: "3.0.0-rc.3", denext: "3.0.0-rc.3" },
      {
        vars: { DENEXT_TOOLCHAIN_ACTIVE: "3.0.0-rc.3" },
        denoVersion: "3.0.0-rc.3",
        denext: "3.0.0-rc.3",
      },
    ]
  ) {
    const { d, seen } = deps(pinned, { pinnedVersion: "3.0.0-rc.3", ...over });
    assertEquals(await maybeReexecToolchain(true, d), false);
    assertEquals([seen.resolved, seen.spawned.length], [0, 0]);
  }
});

Deno.test("maybeReexecToolchain: DENEXT_DENO=stock and a toolchain that can't be had refuse; nothing runs", async () => {
  // denext 5.0 has no opt-out: the resolver refuses DENEXT_DENO=stock, and the command ends.
  const stock = deps(TOOLCHAIN, { vars: { DENEXT_DENO: "stock" }, resolve: refuseStock });
  await assertRejects(
    () => maybeReexecToolchain(true, stock.d),
    DenoToolchainRequiredError,
    "no longer supported",
  );
  assertEquals(stock.seen.spawned, []);
  // Already on the toolchain, DENEXT_DENO=stock is still refused rather than ignored.
  const onIt = deps(TOOLCHAIN, {
    denoVersion: "2.9.7-denext.15",
    vars: { DENEXT_DENO: "stock" },
    resolve: refuseStock,
  });
  await assertRejects(() => maybeReexecToolchain(true, onIt.d), DenoToolchainRequiredError);
  // Offline on first use (or no build for this host, a tampered download, a process without the
  // grants to start it): the resolver's error ends the command — no other Deno runs.
  const offline = deps(TOOLCHAIN, {
    resolve: () => Promise.reject(new DenoToolchainRequiredError("denext: offline. Fix: …")),
  });
  await assertRejects(() => maybeReexecToolchain(true, offline.d), DenoToolchainRequiredError);
  assertEquals(offline.seen.spawned, []);
  for (const standalone of [true, false]) {
    const handing = deps(TOOLCHAIN, {
      standalone: () => standalone,
      handOff: !standalone,
      resolve: () => Promise.reject(new DenoToolchainRequiredError("denext: offline. Fix: …")),
    });
    await assertRejects(
      () => maybeReexecToolchain(standalone, handing.d),
      DenoToolchainRequiredError,
    );
    assertEquals(handing.vars.DENO_BIN, undefined);
  }
});

Deno.test("maybeReexecToolchain: a DENO_BIN of the user's own is resolved (verified), never trusted", async () => {
  // On the toolchain already: the user's DENO_BIN goes through the resolver, which verifies it is
  // denext's runtime (and refuses it otherwise).
  const refused = deps(TOOLCHAIN, {
    denoVersion: "2.9.7-denext.15",
    vars: { DENO_BIN: "/usr/bin/deno" },
    resolve: () =>
      Promise.reject(new DenoToolchainRequiredError("denext: DENO_BIN=/usr/bin/deno is upstream")),
  });
  await assertRejects(() => maybeReexecToolchain(true, refused.d), DenoToolchainRequiredError);
  const verified = deps({ deno: "/my/deno", version: "3.0.0-rc.6", warning: "using it" }, {
    denoVersion: "2.9.7-denext.15",
    vars: { DENO_BIN: "/my/deno" },
  });
  assertEquals(await maybeReexecToolchain(true, verified.d), false);
  assertEquals([verified.seen.resolved, verified.seen.warned], [1, ["using it"]]);
  // One denext handed down itself (the marker beside it) is the toolchain: not resolved again.
  const handed = deps(TOOLCHAIN, {
    denoVersion: "2.9.7-denext.15",
    vars: { DENO_BIN: "/cache/deno", DENEXT_TOOLCHAIN_ACTIVE: "2.9.7-denext.15" },
  });
  assertEquals(await maybeReexecToolchain(true, handed.d), false);
  assertEquals(handed.seen.resolved, 0);
});

Deno.test("maybeReexecToolchain: under deno run, a verb that runs no project code hands the toolchain to its children", async () => {
  const { d, seen, vars } = deps(TOOLCHAIN, {
    handOff: true,
    pathEnv: () => Promise.resolve({ PATH: "/cache:/usr/bin" }),
  });
  assertEquals(await maybeReexecToolchain(false, d), false, "it never re-execs itself");
  assertEquals(seen.spawned, []);
  assertEquals(
    [vars.DENO_BIN, vars.DENEXT_TOOLCHAIN_ACTIVE, vars.PATH],
    ["/cache/deno", "2.9.7-denext.15", "/cache:/usr/bin"],
  );
  // Already on the toolchain (its own Deno is the pinned build): nothing to resolve.
  const on = deps(TOOLCHAIN, { handOff: true, denoVersion: "2.9.7-denext.15" });
  assertEquals(await maybeReexecToolchain(false, on.d), false);
  assertEquals(on.seen.resolved, 0);
  // A DENO_BIN of the user's own is resolved (verified) and handed down.
  const own = deps({ deno: "/my/deno", version: "3.0.0-rc.6" }, {
    handOff: true,
    vars: { DENO_BIN: "/my/deno" },
  });
  assertEquals(await maybeReexecToolchain(false, own.d), false);
  assertEquals([own.seen.resolved, own.vars.DENEXT_TOOLCHAIN_ACTIVE], [1, "3.0.0-rc.6"]);
  // DENEXT_DENO=stock: refused, the children get nothing.
  const stock = deps(TOOLCHAIN, { handOff: true, resolve: refuseStock });
  await assertRejects(() => maybeReexecToolchain(false, stock.d), DenoToolchainRequiredError);
  assertEquals(stock.vars.DENO_BIN, undefined);
});

Deno.test("handsToolchainToChildren: every non-project verb that may spawn deno, under deno run only", () => {
  const reg = buildRegistry();
  const hands = (name: string, action?: string, standalone = false) =>
    handsToolchainToChildren(reg.get(name)!, action, standalone);
  for (const name of ["fmt", "lint", "add", "ui", "mcp", "create", "migrate", "generate"]) {
    assert(hands(name), `${name} hands its children the toolchain`);
    assert(!hands(name, undefined, true), `${name}: a binary does it through toolchainApplies`);
  }
  for (const name of ["dev", "build", "test", "toolchain", "completions"]) {
    assert(!hands(name), `${name}: re-execs, or runs no Deno`);
  }
  assert(!hands("desktop", "run"));
  assert(hands("desktop", "add"), "desktop add runs no project code but may spawn deno");
});

Deno.test("maybeReexecToolchain in a compiled binary: children get the toolchain; a user DENO_BIN is verified", async () => {
  const { d, seen, vars } = deps({ ...TOOLCHAIN, warning: "unverified" }, {
    standalone: () => true,
    pathEnv: (deno) => Promise.resolve({ PATH: `/shim-for${deno}:/usr/bin` }),
  });
  assertEquals(await maybeReexecToolchain(true, d), false);
  assertEquals(vars.DENO_BIN, "/cache/deno");
  assertEquals(vars.DENEXT_TOOLCHAIN_ACTIVE, "2.9.7-denext.15");
  assertEquals(vars.PATH, "/shim-for/cache/deno:/usr/bin", "every `deno` a child looks up");
  assertEquals(seen.spawned, [], "a binary cannot swap its own runtime");
  assertEquals(seen.warned, ["unverified"]);
  // The user's DENO_BIN goes through the resolver (which verifies it) and is handed down as is.
  const own = deps({ deno: "/my/deno", version: "3.0.0-rc.6" }, {
    standalone: () => true,
    vars: { DENO_BIN: "/my/deno" },
  });
  assertEquals(await maybeReexecToolchain(true, own.d), false);
  assertEquals([own.vars.DENO_BIN, own.vars.DENEXT_TOOLCHAIN_ACTIVE], ["/my/deno", "3.0.0-rc.6"]);
  assertEquals(own.seen.resolved, 1);
  // What a parent binary already handed down (DENO_BIN + the marker) stands.
  const handed = deps(TOOLCHAIN, {
    standalone: () => true,
    vars: { DENO_BIN: "/cache/deno", DENEXT_TOOLCHAIN_ACTIVE: "2.9.7-denext.15" },
  });
  assertEquals(await maybeReexecToolchain(true, handed.d), false);
  assertEquals(handed.seen.resolved, 0);
});

Deno.test("maybeReexecToolchain in a compiled binary: the marker or the pinned version never skip the hand-off", async () => {
  // A binary's Deno.version is the runtime it was compiled with, never a `deno` it can spawn.
  for (
    const over of [
      { denoVersion: "2.9.7-denext.15" },
      { vars: { DENEXT_TOOLCHAIN_ACTIVE: "2.9.7-denext.15" } },
    ]
  ) {
    const { d, vars } = deps(TOOLCHAIN, { standalone: () => true, ...over });
    assertEquals(await maybeReexecToolchain(true, d), false);
    assertEquals(vars.DENO_BIN, "/cache/deno");
  }
});

Deno.test("maybeReexecToolchain in a compiled binary: DENEXT_DENO=stock refuses and leaves the environment alone", async () => {
  const { d, vars } = deps(TOOLCHAIN, { standalone: () => true, resolve: refuseStock });
  await assertRejects(() => maybeReexecToolchain(true, d), DenoToolchainRequiredError);
  assertEquals([vars.DENO_BIN, vars.PATH, vars.DENEXT_TOOLCHAIN_ACTIVE], [
    undefined,
    undefined,
    undefined,
  ]);
});

Deno.test("toolchainApplies: a compiled binary hands the toolchain to every verb that may spawn deno", () => {
  const reg = buildRegistry();
  const binary = (name: string, action?: string) => toolchainApplies(reg.get(name)!, action, true);
  for (const name of ["fmt", "lint", "add", "ui", "mcp", "create", "migrate", "generate", "dev"]) {
    assert(binary(name), `${name} may spawn deno`);
  }
  assert(!binary("toolchain") && !binary("completions"), "deno-free verbs");
  assert(toolchainApplies({ name: "toolchain", source: "project" }, undefined, true));
  // Under `deno run` it is exactly runsProjectCode.
  for (const name of ["fmt", "dev", "create", "toolchain", "desktop"]) {
    assertEquals(
      toolchainApplies(reg.get(name)!, undefined, false),
      runsProjectCode(reg.get(name)!, undefined),
      name,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The real CLI, with the toolchain pointed at a wrapper script that records its argv.

const posix = Deno.build.os !== "windows";

/** The version a {@linkcode wrapper} says it is (denext 5.0 runs only on its runtime). */
const WRAPPER_VERSION = "3.0.0-rc.99";

/**
 * A `deno` stand-in: answers `--version` as denext's runtime of {@linkcode WRAPPER_VERSION} (the
 * identity line a `DENEXT_DENO=<path>` is verified by); otherwise records argv (one per line) +
 * the marker into `log` and exits with `code`.
 */
async function wrapper(dir: string, code: number): Promise<{ path: string; log: string }> {
  const path = join(dir, "deno");
  const log = join(dir, "argv.log");
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n` +
      `  printf 'deno ${WRAPPER_VERSION} (stable)\\ndenext ${WRAPPER_VERSION} (Brainwires)\\n'\n` +
      `  exit 0\nfi\nprintf '%s\\n' "$@" > '${log}'\n` +
      `printf 'marker=%s\\n' "$DENEXT_TOOLCHAIN_ACTIVE" >> '${log}'\nexit ${code}\n`,
  );
  await Deno.chmod(path, 0o755);
  return { path, log };
}

/** Run the CLI from source with `env` added; its exit code and stderr. */
async function cli(args: string[], cwd: string, env: Record<string, string>) {
  // Under the coverage tasks the child's coverage joins the run's.
  const coverage = Deno.env.get("DENEXT_CHILD_COVERAGE");
  const out = await boundedOutput(Deno.execPath(), {
    args: [
      "run",
      "-A",
      ...(coverage ? [`--coverage=${resolve(coverage)}`] : []),
      "--config",
      join(ROOT, "deno.json"),
      CLI,
      ...args,
    ],
    cwd,
    env: { DENEXT_TOOLCHAIN_ACTIVE: "", ...env },
  });
  const d = new TextDecoder();
  return { code: out.code, stdout: d.decode(out.stdout), stderr: d.decode(out.stderr) };
}

Deno.test({
  name:
    "denext test re-execs under DENEXT_DENO with argv, permissions and exit code passed through",
  ignore: !posix,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-tc-" });
    try {
      const w = await wrapper(dir, 7);
      // A pin naming another version: run on denext's own toolchain, the CLI would take itself
      // for the pinned build and never re-exec.
      const pinFile = join(dir, "pin.json");
      await Deno.writeTextFile(
        pinFile,
        JSON.stringify({ ...DENO_TOOLCHAIN, version: "0.0.1-denext.1" }),
      );
      const run = await cli(["test", "--filter", "x y", "a.test.ts"], dir, {
        DENEXT_DENO: w.path,
        DENEXT_TOOLCHAIN_PIN_FILE: pinFile,
      });
      assertEquals(run.code, 7, run.stderr);
      assertStringIncludes(run.stderr, "not downloaded, pinned or hash-checked");
      const argv = (await Deno.readTextFile(w.log)).trimEnd().split("\n");
      assertEquals(argv[0], "run");
      assert(argv.includes("-A"), "a -A parent gives the child -A");
      const at = argv.indexOf(CLI);
      assert(at > 0, `the CLI entrypoint: ${argv.join(" ")}`);
      assertEquals(argv.slice(at + 1), [
        "test",
        "--filter",
        "x y",
        "a.test.ts",
        `marker=${WRAPPER_VERSION}`,
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "the CLI never re-execs with the marker set, nor for a verb that runs no project code",
  ignore: !posix,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-tc-" });
    try {
      const w = await wrapper(dir, 7);
      const marked = await cli(["toolchain", "status", "--json"], dir, {
        DENEXT_DENO: w.path,
        DENEXT_TOOLCHAIN_ACTIVE: WRAPPER_VERSION,
      });
      assertEquals(marked.code, 0, marked.stderr);
      const status = JSON.parse(marked.stdout);
      assertEquals([status.mode, status.ok], ["path", true]);
      assertStringIncludes(status.detail, `denext's Deno ${WRAPPER_VERSION}`);
      const help = await cli(["generate", "--help"], dir, { DENEXT_DENO: w.path });
      assertEquals(help.code, 0, help.stderr);
      assertEquals(await Deno.stat(w.log).catch(() => null), null, "the wrapper never ran");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "denext deno passes every token verbatim (global flags too) and the exit code back",
  ignore: !posix,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-tc-" });
    try {
      const w = await wrapper(dir, 3);
      const run = await cli(["deno", "test", "--config", "x.json", "--json", "-A"], dir, {
        DENEXT_DENO: w.path,
      });
      assertEquals(run.code, 3, run.stderr);
      assertEquals((await Deno.readTextFile(w.log)).trimEnd().split("\n"), [
        "test",
        "--config",
        "x.json",
        "--json",
        "-A",
        `marker=${WRAPPER_VERSION}`,
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "denext toolchain install | path | status | link | unlink against a pin served locally",
  ignore: !posix,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-tc-" });
    const w = await wrapper(dir, 5);
    const body = await Deno.readFile(w.path);
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen() {} },
      () => new Response(body),
    );
    let cleanup: string | null = null;
    try {
      const target = `${Deno.build.os}-${Deno.build.arch}`;
      // A version of its own, in the real Deno cache (a fresh DENO_DIR would make the CLI child
      // re-download every module it imports); its directory is removed afterwards.
      const version = `9.9.9-denext.${Date.now()}`;
      const pin: DenoToolchainPin = {
        schema: 1,
        version,
        targets: {
          [target]: {
            file: "deno",
            url: `http://127.0.0.1:${server.addr.port}/deno`,
            sha256: await sha256Hex(body),
            size: body.byteLength,
            format: "binary",
          },
        },
      };
      const pinFile = join(dir, "pin.json");
      await Deno.writeTextFile(pinFile, JSON.stringify(pin));
      const home = join(dir, "home");
      const env = { DENEXT_TOOLCHAIN_PIN_FILE: pinFile, DENO_DIR: denoCacheDir(), HOME: home };
      const bin = join(denoToolchainCacheRoot(), version, target, "deno");
      cleanup = join(denoToolchainCacheRoot(), version);

      const before = JSON.parse((await cli(["toolchain", "status", "--json"], dir, env)).stdout);
      assertEquals([before.state, before.version], ["missing", version]);
      const install = await cli(["toolchain", "install"], dir, env);
      assertEquals(install.code, 0, install.stderr);
      assertStringIncludes(install.stderr, `downloading denext's Deno toolchain ${version}`);
      assertEquals((await cli(["toolchain", "path"], dir, env)).stdout.trim(), bin);
      const after = JSON.parse((await cli(["toolchain", "status", "--json"], dir, env)).stdout);
      assertEquals([after.state, after.path, after.ok], ["cached", bin, true]);

      // The automatic switch runs the downloaded binary with the version as the marker.
      const test = await cli(["test"], dir, env);
      assertEquals(test.code, 5, test.stderr);
      assertStringIncludes(await Deno.readTextFile(w.log), `marker=${version}`);

      const link = await cli(["toolchain", "link"], dir, env);
      assertEquals(link.code, 0, link.stderr);
      assertStringIncludes(link.stdout, "export PATH=");
      assertEquals(await Deno.readLink(join(home, ".denext", "bin", "deno")), bin);
      assertEquals((await cli(["toolchain", "unlink"], dir, env)).code, 0);
      assertEquals(await Deno.lstat(join(home, ".denext", "bin", "deno")).catch(() => null), null);

      const bad = await cli(["toolchain", "nope"], dir, env);
      assertEquals(bad.code, 1);
      assertStringIncludes(bad.stderr, "unknown toolchain action");
    } finally {
      await server.shutdown();
      if (cleanup) await Deno.remove(cleanup, { recursive: true }).catch(() => {});
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "denext 5.0: no toolchain pinned, DENEXT_DENO=stock, upstream Deno or a missing path all refuse",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-tc-" });
    try {
      const pinFile = join(dir, "pin.json");
      await Deno.writeTextFile(pinFile, JSON.stringify({ schema: 1, version: null, targets: {} }));
      const env = { DENEXT_TOOLCHAIN_PIN_FILE: pinFile, DENEXT_DENO: "" };
      const install = await cli(["toolchain", "install"], dir, env);
      assertEquals(install.code, 1);
      assertStringIncludes(install.stderr, "not available for this denext version");
      // No toolchain pinned for this denext version: `denext deno` refuses (it used to run the
      // Deno that started it).
      const deno = await cli(["deno", "--version"], dir, env);
      assertEquals(deno.code, 1, deno.stdout);
      assertStringIncludes(deno.stderr, "pins no Deno toolchain");
      assertStringIncludes(deno.stderr, "denext toolchain install");
      // A DENEXT_DENO=<path> that isn't a file is an error for `denext deno`.
      const missing = await cli(["deno", "--version"], dir, {
        ...env,
        DENEXT_DENO: join(dir, "no-such-deno"),
      });
      assertEquals(missing.code, 1);
      assertStringIncludes(missing.stderr, "is not a file");
      // DENEXT_DENO=stock: the 5.0 refusal, with the fix.
      const stock = await cli(["deno", "--version"], dir, { ...env, DENEXT_DENO: "stock" });
      assertEquals(stock.code, 1, stock.stdout);
      assertStringIncludes(stock.stderr, "DENEXT_DENO=stock is no longer supported");
      assertStringIncludes(stock.stderr, "denext toolchain install");
      // A path to upstream Deno (no identity line): refused by its `--version`.
      if (posix) {
        const upstream = join(dir, "upstream-deno");
        await Deno.writeTextFile(upstream, "#!/bin/sh\necho 'deno 2.9.8 (stable)'\n");
        await Deno.chmod(upstream, 0o755);
        const refused = await cli(["deno", "--version"], dir, { ...env, DENEXT_DENO: upstream });
        assertEquals(refused.code, 1, refused.stdout);
        assertStringIncludes(refused.stderr, "is upstream Deno 2.9.8");
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
