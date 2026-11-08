// The `pty` desktop capability (src/desktop/caps/pty.ts) over a fake `Deno.openPty` and a fake
// extension host: terminals owned per window (another window's id is `not_found`), output to the
// owner only with a per-terminal `seq`, coalescing, the allow-list, the env filter, the cwd check,
// kill / detach on the window's close, the replay through `attach`, the app's quit, and
// `unsupported` without `Deno.openPty`. Plus the packaging side: the baked `--allow-run` names the
// allowed shells only (src/build/desktop-capabilities.ts), the config validator, and the doctor's
// `pty` check.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type DenoPty,
  type DenoPtyOptions,
  type DenoPtyStatus,
  ptyCapability,
  type PtyCapabilityOptions,
  ptyEnvNameRefused,
} from "../src/desktop/caps/pty.ts";
import {
  type DesktopCapability,
  type DesktopCapCtx,
  DesktopCapError,
  type DesktopExtensionHost,
} from "../src/desktop/extension.ts";
import type { OwnedResourcesClosedWindow } from "../src/desktop/owned-resources.ts";
import {
  PTY_DEFAULT_SHELLS,
  ptyConfigProblem,
  resolvePtyConfig,
} from "../src/desktop/pty-config.ts";
import {
  DESKTOP_CAPABILITIES,
  desktopBuildFlags,
  desktopPtyRunPaths,
} from "../src/build/desktop-capabilities.ts";
import { FIRST_PTY_RUNTIME, supportsPty } from "../src/build/deno-version.ts";
import { ptyDoctorCheck, ptyFactLine } from "../src/build/desktop-pty-doctor.ts";
import { formatDesktopDoctor, runDesktopDoctor } from "../src/build/desktop-doctor.ts";
import { validateDesktop } from "../src/server/config-validate/desktop.ts";
import type { DesktopRuntimeStatus } from "../src/build/desktop-runtime.ts";
import { desktopDoctor } from "../src/cli/commands/desktop-doctor.ts";
import type { CommandContext } from "../src/cli/command.ts";
import { join } from "@std/path";
import { withDenoProps } from "./helpers/deno-stub.ts";

const encoder = new TextEncoder();

/** One fake terminal: its output, its exit, and what the capability did to it. */
interface FakeTerm {
  readonly options: DenoPtyOptions;
  readonly pty: DenoPty;
  readonly written: string[];
  readonly kills: string[];
  readonly resizes: Array<[number, number]>;
  output(text: string | Uint8Array): void;
  exit(code: number, signal?: string | null): void;
}

/** A fake `Deno.openPty` that records every terminal it opens. */
function fakeOpenPty(opts: { ignoreHangup?: boolean } = {}) {
  const terms: FakeTerm[] = [];
  let pid = 1000;
  const openPty = (options: DenoPtyOptions): DenoPty => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
    const written: string[] = [];
    const decoder = new TextDecoder();
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => void written.push(decoder.decode(chunk)),
    });
    let settle!: (s: DenoPtyStatus) => void;
    const status = new Promise<DenoPtyStatus>((r) => (settle = r));
    let ended = false;
    const exit = (code: number, signal: string | null = null) => {
      if (ended) return;
      ended = true;
      try {
        ctl.close();
      } catch { /* closed */ }
      settle({ success: code === 0, code, signal });
    };
    const kills: string[] = [];
    const resizes: Array<[number, number]> = [];
    const pty: DenoPty = {
      pid: ++pid,
      readable,
      writable,
      status,
      resize: (c, r) => void resizes.push([c, r]),
      kill: (signal = "SIGHUP") => {
        kills.push(signal);
        if (signal === "SIGHUP" && opts.ignoreHangup) return;
        exit(128 + 1, signal);
      },
    };
    terms.push({
      options,
      pty,
      written,
      kills,
      resizes,
      output: (text) => ctl.enqueue(typeof text === "string" ? encoder.encode(text) : text),
      exit,
    });
    return pty;
  };
  return { openPty, terms };
}

interface Sent {
  event: string;
  data: { id: string; data: Record<string, unknown> };
  window: string | undefined;
}

