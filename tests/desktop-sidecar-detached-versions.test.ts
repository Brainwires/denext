// Detached sidecars that persist (src/desktop/sidecar-detached.ts, sidecar-launch.ts,
// sidecar-host.ts, sidecar-registry.ts): `keepAcrossUpdates` really survives a full-app update
// (the update path lets it go on macOS and Linux, stops it on Windows); `detached.version` makes
// one instance per version key, side by side, each reattached across app versions, listed with its
// key and stopped by `stopDetachedSidecar(name, { version })`; launch-time cleanup keeps an
// instance whose name an installed version of the app still declares (the declarations each
// packaged build records in `<app data>/sidecars/installed/`, dropped once its executable is gone
// or replaced), and reaps the rest. Only instances the app recorded and that authenticate are
// ever signalled.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  detachedOptions,
  detachedSurvivesUpdate,
  type SidecarDefinition,
  sidecarDefinitionError,
} from "../src/desktop/sidecar.ts";
import {
  cleanDetachedLeftovers,
  currentDetachedBuild,
  type DetachedRecord,
  detachedRecordPath,
  detachedRegistryDir,
  type DetachedStat,
  installedDetachedNames,
  listDetachedRecords,
  listDetachedSidecars,
  newDetachedKey,
  parseDetachedRecord,
  readDetachedRecord,
  recordDetachedDeclarations,
  removeDetachedRecord,
  serveDetachedControl,
  stopDetachedRecord,
  writeDetachedRecord,
} from "../src/desktop/sidecar-detached.ts";
import { detachedSidecarLauncher } from "../src/desktop/sidecar-launch.ts";
import type {
  SidecarClock,
  SidecarInstance,
  SidecarLaunchContext,
  SidecarTimer,
} from "../src/desktop/sidecar-supervisor.ts";
import { createSidecarHost } from "../src/desktop/sidecar-host.ts";
import { registerSidecarStopper, stopSidecars } from "../src/desktop/sidecar-registry.ts";

