// Detached sidecars (src/desktop/sidecar-detached*.ts, the detached launcher in sidecar-launch.ts):
// the definition checks; the registry record (atomic write, modes, key-checked removal); the start
// lock; the mutually authenticated control protocol and its failure modes (a wrong key on either
// side, an oversized line, a slow handshake, the connection cap, a replayed `auth`); the forced-kill
// rule; the supervisor's handling of a reattached / unstoppable instance; the launcher's decisions
// (reattach, version change, stale record) against in-process endpoints; and, with REAL processes
// and no window, a detached sidecar that outlives the app that started it: a second launch
// reattaches and stops it, a deleted record ends it, `exitAfterMs` ends it, an impostor on its
// recorded port is refused, and another app version replaces it.

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import process from "node:process";
import {
  detachedOptions,
  isDetachedSidecar,
  type SidecarDefinition,
  sidecarDefinitionError,
  sidecarListError,
} from "../src/desktop/sidecar.ts";
import {
  cleanDetachedLeftovers,
  connectDetachedControl,
  currentAppVersion,
  detachedMac,
  type DetachedRecord,
  detachedRecordPath,
  detachedRegistryDir,
  endDetachedSession,
  importDetachedKey,
  listDetachedRecords,
  listDetachedSidecars,
  newDetachedKey,
  parseDetachedRecord,
  probeDetachedControl,
  readDetachedRecord,
  removeDetachedRecord,
  serveDetachedControl,
  stopDetachedRecord,
  verifyDetachedMac,
  withDetachedLock,
  writeDetachedRecord,
} from "../src/desktop/sidecar-detached.ts";
import {
  detachedChildInitError,
  type DetachedChildProcess,
  rotateDetachedLog,
  runDetachedSidecarChild,
} from "../src/desktop/sidecar-detached-child.ts";
import { detachedSidecarLauncher } from "../src/desktop/sidecar-launch.ts";
import {
  createSidecarSupervisor,
  type SidecarClock,
  type SidecarInstance,
  type SidecarLaunchContext,
  type SidecarTimer,
} from "../src/desktop/sidecar-supervisor.ts";
import { sidecarChildLaunch } from "../src/desktop/sidecar-child.ts";
import { desktopBuildFlags } from "../src/build/desktop-capabilities.ts";
import { createSidecarHost } from "../src/desktop/sidecar-host.ts";
import { addDesktopSidecar } from "../src/build/desktop-sidecar-add.ts";

/**
 * Two launcher tests start a program that does not exist with an IPC channel: a runtime whose
 * failed spawn leaves the channel's resource open trips the resource sanitizer there.
 */
// sanitizer: the runtime leaves a failed spawn's IPC channel open (fixed in the runtime; lift this once denext pins that runtime)
const FAILED_SPAWN = { sanitizeResources: false } as const;

/** A temp folder for one test. */
function tempDir(prefix: string): Promise<string> {
  return Deno.makeTempDir({ prefix: `denext-detached-${prefix}-` });
}

/** Sleep `ms`. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` every 50 ms until it is true or `ms` passed; resolves whether it became true. */
async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(50);
  }
  return await check();
}

// ── the definition ───────────────────────────────────────────────────────────────────────────

Deno.test("sidecarDefinitionError: detached is a module sidecar's option, checked", () => {
  const mod = { name: "ptyd", run: { module: "./ptyd.ts" } };
  assertEquals(sidecarDefinitionError({ ...mod, detached: true }), null);
  assertEquals(sidecarDefinitionError({ ...mod, detached: false }), null);
  assertEquals(
    sidecarDefinitionError({ ...mod, detached: { exitAfterMs: 1000, keepAcrossUpdates: true } }),
    null,
  );
  // proxy stays allowed: the port is fixed for the launch (a reattach reports the same one).
  assertEquals(
    sidecarDefinitionError({ ...mod, detached: true, port: "auto", proxy: true }),
    null,
  );
  assertMatch(
    sidecarDefinitionError({ name: "x", run: { exec: "./bin/x" }, detached: true })!,
    /module sidecar only.*control channel/,
  );
  assertMatch(
    sidecarDefinitionError({
      name: "x",
      run: { exec: "./bin/x", bootstrapFd: 3 },
      detached: true,
    })!,
    /module sidecar only/,
  );
  assertMatch(
    sidecarDefinitionError({ ...mod, detached: true, ready: { stdout: "up" } })!,
    /ready\.stdout cannot be used with detached/,
  );
  assertMatch(sidecarDefinitionError({ ...mod, detached: "yes" })!, /detached must be a boolean/);
  assertMatch(
    sidecarDefinitionError({ ...mod, detached: { exitAfterMs: 999 } })!,
    /exitAfterMs must be milliseconds, at least 1 000/,
  );
  assertMatch(
    sidecarDefinitionError({ ...mod, detached: { keepAcrossUpdates: 1 } })!,
    /keepAcrossUpdates must be a boolean/,
  );
  assertMatch(
    sidecarDefinitionError({ ...mod, detached: { idleMs: 5 } })!,
    /detached\.idleMs is not an option/,
  );
  assertEquals(sidecarListError([{ ...mod, detached: true }]), null);
});

Deno.test("isDetachedSidecar / detachedOptions: the settled options", () => {
  const base = { name: "d", run: { module: "./d.ts" } } as SidecarDefinition;
  assertEquals(isDetachedSidecar(base), false);
  assertEquals(isDetachedSidecar({ ...base, detached: false }), false);
  assertEquals(isDetachedSidecar({ ...base, detached: true }), true);
  assertEquals(detachedOptions({ ...base, detached: true }), { keepAcrossUpdates: false });
  assertEquals(detachedOptions({ ...base, detached: { exitAfterMs: 5000 } }), {
    exitAfterMs: 5000,
    keepAcrossUpdates: false,
  });
});

Deno.test("sidecarChildLaunch: only the detached marker on a detached definition makes the daemon", () => {
  const sidecars: SidecarDefinition[] = [
    { name: "daemon", run: { module: "./d.mjs" }, detached: true },
    { name: "plain", run: { module: "./p.mjs" } },
  ];
  const input = { argc: "0", args: [], standalone: false, entryPath: "/app/desktop.ts", sidecars };
  assertEquals(
    sidecarChildLaunch({ ...input, marker: "daemon", detachedMarker: "1" })?.detached,
    true,
  );
  // A spawnSelf child of the daemon has no detached marker: a plain child.
  assertEquals(sidecarChildLaunch({ ...input, marker: "daemon" })?.detached, undefined);
  // A stray marker on a sidecar that is not detached is ignored.
  assertEquals(
    sidecarChildLaunch({ ...input, marker: "plain", detachedMarker: "1" })?.detached,
    undefined,
  );
});

Deno.test("desktopBuildFlags: a detached sidecar bakes a write of its registry folder", () => {
  const config = {
    desktop: {
      app: { identifier: "com.example.term" },
      sidecars: [{ name: "d", run: { module: "./d.ts" }, detached: true }],
    },
  };
  const flags = desktopBuildFlags(config, "darwin", { dataScope: true });
  const write = flags.find((f) => f.startsWith("--allow-write"));
  assert(write?.includes("$DENO_DESKTOP_DATA/sidecars"), String(flags));
  // A sidecar that is not detached does not get it.
  const plain = desktopBuildFlags(
    {
      desktop: { ...config.desktop, sidecars: [{ name: "d", run: { module: "./d.ts" } }] },
    },
    "darwin",
    { dataScope: true },
  );
  assert(!plain.some((f) => f.includes("/sidecars")), String(plain));
});

Deno.test("detachedChildInitError: the init's fields are checked", () => {
  const init = {
    t: "init",
    name: "d",
    key: newDetachedKey(),
    recordPath: "/x/d.json",
    appVersion: "1",
    startedAt: 1,
    secrets: {},
  };
  assertEquals(detachedChildInitError(init), null);
  assertEquals(detachedChildInitError(null), "not an init message");
  assertEquals(detachedChildInitError({ ...init, key: 1 }), "init.key");
  assertEquals(detachedChildInitError({ ...init, recordPath: "" }), "init.recordPath");
  assertEquals(detachedChildInitError({ ...init, exitAfterMs: -1 }), "init.exitAfterMs");
  assertEquals(detachedChildInitError({ ...init, port: "1" }), "init.port");
  assertEquals(detachedChildInitError({ ...init, t: "control" }), "not an init message");
  assertEquals(detachedChildInitError({ ...init, name: "" }), "init.name");
  assertEquals(detachedChildInitError({ ...init, name: 1 }), "init.name");
  assertEquals(detachedChildInitError({ ...init, recordPath: 1 }), "init.recordPath");
  assertEquals(detachedChildInitError({ ...init, appVersion: 1 }), "init.appVersion");
  assertEquals(detachedChildInitError({ ...init, startedAt: "1" }), "init.startedAt");
  assertEquals(detachedChildInitError({ ...init, secrets: null }), "init.secrets");
  assertEquals(detachedChildInitError({ ...init, secrets: "s" }), "init.secrets");
  assertEquals(detachedChildInitError({ ...init, exitAfterMs: "1" }), "init.exitAfterMs");
  assertEquals(detachedChildInitError({ ...init, logFile: "" }), "init.logFile");
  assertEquals(detachedChildInitError({ ...init, logRotateBytes: 0 }), "init.logRotateBytes");
  assertEquals(detachedChildInitError({ ...init, logCheckMs: "1" }), "init.logCheckMs");
  // The optional fields, when present and well-formed, pass.
  assertEquals(detachedChildInitError({ ...init, port: 5000, exitAfterMs: 0 }), null);
  assertEquals(
    detachedChildInitError({ ...init, logFile: "/x/d.log", logRotateBytes: 10, logCheckMs: 5 }),
    null,
  );
});