/** A fake extension host with the window lifecycle the multi-window bridge gives it. */
function fakeHost() {
  const sent: Sent[] = [];
  const closed = new Set<(info: OwnedResourcesClosedWindow) => void | Promise<void>>();
  const quit = new Set<() => void | Promise<void>>();
  const open = [
    { id: "main", kind: "main" as const, key: "main" },
    { id: "w2", kind: "window" as const, key: "editor" },
  ];
  const host = {
    emit: (event: string, data: unknown, options?: { window?: string }) =>
      void sent.push({ event, data: data as Sent["data"], window: options?.window }),
    pickedPath: () => {
      throw new Error("no picked paths in tests");
    },
    appSupportDir: "",
    os: "linux" as const,
    onWindowClosed: (fn: (info: OwnedResourcesClosedWindow) => void | Promise<void>) => {
      closed.add(fn);
      return () => closed.delete(fn);
    },
    onAppQuit: (fn: () => void | Promise<void>) => {
      quit.add(fn);
      return () => quit.delete(fn);
    },
    windows: () => open,
  };
  return {
    host: host as unknown as DesktopExtensionHost,
    sent,
    close: async (id: string, appQuitting = false) => {
      const win = open.find((w) => w.id === id) ?? { id, kind: "window" as const, key: id };
      for (const fn of [...closed]) await fn({ ...win, appQuitting });
    },
    quit: async () => {
      for (const fn of [...quit]) await fn();
    },
  };
}

function ctx(windowId = "main"): DesktopCapCtx {
  return {
    emit: () => {},
    appSupportDir: "",
    runOnMainThread: () => Promise.reject(new Error("no UI thread")),
    secureStore: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    pickedPath: () => {
      throw new Error("no picked paths");
    },
    os: "linux",
    windowId,
    signal: new AbortController().signal,
  };
}

/** Call a method's handler as the bridge does (always through a promise). */
function call(cap: DesktopCapability, method: string, args: unknown, c = ctx()): Promise<unknown> {
  return Promise.resolve().then(() => cap.methods[method].handler(args, c));
}

/** Wait until `cond` holds (or fail after ~2 s). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting");
}

const ENV: Record<string, string> = {
  HOME: "/home/u",
  SHELL: "/bin/zsh",
  PATH: "/usr/bin:/bin",
  LD_PRELOAD: "/tmp/evil.so",
  ld_library_path: "/tmp",
  " DYLD_INSERT_LIBRARIES": "/tmp/x.dylib",
  TMUX: "/tmp/tmux-1/default,1,0",
};

/** A capability over the fakes (Linux shells, directories `/home/u` and `/srv`). */
function setup(
  over: Partial<PtyCapabilityOptions> & { pty?: unknown; ignoreHangup?: boolean } = {},
) {
  const fake = fakeOpenPty({ ignoreHangup: over.ignoreHangup });
  const host = fakeHost();
  const cap = ptyCapability({
    config: resolvePtyConfig(over.pty ?? true, "linux"),
    os: "linux",
    openPty: fake.openPty,
    env: { get: (k) => ENV[k], toObject: () => ({ ...ENV }) },
    isDirectory: (p) => Promise.resolve(p === "/home/u" || p === "/srv"),
    readTextFile: (p) =>
      p.endsWith("/stat")
        ? Promise.resolve("1001 (zsh (x)) S 1 1001 1001 34816 1200 4194560")
        : Promise.resolve("vim\n"),
    readLink: () => Promise.resolve("/srv"),
    flushMs: 5,
    killGraceMs: 50,
    exitGraceMs: 10,
    ...over,
  });
  cap.setup!(host.host);
  return { cap, ...fake, ...host };
}

type Spawned = { id: string; pid: number; shell: string; cwd: string };

const spawn = (cap: DesktopCapability, c = ctx(), args: Record<string, unknown> = {}) =>
  call(cap, "spawn", { cols: 80, rows: 24, ...args }, c) as Promise<Spawned>;

/** The `data` events sent so far, as `[window, id, seq, data]`. */
const dataSent = (sent: Sent[]) =>
  sent.filter((s) => s.event === "data").map((s) => [
    s.window,
    s.data.id,
    s.data.data.seq,
    s.data.data.data,
  ]);

/** Reject with a DesktopCapError of `code`. */
async function rejectsCode(p: Promise<unknown>, code: string): Promise<DesktopCapError> {
  const err = await assertRejects(() => p, DesktopCapError);
  assertEquals(err.code, code);
  return err;
}

// --- spawn ---------------------------------------------------------------------------------------

Deno.test("pty.spawn: starts the user's shell as a login shell in the home folder", async () => {
  const t = setup();
  const s = await spawn(t.cap);
  assertMatch(s.id, /^[0-9a-f-]{36}$/);
  assertEquals([s.shell, s.cwd, s.pid], ["/bin/zsh", "/home/u", 1001]);
  const o = t.terms[0].options;
  assertEquals([o.cmd, o.args, o.cwd, o.cols, o.rows, o.clearEnv], [
    "/bin/zsh",
    ["-l"],
    "/home/u",
    80,
    24,
    true,
  ]);
  const other = await spawn(t.cap);
  assert(other.id !== s.id, "every terminal gets its own random id");
  await t.quit();
});

