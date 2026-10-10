// Sidecars' login-shell environment (src/desktop/sidecar-login-env.ts, `loginShellEnv`): the
// sentinel command and its parsing through rc-file noise, the shells tried and in which order, the
// budget, a timeout and a non-zero exit on a fake runner, what reaches a sidecar (PATH merged, the
// asked keys, never DENO_* / DENEXT_*), the host's once-per-launch read and its fallback, the
// definition checks, the packaged app's --allow-run, and a real login bash with a temp HOME whose
// profile and rc file put a tool on PATH that a program sidecar then runs by its bare name.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  captureLoginShellEnv,
  denoLoginShellRunner,
  isReservedLoginVariable,
  LOGIN_SHELL_PATHS,
  LOGIN_SHELL_TIMEOUT_MS,
  loginEnvPatch,
  loginShellCandidates,
  type LoginShellCaptureOptions,
  loginShellCommand,
  type LoginShellRunner,
  type LoginShellRunResult,
  parseLoginShellOutput,
} from "../src/desktop/sidecar-login-env.ts";
import { type SidecarDefinition, sidecarDefinitionError } from "../src/desktop/sidecar.ts";
import type {
  SidecarInstance,
  SidecarLaunchContext,
  SidecarLauncher,
} from "../src/desktop/sidecar-supervisor.ts";
import { createSidecarHost } from "../src/desktop/sidecar-host.ts";
import { execSidecarLauncher, workerSidecarLauncher } from "../src/desktop/sidecar-launch.ts";
import { desktopBuildFlags, sidecarPermissionSet } from "../src/build/desktop-capabilities.ts";

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

/** The nonce a command was built with: its first marker, put back together from its halves. */
function nonceOf(command: string): string {
  const halves = command.match(/'(__DENEXT[^']*)' '([^']*)'/);
  return `${halves?.[1]}${halves?.[2]}`.match(/^__DENEXT_ENV_([0-9a-z]+)_/)?.[1] ?? "";
}