Deno.test("currentAppVersion: the updater's version and the executable's stamp; dev unpackaged", () => {
  const desktop = { updater: { status: () => ({ version: "2.3.4" }) } };
  const exe = () => ({ size: 1000, mtime: new Date(5000) });
  const none = () => null;
  assertEquals(currentAppVersion(desktop, true, exe), "2.3.4+1000.5000");
  // Another build of the same version (installed over, no updater): another executable.
  assertEquals(
    currentAppVersion(desktop, true, () => ({ size: 1000, mtime: new Date(6000) })),
    "2.3.4+1000.6000",
  );
  // No updater version: the executable alone tells builds apart.
  assertEquals(currentAppVersion({}, true, exe), "+1000.5000");
  assertEquals(currentAppVersion({}, true, () => ({ size: 7, mtime: null })), "+7.0");
  // An executable that cannot be read: the version alone, else "dev".
  assertEquals(currentAppVersion(desktop, true, none), "2.3.4");
  assertEquals(currentAppVersion({}, true, none), "dev");
  assertEquals(currentAppVersion(desktop, false, exe), "dev");
  assertEquals(
    currentAppVersion(
      {
        updater: {
          status: () => {
            throw new Error("x");
          },
        },
      },
      true,
      none,
    ),
    "dev",
  );
  // The default reads the running executable without throwing.
  assert(currentAppVersion({}, true).startsWith("+"));
});

// ── the registry ─────────────────────────────────────────────────────────────────────────────

/** A record for `name` on `port` with `key`. */
function record(name: string, port: number, key: string, extra: Partial<DetachedRecord> = {}) {
  return {
    v: 1,
    name,
    pid: 4242,
    startedAt: 1,
    appVersion: "1.0.0",
    control: { host: "127.0.0.1", port },
    key,
    ...extra,
  } as DetachedRecord;
}

Deno.test("writeDetachedRecord: atomic, 0600 in a 0700 folder; read back, listed, key-checked removal", async () => {
  const data = await tempDir("record");
  try {
    const dir = detachedRegistryDir(data);
    const key = newDetachedKey();
    await writeDetachedRecord(dir, record("ptyd", 4000, key, { port: 5000, secrets: { t: "s" } }));
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(dir)).mode! & 0o777, 0o700);
      assertEquals((await Deno.stat(detachedRecordPath(dir, "ptyd"))).mode! & 0o777, 0o600);
    }
    // No temp file is left behind.
    const names = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    assertEquals(names, ["ptyd.json"]);
    assertEquals((await readDetachedRecord(dir, "ptyd"))?.secrets, { t: "s" });
    assertEquals((await listDetachedRecords(dir)).map((r) => r.name), ["ptyd"]);
    // A removal naming another key keeps the record (another start replaced it).
    await removeDetachedRecord(dir, "ptyd", newDetachedKey());
    assert(await readDetachedRecord(dir, "ptyd"));
    await removeDetachedRecord(dir, "ptyd", key);
    assertEquals(await readDetachedRecord(dir, "ptyd"), null);
    // A broken file reads as no record.
    await Deno.writeTextFile(detachedRecordPath(dir, "bad"), "{ nope");
    assertEquals(await readDetachedRecord(dir, "bad"), null);
    assertEquals(await listDetachedRecords(dir), []);
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("parseDetachedRecord: a malformed or foreign record is refused", () => {
  const key = newDetachedKey();
  const good = record("d", 4000, key);
  assert(parseDetachedRecord(JSON.stringify(good), "d"));
  assertEquals(parseDetachedRecord(JSON.stringify(good), "other"), null);
  assertEquals(parseDetachedRecord(JSON.stringify({ ...good, v: 2 })), null);
  assertEquals(parseDetachedRecord(JSON.stringify({ ...good, key: "short" })), null);
  assertEquals(
    parseDetachedRecord(JSON.stringify({ ...good, control: { host: "0.0.0.0", port: 1 } })),
    null,
  );
  assertEquals(parseDetachedRecord(JSON.stringify({ ...good, secrets: { a: 1 } })), null);
  assertEquals(parseDetachedRecord("[]"), null);
});

/**
 * Hold the OS lock on `path` from another process until the returned function ends it: the
 * process prints `locked` once it holds the lock.
 */
async function lockFromAnotherProcess(path: string): Promise<() => Promise<void>> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `const f = Deno.openSync(${JSON.stringify(path)}, { read: true, write: true, create: true });
f.lockSync(true);
console.log("locked");
setTimeout(() => {}, 60_000);`,
    ],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  while (!seen.includes("locked")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the locking process ended early");
    seen += value;
  }
  return async () => {
    child.kill("SIGKILL");
    await child.status;
    await reader.cancel().catch(() => {});
  };
}