Deno.test("pty.spawn: a program off the allow-list is refused before anything starts", async () => {
  const t = setup({ pty: { shells: ["/bin/bash"] } });
  await rejectsCode(spawn(t.cap, ctx(), { shell: "/usr/bin/python3" }), "forbidden");
  await rejectsCode(spawn(t.cap, ctx(), { shell: "bash" }), "forbidden");
  assertEquals(t.terms.length, 0);
  // $SHELL (/bin/zsh) is not allowed here, so the default is the list's first entry.
  const s = await spawn(t.cap);
  assertEquals(s.shell, "/bin/bash");
  assertEquals(
    (await spawn(t.cap, ctx(), { shell: "/bin/bash", args: ["-c", "true"] })).shell,
    "/bin/bash",
  );
  assertEquals(t.terms[1].options.args, ["-c", "true"]);
  await t.quit();
});

Deno.test("pty.spawn: a shells list with nothing for this OS refuses every spawn", async () => {
  const t = setup({ pty: { shells: ["C:\\Windows\\System32\\cmd.exe"] } });
  await rejectsCode(spawn(t.cap), "forbidden");
  assertEquals(t.terms.length, 0);
});

Deno.test("pty.spawn: cwd must be an absolute path to an existing directory", async () => {
  const t = setup();
  await rejectsCode(spawn(t.cap, ctx(), { cwd: "/etc/passwd" }), "validation");
  await rejectsCode(spawn(t.cap, ctx(), { cwd: "srv" }), "validation");
  await rejectsCode(spawn(t.cap, ctx(), { cwd: 7 }), "validation");
  assertEquals(t.terms.length, 0);
  assertEquals((await spawn(t.cap, ctx(), { cwd: "/srv" })).cwd, "/srv");
  await t.quit();
});

Deno.test("pty.spawn: sizes, args and env are checked", async () => {
  const t = setup();
  for (
    const bad of [
      { cols: 0 },
      { rows: 1.5 },
      { cols: 10_001 },
      { args: "x" },
      { args: ["a\0b"] },
      { env: { A: 1 } },
      { env: [] },
      { shell: 3 },
    ]
  ) {
    await rejectsCode(spawn(t.cap, ctx(), bad), "validation");
  }
  await rejectsCode(call(t.cap, "spawn", null), "validation");
  assertEquals(t.terms.length, 0);
});

Deno.test("pty.spawn: the env drops LD_* / DYLD_* (any case) and a parent terminal's", async () => {
  const t = setup();
  await spawn(t.cap, ctx(), {
    env: {
      FOO: "bar",
      LD_PRELOAD: "/tmp/page.so",
      Dyld_Library_Path: "/tmp",
      "BAD-NAME": "x",
      TERM: "xterm",
    },
  });
  const env = t.terms[0].options.env!;
  assertEquals(env.FOO, "bar");
  assertEquals(env.TERM, "xterm", "the page may set TERM");
  assertEquals(env.COLORTERM, "truecolor");
  assertEquals(env.PATH, "/usr/bin:/bin");
  assertEquals(env.PWD, "/home/u");
  for (const k of Object.keys(env)) {
    assert(!ptyEnvNameRefused(k), `${k} must not reach the terminal`);
  }
  assertEquals(env.TMUX, undefined);
  assertEquals(env["BAD-NAME"], undefined);
  assertEquals(t.terms[0].options.clearEnv, true, "nothing is inherited past the filter");
  await t.quit();
});

Deno.test("ptyEnvNameRefused: the runtime's LD_ / DYLD_ rule", () => {
  for (const k of ["LD_PRELOAD", "ld_preload", " DYLD_X", "Ld_", "DYLD_"]) {
    assert(ptyEnvNameRefused(k), k);
  }
  for (const k of ["PATH", "OLD_PWD", "XLD_A", "LDPATH"]) assert(!ptyEnvNameRefused(k), k);
});

Deno.test("pty.spawn: an env under a scoped --allow-env reads the known names only", async () => {
  const t = setup({
    env: {
      get: (k) =>
        ({ HOME: "/home/u", PATH: "/bin", LD_PRELOAD: "/x" } as Record<string, string>)[k],
      toObject: () => {
        throw new Error("NotCapable");
      },
    },
  });
  await spawn(t.cap);
  const env = t.terms[0].options.env!;
  assertEquals([env.HOME, env.PATH, env.LD_PRELOAD], ["/home/u", "/bin", undefined]);
  assertEquals(t.terms[0].options.cmd, PTY_DEFAULT_SHELLS.linux[0], "no $SHELL: the first entry");
  await t.quit();
});

