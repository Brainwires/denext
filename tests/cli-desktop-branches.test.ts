// Branches of `src/cli/commands/desktop.ts` past the build: `desktop run` (and `--headless`) and
// `desktop dev` launching the window, with `deno desktop` and the window's executable replaced by
// fakes. No app is built or launched and no window opens: the fake `Deno.Command` answers the
// `deno desktop` build (writing only the bundle's Info.plist the launch reads on macOS) and the
// executable's spawn (a fake child); every other command runs for real (the SPA export). The
// shutdown signal (Ctrl-C) is a captured listener the test fires itself. Also: the pure helpers
// (`denoChosenExplicitly`, `inspectsOnly`) and argument refusals the other suites leave out
// (tests/cli-desktop-coverage.test.ts has the rest).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { denoChosenExplicitly, desktopCommand } from "../src/cli/commands/desktop.ts";
import { denoExecutable } from "../src/build/bundle.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

async function tempDir(prefix: string): Promise<string> {
  // Real path: a build names the project by its real path (macOS `/var` -> `/private/var`).
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix }));
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  return dir;
}

/** Run the `desktop` verb; returns the exit code (0 when it returned) plus captured output. */
async function runVerb(
  positionals: string[],
  dir: string,
  flags: Record<string, string | number | boolean> = {},
): Promise<{ code: number; out: string; err: string; thrown?: unknown }> {
  const cap = capture();
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  const exit = stubExit();
  let code = 0;
  let thrown: unknown;
  try {
    await desktopCommand.run(makeCtx({ positionals, flags, global: { cwd: dir } }));
  } catch (e) {
    if (String(e).includes("__exit__")) code = exit.calls[0];
    else thrown = e;
  } finally {
    exit.restore();
    cap.restore();
    console.warn = warn;
  }
  return {
    code,
    out: cap.logs.join("\n"),
    err: [...cap.errs, ...warns].join("\n"),
    thrown,
  };
}

/** Run `fn` with env vars set (undefined = unset), restoring the previous values after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) {
      x === undefined ? Deno.env.delete(k) : Deno.env.set(k, x);
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(prev);
  }
}

// A stand-in local runtime, so a window's build reaches `deno desktop` with no download on any host.
const localRuntimeDir = await Deno.makeTempDir({ prefix: "denext_desktop_branches_runtime_" });
await Deno.mkdir(join(localRuntimeDir, "laufey"));
await Deno.writeTextFile(
  join(
    localRuntimeDir,
    Deno.build.os === "windows"
      ? "denort.dll"
      : Deno.build.os === "darwin"
      ? "libdenort.dylib"
      : "libdenort.so",
  ),
  "",
);
globalThis.addEventListener("unload", () => {
  Deno.removeSync(localRuntimeDir, { recursive: true });
});

/** The env every launch test runs under: the local runtime, and no inherited headless switch. */
const LAUNCH_ENV = {
  DENEXT_DESKTOP_RUNTIME_DIR: localRuntimeDir,
  DENEXT_DESKTOP_HEADLESS: undefined,
  DENEXT_DENO: undefined,
  DENO_BIN: undefined,
};

/** How the fake window's executable behaves. */
interface FakeWindowPlan {
  /** Exit with this code at once; `undefined`: run until killed. */
  exitCode?: number;
  /** `kill()` throws (the process is already gone), the child still ends. */
  killThrows?: boolean;
}

/** What the fakes saw. */
interface FakeLaunch {
  builds: string[][];
  spawns: { exe: string; env: Record<string, string> }[];
  kills: string[];
  /** Fire the shutdown signal (Ctrl-C) on every captured listener. */
  signal(): void;
}

/**
 * Run `fn` with `Deno.Command` answering the `deno desktop` build and the built executable's
 * launch with fakes (everything else runs as usual) and the shutdown signal listeners captured.
 */
