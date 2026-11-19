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
  readDetachedRecord,
  removeDetachedRecord,
  serveDetachedControl,
  stopDetachedRecord,
  verifyDetachedMac,
  withDetachedLock,
  writeDetachedRecord,
} from "../src/desktop/sidecar-detached.ts";
import { detachedChildInitError } from "../src/desktop/sidecar-detached-child.ts";
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

/** Network tests hold sockets the server side closes on its own schedule. */
const NET = { sanitizeOps: false, sanitizeResources: false } as const;

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

Deno.test("withDetachedLock: serializes two starts; a stale lock is broken; a held one times out", async () => {
  const dir = await tempDir("lock");
  try {
    const order: string[] = [];
    await Promise.all([
      withDetachedLock(dir, "d", async () => {
        order.push("a+");
        await sleep(150);
        order.push("a-");
      }),
      (async () => {
        await sleep(20);
        await withDetachedLock(dir, "d", () => {
          order.push("b");
          return Promise.resolve();
        });
      })(),
    ]);
    assertEquals(order, ["a+", "a-", "b"]);
    // A lock its holder stopped refreshing (it is gone) is broken.
    const lock = join(dir, "d.lock");
    await Deno.writeTextFile(lock, "{}");
    const past = new Date(Date.now() - 60_000);
    await Deno.utime(lock, past, past);
    assertEquals(await withDetachedLock(dir, "d", () => Promise.resolve(7)), 7);
    // A fresh one is respected until the wait gives up.
    await Deno.writeTextFile(lock, "{}");
    await assertRejects(
      () => withDetachedLock(dir, "d", () => Promise.resolve(), { timeoutMs: 200 }),
      Error,
      "holds the start lock",
    );
    await Deno.remove(lock);
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
        const r = await Promise.race([reader.read(), sleep(left).then(() => "t" as const)]);
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
  ...NET,
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
  ...NET,
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
  ...NET,
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
  ...NET,
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
      // Silent: closed once the handshake budget passed.
      const started = Date.now();
      const slow = await raw(server.port);
      assertEquals(await slow.line(2000), null);
      assert(Date.now() - started < 1500);
      slow.close();
      // Two pending connections fill the cap; a third is closed at once.
      const a = await raw(server.port);
      const b = await raw(server.port);
      await sleep(50);
      const c = await raw(server.port);
      assertEquals(await c.line(250), null);
      assertEquals(await a.line(100), "timeout"); // still open, waiting for its hello
      a.close();
      b.close();
      c.close();
    } finally {
      server.close();
    }
  },
});

Deno.test({
  name:
    "endDetachedSession: shutdown first; a forced kill only of the pid this session's ok named, only when permitted",
  ...NET,
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
  ...NET,
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
  ...NET,
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
  ...NET,
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
  ...NET,
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
  ...NET,
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

// ── real processes ───────────────────────────────────────────────────────────────────────────

const FIXTURE = new URL("./fixtures/sidecar-detached/", import.meta.url);
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

/** The pids of processes whose command line has `marker`. */
async function pidsOf(marker: string): Promise<number[]> {
  const out = await new Deno.Command("pgrep", { args: ["-f", marker], stdout: "piped" }).output();
  return new TextDecoder().decode(out.stdout).split("\n").filter(Boolean).map(Number);
}

/** End every process carrying `marker` (this test's own children only: the marker is unique). */
async function killMarked(marker: string): Promise<void> {
  for (const pid of await pidsOf(marker)) {
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

/** Run `fn` with a fresh data folder and marker, ending every marked process afterwards. */
async function withApp(
  name: string,
  fn: (data: string, marker: string) => Promise<void>,
): Promise<void> {
  const data = await tempDir(name);
  const marker = `DENEXT_DETACHED_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await fn(data, marker);
  } finally {
    await killMarked(marker);
    assert(await waitFor(async () => (await pidsOf(marker)).length === 0, 5000), "left running");
    await Deno.remove(data, { recursive: true });
  }
}

const REAL = { ...NET, ignore: Deno.build.os === "windows" } as const;

Deno.test({
  name: "real: a detached sidecar outlives its app; the next launch reattaches and stops it",
  ...REAL,
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
  ...REAL,
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
  ...REAL,
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
  ...REAL,
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
  ...REAL,
  fn: () =>
    withApp("update", async (data, marker) => {
      const first = (await launchApp("exit", data, marker, "1.0.0")).STATUS;
      const second = await launchApp("stop", data, marker, "2.0.0");
      assertEquals(second.STATUS.reattached, undefined);
      assert(second.STATUS.pid !== first.pid);
      assert(await waitFor(async () => (await pidsOf(marker)).length === 0, 10_000));
    }),
});