Deno.test("pty.spawn: NotCapable is forbidden, NotSupported (Windows) unsupported, else spawn_failed", async () => {
  for (
    const [name, code] of [
      ["NotCapable", "forbidden"],
      ["NotSupported", "unsupported"],
      ["Error", "spawn_failed"],
    ]
  ) {
    const t = setup({
      openPty: () => {
        const e = new Error("denied /bin/zsh");
        e.name = name;
        throw e;
      },
    });
    const err = await rejectsCode(spawn(t.cap), code);
    assert(!err.message.includes("/bin/zsh"), "no host path in the message");
  }
});

Deno.test("pty.spawn: at most 64 terminals at once", async () => {
  const t = setup();
  for (let i = 0; i < 64; i++) await spawn(t.cap);
  await rejectsCode(spawn(t.cap), "busy");
  t.terms[0].exit(0);
  await until(() => t.sent.some((s) => s.event === "exit"));
  await spawn(t.cap); // an ended terminal frees its place
  await t.quit();
});

// --- output -------------------------------------------------------------------------------------

Deno.test("pty data: to the owner window only, coalesced, with a growing seq", async () => {
  const t = setup();
  const s = await spawn(t.cap, ctx("w2"));
  const term = t.terms[0];
  term.output("a");
  term.output("b");
  term.output("c");
  await until(() => dataSent(t.sent).length === 1);
  term.output("d");
  await until(() => dataSent(t.sent).length === 2);
  assertEquals(dataSent(t.sent), [["w2", s.id, 1, "abc"], ["w2", s.id, 2, "d"]]);
  await t.quit();
});

Deno.test("pty data: a large chunk is split, and a split UTF-8 character is kept whole", async () => {
  const t = setup({ pty: { replayBytes: 8192 } }); // events of at most 8192 / 8 = 1024 bytes
  await spawn(t.cap);
  const term = t.terms[0];
  term.output("x".repeat(2500));
  const euro = encoder.encode("€");
  term.output(euro.subarray(0, 1));
  term.output(euro.subarray(1));
  await until(() => dataSent(t.sent).map((d) => d[3] as string).join("").length === 2501);
  const chunks = dataSent(t.sent).map((d) => d[3] as string);
  assert(chunks.length >= 3);
  assert(chunks.every((c) => encoder.encode(c).byteLength <= 1024));
  assertEquals(chunks.join(""), "x".repeat(2500) + "€");
  assertEquals(dataSent(t.sent).map((d) => d[2]), chunks.map((_, i) => i + 1));
  await t.quit();
});

Deno.test("pty exit: the last output then the exit, to the owner; the terminal is forgotten", async () => {
  const t = setup();
  const s = await spawn(t.cap, ctx("w2"));
  t.terms[0].output("bye");
  t.terms[0].exit(3);
  await until(() => t.sent.some((e) => e.event === "exit"));
  const last = t.sent.slice(-2);
  assertEquals(last.map((e) => [e.event, e.window]), [["data", "w2"], ["exit", "w2"]]);
  assertEquals(last[1].data, { id: s.id, data: { exitCode: 3, signal: null } });
  await until(() => true);
  await rejectsCode(call(t.cap, "info", { id: s.id }, ctx("w2")), "not_found");
});

// --- ownership ----------------------------------------------------------------------------------

Deno.test("pty ownership: another window's terminal is not_found for every method", async () => {
  const t = setup();
  const s = await spawn(t.cap, ctx("main"));
  const other = ctx("w2");
  await rejectsCode(call(t.cap, "write", { id: s.id, data: "rm -rf ~\r" }, other), "not_found");
  await rejectsCode(call(t.cap, "resize", { id: s.id, cols: 1, rows: 1 }, other), "not_found");
  await rejectsCode(call(t.cap, "kill", { id: s.id }, other), "not_found");
  await rejectsCode(call(t.cap, "info", { id: s.id }, other), "not_found");
  await rejectsCode(call(t.cap, "attach", { id: s.id }, other), "not_found");
  await rejectsCode(call(t.cap, "write", { id: crypto.randomUUID(), data: "x" }), "not_found");
  assertEquals(await call(t.cap, "list", {}, other), []);
  assertEquals(t.terms[0].written, []);
  assertEquals(t.terms[0].kills, []);
  assertEquals(t.terms[0].resizes, []);
  await t.quit();
});