/** A temp folder for one test. */
function tempDir(prefix: string): Promise<string> {
  return Deno.makeTempDir({ prefix: `denext-detached-v-${prefix}-` });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` until it is true or `ms` passed. */
async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(50);
  }
  return await check();
}

/** Let pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await sleep(0);
}

/** A control server with `key` whose `shutdown` closes it. */
async function testServer(key: string, name: string) {
  const shutdowns: number[] = [];
  const server = await serveDetachedControl({
    key,
    identity: { name, pid: 999_999, startedAt: 5, appVersion: "1.0.0" },
    onShutdown: (g) => {
      shutdowns.push(g);
      server.close();
    },
  });
  return { server, shutdowns };
}

/** A record for `name` (and `version`) at `port`. */
function record(
  name: string,
  port: number,
  key: string,
  extra: Partial<DetachedRecord> = {},
): DetachedRecord {
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

/** A clock that only moves when told to. */
function fakeClock(): SidecarClock {
  let next = 0;
  return {
    now: () => 1_000_000,
    setTimeout: () => ++next as unknown as SidecarTimer,
    clearTimeout: () => {},
  };
}

/** A detached instance that records `stop` / `detach`. */
function detachedInstance() {
  let end!: (e: { code?: number }) => void;
  const exited = new Promise<{ code?: number }>((r) => end = r);
  const calls: string[] = [];
  const inst: SidecarInstance = {
    pid: 777,
    exited,
    detached: true,
    ready: true,
    stop: () => {
      calls.push("stop");
      end({ code: 0 });
      return Promise.resolve();
    },
    detach: () => calls.push("detach"),
  };
  return { inst, calls };
}

const BASE: SidecarDefinition = { name: "ptyd", run: { module: "./d.ts" }, detached: true };

/** A child base whose program does not exist: a fresh start fails at the spawn. */
const NO_SPAWN = {
  name: "ptyd",
  command: "/nonexistent/denext-detached-test-app",
  args: ["run", "/nonexistent/desktop.ts"],
  env: {},
  argcEnv: "DENEXT_SIDECAR_CHILD_ARGC",
  selfForkAuthorized: true,
};

function launchCtx(def: SidecarDefinition): SidecarLaunchContext {
  return {
    definition: def,
    bootstrap: null,
    secrets: {},
    onLine: () => {},
    onReadySignal: () => {},
  };
}

// ── the definition ───────────────────────────────────────────────────────────────────────────

Deno.test("detached.version: a version key is checked and implies keepAcrossUpdates", () => {
  const mod = { name: "ptyd", run: { module: "./d.ts" } };
  assertEquals(sidecarDefinitionError({ ...mod, detached: { version: "proto-2.1" } }), null);
  for (const bad of ["", ".x", "a b", "x".repeat(65), 2]) {
    assert(
      sidecarDefinitionError({ ...mod, detached: { version: bad } })?.includes("detached.version"),
      `accepted ${JSON.stringify(bad)}`,
    );
  }
  assertEquals(detachedOptions({ ...BASE, detached: { version: "2" } }), {
    keepAcrossUpdates: true,
    version: "2",
  });
});

Deno.test("detachedSurvivesUpdate: keepAcrossUpdates or a version, on macOS and Linux only", () => {
  const keep: SidecarDefinition = { ...BASE, detached: { keepAcrossUpdates: true } };
  const versioned: SidecarDefinition = { ...BASE, detached: { version: "1" } };
  for (const os of ["darwin", "linux"]) {
    assert(detachedSurvivesUpdate(keep, os));
    assert(detachedSurvivesUpdate(versioned, os));
    assert(!detachedSurvivesUpdate(BASE, os));
  }
  assert(!detachedSurvivesUpdate(keep, "windows"));
  assert(!detachedSurvivesUpdate(versioned, "windows"));
  assert(!detachedSurvivesUpdate({ name: "p", run: { module: "./p.ts" } }, "darwin"));
});

// ── the records ──────────────────────────────────────────────────────────────────────────────

Deno.test("records: a versioned instance is <name>@<version>.json, read, listed and removed by key", async () => {
  const data = await tempDir("records");
  try {
    const dir = detachedRegistryDir(data);
    const k1 = newDetachedKey();
    const k2 = newDetachedKey();
    const k0 = newDetachedKey();
    await writeDetachedRecord(dir, record("ptyd", 4001, k1, { version: "1" }));
    await writeDetachedRecord(dir, record("ptyd", 4002, k2, { version: "2.0" }));
    await writeDetachedRecord(dir, record("ptyd", 4000, k0));
    assertEquals(detachedRecordPath(dir, "ptyd", "2.0"), join(dir, "ptyd@2.0.json"));
    assert(await Deno.stat(join(dir, "ptyd@1.json")));
    assertEquals((await readDetachedRecord(dir, "ptyd", "1"))?.key, k1);
    assertEquals((await readDetachedRecord(dir, "ptyd"))?.key, k0);
    assertEquals(await readDetachedRecord(dir, "ptyd", "3"), null);
    assertEquals(
      (await listDetachedRecords(dir)).map((r) => [r.name, r.version ?? null]),
      [["ptyd", null], ["ptyd", "1"], ["ptyd", "2.0"]],
    );
    // A record whose version is not the one its file names is refused.
    const text = await Deno.readTextFile(join(dir, "ptyd@1.json"));
    assertEquals(parseDetachedRecord(text, "ptyd", "2.0"), null);
    assertEquals(parseDetachedRecord(text, "ptyd", null), null);
    assertEquals(parseDetachedRecord(text, "ptyd")?.version, "1");
    assertEquals(
      parseDetachedRecord(JSON.stringify({ ...JSON.parse(text), version: "a b" })),
      null,
    );
    // Removal is per instance and checks the key.
    await removeDetachedRecord(dir, "ptyd", k2, "1"); // another key: kept
    assert(await readDetachedRecord(dir, "ptyd", "1"));
    await removeDetachedRecord(dir, "ptyd", k1, "1");
    assertEquals(await readDetachedRecord(dir, "ptyd", "1"), null);
    assert(await readDetachedRecord(dir, "ptyd", "2.0"));
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

// ── the launcher ─────────────────────────────────────────────────────────────────────────────

Deno.test("launcher: a version key's instance is reattached whatever app version started it", async () => {
  const data = await tempDir("reattach");
  const dir = detachedRegistryDir(data);
  const key = newDetachedKey();
  const other = newDetachedKey();
  const v2 = await testServer(key, "ptyd");
  const v1 = await testServer(other, "ptyd");
  try {
    await writeDetachedRecord(
      dir,
      record("ptyd", v2.server.port, key, {
        version: "2",
        appVersion: "0.9.0+old",
        port: 6200,
      }),
    );
    await writeDetachedRecord(dir, record("ptyd", v1.server.port, other, { version: "1" }));
    const def: SidecarDefinition = { ...BASE, detached: { version: "2" } };
    const inst = await detachedSidecarLauncher({
      child: NO_SPAWN,
      registryDir: dir,
      appVersion: "1.0.0+new",
    })(launchCtx(def));
    assertEquals(inst.reattached, true);
    assertEquals(inst.port, 6200);
    // The other key's instance was neither touched nor replaced.
    assertEquals(v1.shutdowns, []);
    assertEquals(v2.shutdowns, []);
    inst.detach!();
    await inst.exited;
    // stop() ends this instance and removes its record only.
    const again = await detachedSidecarLauncher({
      child: NO_SPAWN,
      registryDir: dir,
      appVersion: "1.0.0+new",
    })(launchCtx(def));
    await again.stop(500);
    assertEquals(v2.shutdowns, [500]);
    assertEquals(await readDetachedRecord(dir, "ptyd", "2"), null);
    assert(await readDetachedRecord(dir, "ptyd", "1"));
  } finally {
    v1.server.close();
    v2.server.close();
    await Deno.remove(data, { recursive: true });
  }
});

// ── the declarations and the launch-time cleanup ─────────────────────────────────────────────

/** A stat over a fake set of executables: path → `{ size, mtime }`. */
function fakeStat(files: Record<string, number>): DetachedStat {
  return (path) =>
    path in files
      ? Promise.resolve({ size: files[path], mtime: new Date(1000) })
      : Promise.reject(new Deno.errors.NotFound(path));
}

Deno.test("declarations: an installed version's names count while its executable is unchanged", async () => {
  const data = await tempDir("decl");
  try {
    const dir = detachedRegistryDir(data);
    assertEquals(await installedDetachedNames(dir), []); // no folder yet
    await recordDetachedDeclarations(
      dir,
      { appVersion: "1.4.0+1", exe: "/apps/stable/App", stamp: "100.1000" },
      [{ name: "ptyd", version: "1" }, "agent"],
    );
    await recordDetachedDeclarations(
      dir,
      { appVersion: "1.5.0+2", exe: "/apps/beta/App", stamp: "200.1000" },
      [{ name: "indexer" }],
    );
    const both = fakeStat({ "/apps/stable/App": 100, "/apps/beta/App": 200 });
    assertEquals(await installedDetachedNames(dir, both), ["agent", "indexer", "ptyd"]);
    if (Deno.build.os !== "windows") {
      for await (const e of Deno.readDir(join(dir, "installed"))) {
        assertEquals((await Deno.stat(join(dir, "installed", e.name))).mode! & 0o777, 0o600);
      }
    }
    // The beta build was updated over (another size): its declaration is dropped for good.
    const updated = fakeStat({ "/apps/stable/App": 100, "/apps/beta/App": 999 });
    assertEquals(await installedDetachedNames(dir, updated), ["agent", "ptyd"]);
    assertEquals(await installedDetachedNames(dir, both), ["agent", "ptyd"]);
    // Uninstalled: gone; a corrupt file is dropped too.
    await Deno.writeTextFile(join(dir, "installed", "0123456789abcdef01234567.json"), "{");
    assertEquals(await installedDetachedNames(dir, fakeStat({})), []);
    assertEquals([...Deno.readDirSync(join(dir, "installed"))].length, 0);
    // A dev run records nothing.
    assertEquals(await currentDetachedBuild("dev"), null);
    const build = await currentDetachedBuild("1.0.0+3", fakeStat({ [Deno.execPath()]: 7 }));
    assertEquals(build, { appVersion: "1.0.0+3", exe: Deno.execPath(), stamp: "7.1000" });
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("cleanup: names an installed version declares are kept, other versions of them too; the rest go", async () => {
  const data = await tempDir("clean");
  const dir = detachedRegistryDir(data);
  const servers: Array<Awaited<ReturnType<typeof testServer>>> = [];
  const live = async (name: string, version?: string) => {
    const key = newDetachedKey();
    const s = await testServer(key, name);
    servers.push(s);
    await writeDetachedRecord(dir, record(name, s.server.port, key, version ? { version } : {}));
    return s;
  };
  try {
    const ownV2 = await live("ptyd", "2");
    const oldV1 = await live("ptyd", "1"); // an older protocol's daemon, still serving
    const otherInstall = await live("indexer"); // another installed version's sidecar
    const dropped = await live("legacy"); // no installed version declares it any more
    await writeDetachedRecord(dir, record("ptyd", 1, newDetachedKey(), { version: "0" })); // stale
    const removed = await cleanDetachedLeftovers(
      dir,
      [{ name: "ptyd", version: "2" }],
      200,
      ["indexer"],
    );
    assertEquals(removed.sort(), ["legacy", "ptyd@0"]);
    assertEquals(dropped.shutdowns, [200]);
    for (const s of [ownV2, oldV1, otherInstall]) assertEquals(s.shutdowns, []);
    assertEquals(
      (await listDetachedRecords(dir)).map((r) => `${r.name}${r.version ? "@" + r.version : ""}`),
      ["indexer", "ptyd@1", "ptyd@2"],
    );
    // Listed with their keys; only the declared instance reads declared.
    const entries = await listDetachedSidecars(dir, [{ name: "ptyd", version: "2" }]);
    assertEquals(
      entries.map((e) => [e.name, e.version ?? null, e.declared, e.reachable]),
      [["indexer", null, false, true], ["ptyd", "1", false, true], ["ptyd", "2", true, true]],
    );
    // The app (or the user) retires the old daemon by its key.
    await stopDetachedRecord(dir, "ptyd", 300, {}, "1");
    assertEquals(oldV1.shutdowns, [300]);
    await assertRejects(
      () => stopDetachedRecord(dir, "ptyd", 300, {}, "9"),
      Error,
      "ptyd@9: no detached sidecar",
    );
  } finally {
    for (const s of servers) s.server.close();
    await Deno.remove(data, { recursive: true });
  }
});

// ── the host: updates, the launch, stopping one instance ─────────────────────────────────────

/** A host over one detached sidecar `def`, its instances recorded. */
async function hostWith(def: SidecarDefinition, data: string, os: string) {
  const instances: Array<ReturnType<typeof detachedInstance>> = [];
  const host = await createSidecarHost({
    sidecars: [def],
    dataDir: data,
    clock: fakeClock(),
    os,
    appVersion: "dev",
    launcher: () => () => {
      const i = detachedInstance();
      instances.push(i);
      return Promise.resolve(i.inst);
    },
  });
  return { host, instances };
}

Deno.test("host: an update lets a sidecar that survives updates go on macOS / Linux, stops it on Windows", async () => {
  const data = await tempDir("update");
  try {
    const cases: Array<[SidecarDefinition, string, string]> = [
      [{ ...BASE, detached: { keepAcrossUpdates: true } }, "darwin", "detach"],
      [{ ...BASE, detached: { version: "1" } }, "linux", "detach"],
      [{ ...BASE, detached: { keepAcrossUpdates: true } }, "windows", "stop"],
      [BASE, "darwin", "stop"],
    ];
    for (const [def, os, expected] of cases) {
      const { host, instances } = await hostWith(def, data, os);
      await host.handle("ptyd").restart();
      await settle();
      host.killAll("update");
      await settle();
      assertEquals(instances[0].calls, [expected], `${JSON.stringify(def.detached)} on ${os}`);
    }
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("host: stopSidecars({ forUpdate }) lets a surviving sidecar go; a plain stopSidecars() stops it", async () => {
  const data = await tempDir("stopall");
  try {
    for (const [forUpdate, expected] of [[true, "detach"], [false, "stop"]] as const) {
      const { host, instances } = await hostWith(
        { ...BASE, detached: { keepAcrossUpdates: true } },
        data,
        "darwin",
      );
      await host.handle("ptyd").restart();
      await settle();
      const unregister = registerSidecarStopper({ kill: host.killAll, stop: host.stopAll });
      try {
        await stopSidecars(forUpdate ? { forUpdate } : undefined);
      } finally {
        unregister();
      }
      assertEquals(instances[0].calls, [expected]);
    }
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("host: stopDetachedSidecar takes a version; the declared instance stops through its handle", async () => {
  const data = await tempDir("stopone");
  const dir = detachedRegistryDir(data);
  const key = newDetachedKey();
  const old = await testServer(key, "ptyd");
  try {
    await writeDetachedRecord(dir, record("ptyd", old.server.port, key, { version: "1" }));
    const { host, instances } = await hostWith(
      { ...BASE, detached: { version: "2" } },
      data,
      "darwin",
    );
    await host.handle("ptyd").restart();
    await settle();
    // The other key's instance, by its record.
    await host.stopDetachedSidecar("ptyd", { version: "1" });
    assertEquals(old.shutdowns.length, 1);
    assertEquals(instances[0].calls, []);
    // No version: the one the app declares, through its handle.
    await host.stopDetachedSidecar("ptyd");
    assertEquals(instances[0].calls, ["stop"]);
    await assertRejects(() => host.stopDetachedSidecar("ptyd", { version: "1" }), Error, "ptyd@1");
  } finally {
    old.server.close();
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("host: the launch keeps another installed version's sidecars and reaps what none declares", async () => {
  const data = await tempDir("launch");
  const dir = detachedRegistryDir(data);
  const keep = newDetachedKey();
  const drop = newDetachedKey();
  const theirs = await testServer(keep, "indexer");
  const orphan = await testServer(drop, "legacy");
  try {
    await writeDetachedRecord(dir, record("indexer", theirs.server.port, keep));
    await writeDetachedRecord(dir, record("legacy", orphan.server.port, drop));
    // Another installed build (its executable unchanged) declares "indexer".
    const exe = join(data, "OtherApp");
    await Deno.writeTextFile(exe, "binary");
    const info = await Deno.stat(exe);
    await recordDetachedDeclarations(
      dir,
      { appVersion: "2.0.0+9", exe, stamp: `${info.size}.${info.mtime?.getTime() ?? 0}` },
      ["indexer"],
    );
    const { host } = await hostWith(BASE, data, "darwin");
    host.startAll();
    assert(await waitFor(() => orphan.shutdowns.length === 1, 5000));
    await settle();
    assertEquals(theirs.shutdowns, []);
    assertEquals((await listDetachedRecords(dir)).map((r) => r.name), ["indexer"]);
    host.killAll("exit");
  } finally {
    theirs.server.close();
    orphan.server.close();
    await Deno.remove(data, { recursive: true });
  }
});