/** What a shell running `command` would print: each variable's value between its markers. */
function shellOutput(
  command: string,
  values: Record<string, string>,
  noise = "",
): string {
  const nonce = nonceOf(command);
  const names = [...command.matchAll(/printenv ([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  let out = noise;
  for (const name of names) {
    out += `__DENEXT_ENV_${nonce}_${name}_START__\n`;
    if (values[name] !== undefined) out += `${values[name]}\n`;
    out += `__DENEXT_ENV_${nonce}_${name}_END__\n`;
  }
  return out;
}

/** A recorded call of the fake runner. */
interface RunCall {
  readonly shell: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** A runner answering per shell; unknown shells fail to spawn. */
function fakeRunner(
  answers: Record<string, (command: string) => LoginShellRunResult>,
): { run: LoginShellRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: LoginShellRunner = (shell, args, env, timeoutMs) => {
    calls.push({ shell, args, env, timeoutMs });
    const answer = answers[shell];
    return Promise.resolve(
      answer ? answer(args[args.length - 1]) : { kind: "error", message: "NotFound" },
    );
  };
  return { run, calls };
}

/** Capture options on darwin with a fake runner. */
function opts(extra: Partial<LoginShellCaptureOptions>): LoginShellCaptureOptions {
  return { os: "darwin", env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" }, ...extra };
}

// ── the command and its output ───────────────────────────────────────────────────────────────

Deno.test("loginShellCommand: printf/printenv only, markers split so the command never contains one", () => {
  const cmd = loginShellCommand(["PATH", "LANG"], "abc123");
  assertStringIncludes(cmd, "printenv PATH; ");
  assertStringIncludes(cmd, "printenv LANG; ");
  assert(!cmd.includes("__DENEXT_ENV_abc123_PATH_START__"), "a whole marker is never in the text");
  assert(!cmd.includes("||") && !cmd.includes("&&") && !cmd.includes("$"), "portable to fish/nu");
  // What it prints, parsed back.
  const out = shellOutput(cmd, { PATH: "/opt/homebrew/bin:/usr/bin", LANG: "en_US.UTF-8" });
  assertEquals(parseLoginShellOutput(out, ["PATH", "LANG"], "abc123"), {
    PATH: "/opt/homebrew/bin:/usr/bin",
    LANG: "en_US.UTF-8",
  });
});

Deno.test("parseLoginShellOutput: rc-file noise, CRLF, multi-line and unset values; no PATH markers is null", () => {
  const n = "n0";
  const m = (name: string, edge: string) => `__DENEXT_ENV_${n}_${name}_${edge}__`;
  const out = "\x1b]1337;SetMark\x07Welcome to fish!\r\nlast login: today\n" +
    `${m("PATH", "START")}\r\n/a:/b\r\n${m("PATH", "END")}\r\n` +
    `motd in between\n${m("MULTI", "START")}\nline1\nline2\n${m("MULTI", "END")}\n` +
    `${m("UNSET", "START")}\n${m("UNSET", "END")}\n` +
    `${m("HALF", "START")}\nno end marker\n`;
  assertEquals(parseLoginShellOutput(out, ["PATH", "MULTI", "UNSET", "HALF", "NONE"], n), {
    PATH: "/a:/b",
    MULTI: "line1\nline2",
  });
  assertEquals(parseLoginShellOutput("just noise\n", ["PATH"], n), null);
  assertEquals(
    parseLoginShellOutput(`${m("PATH", "START")}\n/a\n`, ["PATH"], n),
    null,
    "a PATH start without its end is no answer",
  );
  // Another run's markers (a different nonce) are not this run's.
  assertEquals(parseLoginShellOutput(out, ["PATH"], "other"), null);
});

Deno.test("loginShellCandidates: $SHELL first, then the OS's defaults; csh/tcsh and relative paths skipped", () => {
  assertEquals(loginShellCandidates("darwin", "/opt/homebrew/bin/fish"), [
    "/opt/homebrew/bin/fish",
    "/bin/zsh",
    "/bin/bash",
  ]);
  assertEquals(loginShellCandidates("darwin", "/bin/zsh"), ["/bin/zsh", "/bin/bash"]);
  assertEquals(loginShellCandidates("linux", undefined), ["/bin/bash", "/bin/sh"]);
  assertEquals(loginShellCandidates("linux", "/bin/tcsh"), ["/bin/bash", "/bin/sh"]);
  assertEquals(loginShellCandidates("linux", "/usr/bin/csh"), ["/bin/bash", "/bin/sh"]);
  assertEquals(loginShellCandidates("linux", "zsh"), ["/bin/bash", "/bin/sh"]);
});

Deno.test("isReservedLoginVariable: DENO_* and DENEXT_* in any case", () => {
  assert(isReservedLoginVariable("DENO_DESKTOP_TOKEN"));
  assert(isReservedLoginVariable("DENEXT_OTA_SIGNING_KEY"));
  assert(isReservedLoginVariable("deno_dir"));
  assert(!isReservedLoginVariable("DENOX"));
  assert(!isReservedLoginVariable("PATH"));
});

// ── capture on a fake runner ─────────────────────────────────────────────────────────────────

Deno.test("captureLoginShellEnv: zsh answers through its rc noise; -l -i -c, stdin-free env without DENO_*/DENEXT_*", async () => {
  const { run, calls } = fakeRunner({
    "/bin/zsh": (cmd) => ({
      kind: "exit",
      code: 0,
      stdout: shellOutput(
        cmd,
        { PATH: "/opt/homebrew/bin:/usr/bin", SSH_AUTH_SOCK: "/tmp/s" },
        "[oh-my-zsh] update?\n",
      ),
    }),
  });
  const result = await captureLoginShellEnv(opts({
    run,
    names: ["SSH_AUTH_SOCK", "PATH", "DENO_DIR", "bad-name", "DENEXT_X"],
    env: { SHELL: "/bin/zsh", HOME: "/Users/u", DENO_DESKTOP_TOKEN: "t", DENEXT_DEV: "1" },
  }));
  assertEquals(result, {
    ok: true,
    shell: "/bin/zsh",
    env: { PATH: "/opt/homebrew/bin:/usr/bin", SSH_AUTH_SOCK: "/tmp/s" },
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args.slice(0, 3), ["-l", "-i", "-c"]);
  const cmd = calls[0].args[3];
  assertEquals([...cmd.matchAll(/printenv (\w+)/g)].map((m) => m[1]), ["PATH", "SSH_AUTH_SOCK"]);
  assertEquals(calls[0].env, { SHELL: "/bin/zsh", HOME: "/Users/u" });
  assertEquals(calls[0].timeoutMs, LOGIN_SHELL_TIMEOUT_MS);
});

Deno.test("captureLoginShellEnv: fish as $SHELL; a refused shell (NotCapable) falls back to the next", async () => {
  const { run, calls } = fakeRunner({
    "/opt/homebrew/bin/fish": () => ({ kind: "error", message: "Requires run access" }),
    "/bin/zsh": (cmd) => ({ kind: "exit", code: 0, stdout: shellOutput(cmd, { PATH: "/z" }) }),
  });
  const result = await captureLoginShellEnv(opts({
    run,
    env: { SHELL: "/opt/homebrew/bin/fish" },
  }));
  assertEquals(result, { ok: true, shell: "/bin/zsh", env: { PATH: "/z" } });
  assertEquals(calls.map((c) => c.shell), ["/opt/homebrew/bin/fish", "/bin/zsh"]);
});

Deno.test("captureLoginShellEnv: a non-zero exit or a shell that prints nothing tries the next; all failing says why", async () => {
  const { run, calls } = fakeRunner({
    "/usr/local/bin/bash": (cmd) => ({
      kind: "exit",
      code: 1,
      stdout: shellOutput(cmd, { PATH: "/x" }),
    }),
    "/bin/bash": () => ({ kind: "exit", code: 0, stdout: "bash: no job control in this shell\n" }),
    "/bin/sh": () => ({ kind: "exit", code: 127, stdout: "" }),
  });
  const result = await captureLoginShellEnv({
    os: "linux",
    env: { SHELL: "/usr/local/bin/bash" },
    run,
  });
  assertEquals(calls.map((c) => c.shell), ["/usr/local/bin/bash", "/bin/bash", "/bin/sh"]);
  assert(!result.ok);
  assertEquals(
    result.reason,
    "/usr/local/bin/bash exited 1; /bin/bash printed no environment; /bin/sh exited 127",
  );
});

Deno.test("captureLoginShellEnv: a timeout ends the search; the budget spans every shell", async () => {
  const timeout = fakeRunner({
    "/bin/zsh": () => ({ kind: "timeout" }),
    "/bin/bash": (cmd) => ({ kind: "exit", code: 0, stdout: shellOutput(cmd, { PATH: "/b" }) }),
  });
  const timedOut = await captureLoginShellEnv(opts({ run: timeout.run, timeoutMs: 1500 }));
  assertEquals(timedOut, { ok: false, reason: "/bin/zsh timed out after 1500 ms" });
  assertEquals(timeout.calls.length, 1, "no second shell after a timeout");

  // The first shell fails after using up 900 of 1000 ms: the next gets the 100 left; then none.
  let now = 0;
  const budget = fakeRunner({
    "/bin/fish": () => {
      now += 900;
      return { kind: "exit", code: 2, stdout: "" };
    },
    "/bin/zsh": () => {
      now += 200;
      return { kind: "error", message: "boom" };
    },
  });
  const spent = await captureLoginShellEnv(opts({
    run: budget.run,
    timeoutMs: 1000,
    now: () => now,
    env: { SHELL: "/bin/fish" },
  }));
  assertEquals(budget.calls.map((c) => [c.shell, c.timeoutMs]), [["/bin/fish", 1000], [
    "/bin/zsh",
    100,
  ]]);
  assert(!spent.ok);
  assertMatch(spent.reason, /timed out after 1000 ms$/);
});

Deno.test("captureLoginShellEnv: nothing to do on Windows (and other OSes)", async () => {
  const { run, calls } = fakeRunner({});
  assertEquals(await captureLoginShellEnv({ os: "windows", run }), { ok: false, reason: "" });
  assertEquals(await captureLoginShellEnv({ os: "freebsd", run }), { ok: false, reason: "" });
  assertEquals(calls.length, 0);
});

// ── what a sidecar gets ──────────────────────────────────────────────────────────────────────

Deno.test("loginEnvPatch: login PATH first, inherited entries it lacks after; asked keys only; never reserved", () => {
  assertEquals(
    loginEnvPatch(
      {
        PATH: "/opt/homebrew/bin:/usr/bin::/bin",
        SSH_AUTH_SOCK: "/s",
        LANG: "C",
        DENO_DIR: "/d",
      },
      ["SSH_AUTH_SOCK", "MISSING", "DENO_DIR", "PATH"],
      "/usr/bin:/bin:/usr/sbin:/sbin",
    ),
    {
      SSH_AUTH_SOCK: "/s",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
  );
  assertEquals(loginEnvPatch({}, [], undefined), {});
  assertEquals(loginEnvPatch({}, [], "/usr/bin"), { PATH: "/usr/bin" });
});

/** A launcher that records each start's context and ends at once. */
function recordingLauncher(): { launch: SidecarLauncher; ctxs: SidecarLaunchContext[] } {
  const ctxs: SidecarLaunchContext[] = [];
  const launch: SidecarLauncher = (ctx) => {
    ctxs.push(ctx);
    let end!: () => void;
    const exited = new Promise<{ code: number }>((r) => end = () => r({ code: 0 }));
    const instance: SidecarInstance = {
      exited,
      stop: () => {
        end();
        return exited.then(() => {});
      },
    };
    return Promise.resolve(instance);
  };
  return { launch, ctxs };
}

/** Wait until `check` holds (real time, bounded). */
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

Deno.test("host: the login environment is read once per launch, for the sidecars that ask, with every key and the longest budget", async () => {
  const { launch, ctxs } = recordingLauncher();
  const requests: LoginShellCaptureOptions[] = [];
  const host = await createSidecarHost({
    sidecars: [
      {
        name: "a",
        run: { exec: "true" },
        loginShellEnv: { keys: ["SSH_AUTH_SOCK"], timeoutMs: 500 },
      },
      { name: "b", run: { module: "./b.ts" }, loginShellEnv: { keys: ["LANG"] } },
      { name: "c", run: { exec: "true" }, loginShellEnv: false, env: { X: "1" } },
      { name: "d", run: { exec: "true" }, loginShellEnv: true, env: { PATH: "/mine" } },
    ],
    launcher: () => launch,
    inheritedPath: "/usr/bin:/bin",
    captureLoginShellEnv: (o) => {
      requests.push(o);
      return Promise.resolve({
        ok: true,
        shell: "/bin/zsh",
        env: { PATH: "/opt/homebrew/bin:/usr/bin", SSH_AUTH_SOCK: "/s", LANG: "en_US.UTF-8" },
      });
    },
  });
  host.startAll();
  await until(() => ctxs.length === 4);
  const by = (name: string) => ctxs.find((c) => c.definition.name === name)!;
  assertEquals(requests, [{ names: ["SSH_AUTH_SOCK", "LANG"], timeoutMs: LOGIN_SHELL_TIMEOUT_MS }]);
  assertEquals(by("a").loginEnv, { SSH_AUTH_SOCK: "/s", PATH: "/opt/homebrew/bin:/usr/bin:/bin" });
  assertEquals(by("b").loginEnv, { LANG: "en_US.UTF-8", PATH: "/opt/homebrew/bin:/usr/bin:/bin" });
  assertEquals(by("c").loginEnv, undefined, "a sidecar that did not ask gets nothing");
  assertEquals(by("d").loginEnv, { PATH: "/opt/homebrew/bin:/usr/bin:/bin" });
  // A restart reuses the launch's read.
  await host.handle("a").restart();
  await until(() => ctxs.length === 5);
  assertEquals(requests.length, 1);
  await host.stopAll();
});

Deno.test("host: a failed read logs one warning and starts with the inherited environment", async () => {
  const { launch, ctxs } = recordingLauncher();
  let reads = 0;
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    const host = await createSidecarHost({
      sidecars: [
        { name: "a", run: { exec: "true" }, loginShellEnv: { timeoutMs: 9000 } },
        { name: "b", run: { exec: "true" }, loginShellEnv: true },
      ],
      launcher: () => launch,
      captureLoginShellEnv: (o) => {
        reads++;
        assertEquals(o.timeoutMs, 9000);
        return Promise.resolve({ ok: false, reason: "/bin/zsh timed out after 9000 ms" });
      },
    });
    host.startAll();
    await until(() => ctxs.length === 2);
    assertEquals(ctxs.map((c) => c.loginEnv), [undefined, undefined]);
    assertEquals(reads, 1);
    const warnings = errors.filter((e) => e.includes("login-shell environment"));
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "timed out after 9000 ms");
    assertStringIncludes(warnings[0], "starting with the inherited one");
    await host.stopAll();
  } finally {
    console.error = original;
  }
});

Deno.test("host: Windows (an empty reason) starts silently; no sidecar asking reads nothing", async () => {
  const { launch, ctxs } = recordingLauncher();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  let reads = 0;
  try {
    const host = await createSidecarHost({
      sidecars: [{ name: "a", run: { exec: "true" }, loginShellEnv: true }],
      launcher: () => launch,
      captureLoginShellEnv: () => {
        reads++;
        return Promise.resolve({ ok: false, reason: "" });
      },
    });
    host.startAll();
    await until(() => ctxs.length === 1);
    assertEquals(ctxs[0].loginEnv, undefined);
    assertEquals(errors.filter((e) => e.includes("login-shell")), []);
    await host.stopAll();
    const none = await createSidecarHost({
      sidecars: [{ name: "b", run: { exec: "true" } }],
      launcher: () => launch,
      captureLoginShellEnv: () => {
        reads++;
        return Promise.resolve({ ok: false, reason: "" });
      },
    });
    none.startAll();
    await until(() => ctxs.length === 2);
    assertEquals(reads, 1);
    await none.stopAll();
  } finally {
    console.error = original;
  }
});

// ── definitions and packaging ────────────────────────────────────────────────────────────────

Deno.test("sidecarDefinitionError: loginShellEnv shapes", () => {
  const d = (loginShellEnv: unknown) =>
    sidecarDefinitionError({ name: "a", run: { exec: "x" }, loginShellEnv });
  assertEquals(d(true), null);
  assertEquals(d(false), null);
  assertEquals(d({}), null);
  assertEquals(d({ timeoutMs: 5000, keys: ["SSH_AUTH_SOCK", "LANG"] }), null);
  assertEquals(d("yes"), "loginShellEnv must be a boolean or { timeoutMs, keys }");
  assertMatch(d({ timeout: 1 })!, /^loginShellEnv\.timeout is not an option/);
  assertMatch(d({ timeoutMs: 0 })!, /timeoutMs must be milliseconds between 1 and 60 000/);
  assertMatch(d({ timeoutMs: 60_001 })!, /timeoutMs must be/);
  assertMatch(d({ timeoutMs: 1.5 })!, /timeoutMs must be/);
  assertEquals(d({ keys: "PATH" }), "loginShellEnv.keys must be a string array");
  assertEquals(d({ keys: ["A;rm"] }), 'loginShellEnv.keys: "A;rm" is not a variable name');
  assertMatch(d({ keys: ["DENO_DIR"] })!, /"DENO_DIR" is reserved/);
  assertMatch(d({ keys: ["denext_token"] })!, /"denext_token" is reserved/);
});

Deno.test("packaging: loginShellEnv bakes --allow-run for the OS's shells (none on Windows)", () => {
  const sidecars: SidecarDefinition[] = [
    { name: "a", run: { module: "./a.ts" }, loginShellEnv: true },
  ];
  assertEquals(sidecarPermissionSet(sidecars, "darwin").run, [...LOGIN_SHELL_PATHS.darwin].sort());
  assertEquals(sidecarPermissionSet(sidecars, "linux").run, [...LOGIN_SHELL_PATHS.linux].sort());
  assertEquals(sidecarPermissionSet(sidecars, "windows"), {});
  assertEquals(sidecarPermissionSet(sidecars), {});
  assertEquals(
    sidecarPermissionSet([{ name: "a", run: { module: "./a.ts" }, loginShellEnv: false }], "linux"),
    {},
  );
  const flags = desktopBuildFlags({ desktop: { sidecars } }, "darwin");
  const run = flags.find((f) => f.startsWith("--allow-run="));
  assert(run?.includes("/bin/zsh") && run.includes("/opt/homebrew/bin/fish"), run);
  assert(
    !desktopBuildFlags({ desktop: { sidecars } }, "windows").some((f) =>
      f.startsWith("--allow-run")
    ),
  );
});

// ── real processes ───────────────────────────────────────────────────────────────────────────

const POSIX = Deno.build.os !== "windows";

Deno.test({
  name:
    "denoLoginShellRunner: an exit with its output, a missing shell, and a hung shell killed at the timeout",
  ignore: !POSIX,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-login-shell-" });
    try {
      const ok = await denoLoginShellRunner("/bin/sh", [
        "-c",
        "printf 'hi\\n'; echo err >&2; exit 3",
      ], {
        PATH: "/usr/bin:/bin",
      }, 5000);
      assertEquals(ok, { kind: "exit", code: 3, stdout: "hi\n" });
      const missing = await denoLoginShellRunner(join(dir, "nope"), [], {}, 1000);
      assertEquals(missing.kind, "error");
      // A shell whose rc file never returns (and a grandchild holding stdout open).
      const hang = join(dir, "hang.sh");
      const pidFile = join(dir, "bg.pid");
      await Deno.writeTextFile(
        hang,
        `#!/bin/sh\nprintf 'partial'\nsleep 30 &\necho $! > '${pidFile}'\nexec sleep 30\n`,
      );
      await Deno.chmod(hang, 0o755);
      const started = Date.now();
      const timedOut = await denoLoginShellRunner(hang, [], { PATH: "/usr/bin:/bin" }, 300);
      assertEquals(timedOut, { kind: "timeout" });
      assert(Date.now() - started < 5000, "the timeout did not wait for the grandchild");
      // The orphaned `sleep 30 &` is killed so the test leaves nothing behind.
      const bg = Number((await Deno.readTextFile(pidFile)).trim());
      if (bg > 0) {
        try {
          Deno.kill(bg, "SIGKILL");
        } catch { /* already gone */ }
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "real login bash: a temp HOME's .profile and .bashrc put a tool on PATH, which a program sidecar runs by name",
  ignore: !POSIX || !(() => {
    try {
      return Deno.statSync("/bin/bash").isFile;
    } catch {
      return false;
    }
  })(),
  fn: async () => {
    const home = await Deno.makeTempDir({ prefix: "denext-login-home-" });
    try {
      const tools = join(home, "my tools");
      await Deno.mkdir(tools);
      const tool = join(tools, "denext-login-probe");
      await Deno.writeTextFile(tool, '#!/bin/sh\necho "probe ran: $GREETING $FROM_RC"\n');
      await Deno.chmod(tool, 0o755);
      await Deno.writeTextFile(
        join(home, ".profile"),
        `export PATH="$HOME/my tools:$PATH"\necho "profile noise"\n. "$HOME/.bashrc"\n`,
      );
      await Deno.writeTextFile(join(home, ".bashrc"), 'export FROM_RC=rc-value\necho "rc noise"\n');
      const capture = await captureLoginShellEnv({
        env: {
          HOME: home,
          SHELL: "/bin/bash",
          PATH: "/usr/bin:/bin",
          DENO_DESKTOP_TOKEN: "secret",
        },
        names: ["FROM_RC", "DENO_DESKTOP_TOKEN"],
        timeoutMs: 15_000,
      });
      assert(capture.ok, JSON.stringify(capture));
      assertEquals(capture.shell, "/bin/bash");
      assert(capture.env.PATH.split(":").includes(tools), capture.env.PATH);
      assertEquals(capture.env.FROM_RC, "rc-value");
      assertEquals(capture.env.DENO_DESKTOP_TOKEN, undefined);

      // A program sidecar named by its bare name is found on the login PATH.
      const loginEnv = loginEnvPatch(capture.env, ["FROM_RC"], "/usr/bin:/bin");
      const lines: string[] = [];
      const ctx: SidecarLaunchContext = {
        definition: { name: "probe", run: { exec: "denext-login-probe" }, env: { GREETING: "hi" } },
        bootstrap: null,
        secrets: {},
        loginEnv,
        onLine: (_s, l) => void lines.push(l),
        onReadySignal: () => {},
      };
      const inst = await execSidecarLauncher({ program: "denext-login-probe" })(ctx);
      assertEquals(await inst.exited, { code: 0 });
      assertEquals(lines, ["probe ran: hi rc-value"]);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  },
});

Deno.test("worker launcher: a module sidecar's process.env has the login variables under its own env", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-login-worker-" });
  const path = join(dir, "env.mjs");
  await Deno.writeTextFile(
    path,
    'import process from "node:process";\n' +
      "console.log([process.env.LOGIN_ONLY, process.env.BOTH, process.env.PATH].join('|'));\n" +
      "process.exit(0);\n",
  );
  try {
    const lines: string[] = [];
    const ctx: SidecarLaunchContext = {
      definition: { name: "w", run: { module: "./env.mjs" }, env: { BOTH: "mine" } },
      bootstrap: null,
      secrets: {},
      loginEnv: { LOGIN_ONLY: "login", BOTH: "login", PATH: "/login/bin:/usr/bin" },
      onLine: (_s, l) => void lines.push(l),
      onReadySignal: () => {},
    };
    const inst = await workerSidecarLauncher({ entry: toFileUrl(path).href })(ctx);
    await inst.exited;
    assertEquals(lines, ["login|mine|/login/bin:/usr/bin"]);
    assertEquals(Deno.env.get("LOGIN_ONLY"), undefined, "the app's environment is untouched");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