async function withFakeLaunch<T>(
  plan: FakeWindowPlan,
  fn: (seen: FakeLaunch) => Promise<T>,
): Promise<T> {
  const RealCommand = Deno.Command;
  const realAdd = Deno.addSignalListener;
  const realRemove = Deno.removeSignalListener;
  const listeners = new Set<() => void>();
  const outputs: string[] = [];
  const seen: FakeLaunch = {
    builds: [],
    spawns: [],
    kills: [],
    signal: () => {
      for (const l of [...listeners]) l();
    },
  };
  const Fake = function (cmd: string | URL, opts: Deno.CommandOptions = {}) {
    const exe = String(cmd);
    const args = opts.args?.map(String) ?? [];
    if (exe === denoExecutable() && args[0] === "desktop" && args.includes("--output")) {
      seen.builds.push(args);
      const output = args[args.indexOf("--output") + 1];
      outputs.push(output);
      return {
        output: async () => {
          if (Deno.build.os === "darwin") {
            await Deno.mkdir(join(`${output}.app`, "Contents"), { recursive: true });
            await Deno.writeTextFile(
              join(`${output}.app`, "Contents", "Info.plist"),
              "<key>CFBundleExecutable</key><string>fake_window_host</string>",
            );
          }
          return { code: 0, success: true, signal: null };
        },
      };
    }
    if (outputs.some((o) => exe.startsWith(o))) {
      seen.spawns.push({ exe, env: { ...(opts.env ?? {}) } });
      let end!: (code: number) => void;
      const ended = new Promise<number>((r) => end = r);
      if (plan.exitCode !== undefined) end(plan.exitCode);
      return {
        spawn: () => ({
          status: ended.then((code) => ({ code, success: code === 0, signal: null })),
          kill: (sig: string) => {
            seen.kills.push(sig);
            end(143);
            if (plan.killThrows) throw new TypeError("Child process has already terminated");
          },
        }),
      };
    }
    return new RealCommand(cmd, opts);
  } as unknown as typeof Deno.Command;
  Deno.Command = Fake;
  Deno.addSignalListener = (_sig: Deno.Signal, handler: () => void) => void listeners.add(handler);
  Deno.removeSignalListener = (_sig: Deno.Signal, handler: () => void) =>
    void listeners.delete(handler);
  try {
    return await fn(seen);
  } finally {
    Deno.Command = RealCommand;
    Deno.addSignalListener = realAdd;
    Deno.removeSignalListener = realRemove;
  }
}

/** Resolve once `cond` holds (polled on the event loop; the fakes settle within a few turns). */
async function until(cond: () => boolean): Promise<void> {
  for (let turn = 0; !cond(); turn++) {
    if (turn > 2000) throw new Error("the fake window was never launched");
    await new Promise((r) => setTimeout(r, 5));
  }
}