Deno.test("pty: the owner writes (text, binary), resizes, inspects and kills", async () => {
  const t = setup();
  const s = await spawn(t.cap);
  await call(t.cap, "write", { id: s.id, data: "ls\r" });
  await call(t.cap, "write", { id: s.id, data: "\x1b[M\xff", binary: true });
  await rejectsCode(call(t.cap, "write", { id: s.id, data: "€", binary: true }), "validation");
  await rejectsCode(call(t.cap, "write", { id: s.id, data: 5 }), "validation");
  assertEquals(t.terms[0].written[0], "ls\r");
  assertEquals(t.terms[0].written.length, 2);
  await call(t.cap, "resize", { id: s.id, cols: 100, rows: 40 });
  assertEquals(t.terms[0].resizes, [[100, 40]]);
  assertEquals(await call(t.cap, "info", { id: s.id }), {
    pid: s.pid,
    process: "vim",
    cwd: "/srv",
  });
  await rejectsCode(call(t.cap, "kill", { id: s.id, signal: "SIGSTOP" }), "validation");
  await call(t.cap, "kill", { id: s.id, signal: "SIGTERM" });
  assertEquals(t.terms[0].kills, ["SIGTERM"]);
  await until(() => t.sent.some((e) => e.event === "exit"));
});

Deno.test("pty.list: the window's own terminals and the detached ones", async () => {
  const t = setup({ pty: { onWindowClose: "detach" } });
  const a = await spawn(t.cap, ctx("main"));
  const b = await spawn(t.cap, ctx("w2"));
  assertEquals(
    (await call(t.cap, "list", {}, ctx("main")) as Array<{ id: string }>).map((e) => e.id),
    [a.id],
  );
  await t.close("w2");
  const listed = await call(t.cap, "list", {}, ctx("main")) as Array<
    { id: string; detached: boolean; exited: boolean }
  >;
  assertEquals(listed.map((e) => [e.id, e.detached, e.exited]), [[a.id, false, false], [
    b.id,
    true,
    false,
  ]]);
  await t.quit();
});

// --- window close, reload, quit -----------------------------------------------------------------

Deno.test("pty kill policy: closing the owner kills its terminals (SIGHUP), not others'", async () => {
  const t = setup();
  await spawn(t.cap, ctx("main"));
  const b = await spawn(t.cap, ctx("w2"));
  await t.close("w2");
  assertEquals(t.terms[1].kills, ["SIGHUP"]);
  assertEquals(t.terms[0].kills, []);
  await rejectsCode(call(t.cap, "attach", { id: b.id }, ctx("main")), "not_found");
  await t.quit();
});

Deno.test("pty kill policy: a program ignoring SIGHUP gets SIGKILL", async () => {
  const t = setup({ ignoreHangup: true });
  await spawn(t.cap, ctx("w2"));
  await t.close("w2");
  assertEquals(t.terms[0].kills, ["SIGHUP", "SIGKILL"]);
});

Deno.test("pty detach policy: a closed window's terminal keeps running; attach replays it", async () => {
  const t = setup({ pty: { onWindowClose: "detach" } });
  const s = await spawn(t.cap, ctx("w2"));
  t.terms[0].output("one");
  await until(() => dataSent(t.sent).length === 1);
  await t.close("w2");
  assertEquals(t.terms[0].kills, [], "detached, not killed");
  t.terms[0].output("two");
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(dataSent(t.sent).length, 1, "nobody owns it: nothing is sent");
  // Any window may take a detached terminal over, and gets what it missed.
  const { replay } = await call(t.cap, "attach", { id: s.id }, ctx("main")) as {
    replay: Array<{ event: string; data: unknown }>;
  };
  assertEquals(replay, [
    { event: "data", data: { seq: 1, data: "one" } },
    { event: "data", data: { seq: 2, data: "two" } },
  ]);
  t.terms[0].output("three");
  await until(() => dataSent(t.sent).length === 2);
  assertEquals(dataSent(t.sent)[1], ["main", s.id, 3, "three"]);
  // Now main owns it: the window that closed cannot reach it any more.
  await rejectsCode(call(t.cap, "write", { id: s.id, data: "x" }, ctx("w2")), "not_found");
  await call(t.cap, "write", { id: s.id, data: "x" }, ctx("main"));
  await t.quit();
});

Deno.test("pty detach policy: an exit while detached is replayed, then the terminal is gone", async () => {
  const t = setup({ pty: { onWindowClose: "detach" } });
  const s = await spawn(t.cap, ctx("w2"));
  await t.close("w2");
  t.terms[0].output("done");
  t.terms[0].exit(0);
  await new Promise((r) => setTimeout(r, 40));
  const listed = await call(t.cap, "list", {}, ctx("main")) as Array<{ exited: boolean }>;
  assertEquals(listed.map((e) => e.exited), [true]);
  const { replay } = await call(t.cap, "attach", { id: s.id }, ctx("main")) as {
    replay: Array<{ event: string; data: unknown }>;
  };
  assertEquals(replay.map((e) => e.event), ["data", "exit"]);
  assertEquals(replay[1].data, { exitCode: 0, signal: null });
  await rejectsCode(call(t.cap, "attach", { id: s.id }, ctx("main")), "not_found");
});

