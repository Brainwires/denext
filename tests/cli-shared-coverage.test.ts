// Coverage for the pure CLI helpers in src/cli/shared.ts: project-dir resolution,
// the build-step error wrapper, the app-dir gate, and the shutdown-signal list.
// Deliberately avoids installShutdown / spawnDenoAndExit (they touch signals and
// spawn processes).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  commandCwd,
  ensureAppDir,
  projectDir,
  runBuildStep,
  SHUTDOWN_SIGNALS,
} from "../src/cli/shared.ts";
import type { CommandContext } from "../src/cli/command.ts";

/** Build a minimal CommandContext with optional overrides. */
function ctx(
  opts: {
    positionals?: string[];
    cwd?: string;
  } = {},
): CommandContext {
  return {
    positionals: opts.positionals ?? [],
    flags: {},
    global: {
      cwd: opts.cwd,
      config: undefined,
      json: false,
      verbose: false,
      quiet: false,
    },
    rest: [],
  };
}

// ---- projectDir / commandCwd -----------------------------------------------

Deno.test("projectDir: --cwd wins over positionals", () => {
  assertEquals(
    projectDir(ctx({ cwd: "/tmp/from-flag", positionals: ["/tmp/from-pos"] })),
    resolve("/tmp/from-flag"),
  );
});

Deno.test("projectDir: first positional when no --cwd", () => {
  assertEquals(
    projectDir(ctx({ positionals: ["some/rel/dir"] })),
    resolve("some/rel/dir"),
  );
});

Deno.test("projectDir: defaults to '.' when nothing given", () => {
  assertEquals(projectDir(ctx()), resolve("."));
});

Deno.test("commandCwd: --cwd resolves, else the real cwd", () => {
  assertEquals(commandCwd(ctx({ cwd: "rel/here" })), resolve("rel/here"));
  assertEquals(commandCwd(ctx()), Deno.cwd());
});

// ---- runBuildStep -----------------------------------------------------------

Deno.test("runBuildStep returns the step's value on success", async () => {
  const out = await runBuildStep(() => Promise.resolve(42), "build");
  assertEquals(out, 42);
});

Deno.test("runBuildStep passes an already-denext:-prefixed error through unchanged", async () => {
  const original = new Error("denext: config invalid");
  const err = await assertRejects(
    () => runBuildStep(() => Promise.reject(original), "build"),
    Error,
  );
  // Same instance, message untouched (no double-wrapping).
  assert(err === original);
  assertEquals(err.message, "denext: config invalid");
  assertEquals(err.cause, undefined);
});

Deno.test("runBuildStep wraps a plain Error with label + cause", async () => {
  const boom = new Error("disk full");
  const err = await assertRejects(
    () => runBuildStep(() => Promise.reject(boom), "export"),
    Error,
    "denext: export failed — disk full",
  );
  assertEquals(err.cause, boom);
});

Deno.test("runBuildStep wraps a non-Error throw via String()", async () => {
  const err = await assertRejects(
    () => runBuildStep(() => Promise.reject("kaboom"), "compile"),
    Error,
    "denext: compile failed — kaboom",
  );
  assertEquals(err.cause, "kaboom");
});

// ---- ensureAppDir -----------------------------------------------------------

Deno.test("ensureAppDir returns when an app/ directory exists", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "app"));
    // Resolves without throwing.
    await ensureAppDir(join(dir, "app"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureAppDir accepts a Pages Router tree (pages/ or src/pages/)", async () => {
  const dir1 = await Deno.makeTempDir();
  const dir2 = await Deno.makeTempDir();
  try {
    // No app/, but a top-level pages/ under the project dir.
    await Deno.mkdir(join(dir1, "pages"));
    await ensureAppDir(join(dir1, "app"), dir1);
    // No app/, but src/pages/ under the project dir.
    await Deno.mkdir(join(dir2, "src", "pages"), { recursive: true });
    await ensureAppDir(join(dir2, "app"), dir2);
  } finally {
    await Deno.remove(dir1, { recursive: true });
    await Deno.remove(dir2, { recursive: true });
  }
});

Deno.test("ensureAppDir exits(1) and prints when no routable tree exists", async () => {
  const dir = await Deno.makeTempDir();
  const realExit = Deno.exit;
  const realError = console.error;
  const errors: string[] = [];
  // Stub Deno.exit to throw (so we can observe the exit + halt execution) and
  // capture console.error.
  (Deno as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as typeof Deno.exit;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await assertRejects(
      () => ensureAppDir(join(dir, "app"), dir),
      Error,
      "EXIT:1",
    );
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0], "no app directory found");
    assertStringIncludes(errors[0], "App Router");
  } finally {
    Deno.exit = realExit;
    console.error = realError;
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- SHUTDOWN_SIGNALS -------------------------------------------------------

Deno.test("SHUTDOWN_SIGNALS always traps SIGINT and is platform-appropriate", () => {
  assert(SHUTDOWN_SIGNALS.includes("SIGINT"));
  if (Deno.build.os === "windows") {
    assert(SHUTDOWN_SIGNALS.includes("SIGBREAK"));
    assert(!SHUTDOWN_SIGNALS.includes("SIGTERM"));
  } else {
    assert(SHUTDOWN_SIGNALS.includes("SIGTERM"));
    assert(!SHUTDOWN_SIGNALS.includes("SIGBREAK"));
  }
});