Deno.test("withDetachedLock: two starts take turns; a held lock is never broken; the OS frees a dead holder's", async () => {
  const dir = await tempDir("lock");
  try {
    // Two concurrent starters in one process: exactly one inside at a time, both run.
    const order: string[] = [];
    let inside = 0;
    const start = (tag: string) =>
      withDetachedLock(dir, "d", async () => {
        inside++;
        assertEquals(inside, 1, "one start at a time");
        order.push(`${tag}+`);
        await sleep(100);
        order.push(`${tag}-`);
        inside--;
      });
    await Promise.all([start("a"), start("b")]);
    assertEquals(order.length, 4);
    assertEquals([order[0][0], order[1]], [order[0][0], `${order[0][0]}-`]);
    // Held by another process: waited for, never broken, however old the file looks (a holder
    // whose timers stalled, a machine that slept).
    const lock = join(dir, "d.lock");
    const release = await lockFromAnotherProcess(lock);
    const past = new Date(Date.now() - 3600_000);
    await Deno.utime(lock, past, past);
    let ran = false;
    await assertRejects(
      () =>
        withDetachedLock(dir, "d", () => {
          ran = true;
          return Promise.resolve();
        }, { timeoutMs: 300 }),
      Error,
      "holds the start lock",
    );
    assertEquals(ran, false);
    // Its holder dies (a crash, a kill): the OS frees the lock at once, no stale wait.
    await release();
    assertEquals(
      await withDetachedLock(dir, "d", () => Promise.resolve(7), { timeoutMs: 2000 }),
      7,
    );
    assert(await Deno.stat(lock).then(() => true), "the lock file is kept for the next start");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the protocol ─────────────────────────────────────────────────────────────────────────────

Deno.test("detachedMac: verified with the key and both nonces only", async () => {
  const key = await importDetachedKey(newDetachedKey());
  const other = await importDetachedKey(newDetachedKey());
  const mac = await detachedMac(key, "server", "a".repeat(22), "b".repeat(22));
  assert(await verifyDetachedMac(key, "server", "a".repeat(22), "b".repeat(22), mac));
  assert(!(await verifyDetachedMac(other, "server", "a".repeat(22), "b".repeat(22), mac)));
  assert(!(await verifyDetachedMac(key, "client", "a".repeat(22), "b".repeat(22), mac)));
  assert(!(await verifyDetachedMac(key, "server", "a".repeat(22), "c".repeat(22), mac)));
  assert(!(await verifyDetachedMac(key, "server", "a".repeat(22), "b".repeat(22), 42)));
  assert(!(await verifyDetachedMac(key, "server", "a".repeat(22), "b".repeat(22), "%%%")));
  await assertRejects(() => importDetachedKey("short"), Error, "32 bytes");
});

/** A control server with `key` whose `shutdown` closes it (or is ignored with `stubborn`). */
async function testServer(key: string, opts: {
  stubborn?: boolean;
  handshakeMs?: number;
  maxPending?: number;
  pid?: number;
  appVersion?: string;
  name?: string;
} = {}) {
  const shutdowns: number[] = [];
  const attached: number[] = [];
  const server = await serveDetachedControl({
    key,
    identity: {
      name: opts.name ?? "d",
      pid: opts.pid ?? 999_999,
      startedAt: 5,
      appVersion: opts.appVersion ?? "1.0.0",
    },
    onShutdown: (g) => {
      shutdowns.push(g);
      if (!opts.stubborn) server.close();
    },
    onAttachedChange: (n) => attached.push(n),
    ...(opts.handshakeMs ? { handshakeMs: opts.handshakeMs } : {}),
    ...(opts.maxPending ? { maxPending: opts.maxPending } : {}),
  });
  return { server, shutdowns, attached };
}

/** A raw connection: send lines, read lines, see the close. */
async function raw(port: number) {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const reader = conn.readable.getReader();
  let buf = "";
  const dec = new TextDecoder();
  return {
    send: (text: string) => conn.write(new TextEncoder().encode(text)),
    /** The next line, or `null` at the close (within `ms`; `"timeout"` past it). */
    async line(ms = 3000): Promise<string | null | "timeout"> {
      const end = Date.now() + ms;
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          const l = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          return l;
        }
        const left = end - Date.now();
        if (left <= 0) return "timeout";
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<"t">((resolve) => (timer = setTimeout(() => resolve("t"), left)));
        const r = await Promise.race([reader.read(), late]).finally(() => clearTimeout(timer));
        if (r === "t") return "timeout";
        if (r.done) return null;
        buf += dec.decode(r.value);
      }
    },
    close: () => {
      try {
        conn.close();
      } catch { /* closed */ }
    },
  };
}

Deno.test({
  name: "control: both sides prove the key; ping, status, attachments, ready push",
  fn: async () => {
    const key = newDetachedKey();
    const { server, attached } = await testServer(key);
    try {
      const s = await connectDetachedControl({ port: server.port, key, name: "d" });
      assert(s);
      assertEquals(s.info.name, "d");
      assertEquals(s.info.pid, 999_999);
      assertEquals(s.info.attached, 1);
      assertEquals(s.ready, false);
      assert(await s.ping());
      assertEquals((await s.status())?.attached, 1);
      server.setReady();
      await s.whenReady();
      assert(s.ready);
      const s2 = await connectDetachedControl({ port: server.port, key });
      assertEquals(s2?.info.ready, true); // a later attach learns it from `ok`
      assertEquals(server.attached(), 2);
      s2!.close();
      s.close();
      assert(await waitFor(() => server.attached() === 0, 2000));
      assertEquals(attached, [1, 2, 1, 0]);
      // A name other than expected is not this sidecar.
      assertEquals(await connectDetachedControl({ port: server.port, key, name: "x" }), null);
    } finally {
      server.close();
    }
  },
});

Deno.test({
  name: "control: a client with the wrong key is refused, and so is a server with the wrong key",
  fn: async () => {
    const key = newDetachedKey();
    const { server } = await testServer(key);
    try {
      // The client cannot verify the server's mac under its own (wrong) key: refused.
      assertEquals(
        await connectDetachedControl({ port: server.port, key: newDetachedKey() }),
        null,
      );
      assertEquals(server.attached(), 0);
      // A client that skips the check and sends a bogus auth gets no payload, only the close.
      const c = await raw(server.port);
      await c.send(JSON.stringify({ t: "hello", v: 1, nonce: "A".repeat(22) }) + "\n");
      const challenge = JSON.parse(await c.line() as string);
      assertEquals(challenge.t, "challenge");
      await c.send(JSON.stringify({ t: "auth", mac: "B".repeat(43) }) + "\n");
      assertEquals(await c.line(), null);
      c.close();
      assertEquals(server.attached(), 0);
      // A bad hello (wrong version, malformed nonce) is closed with no challenge.
      const v = await raw(server.port);
      await v.send(JSON.stringify({ t: "hello", v: 2, nonce: "A".repeat(22) }) + "\n");
      assertEquals(await v.line(), null);
      v.close();
    } finally {
      server.close();
    }
  },
});

Deno.test({
  name: "control: an auth replayed into another connection fails (fresh server nonce)",
  fn: async () => {
    const keyText = newDetachedKey();
    const key = await importDetachedKey(keyText);
    const { server } = await testServer(keyText);
    try {
      const nonce = "C".repeat(22);
      const first = await raw(server.port);
      await first.send(JSON.stringify({ t: "hello", v: 1, nonce }) + "\n");
      const ch1 = JSON.parse(await first.line() as string);
      const mac = await detachedMac(key, "client", nonce, ch1.nonce);
      await first.send(JSON.stringify({ t: "auth", mac }) + "\n");
      assertEquals(JSON.parse(await first.line() as string).t, "ok");
      // The same client nonce and the captured mac in a second connection: refused.
      const second = await raw(server.port);
      await second.send(JSON.stringify({ t: "hello", v: 1, nonce }) + "\n");
      const ch2 = JSON.parse(await second.line() as string);
      assert(ch2.nonce !== ch1.nonce);
      await second.send(JSON.stringify({ t: "auth", mac }) + "\n");
      assertEquals(await second.line(), null);
      first.close();
      second.close();
    } finally {
      server.close();
    }
  },
});

Deno.test({
  name: "control: an oversized line, a slow handshake and too many pending connections are closed",
  fn: async () => {
    const key = newDetachedKey();
    const { server } = await testServer(key, { handshakeMs: 300, maxPending: 2 });
    try {
      const big = await raw(server.port);
      await big.send("x".repeat(9000));
      assertEquals(await big.line(), null);
      big.close();
      const bigLine = await raw(server.port);
      await bigLine.send(JSON.stringify({ t: "hello", v: 1, nonce: "x".repeat(9000) }) + "\n");
      assertEquals(await bigLine.line(), null);
      bigLine.close();
      // Silent: closed by the server once its 300 ms handshake budget passed (long before the
      // client's own 5 s wait would read "timeout").
      const slow = await raw(server.port);
      assertEquals(await slow.line(5000), null);
      slow.close();
    } finally {
      server.close();
    }
    // The pending cap, on a server whose handshake budget far outlasts the probes, so only the
    // cap (never the budget) can close a connection here.
    const capped = (await testServer(key, { handshakeMs: 60_000, maxPending: 2 })).server;
    try {
      const a = await raw(capped.port);
      const b = await raw(capped.port);
      // Both are accepted and held pending before the third arrives.
      assert(await waitFor(() => capped.pending() === 2, 5000), "two pending");
      const c = await raw(capped.port);
      assertEquals(await c.line(5000), null); // closed at once: the cap is full
      assertEquals(await a.line(100), "timeout"); // still open, waiting for its hello
      a.close();
      b.close();
      c.close();
    } finally {
      capped.close();
    }
  },
});

Deno.test({
  name:
    "probeDetachedControl: refused or unproven is stale; accepted but unanswered is busy, waited for",
  fn: async () => {
    const key = newDetachedKey();
    // Nothing listens: stale.
    const gone = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const gonePort = (gone.addr as Deno.NetAddr).port;
    gone.close();
    assertEquals(await probeDetachedControl({ port: gonePort, key, timeoutMs: 200 }), {
      state: "stale",
    });
    // A listening socket whose process never answers (an event loop blocked in synchronous
    // work: the OS still accepts the connection): busy, never stale.
    const blocked = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const blockedPort = (blocked.addr as Deno.NetAddr).port;
    try {
      assertEquals(
        await probeDetachedControl({ port: blockedPort, key, timeoutMs: 100, busyWaitMs: 100 }),
        { state: "busy", waitedMs: 200 },
      );
    } finally {
      blocked.close();
    }
    // One that answers but cannot prove the key: stale.
    const impostor = await testServer(newDetachedKey());
    try {
      assertEquals(await probeDetachedControl({ port: impostor.server.port, key }), {
        state: "stale",
      });
    } finally {
      impostor.server.close();
    }
    // A sidecar that answers only after the handshake budget, within the busy wait: a session.
    const late = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const latePort = (late.addr as Deno.NetAddr).port;
    const { server } = await testServer(key, { name: "d" });
    const relay = (async () => {
      // Accept late, then relay the connection to the real endpoint.
      await sleep(300);
      const inbound = await late.accept();
      const outbound = await Deno.connect({ hostname: "127.0.0.1", port: server.port });
      await Promise.allSettled([
        inbound.readable.pipeTo(outbound.writable),
        outbound.readable.pipeTo(inbound.writable),
      ]);
    })();
    try {
      const probe = await probeDetachedControl({
        port: latePort,
        key,
        name: "d",
        timeoutMs: 100,
        busyWaitMs: 5000,
      });
      assertEquals(probe.state, "session");
      if (probe.state === "session") probe.session.close();
    } finally {
      server.close();
      late.close();
      await relay.catch(() => {});
    }
  },
});

Deno.test({
  name: "launcher: a recorded instance that is alive but busy fails the start; no second instance",
  fn: async () => {
    const data = await tempDir("busy");
    const dir = detachedRegistryDir(data);
    // The recorded sidecar's endpoint accepts (its process runs) but its event loop is blocked.
    const blocked = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const key = newDetachedKey();
    try {
      await writeDetachedRecord(dir, record("daemon", (blocked.addr as Deno.NetAddr).port, key));
      let spawned = false;
      const child = new Proxy(NO_SPAWN, {
        get(target, prop, recv) {
          if (prop === "args") spawned = true;
          return Reflect.get(target, prop, recv);
        },
      });
      await assertRejects(
        () =>
          detachedSidecarLauncher({
            child,
            registryDir: dir,
            appVersion: "1.0.0",
            stopOptions: { busyWaitMs: 100 },
          })(launchCtx(DAEMON, [])),
        Error,
        "is running but did not answer its control connection",
      );
      assertEquals(spawned, false, "no second instance is started");
      assertEquals((await readDetachedRecord(dir, "daemon"))?.key, key, "its record is kept");
      // Stopping it by name reports it as still running (its record removed, so it ends itself).
      await assertRejects(
        () => stopDetachedRecord(dir, "daemon", 0, { busyWaitMs: 100 }),
        Error,
        "is running but did not answer",
      );
      assertEquals(await readDetachedRecord(dir, "daemon"), null);
    } finally {
      blocked.close();
      await Deno.remove(data, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "endDetachedSession: shutdown first; a forced kill only of the pid this session's ok named, only when permitted",
  fn: async () => {
    const key = newDetachedKey();
    // A sidecar that ends when asked.
    const polite = await testServer(key);
    const s1 = await connectDetachedControl({ port: polite.server.port, key });
    assertEquals(await endDetachedSession(s1!, 50_000), { ended: true });
    assertEquals(polite.shutdowns, [30_000]); // capped
    // One that ignores the shutdown: without permission it is reported, never signalled.
    const stubborn = await testServer(key, { stubborn: true, pid: 4_242_424 });
    try {
      const s2 = await connectDetachedControl({ port: stubborn.server.port, key });
      const killed: number[] = [];
      const refused = await endDetachedSession(s2!, 0, {
        canKill: () => false,
        kill: (pid) => killed.push(pid),
      });
      assertEquals(refused.ended, false);
      assertMatch(refused.reason!, /no run permission to end process 4242424/);
      assertEquals(killed, []);
      // With permission: the authenticated pid, and nothing else.
      const s3 = await connectDetachedControl({ port: stubborn.server.port, key });
      const forced = await endDetachedSession(s3!, 0, {
        canKill: () => true,
        kill: (pid) => {
          killed.push(pid);
          stubborn.server.close(); // the process dies
        },
      });
      assertEquals(forced, { ended: true, killed: true });
      assertEquals(killed, [4_242_424]);
    } finally {
      stubborn.server.close();
    }
  },
});

// ── the host's registry helpers ──────────────────────────────────────────────────────────────

Deno.test({
  name:
    "cleanDetachedLeftovers: an undeclared sidecar is shut down and removed; a stale record removed",
  fn: async () => {
    const data = await tempDir("leftovers");
    const dir = detachedRegistryDir(data);
    const key = newDetachedKey();
    const old = await testServer(key, { name: "old" });
    const keep = await testServer(key, { name: "keep" });
    try {
      await writeDetachedRecord(dir, record("old", old.server.port, key));
      await writeDetachedRecord(dir, record("keep", keep.server.port, key));
      // Nothing listens there any more (a reboot).
      const gone = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const gonePort = (gone.addr as Deno.NetAddr).port;
      gone.close();
      await writeDetachedRecord(dir, record("gone", gonePort, newDetachedKey()));
      const listed = await listDetachedSidecars(dir, ["keep"]);
      assertEquals(listed.map((e) => [e.name, e.reachable, e.declared]), [
        ["gone", false, false],
        ["keep", true, true],
        ["old", true, false],
      ]);
      assertEquals((await cleanDetachedLeftovers(dir, ["keep"], 1000)).sort(), ["gone", "old"]);
      assertEquals(old.shutdowns, [1000]);
      assertEquals(keep.shutdowns, []);
      assertEquals((await listDetachedRecords(dir)).map((r) => r.name), ["keep"]);
      await assertRejects(() => stopDetachedRecord(dir, "none", 100), Error, "no detached sidecar");
    } finally {
      old.server.close();
      keep.server.close();
      await Deno.remove(data, { recursive: true });
    }
  },
});

// ── the supervisor with a detached instance ──────────────────────────────────────────────────

/** A clock that only moves when told to. */
function fakeClock(): SidecarClock {
  let next = 0;
  const timers = new Map<number, () => void>();
  return {
    now: () => 1_000_000,
    setTimeout: (fn) => {
      timers.set(++next, fn);
      return next as unknown as SidecarTimer;
    },
    clearTimeout: (id) => void timers.delete(id as unknown as number),
  };
}

/** Let pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await sleep(0);
}

/** A detached instance whose `exited` the test settles. */
function detachedInstance(over: Partial<SidecarInstance> = {}) {
  let end!: (e: { code?: number; error?: string }) => void;
  const exited = new Promise<{ code?: number; error?: string }>((r) => end = r);
  const calls: string[] = [];
  const inst: SidecarInstance = {
    pid: 777,
    exited,
    detached: true,
    stop: () => {
      calls.push("stop");
      end({ code: 0 });
      return Promise.resolve();
    },
    detach: () => calls.push("detach"),
    ...over,
  };
  return { inst, end, calls };
}

const DAEMON: SidecarDefinition = {
  name: "daemon",
  run: { module: "./d.ts" },
  detached: true,
  port: "auto",
  ready: { signal: true },
  restart: { on: "crash" },
};

Deno.test("supervisor: a reattached instance is ready at once, with its own port and values", async () => {
  const { inst } = detachedInstance({
    reattached: true,
    ready: true,
    port: 6001,
    values: { token: "old" },
  });
  const sup = createSidecarSupervisor({
    definition: DAEMON,
    launch: () => Promise.resolve(inst),
    port: 5000,
    values: { token: "new" },
    clock: fakeClock(),
  });
  assertEquals(sup.status.detached, true);
  assertEquals(sup.detached, true);
  sup.start();
  await settle();
  assertEquals(sup.status.state, "ready"); // no ready signal needed
  assertEquals(sup.status.reattached, true);
  assertEquals(sup.status.port, 6001);
  assertEquals(sup.status.pid, 777);
  assertEquals(sup.info.values, { token: "old" });
  assertEquals(sup.info.url, "http://127.0.0.1:6001");
});

Deno.test("supervisor: release() lets a detached sidecar go: no stop, no restart", async () => {
  const { inst, end, calls } = detachedInstance({ ready: true });
  let launches = 0;
  const sup = createSidecarSupervisor({
    definition: DAEMON,
    launch: () => {
      launches++;
      return Promise.resolve(inst);
    },
    clock: fakeClock(),
  });
  sup.start();
  await settle();
  assertEquals(sup.status.state, "ready");
  sup.release();
  end({ error: "the detached sidecar ended (its control connection closed)" });
  await settle();
  assertEquals(calls, ["detach"]);
  assertEquals(launches, 1);
  assertEquals(sup.status.state, "ready"); // the app is exiting: nothing changes
});

Deno.test("supervisor: a detached stop that cannot end the process rejects and reads failed", async () => {
  const { inst, end } = detachedInstance({
    ready: true,
    stop: () => {
      end({ code: 0 });
      return Promise.reject(new Error("sidecar daemon: did not end within 5000 ms, and the app …"));
    },
  });
  const sup = createSidecarSupervisor({
    definition: DAEMON,
    launch: () => Promise.resolve(inst),
    clock: fakeClock(),
  });
  sup.start();
  await settle();
  await assertRejects(() => sup.stop(), Error, "did not end");
  assertEquals(sup.status.state, "failed");
  assertMatch(sup.status.lastExit?.error ?? "", /did not end/);
});

// ── the host ─────────────────────────────────────────────────────────────────────────────────

Deno.test("createSidecarHost: a detached sidecar needs the app's data folder", async () => {
  await assertRejects(
    () => createSidecarHost({ sidecars: [DAEMON], launcher: () => () => Promise.reject() }),
    Error,
    "needs the app's data folder",
  );
});

Deno.test({
  name:
    "host: at exit a detached sidecar is let go, before an update it is stopped; leftovers are listed and stopped",
  fn: async () => {
    const data = await tempDir("host");
    const dir = detachedRegistryDir(data);
    const key = newDetachedKey();
    const leftover = await testServer(key, { name: "old" });
    try {
      await writeDetachedRecord(dir, record("old", leftover.server.port, key));
      const instances: Array<ReturnType<typeof detachedInstance>> = [];
      const host = await createSidecarHost({
        sidecars: [{ ...DAEMON, ready: undefined, port: undefined }],
        dataDir: data,
        clock: fakeClock(),
        launcher: () => () => {
          const i = detachedInstance({ ready: true });
          instances.push(i);
          return Promise.resolve(i.inst);
        },
      });
      // Listed before the start's cleanup runs.
      const listed = await host.detachedSidecars();
      assertEquals(listed.map((e) => [e.name, e.reachable, e.declared]), [["old", true, false]]);
      host.startAll();
      await settle();
      // The start removed the undeclared leftover in the background.
      assert(await waitFor(async () => (await listDetachedRecords(dir)).length === 0, 5000));
      assertEquals(leftover.shutdowns.length, 1);
      assertEquals(host.handle("daemon").status.state, "ready");
      host.killAll("exit");
      assertEquals(instances[0].calls, ["detach"]);
      // A new start, then an update: stopped.
      await host.handle("daemon").restart();
      await settle();
      host.killAll("update");
      await settle();
      assertEquals(instances[1].calls, ["stop"]);
      await assertRejects(() => host.stopDetachedSidecar("none"), Error, "no detached sidecar");
    } finally {
      leftover.server.close();
      await Deno.remove(data, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "host: the default detached launcher reattaches to the recorded instance; stopping it by name ends it",
  fn: async () => {
    const data = await tempDir("host-default");
    const dir = detachedRegistryDir(data);
    const key = newDetachedKey();
    const running = await testServer(key, { name: "daemon" });
    running.server.setReady();
    try {
      await writeDetachedRecord(dir, record("daemon", running.server.port, key, { port: 6200 }));
      const host = await createSidecarHost({
        sidecars: [{
          name: "daemon",
          run: { module: "./d.ts" },
          detached: true,
          logs: "file",
          restart: { on: "never" },
        }],
        importMetaUrl: import.meta.url,
        dataDir: data,
        appVersion: "1.0.0",
        logRotateBytes: 1 << 20,
        detachedRecordPollMs: 100,
        clock: fakeClock(),
      });
      host.startAll();
      const handle = host.handle("daemon");
      assert(await waitFor(() => handle.status.state === "ready", 5000), handle.status.state);
      assertEquals([handle.status.reattached, handle.status.port], [true, 6200]);
      // Declared and running: stopped through its supervisor (a shutdown, the record removed).
      await host.stopDetachedSidecar("daemon");
      assertEquals(running.shutdowns.length, 1);
      assertEquals(handle.status.state, "stopped");
      assertEquals(await readDetachedRecord(dir, "daemon"), null);
      await host.stopAll();
    } finally {
      running.server.close();
      await Deno.remove(data, { recursive: true });
    }
  },
});

Deno.test("host: a detached sidecar without the app's entry fails to start; with no data folder there is no registry", async () => {
  const data = await tempDir("host-noentry");
  try {
    const host = await createSidecarHost({
      sidecars: [{
        name: "daemon",
        run: { module: "./d.ts" },
        detached: true,
        restart: { on: "never" },
      }],
      dataDir: data,
      clock: fakeClock(),
    });
    host.startAll();
    const handle = host.handle("daemon");
    assert(await waitFor(() => handle.status.lastExit !== undefined, 5000));
    assertMatch(handle.status.lastExit?.error ?? "", /app's entry/);
    assert(!["starting", "ready", "backoff", "stopping"].includes(handle.status.state));
    // Declared but not running: looked up in the registry, where nothing is recorded.
    await assertRejects(() => host.stopDetachedSidecar("daemon"), Error, "no detached sidecar");
    await host.stopAll();
  } finally {
    await Deno.remove(data, { recursive: true });
  }
  // No detached sidecar and no data folder: none listed, none to stop.
  const plain = await createSidecarHost({
    sidecars: [{ name: "api", run: { module: "./api.ts" } }],
    launcher: () => () => Promise.reject(new Error("not started")),
  });
  assertEquals(await plain.detachedSidecars(), []);
  await assertRejects(
    () => plain.stopDetachedSidecar("api"),
    Error,
    "sidecar api: no detached sidecar of that name is recorded",
  );
});

Deno.test("addDesktopSidecar: --detached writes detached: true (a module only)", async () => {
  const root = await tempDir("add");
  try {
    const report = await addDesktopSidecar({
      dir: root,
      name: "ptyd",
      entry: "desktop/ptyd.ts",
      detached: true,
      dryRun: true,
    });
    assertEquals(report.sidecar.detached, true);
    assert(report.notes.some((n) => n.includes("outlives the app")));
    assert(report.notes.some((n) => n.includes("detachedSidecars()")));
    await assertRejects(
      () => addDesktopSidecar({ dir: root, name: "x", exec: "./bin/x", detached: true }),
      Error,
      "module sidecar only",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ── the launcher's decisions, against in-process endpoints ───────────────────────────────────

/** A launch context for the launcher. */
function launchCtx(def: SidecarDefinition, readies: number[]): SidecarLaunchContext {
  return {
    definition: def,
    port: 5000,
    bootstrap: null,
    secrets: { token: "s" },
    onLine: () => {},
    onReadySignal: () => readies.push(1),
  };
}

/** A child base whose program does not exist: a fresh start fails at the spawn. */
const NO_SPAWN = {
  name: "daemon",
  command: "/nonexistent/denext-detached-test-app",
  args: ["run", "/nonexistent/desktop.ts"],
  env: {},
  argcEnv: "DENEXT_SIDECAR_CHILD_ARGC",
  selfForkAuthorized: true,
};

Deno.test({
  name:
    "launcher: a recorded instance of this app version is reattached (port, values from its record)",
  fn: async () => {
    const data = await tempDir("reattach");
    const dir = detachedRegistryDir(data);
    const key = newDetachedKey();
    const { server } = await testServer(key, { name: "daemon" });
    server.setReady();
    try {
      await writeDetachedRecord(
        dir,
        record("daemon", server.port, key, { port: 6100, values: { token: "kept" } }),
      );
      const readies: number[] = [];
      const inst = await detachedSidecarLauncher({
        child: NO_SPAWN,
        registryDir: dir,
        appVersion: "1.0.0",
      })(launchCtx(DAEMON, readies));
      assertEquals(inst.reattached, true);
      assertEquals(inst.ready, true);
      assertEquals(inst.port, 6100);
      assertEquals(inst.values, { token: "kept" });
      assertEquals(inst.pid, 999_999); // the authenticated ok's pid, not the record's 4242
      assertEquals(readies, [1]);
      inst.detach!();
      assertEquals(await inst.exited, { code: 0 });
      assert(await readDetachedRecord(dir, "daemon")); // detaching keeps it recorded
    } finally {
      server.close();
      await Deno.remove(data, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "launcher: another app version's instance is shut down and replaced; keepAcrossUpdates keeps it",
  ...FAILED_SPAWN,
  fn: async () => {
    const data = await tempDir("version");
    const dir = detachedRegistryDir(data);
    const key = newDetachedKey();
    const kept = await testServer(key, { appVersion: "0.9.0", name: "daemon" });
    const replaced = await testServer(key, { appVersion: "0.9.0", name: "daemon" });
    try {
      await writeDetachedRecord(
        dir,
        record("daemon", kept.server.port, key, { appVersion: "0.9.0" }),
      );
      const keep = await detachedSidecarLauncher({
        child: NO_SPAWN,
        registryDir: dir,
        appVersion: "1.0.0",
      })(launchCtx({ ...DAEMON, detached: { keepAcrossUpdates: true } }, []));
      assertEquals(keep.reattached, true);
      keep.detach!();
      assertEquals(kept.shutdowns, []);

      await writeDetachedRecord(
        dir,
        record("daemon", replaced.server.port, key, { appVersion: "0.9.0" }),
      );
      // The fresh start then fails here (no app to spawn), after the old one was replaced.
      await assertRejects(() =>
        detachedSidecarLauncher({ child: NO_SPAWN, registryDir: dir, appVersion: "1.0.0" })(
          launchCtx(DAEMON, []),
        )
      );
      assertEquals(replaced.shutdowns.length, 1);
      assertEquals(await readDetachedRecord(dir, "daemon"), null);
    } finally {
      kept.server.close();
      replaced.server.close();
      await Deno.remove(data, { recursive: true });
    }
  },
});

Deno.test({
  name: "launcher: a record whose endpoint does not authenticate is dropped, its pid never touched",
  ...FAILED_SPAWN,
  fn: async () => {
    const data = await tempDir("stale");
    const dir = detachedRegistryDir(data);
    // An impostor took the port: it answers, but cannot prove the key.
    const impostor = await testServer(newDetachedKey(), { name: "daemon" });
    try {
      await writeDetachedRecord(
        dir,
        record("daemon", impostor.server.port, newDetachedKey(), { pid: Deno.pid }),
      );
      await assertRejects(() =>
        detachedSidecarLauncher({ child: NO_SPAWN, registryDir: dir, appVersion: "1.0.0" })(
          launchCtx(DAEMON, []),
        )
      );
      assertEquals(await readDetachedRecord(dir, "daemon"), null);
      assertEquals(impostor.shutdowns, []); // never commanded
      // (The record named this test's own pid: it is still running.)
    } finally {
      impostor.server.close();
      await Deno.remove(data, { recursive: true });
    }
  },
});

Deno.test({
  name: "launcher: a reattached session's end reads as its bye: a code, an error, none at all",
  fn: async () => {
    const data = await tempDir("bye");
    const dir = detachedRegistryDir(data);
    const ends: Array<[{ code?: number; error?: string; reason: string } | null, unknown]> = [
      [{ code: 2, reason: "done" }, { code: 2 }],
      [{ error: "boom", reason: "crashed" }, { error: "boom" }],
      [{ reason: "ended" }, { code: 0 }],
      [null, { error: "the detached sidecar ended (its control connection closed)" }],
    ];
    try {
      for (const [bye, expected] of ends) {
        const key = newDetachedKey();
        const { server } = await testServer(key, { name: "daemon" });
        try {
          await writeDetachedRecord(dir, record("daemon", server.port, key));
          const readies: number[] = [];
          const inst = await detachedSidecarLauncher({
            child: NO_SPAWN,
            registryDir: dir,
            appVersion: "1.0.0",
          })(launchCtx(DAEMON, readies));
          // Not ready yet: the ready push from the instance is the ready signal.
          assertEquals([inst.reattached, inst.ready, readies], [true, false, []]);
          server.setReady();
          assert(await waitFor(() => readies.length === 1, 3000));
          if (bye) await server.bye(bye);
          server.close();
          assertEquals(await inst.exited, expected);
        } finally {
          server.close();
        }
      }
    } finally {
      await Deno.remove(data, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "launcher: an instance that will not end: its stop rejects, and another version cannot be replaced",
  fn: async () => {
    const data = await tempDir("stubborn");
    const dir = detachedRegistryDir(data);
    const key = newDetachedKey();
    const killed: number[] = [];
    const stopOptions = { canKill: () => false, kill: (pid: number) => void killed.push(pid) };
    const same = await testServer(key, { name: "daemon", stubborn: true });
    const old = await testServer(key, { name: "daemon", stubborn: true, appVersion: "0.9.0" });
    try {
      same.server.setReady();
      await writeDetachedRecord(dir, record("daemon", same.server.port, key));
      const inst = await detachedSidecarLauncher({
        child: NO_SPAWN,
        registryDir: dir,
        appVersion: "1.0.0",
        stopOptions,
      })(launchCtx(DAEMON, []));
      await assertRejects(() => inst.stop(0), Error, "sidecar daemon: did not end within 0 ms");
      assertEquals(same.shutdowns, [0]);
      assertEquals(await readDetachedRecord(dir, "daemon"), null, "the record is removed anyway");
      assertEquals(await inst.exited, { code: 0 }, "asked to stop: not a crash");

      await writeDetachedRecord(
        dir,
        record("daemon", old.server.port, key, { appVersion: "0.9.0" }),
      );
      await assertRejects(
        () =>
          detachedSidecarLauncher({
            child: NO_SPAWN,
            registryDir: dir,
            appVersion: "1.0.0",
            stopOptions,
          })(launchCtx({ ...DAEMON, shutdown: { graceMs: 0 } }, [])),
        Error,
        "the instance app version 0.9.0 started did not end",
      );
      assertEquals(old.shutdowns, [0]);
      assertEquals(await readDetachedRecord(dir, "daemon"), null);
      assertEquals(killed, [], "never signalled without the run permission");
    } finally {
      same.server.close();
      old.server.close();
      await Deno.remove(data, { recursive: true });
    }
  },
});

Deno.test("launcher: a child base that cannot start the app fails every start with its reason", async () => {
  const data = await tempDir("nobase");
  try {
    await assertRejects(
      () =>
        detachedSidecarLauncher({
          child: { error: "sidecar daemon: no app entry" } as unknown as typeof NO_SPAWN,
          registryDir: detachedRegistryDir(data),
          appVersion: "1.0.0",
        })(launchCtx(DAEMON, [])),
      Error,
      "no app entry",
    );
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

// ── the launcher's failed fresh starts, against real processes ───────────────────────────────

/**
 * A child base whose "app" is `sh -c script`: Node's IPC channel is on `$NODE_CHANNEL_FD`, where
 * the script reads its init line and writes what it answers. It never runs the app itself.
 */
function shChild(script: string) {
  return { ...NO_SPAWN, command: "sh", args: ["-c", `fd=\${NODE_CHANNEL_FD:-3}; ${script}`] };
}

/** Whether process `pid` still exists (a zombie included: gone only once it was reaped). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid a {@linkcode shChild} script printed to the log (`pid N`). */
async function loggedPid(logFile: string): Promise<number> {
  let pid = 0;
  assert(
    await waitFor(async () => {
      const text = await Deno.readTextFile(logFile).catch(() => "");
      pid = Number(/^pid (\d+)$/m.exec(text)?.[1] ?? 0);
      return pid > 0;
    }, 5000),
    "the script logged its pid",
  );
  return pid;
}

Deno.test({
  name:
    "launcher: a fresh start that exits, stalls, garbles its channel or fails to authenticate is abandoned",
  ignore: Deno.build.os === "windows", // sh
  fn: async () => {
    const data = await tempDir("fresh");
    const dir = detachedRegistryDir(data);
    const logFile = join(data, "logs", "sidecar-daemon.log");
    const impostor = await testServer(newDetachedKey(), { name: "daemon" });
    const start = (script: string, def: SidecarDefinition = DAEMON, logRotateBytes?: number) => {
      // No port, with values: the init and the record carry only what the start has.
      const { port: _port, ...ctx } = launchCtx(def, []);
      return detachedSidecarLauncher({
        child: shChild(script),
        registryDir: dir,
        appVersion: "1.0.0",
        logFile,
        ...(logRotateBytes !== undefined ? { logRotateBytes } : {}),
      })({ ...ctx, values: { token: "v" } });
    };
    const reaped = async (pid: number) => {
      assert(await waitFor(() => !processExists(pid), 5000), `process ${pid} was ended`);
      await sleep(50); // its exit reaches the child handle
    };
    try {
      // Ends before it reports its endpoint (it read the init first: no broken pipe). Its init
      // names the log and its size, so the process rotates its own log while it runs.
      await assertRejects(
        () => start('read -r init <&"$fd"; echo "$init"; exit 3', DAEMON, 4096),
        Error,
        "exited before it served its control endpoint (3)",
      );
      const init = JSON.parse((await Deno.readTextFile(logFile)).trim().split("\n").at(-1)!);
      assertEquals([init.logFile, init.logRotateBytes], [logFile, 4096]);
      await Deno.remove(logFile);
      // Never answers: the ready budget runs out and the process is killed by its handle.
      await Deno.writeTextFile(logFile, "x".repeat(64)); // a log past its size is rotated
      await assertRejects(
        () =>
          start(
            'read -r init <&"$fd"; echo "pid $$"; exec sleep 30',
            { ...DAEMON, ready: { signal: true, timeoutMs: 300 } },
            16,
          ),
        Error,
        "did not serve its control endpoint within 300 ms",
      );
      assertEquals(await Deno.readTextFile(`${logFile}.1`), "x".repeat(64));
      await reaped(await loggedPid(logFile));
      // A line that is not JSON breaks the channel: an `error` from the child handle.
      await Deno.remove(logFile);
      const garbled = await assertRejects(() =>
        start(
          `read -r init <&"$fd"; echo "pid $$"; printf 'not json\\n' >&"$fd"; exec sleep 30`,
          { ...DAEMON, ready: { signal: true, timeoutMs: 5000 } },
        )
      );
      assert(!String((garbled as Error).message).includes("control endpoint"), String(garbled));
      await reaped(await loggedPid(logFile));
      // Something else first (ignored), then an endpoint that cannot prove the key.
      await Deno.remove(logFile);
      await assertRejects(
        () =>
          start(
            `read -r init <&"$fd"; echo "pid $$"; printf '{"t":"hello"}\\n{"t":"control","port":%s,"pid":%s}\\n' ${impostor.server.port} $$ >&"$fd"; exec sleep 30`,
          ),
        Error,
        "its control endpoint did not authenticate",
      );
      await reaped(await loggedPid(logFile));
      assertEquals(await readDetachedRecord(dir, "daemon"), null, "the record it wrote is removed");
      assertEquals(impostor.shutdowns, []);
    } finally {
      impostor.server.close();
      await Deno.remove(data, { recursive: true });
    }
  },
});

// ── real processes ───────────────────────────────────────────────────────────────────────────

const FIXTURE = new URL("./fixtures/sidecar-detached/", import.meta.url);
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

/**
 * Whether process `pid` is running, asked of the OS: `tasklist` on Windows, signal 0 elsewhere
 * (the detached processes are not this test's children: once ended, init reaps them).
 */
async function processRunning(pid: number): Promise<boolean> {
  if (Deno.build.os !== "windows") return processExists(pid);
  const out = await new Deno.Command("tasklist", {
    args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(out.stdout).includes(`"${pid}"`);
}

/**
 * The running processes of the fixture's detached sidecar: each writes its pid as a file under
 * `pidDir` (its `marker` argument) when it starts, and the OS says which still run.
 */
async function pidsOf(pidDir: string): Promise<number[]> {
  const pids: number[] = [];
  try {
    for await (const e of Deno.readDir(pidDir)) {
      const pid = Number(e.name);
      if (Number.isSafeInteger(pid) && pid > 0 && await processRunning(pid)) pids.push(pid);
    }
  } catch { /* none started yet */ }
  return pids.sort((a, b) => a - b);
}

/** End every process the fixture recorded under `pidDir` (this test's own, by its pid). */
async function killMarked(pidDir: string): Promise<void> {
  for (const pid of await pidsOf(pidDir)) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* gone */ }
  }
}

/** One launch of the fixture app (`parent.ts`): its `STATUS` / `STOPPED` lines. */
async function launchApp(
  action: "exit" | "stop" | "list",
  data: string,
  marker: string,
  appVersion: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, Record<string, unknown>>> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      CONFIG,
      fromFileUrl(new URL("parent.ts", FIXTURE)),
      action,
      data,
      marker,
      appVersion,
      JSON.stringify(extra),
    ],
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
    signal: AbortSignal.timeout(120_000),
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  const lines: Record<string, Record<string, unknown>> = {};
  for (const l of text.split("\n")) {
    const m = /^(STATUS|STOPPED|LIST) (.*)$/.exec(l);
    if (m) lines[m[1]] = JSON.parse(m[2]);
  }
  assert(out.success && lines.STATUS, text + new TextDecoder().decode(out.stderr));
  return lines;
}

/**
 * Run `fn` with a fresh data folder and marker (the folder the sidecar records its pid in),
 * ending every recorded process afterwards.
 */
async function withApp(
  name: string,
  fn: (data: string, marker: string) => Promise<void>,
): Promise<void> {
  const data = await tempDir(name);
  const marker = join(data, "pids");
  try {
    await fn(data, marker);
  } finally {
    await killMarked(marker);
    assert(await waitFor(async () => (await pidsOf(marker)).length === 0, 5000), "left running");
    await Deno.remove(data, { recursive: true });
  }
}

Deno.test({
  name: "real: a detached sidecar outlives its app; the next launch reattaches and stops it",
  fn: () =>
    withApp("lifecycle", async (data, marker) => {
      const first = (await launchApp("exit", data, marker, "1.0.0")).STATUS;
      assertEquals(first.state, "ready");
      assertEquals(first.detached, true);
      assertEquals(first.reattached, undefined);
      // The app exited; the sidecar did not.
      assertEquals(await pidsOf(marker), [first.pid]);
      const rec = await readDetachedRecord(detachedRegistryDir(data), "daemon");
      assertEquals(rec?.pid, first.pid);
      assertEquals(rec?.port, first.port);
      // Its own port serves.
      const res = await fetch(`http://127.0.0.1:${first.port}/`);
      assertEquals(await res.text(), "ok");

      const second = await launchApp("stop", data, marker, "1.0.0");
      assertEquals(second.STATUS.reattached, true);
      assertEquals(second.STATUS.pid, first.pid);
      assertEquals(second.STATUS.port, first.port);
      assertEquals(second.STATUS.values, first.values); // the secret it was started with
      assertEquals(second.STOPPED.state, "stopped");
      assert(await waitFor(async () => (await pidsOf(marker)).length === 0, 10_000));
      assertEquals(await readDetachedRecord(detachedRegistryDir(data), "daemon"), null);
      // What it logged after the first app quit: the attachments and its shutdown handler.
      const log = await Deno.readTextFile(join(data, "logs", "sidecar-daemon.log"));
      assertMatch(log, /"secrets":\["token"\]/);
      assertMatch(log, /"bootstrap":\{"hello":"world"\}/);
      assertMatch(
        log,
        /attached true[\s\S]*attached false[\s\S]*attached true[\s\S]*shutdown handler/,
      );
    }),
});

Deno.test({
  name: "real: a detached sidecar whose registry record is deleted ends itself",
  fn: () =>
    withApp("record", async (data, marker) => {
      const status = (await launchApp("exit", data, marker, "1.0.0", { pollMs: 200 })).STATUS;
      assertEquals(await pidsOf(marker), [status.pid]);
      await Deno.remove(detachedRecordPath(detachedRegistryDir(data), "daemon"));
      assert(
        await waitFor(async () => (await pidsOf(marker)).length === 0, 15_000),
        "still running",
      );
    }),
});

Deno.test({
  name: "real: detached.exitAfterMs ends it once no app was attached that long",
  fn: () =>
    withApp("idle", async (data, marker) => {
      const status = (await launchApp("exit", data, marker, "1.0.0", {
        detached: { exitAfterMs: 1500 },
      })).STATUS;
      assertEquals(await pidsOf(marker), [status.pid]);
      assert(
        await waitFor(async () => (await pidsOf(marker)).length === 0, 20_000),
        "still running",
      );
    }),
});

Deno.test({
  name: "real: an impostor on the recorded control port is refused and the record replaced",
  fn: () =>
    withApp("impostor", async (data, marker) => {
      const first = (await launchApp("exit", data, marker, "1.0.0")).STATUS;
      const dir = detachedRegistryDir(data);
      const rec = (await readDetachedRecord(dir, "daemon"))!;
      // The sidecar dies (the test's own child, by its marker) and another process takes its port.
      await killMarked(marker);
      assert(await waitFor(async () => (await pidsOf(marker)).length === 0, 5000));
      let impostor: Deno.Listener | undefined;
      const heard: string[] = [];
      try {
        impostor = Deno.listen({ hostname: "127.0.0.1", port: rec.control.port });
      } catch { /* the port went elsewhere: the record is just as stale */ }
      const accepting = impostor && (async () => {
        for await (const conn of impostor!) {
          const buf = new Uint8Array(512);
          const n = await conn.read(buf).catch(() => null);
          if (n) heard.push(new TextDecoder().decode(buf.subarray(0, n)));
          // Pretend to be the sidecar without the key.
          await conn.write(
            new TextEncoder().encode(
              JSON.stringify({ t: "challenge", nonce: "D".repeat(22), mac: "E".repeat(43) }) + "\n",
            ),
          ).catch(() => {});
          conn.close();
        }
      })();
      try {
        const second = await launchApp("stop", data, marker, "1.0.0");
        assertEquals(second.STATUS.reattached, undefined); // a fresh start
        assert(second.STATUS.pid !== first.pid);
        if (impostor) assertMatch(heard.join(""), /"t":"hello"/); // it was asked, and failed
      } finally {
        impostor?.close();
        await accepting?.catch(() => {});
      }
      assertEquals(await readDetachedRecord(dir, "daemon"), null);
    }),
});

Deno.test({
  name: "real: another app version replaces the running detached sidecar",
  fn: () =>
    withApp("update", async (data, marker) => {
      const first = (await launchApp("exit", data, marker, "1.0.0")).STATUS;
      const second = await launchApp("stop", data, marker, "2.0.0");
      assertEquals(second.STATUS.reattached, undefined);
      assert(second.STATUS.pid !== first.pid);
      assert(await waitFor(async () => (await pidsOf(marker)).length === 0, 10_000));
    }),
});

// ── the detached sidecar's own process, in-process (a fake `node:process`) ──────────────────────

/** A fake `node:process` with an IPC channel: what `send` sent, and the events it can emit. */
function fakeChildProcess(opts: { ipc?: boolean } = {}) {
  const sent: unknown[] = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const proc: DetachedChildProcess = {
    ...(opts.ipc === false ? {} : {
      send: (msg: unknown) => {
        sent.push(msg);
        return true;
      },
    }),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return proc;
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
      return proc;
    },
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    emit(event, ...args) {
      const set = [...(listeners.get(event) ?? [])];
      for (const fn of set) fn(...args);
      return set.length > 0;
    },
  };
  return { proc, sent };
}

/** The `globalThis.denextSidecar` a detached child installs, as these tests read it. */
interface DetachedChildGlobal {
  readonly name: string;
  readonly child: boolean;
  readonly port?: number;
  readonly bootstrap?: unknown;
  readonly secrets: Readonly<Record<string, string>>;
  ready(): void;
  onShutdown(fn: unknown): void;
  readonly detached: {
    readonly attached: boolean;
    onAttachedChange(fn: unknown): () => void;
  };
  readonly childCommand?: unknown;
}

/** A module that loads (each test's own, so the import really runs). */
const okEntry = (tag: string) =>
  `data:text/javascript,globalThis.__detachedChildLoaded=${JSON.stringify(tag)};`;

/**
 * Start `runDetachedSidecarChild` for a sidecar `d` against a fake process, hand it a valid init
 * (after a message that is not one), and wait until it imported its module.
 */
async function startDetachedChild(opts: {
  dir: string;
  init?: Record<string, unknown>;
  firstAttachMs?: number;
  armFirstAttach?: (fire: () => void, ms: number) => ReturnType<typeof setTimeout>;
  writeRecord?: boolean;
  entry?: string;
}) {
  const { proc, sent } = fakeChildProcess();
  const exits: number[] = [];
  const key = newDetachedKey();
  const recordDir = detachedRegistryDir(opts.dir);
  const recordPath = detachedRecordPath(recordDir, "d");
  if (opts.writeRecord !== false) await writeDetachedRecord(recordDir, record("d", 1, key));
  const helper = () => "child-command";
  const run = runDetachedSidecarChild({
    name: "d",
    entry: opts.entry ?? okEntry(crypto.randomUUID()),
    childHelpers: { childCommand: helper },
    process: proc,
    exit: (code) => exits.push(code),
    firstAttachMs: opts.firstAttachMs ?? 10_000,
    ...(opts.armFirstAttach ? { armFirstAttach: opts.armFirstAttach } : {}),
  });
  proc.emit("message", { t: "status" }); // not the init: ignored
  proc.emit("message", {
    t: "init",
    name: "d",
    key,
    secrets: { token: "s3cret" },
    appVersion: "1.0.0",
    startedAt: 7,
    recordPath,
    graceMs: 50,
    ...opts.init,
  });
  await run;
  const control = sent[0] as { t: string; port: number; pid: number };
  const sidecar = (globalThis as { denextSidecar?: DetachedChildGlobal }).denextSidecar!;
  return { proc, sent, exits, key, control, sidecar, helper, recordDir, recordPath };
}

/** Drop the global a detached child installed. */
function clearDetachedChildGlobal(): void {
  delete (globalThis as { denextSidecar?: unknown }).denextSidecar;
  delete (globalThis as { __detachedChildLoaded?: unknown }).__detachedChildLoaded;
}

Deno.test("runDetachedSidecarChild: no IPC channel, a late, dropped, bad or foreign init is refused", async () => {
  // No IPC channel at all.
  await assertRejects(
    () =>
      runDetachedSidecarChild({
        name: "d",
        entry: okEntry("never"),
        childHelpers: {},
        process: fakeChildProcess({ ipc: false }).proc,
        exit: () => {},
      }),
    Error,
    "needs the IPC channel",
  );
  // No init in time: the listeners are dropped again.
  const late = fakeChildProcess();
  await assertRejects(
    () =>
      runDetachedSidecarChild({
        name: "d",
        entry: okEntry("never"),
        childHelpers: {},
        process: late.proc,
        exit: () => {},
        initTimeoutMs: 30,
      }),
    Error,
    "got no init within 30 ms",
  );
  assertEquals(late.proc.listenerCount("message"), 0);
  assertEquals(late.proc.listenerCount("disconnect"), 0);
  // The app drops the channel first.
  const dropped = fakeChildProcess();
  const droppedRun = runDetachedSidecarChild({
    name: "d",
    entry: okEntry("never"),
    childHelpers: {},
    process: dropped.proc,
    exit: () => {},
  });
  dropped.proc.emit("disconnect");
  await assertRejects(() => droppedRun, Error, "dropped a detached sidecar's IPC channel");
  assertEquals(dropped.proc.listenerCount("message"), 0);
  // A malformed init names its first bad field.
  const bad = fakeChildProcess();
  const badRun = runDetachedSidecarChild({
    name: "d",
    entry: okEntry("never"),
    childHelpers: {},
    process: bad.proc,
    exit: () => {},
  });
  bad.proc.emit("message", { t: "init", name: "" });
  await assertRejects(() => badRun, Error, "a detached sidecar got a bad init (init.name)");
  // An init for another sidecar.
  const foreign = fakeChildProcess();
  const foreignRun = runDetachedSidecarChild({
    name: "d",
    entry: okEntry("never"),
    childHelpers: {},
    process: foreign.proc,
    exit: () => {},
  });
  foreign.proc.emit("message", {
    t: "init",
    name: "other",
    key: newDetachedKey(),
    secrets: {},
    appVersion: "1",
    startedAt: 1,
    recordPath: "/x/other.json",
  });
  await assertRejects(() => foreignRun, Error, "the init names another sidecar (other)");
  // None of them opened an endpoint or told the app a port.
  assertEquals([late, dropped, bad, foreign].map((f) => f.sent.length), [0, 0, 0, 0]);
  assertEquals((globalThis as { denextSidecar?: unknown }).denextSidecar, undefined);
});

Deno.test("runDetachedSidecarChild: the global, attachments, ready() and an app-asked shutdown", async () => {
  const dir = await tempDir("child-life");
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const { proc, exits, key, control, sidecar, helper } = await startDetachedChild({
      dir,
      init: { port: 5555, bootstrap: { hello: "world" } },
    });
    // The app learns the control endpoint and this pid over the IPC channel.
    assertEquals(control.t, "control");
    assertEquals(control.pid, Deno.pid);
    assert(control.port > 0);
    // The module was imported with the global in place.
    assert((globalThis as { __detachedChildLoaded?: unknown }).__detachedChildLoaded);
    assertEquals(sidecar.name, "d");
    assertEquals(sidecar.child, true);
    assertEquals(sidecar.port, 5555);
    assertEquals(sidecar.bootstrap, { hello: "world" });
    assertEquals(sidecar.secrets, { token: "s3cret" });
    assert(Object.isFrozen(sidecar) && Object.isFrozen(sidecar.secrets));
    assertEquals(sidecar.childCommand, helper);
    assertEquals(sidecar.detached.attached, false);

    const changes: boolean[] = [];
    const dropped: boolean[] = [];
    sidecar.detached.onAttachedChange((now: boolean) => changes.push(now));
    sidecar.detached.onAttachedChange(() => {
      throw new Error("listener boom");
    });
    const unsubscribe = sidecar.detached.onAttachedChange((now: boolean) => dropped.push(now));
    unsubscribe();
    // A non-function is ignored and still hands back an unsubscribe.
    const noop = sidecar.detached.onAttachedChange("nope");
    assertEquals(typeof noop, "function");
    noop();

    const order: string[] = [];
    sidecar.onShutdown(async () => {
      await sleep(5);
      order.push("handler");
    });
    sidecar.onShutdown(() => {
      throw new Error("a failing handler does not stop the others");
    });
    sidecar.onShutdown("not a function");
    proc.on("SIGTERM", (sig) => void order.push(`signal ${sig}`));

    const s = await connectDetachedControl({ port: control.port, key, name: "d" });
    assert(s);
    assertEquals(s.info.name, "d");
    assertEquals(s.info.appVersion, "1.0.0");
    assertEquals(s.info.startedAt, 7);
    assert(await waitFor(() => sidecar.detached.attached, 2000));
    assertEquals(changes, [true]);
    assertEquals(dropped, []);
    // The throwing listener is reported, not fatal.
    assertEquals(errors.length, 1);
    assertMatch(String(errors[0][0]), /sidecar d: an onAttachedChange listener failed/);

    // ready() reaches the attached app.
    assertEquals(s.ready, false);
    sidecar.ready();
    await s.whenReady();
    assert(s.ready);

    // A second attachment is no change for the module.
    const s2 = await connectDetachedControl({ port: control.port, key, name: "d" });
    assert(s2);
    assertEquals(s2.info.attached, 2);
    s2.close();
    assert(await waitFor(async () => (await s.status())?.attached === 1, 2000));
    assertEquals(changes, [true]);
    assertEquals(exits, []);

    // The app asks it to stop: handlers, then SIGTERM listeners, then the bye and exit(0).
    assert(await s.shutdown(60));
    assertEquals((await s.closed).bye?.reason, "the app asked it to stop");
    assertEquals((await s.closed).bye?.code, 0);
    assertEquals(order, ["handler", "signal SIGTERM"]);
    assertEquals(exits, [0]);
    // The unconditional grace exit still fires (the process would be gone by then).
    assert(await waitFor(() => exits.length === 2, 2000));
  } finally {
    console.error = realError;
    clearDetachedChildGlobal();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDetachedSidecarChild: no app attaching after the start ends it", async () => {
  const dir = await tempDir("child-first");
  try {
    const order: string[] = [];
    // The deadline is armed (with its budget) before the module is imported; the test fires it
    // once the module's shutdown handler is in place, so no wall clock decides the order.
    const armed: Array<{ fire: () => void; ms: number }> = [];
    const { exits, sidecar } = await startDetachedChild({
      dir,
      firstAttachMs: 80,
      armFirstAttach: (fire, ms) => {
        armed.push({ fire, ms });
        return setTimeout(() => {}, 0);
      },
    });
    assertEquals(armed.map((a) => a.ms), [80]);
    sidecar.onShutdown(() => void order.push("handler"));
    assertEquals(exits, [], "nothing ends it before its deadline");
    armed[0].fire();
    assert(await waitFor(() => exits.length >= 1, 5000));
    assertEquals(exits[0], 0);
    assertEquals(order, ["handler"]);
    assert(await waitFor(() => exits.length === 2, 2000));
  } finally {
    clearDetachedChildGlobal();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rotateDetachedLog: past the size the log moves to .1 and the open append descriptor writes anew", async () => {
  const dir = await tempDir("log-rotate");
  const log = join(dir, "sidecar-d.log");
  const fs = await import("node:fs");
  // The descriptor the app opened for the process's output (append mode), kept open.
  const fd = fs.openSync(log, "a", 0o600);
  try {
    fs.writeSync(fd, "old-".repeat(10)); // 40 bytes
    assertEquals(await rotateDetachedLog(log, 100), false, "under the size: left alone");
    fs.writeSync(fd, "old-".repeat(20)); // 120 bytes
    assertEquals(await rotateDetachedLog(log, 100), true);
    assertEquals(await Deno.readTextFile(`${log}.1`), "old-".repeat(30));
    // The process keeps writing through the same descriptor: into the emptied file.
    fs.writeSync(fd, "new");
    assertEquals(await Deno.readTextFile(log), "new");
    // A missing log is no error.
    assertEquals(await rotateDetachedLog(join(dir, "none.log"), 1), false);
  } finally {
    fs.closeSync(fd);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDetachedSidecarChild: its log is rotated while it runs, not only at a start", async () => {
  const dir = await tempDir("child-log");
  const log = join(dir, "sidecar-d.log");
  try {
    await Deno.writeTextFile(log, "x".repeat(64));
    const { exits, key, control } = await startDetachedChild({
      dir,
      init: { logFile: log, logRotateBytes: 32, logCheckMs: 20 },
    });
    assert(await waitFor(async () => (await Deno.stat(log)).size === 0, 3000), "rotated");
    assertEquals(await Deno.readTextFile(`${log}.1`), "x".repeat(64));
    const s = await connectDetachedControl({ port: control.port, key, name: "d" });
    assert(s);
    assert(await s.shutdown(20));
    // The shutdown's own exit, then its grace's (each `exit` is a fake here).
    assert(await waitFor(() => exits.length === 2, 2000));
  } finally {
    clearDetachedChildGlobal();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDetachedSidecarChild: a record another start replaced ends it at the next check", async () => {
  const dir = await tempDir("child-replaced");
  try {
    const { exits, key, control, recordDir } = await startDetachedChild({
      dir,
      init: { recordPollMs: 50 },
    });
    const s = await connectDetachedControl({ port: control.port, key, name: "d" });
    assert(s);
    // While the record holds its key, the checks keep it running.
    await sleep(200);
    assertEquals(exits, []);
    assert(s.open);
    await writeDetachedRecord(recordDir, record("d", 1, newDetachedKey()));
    const end = await s.closed;
    assertEquals(end.bye?.reason, "its registry record is gone or was replaced");
    assertEquals(exits[0], 0);
    assert(await waitFor(() => exits.length === 2, 2000));
  } finally {
    clearDetachedChildGlobal();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDetachedSidecarChild: a record that cannot be read just now does not end it", async () => {
  const dir = await tempDir("child-unreadable");
  try {
    const { exits, key, control, recordDir, recordPath } = await startDetachedChild({
      dir,
      init: { recordPollMs: 30 },
    });
    const s = await connectDetachedControl({ port: control.port, key, name: "d" });
    assert(s);
    // The read fails with something other than NotFound (here: a folder in its place, as a
    // scanner holding the file or no free descriptors would): checked again, never an end.
    await Deno.remove(recordPath);
    await Deno.mkdir(recordPath);
    await sleep(300);
    assertEquals(exits, []);
    assert(s.open);
    // Readable again, naming another start: it ends at the next check.
    await Deno.remove(recordPath);
    await writeDetachedRecord(recordDir, record("d", 1, newDetachedKey()));
    const end = await s.closed;
    assertEquals(end.bye?.reason, "its registry record is gone or was replaced");
    assert(await waitFor(() => exits.length === 2, 2000));
  } finally {
    clearDetachedChildGlobal();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDetachedSidecarChild: a missing record ends it once the last app detaches", async () => {
  const dir = await tempDir("child-missing");
  try {
    const { exits, key, control, sidecar } = await startDetachedChild({ dir, writeRecord: false });
    const changes: boolean[] = [];
    sidecar.detached.onAttachedChange((now: boolean) => changes.push(now));
    const s = await connectDetachedControl({ port: control.port, key, name: "d" });
    assert(s);
    assert(await waitFor(() => changes.length === 1, 2000));
    s.close();
    assert(await waitFor(() => exits.length >= 1, 3000));
    assertEquals(changes, [true, false]);
    assertEquals(exits[0], 0);
    assert(await waitFor(() => exits.length === 2, 2000));
  } finally {
    clearDetachedChildGlobal();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDetachedSidecarChild: exitAfterMs ends it once no app was attached that long; a re-attach resets it", async () => {
  const dir = await tempDir("child-idle");
  try {
    const { exits, key, control, sidecar } = await startDetachedChild({
      dir,
      init: { exitAfterMs: 250 },
    });
    const changes: boolean[] = [];
    sidecar.detached.onAttachedChange((now: boolean) => changes.push(now));
    const s = await connectDetachedControl({ port: control.port, key, name: "d" });
    assert(s);
    assert(await waitFor(() => changes.length === 1, 2000));
    s.close();
    assert(await waitFor(() => changes.length === 2, 2000));
    // Re-attached before the idle budget ran out: the idle exit is cancelled.
    const s2 = await connectDetachedControl({ port: control.port, key, name: "d" });
    assert(s2);
    assert(await waitFor(() => changes.length === 3, 2000));
    await sleep(400);
    assertEquals(exits, []);
    const detachedAt = Date.now();
    s2.close();
    assert(await waitFor(() => exits.length >= 1, 3000));
    assert(Date.now() - detachedAt >= 200, "ended before exitAfterMs");
    assertEquals(changes, [true, false, true, false]);
    assertEquals(exits[0], 0);
    assert(await waitFor(() => exits.length === 2, 2000));
  } finally {
    clearDetachedChildGlobal();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDetachedSidecarChild: a module that fails after the first-attach deadline ended the start exits once, with 0", async () => {
  const dir = await tempDir("child-late-fail");
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    // The module outlives the 50 ms deadline, then throws: the shutdown the deadline began ends
    // the process, and the failure is only reported (no exit 1 after it).
    const entry = "data:text/javascript," +
      encodeURIComponent(
        `await new Promise((r) => setTimeout(r, 400)); throw new Error("late boom ${crypto.randomUUID()}");`,
      );
    const { exits } = await startDetachedChild({ dir, entry, firstAttachMs: 50 });
    assert(exits.length >= 1);
    assert(exits.every((c) => c === 0));
    assertEquals(errors.length, 1);
    assertMatch(String(errors[0][0]), /^sidecar d: Error: late boom/);
  } finally {
    console.error = realError;
    clearDetachedChildGlobal();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDetachedSidecarChild: a module that fails to load is reported and exits 1", async () => {
  const dir = await tempDir("child-fail");
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const { exits, sent } = await startDetachedChild({
      dir,
      entry: `data:text/javascript,throw new Error("module boom ${crypto.randomUUID()}");`,
      // Room for the import on a slow runner: an expired deadline would end it first (exit 0).
      firstAttachMs: 2000,
    });
    assertEquals((sent[0] as { t: string }).t, "control");
    assertEquals(exits, [1]);
    assertEquals(errors.length, 1);
    assertMatch(String(errors[0][0]), /^sidecar d: Error: module boom/);
    // The first-attach budget that was still armed finds it already ending: no second exit.
    await sleep(200);
    assertEquals(exits, [1]);
  } finally {
    console.error = realError;
    clearDetachedChildGlobal();
    await Deno.remove(dir, { recursive: true });
  }
});