Deno.test("pty: a page reload kills (kill policy) or detaches (detach policy) its terminals", async () => {
  const killed = setup();
  await spawn(killed.cap, ctx("w2"));
  await spawn(killed.cap, ctx("main"));
  await killed.cap.onPageLoad!("w2");
  assertEquals(killed.terms.map((t) => t.kills), [["SIGHUP"], []]);
  await killed.quit();

  const kept = setup({ pty: { onWindowClose: "detach" } });
  const s = await spawn(kept.cap, ctx("w2"));
  await kept.cap.onPageLoad!("w2");
  assertEquals(kept.terms[0].kills, []);
  const listed = await call(kept.cap, "list", {}, ctx("w2")) as Array<
    { id: string; detached: boolean }
  >;
  assertEquals(listed, [{ ...listed[0], id: s.id, detached: true }]);
  await call(kept.cap, "attach", { id: s.id }, ctx("w2"));
  await kept.quit();
});

Deno.test("pty: the app's quit kills every terminal, detached ones too", async () => {
  const t = setup({ pty: { onWindowClose: "detach" } });
  await spawn(t.cap, ctx("main"));
  await spawn(t.cap, ctx("w2"));
  await t.close("w2");
  await t.quit();
  assertEquals(t.terms.map((x) => x.kills), [["SIGHUP"], ["SIGHUP"]]);
  assertEquals(await call(t.cap, "list", {}, ctx("main")), []);
});

Deno.test("pty: a window closing because the app quits kills, whatever the policy", async () => {
  const t = setup({ pty: { onWindowClose: "detach" } });
  await spawn(t.cap, ctx("main"));
  await t.close("main", true);
  assertEquals(t.terms[0].kills, ["SIGHUP"]);
});

Deno.test("pty: without the window lifecycle on the host, setup still works", async () => {
  const fake = fakeOpenPty();
  const sent: unknown[] = [];
  const cap = ptyCapability({
    config: resolvePtyConfig(true, "linux"),
    os: "linux",
    openPty: fake.openPty,
    env: { get: () => undefined, toObject: () => ({}) },
    isDirectory: () => Promise.resolve(false),
    flushMs: 1,
  });
  cap.setup!(
    { emit: (_e: string, d: unknown) => void sent.push(d) } as unknown as DesktopExtensionHost,
  );
  const s = await spawn(cap);
  assertEquals(s.cwd, "", "no readable home: the runtime's own folder");
  fake.terms[0].output("hi");
  await until(() => sent.length === 1);
  fake.terms[0].exit(0);
  await until(() => sent.length === 2);
});

// --- unsupported ---------------------------------------------------------------------------------

Deno.test("pty: without Deno.openPty every method rejects unsupported with the reason", async () => {
  const t = setup();
  const cap = ptyCapability({
    config: resolvePtyConfig(true, "linux"),
    os: "linux",
    env: { get: () => undefined, toObject: () => ({}) },
  });
  cap.setup!(t.host);
  await withDenoProps({ openPty: undefined }, async () => {
    for (
      const [method, args] of [
        ["spawn", { cols: 80, rows: 24 }],
        ["write", { id: "x", data: "y" }],
        ["resize", { id: "x", cols: 1, rows: 1 }],
        ["kill", { id: "x" }],
        ["info", { id: "x" }],
        ["attach", { id: "x" }],
        ["list", {}],
      ] as const
    ) {
      const err = await rejectsCode(call(cap, method, args), "unsupported");
      assert(err.message.includes(FIRST_PTY_RUNTIME), method);
      assertEquals((err.data as { requires: string }).requires, FIRST_PTY_RUNTIME);
    }
  });
  // The runtime's own Deno.openPty is used when it has one (looked up at each call).
  const fake = fakeOpenPty();
  await withDenoProps({ openPty: fake.openPty }, () => spawn(cap));
  assertEquals(fake.terms.length, 1);
  await t.quit();
});

Deno.test("FIRST_PTY_RUNTIME: Deno.openPty from 3.0.0-denext.12 (no .11 release)", () => {
  assertEquals(FIRST_PTY_RUNTIME, "3.0.0-denext.12");
  assert(supportsPty("3.0.0-denext.12"));
  assert(supportsPty("3.0.0-denext.13"));
  assert(!supportsPty("3.0.0-denext.10"));
  assert(!supportsPty("3.0.0-rc.6"));
  assert(!supportsPty("not a version"));
});

// --- config --------------------------------------------------------------------------------------

