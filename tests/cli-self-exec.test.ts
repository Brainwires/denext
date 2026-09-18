// A compiled binary carries one framework version; a project pins its own. These cover the
// pieces that decide which one runs: reading a project's pin the way `deno run` would resolve
// it, comparing it to a concrete version without tripping over the range operator a scaffolded
// project writes, and the re-exec decision itself, driven through its process seams.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  maybeReexecPinned,
  pinnedDenextCli,
  pinnedVersion,
  type ReexecPinnedDeps,
  samePin,
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
  for (const name of ["dev", "build", "export", "start", "task", "doctor", "analyze", "profile"]) {
    assert(deferred.includes(name), `${name} loads the project's modules`);
  }
  for (const name of ["ui", "create", "init", "completions", "commands", "mcp", "fmt", "lint"]) {
    assert(!deferred.includes(name), `${name} never loads the project's modules in-process`);
  }
});