Deno.test("desktop run --headless: launches with the headless env and exits with the app's code", async () => {
  const dir = await tempDir("denext_desktop_run_headless_");
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "export {};\n");
    const r = await withEnv(
      LAUNCH_ENV,
      () =>
        withFakeLaunch({ exitCode: 3 }, async (seen) => {
          const r = await runVerb(["run"], dir, { headless: true });
          assertEquals(seen.builds.length, 1);
          assertEquals(seen.spawns.length, 1);
          const env = seen.spawns[0].env;
          assertEquals(env.DENEXT_DESKTOP_HEADLESS, "1");
          assertEquals(env.LAUFEY_HEADLESS, "1");
          assertEquals(env.LAUFEY_ACTIVATION_POLICY, "accessory");
          assertEquals(env.LAUFEY_CWD, undefined, "no bootstrap layout");
          // The app exited by itself: the verb still stops it (and removes the scratch build).
          assertEquals(seen.kills, ["SIGTERM"]);
          return r;
        }),
    );
    assertEquals(r.code, 3, r.err);
    assertStringIncludes(r.out, "Starting the app headless (every window hidden)");
    assert(!r.out.includes("Opening the desktop window"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop run: Ctrl-C quits the window and exits 0; a gone child and media grants are fine", async () => {
  const dir = await tempDir("denext_desktop_run_quit_");
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "export {};\n");
    // deno.json's own media grant is left out of the build; the config's capability is warned about.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ desktop: { app: { mediaCapture: { microphone: true } } } }),
    );
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "export default { desktop: { capabilities: { microphone: true } } };\n",
    );
    const r = await withEnv(
      LAUNCH_ENV,
      () =>
        withFakeLaunch({ killThrows: true }, async (seen) => {
          const run = runVerb(["run"], dir);
          await until(() => seen.spawns.length === 1);
          const env = seen.spawns[0].env;
          assertEquals(env.LAUFEY_HEADLESS, undefined, "not headless");
          seen.signal();
          const r = await run;
          assertEquals(seen.kills, ["SIGTERM"]);
          // The build read a copy of deno.json without the grant.
          assert(seen.builds[0].includes("--config"), seen.builds[0].join(" "));
          return r;
        }),
    );
    assertEquals(r.code, 0, r.err);
    assertStringIncludes(r.out, "Opening the desktop window");
    assertStringIncludes(r.err, "desktop.app.mediaCapture");
    assertStringIncludes(r.err, "desktop.capabilities.microphone applies to the packaged app");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop dev --inspect-renderer: the window gets the dev URL and CEF's port; its pages are announced", async () => {
  const dir = await tempDir("denext_desktop_dev_launch_");
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} },
    () => new Response("dev"),
  );
  const realFetch = globalThis.fetch;
  const listed: string[] = [];
  // The CDP page list the announcer polls, answered here (no renderer exists).
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/json/list")) {
      listed.push(url);
      return Promise.resolve(
        Response.json([{ type: "page", url: "http://127.0.0.1/", title: "App", id: "1" }]),
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "export {};\n");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ desktop: { backend: "cef" } }),
    );
    const r = await withEnv(
      LAUNCH_ENV,
      () =>
        withFakeLaunch({}, async (seen) => {
          const dev = runVerb(["dev"], dir, {
            host: "127.0.0.1",
            port: server.addr.port,
            "inspect-renderer": true,
          });
          await until(() => seen.spawns.length === 1 && listed.length > 0);
          seen.signal();
          const r = await dev;
          assertEquals(seen.kills, ["SIGTERM"]);
          return { r, env: seen.spawns[0].env };
        }),
    );
    assertEquals(r.r.code, 0, r.r.err);
    assertStringIncludes(
      r.env.DENEXT_DESKTOP_DEV_URL ?? "",
      `http://127.0.0.1:${server.addr.port}`,
    );
    assertEquals(r.env.DENEXT_DESKTOP_DEV_LAN, undefined);
    // A bare flag picks a free loopback port, handed to CEF and polled for the window's pages.
    const port = r.env.LAUFEY_REMOTE_DEBUGGING_PORT;
    assert(/^\d+$/.test(port ?? ""), JSON.stringify(r.env));
    assertStringIncludes(
      r.r.out,
      `Renderer inspector (Chrome DevTools Protocol): http://127.0.0.1:${port}/json/list`,
    );
    assertEquals(listed, [`http://127.0.0.1:${port}/json/list`]);
    // The attached dev server is left running.
    assertEquals(await (await realFetch(`http://127.0.0.1:${server.addr.port}/`)).text(), "dev");
  } finally {
    globalThis.fetch = realFetch;
    ac.abort();
    await server.finished;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denoChosenExplicitly: DENEXT_DENO other than pinned, or a DENO_BIN outside the toolchain", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assertEquals(denoChosenExplicitly(env({})), false);
  assertEquals(denoChosenExplicitly(env({ DENEXT_DENO: " Pinned " })), false);
  assertEquals(denoChosenExplicitly(env({ DENEXT_DENO: "" })), false);
  assertEquals(denoChosenExplicitly(env({ DENEXT_DENO: "stock" })), true);
  assertEquals(denoChosenExplicitly(env({ DENEXT_DENO: "/opt/deno" })), true);
  assertEquals(denoChosenExplicitly(env({ DENO_BIN: "/opt/deno" })), true);
  assertEquals(
    denoChosenExplicitly(env({ DENO_BIN: "/opt/deno", DENEXT_TOOLCHAIN_ACTIVE: "1" })),
    false,
  );
  // The default reads this process's environment.
  assertEquals(typeof denoChosenExplicitly(), "boolean");
});

Deno.test("desktop: doctor and add only inspect; the other actions do not", () => {
  const inspects = (positionals: string[]) =>
    desktopCommand.inspectsOnly!(makeCtx({ positionals }));
  assertEquals(inspects(["doctor"]), true);
  assertEquals(inspects(["add", "fs"]), true);
  for (const action of ["run", "dev", "build", "package", "publish-update"]) {
    assertEquals(inspects([action]), false, action);
  }
  assertEquals(inspects([]), false);
});

Deno.test("desktop: an --entry outside the project, and flags of another action, are refused", async () => {
  const dir = await tempDir("denext_desktop_flags_");
  try {
    let r = await runVerb(["run"], dir, { entry: "../elsewhere.ts" });
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, "denext desktop: --entry ../elsewhere.ts is outside the project");
    r = await runVerb(["build"], dir, { headless: true });
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, "--headless applies to `denext desktop run` only");
    r = await runVerb(["run"], dir, { "inspect-renderer": true });
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, "--inspect-renderer applies to `denext desktop dev` only");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