Deno.test("resolvePtyConfig: defaults, per-OS filtering, and refusals", () => {
  assertEquals(resolvePtyConfig(true, "darwin"), {
    onWindowClose: "kill",
    replayBytes: 512 * 1024,
    shells: ["/bin/zsh", "/bin/bash", "/bin/sh"],
  });
  const mixed = {
    shells: ["/opt/homebrew/bin/fish", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"],
  };
  assertEquals(resolvePtyConfig(mixed, "linux").shells, ["/opt/homebrew/bin/fish"]);
  assertEquals(resolvePtyConfig(mixed, "windows").shells, [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  ]);
  for (
    const bad of [
      "yes",
      { onWindowClose: "keep" },
      { replayBytes: 10 },
      { replayBytes: -1 },
      { shells: "/bin/sh" },
      { shells: ["zsh"] },
      { shells: ["./bin/sh"] },
      { shells: ["/bin/a,/bin/b"] },
    ]
  ) {
    assert(ptyConfigProblem(bad) !== null, JSON.stringify(bad));
    assertThrows(() => resolvePtyConfig(bad, "linux"));
  }
  assertEquals(ptyConfigProblem({ replayBytes: 0, onWindowClose: "detach" }), null);
});

Deno.test("validateDesktop: an invalid pty value fails the config", () => {
  const fail = (field: string, msg: string): never => {
    throw new Error(`${field} ${msg}`);
  };
  assertThrows(
    () => validateDesktop({ capabilities: { pty: { shells: ["bash"] } } }, undefined, fail),
    Error,
    "desktop.capabilities.pty.shells",
  );
  validateDesktop({ capabilities: { pty: { shells: ["/bin/bash"] } } }, undefined, fail);
  validateDesktop({ capabilities: { pty: true } }, undefined, fail);
});

// --- packaging -----------------------------------------------------------------------------------

/** The baked `--allow-run` of a config on `os`. */
const runFlag = (config: unknown, os: "darwin" | "linux" | "windows") =>
  desktopBuildFlags(config, os, { dataScope: false }).filter((f) => f.startsWith("--allow-run"));

Deno.test("packaging: pty bakes --allow-run of the allowed shells only, never unscoped", () => {
  const on = { desktop: { capabilities: { pty: true } } };
  assertEquals(runFlag(on, "darwin"), ["--allow-run=/bin/bash,/bin/sh,/bin/zsh"]);
  assertEquals(runFlag(on, "windows"), [
    "--allow-run=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe,C:\\Windows\\System32\\cmd.exe",
  ]);
  const narrowed = { desktop: { capabilities: { pty: { shells: ["/usr/local/bin/fish"] } } } };
  assertEquals(runFlag(narrowed, "linux"), ["--allow-run=/usr/local/bin/fish"]);
  assertEquals(runFlag(narrowed, "windows"), [], "no shell for this OS: no run grant");
  // Merged with another capability's programs into one flag.
  const both = { desktop: { capabilities: { pty: { shells: ["/bin/sh"] }, shell: true } } };
  assertEquals(runFlag(both, "linux"), ["--allow-run=/bin/sh,dbus-send,gio,xdg-open"]);
  assertEquals(runFlag({ desktop: { capabilities: { pty: false } } }, "linux"), []);
  assertEquals(desktopPtyRunPaths({ desktop: { capabilities: {} } }, "linux"), []);
  for (const os of ["darwin", "linux", "windows"] as const) {
    assert(!desktopBuildFlags(on, os, { dataScope: false }).includes("--allow-run"));
  }
});

Deno.test("packaging: an invalid pty.shells fails the build rather than bake it", () => {
  assertThrows(
    () => desktopBuildFlags({ desktop: { capabilities: { pty: { shells: ["sh"] } } } }, "linux"),
    Error,
    "pty.shells",
  );
});

Deno.test("desktop add pty: the catalog entry shows the default shells per OS", () => {
  const entry = DESKTOP_CAPABILITIES.pty;
  assertEquals([entry.key, entry.value, entry.trust], ["pty", true, "full"]);
  assertEquals(entry.os?.darwin?.run, PTY_DEFAULT_SHELLS.darwin);
  assert(entry.api.includes("spawnPty (denext/desktop/client)"));
});

// --- doctor --------------------------------------------------------------------------------------

Deno.test("doctor pty: the baked run list, the runtime, detach without keepAlive", () => {
  assertEquals(ptyDoctorCheck({ capabilities: {} }, "linux", "3.0.0-denext.12"), null);
  const old = ptyDoctorCheck({ capabilities: { pty: true } }, "darwin", "3.0.0-denext.8")!;
  assertEquals(old.pty, {
    runAllow: ["/bin/zsh", "/bin/bash", "/bin/sh"],
    onWindowClose: "kill",
    runtimeSupported: false,
  });
  assertEquals(old.findings.map((f) => f.level), ["warning"]);
  assert(old.findings[0].message.includes(FIRST_PTY_RUNTIME));
  assertEquals(
    ptyFactLine(old.pty!),
    `  pty       --allow-run=/bin/zsh,/bin/bash,/bin/sh; onWindowClose kill; needs ${FIRST_PTY_RUNTIME}`,
  );

  const detach = { capabilities: { pty: { onWindowClose: "detach" } } };
  const lonely = ptyDoctorCheck(detach, "linux", "3.0.0-denext.12")!;
  assertEquals(lonely.findings.length, 1);
  assert(lonely.findings[0].message.includes("keepAlive"));
  assertEquals(
    ptyDoctorCheck({ ...detach, app: { keepAlive: true } }, "linux", "3.0.0-denext.12")!.findings,
    [],
  );
  assertEquals(
    ptyDoctorCheck({ ...detach, tray: { icon: "/t.png" } }, "linux", "3.0.0-denext.12")!.findings,
    [],
    "a tray keeps the app alive by default",
  );
  assertEquals(
    ptyDoctorCheck(
      { ...detach, tray: { icon: "/t.png" }, app: { keepAlive: false } },
      "linux",
      "3.0.0-denext.12",
    )!.findings.length,
    1,
  );
  const none = ptyDoctorCheck(
    { capabilities: { pty: { shells: ["/bin/sh"] } } },
    "windows",
    "3.0.0-denext.12",
  )!;
  // Windows: no terminals in the runtime yet, and no Windows program on the list.
  assertEquals(none.findings.map((f) => f.check), ["pty", "pty"]);
  assertStringIncludes(none.findings[0].message, "no terminals on Windows");
  assertStringIncludes(none.findings[1].message, "lists no program for windows");
  const bad = ptyDoctorCheck(
    { capabilities: { pty: { shells: ["sh"] } } },
    "linux",
    "3.0.0-denext.12",
  )!;
  assertEquals([bad.pty, bad.findings[0].level], [null, "error"]);
});

Deno.test("doctor: the pty check runs from the project's desktop config", async () => {
  const status = {
    mode: "stock",
    ok: true,
    detail: "stock runtime",
    backend: "webview",
  } as unknown as DesktopRuntimeStatus;
  const report = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status),
    os: "darwin",
    linux: false,
    desktopConfig: () => Promise.resolve({ capabilities: { pty: true } }),
  });
  assert(report.checks.includes("pty"));
  assertEquals(report.pty?.runAllow, ["/bin/zsh", "/bin/bash", "/bin/sh"]);
  assert(formatDesktopDoctor(report).includes("--allow-run=/bin/zsh,/bin/bash,/bin/sh"));
  const without = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status),
    os: "darwin",
    linux: false,
    desktopConfig: () => Promise.resolve(null),
  });
  assert(!without.checks.includes("pty"));
});

Deno.test("desktop doctor CLI: the pty check reads the project's denext.config.ts as data", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_pty_doctor_cli_" });
  const status = {
    mode: "stock",
    ok: true,
    detail: "stock runtime",
    backend: "webview",
  } as unknown as DesktopRuntimeStatus;
  const ctx = {
    flags: {},
    positionals: ["doctor"],
    global: { json: true },
    rest: [],
  } as unknown as CommandContext;
  const seams = {
    os: "darwin",
    runtimeStatus: () => Promise.resolve(status),
    launchPolicy: () => Promise.resolve(null),
  } as const;
  const log = console.log;
  console.log = () => {};
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "// entry\n");
    const config = join(dir, "denext.config.ts");
    // A desktop project whose config holds `capabilities.pty` as data: the check runs.
    await Deno.writeTextFile(
      config,
      "export default { desktop: { capabilities: { pty: true } } };\n",
    );
    const on = await desktopDoctor(ctx, dir, seams);
    assert(on.checks.includes("pty"), on.checks.join(","));
    assertEquals(on.pty?.runAllow, ["/bin/zsh", "/bin/bash", "/bin/sh"]);
    // `desktop` computed at runtime can't be read as data: no pty check (the launch-policy check
    // is the one that reports an unreadable config).
    await Deno.writeTextFile(
      config,
      "const desktop = { capabilities: { pty: true } };\nexport default { desktop };\n",
    );
    assert(!(await desktopDoctor(ctx, dir, seams)).checks.includes("pty"));
    // Not a desktop project: no pty check either.
    await Deno.remove(join(dir, "desktop.ts"));
    assert(!(await desktopDoctor(ctx, dir, seams)).checks.includes("pty"));
  } finally {
    console.log = log;
    await Deno.remove(dir, { recursive: true });
  }
});
