// What a revoked pin changes (src/build/runtime-revocations.ts through deno-toolchain.ts,
// desktop-runtime.ts, compile-app.ts, the CLI gate and the pin generator): a fixture toolchain pin
// whose `rollback` names an earlier release, both served from a LOCAL server, and a list signed
// with a TEST key handed in through the test-only DENEXT_REVOCATION_KEYS_FILE seam.

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  activeToolchainPin,
  type DenoToolchainChoice,
  type DenoToolchainPin,
  resolveDenoToolchain,
  rollbackToolchainPin,
  selectToolchainPin,
  shippingToolchainPin,
  toolchainTargetTriple,
} from "../src/build/deno-toolchain.ts";
import {
  type DesktopRuntimePin,
  resolveDesktopRuntimeEnv,
  rollbackDesktopPin,
} from "../src/build/desktop-runtime.ts";
import { denortBinary } from "../src/build/compile-app.ts";
import {
  assertRuntimeShippable,
  freshRevocationList,
  honourRevocationKeysFileForTests,
  REVOCATION_KEYS_FILE_ENV,
  REVOCATION_NOTICED_ENV,
  revocationKeySetId,
  type RuntimeRevocation,
  signRevocationList,
} from "../src/build/runtime-revocations.ts";
import { toBase64 } from "../src/build/ota-signing.ts";
import {
  maybeReexecToolchain,
  type ReexecToolchainDeps,
  revocationCheckFor,
} from "../src/cli/self-exec.ts";
import { runtimeRevocationsCheck } from "../src/cli/commands/doctor.ts";
import {
  main as pinMain,
  type PinFile,
  rollbackFor,
  runtimeRollbackOf,
  type ToolchainPinFile,
  toolchainRollbackOf,
} from "../scripts/desktop-pin-runtime.ts";
import { sha256Hex, zip } from "./_archive-fixtures.ts";

// The keys file is honoured only under this test-only switch (never by the variable alone).
honourRevocationKeysFileForTests();

const TARGET = "linux-x86_64";
const TRIPLE = "x86_64-unknown-linux-gnu";
const PINNED = "9.9.9-denext.3";
const ROLLBACK = "9.9.9-denext.2";
const quiet = () => {};
const allGranted = () => Promise.resolve([]);
const noFetch: typeof fetch = () => Promise.reject(new Error("must not fetch"));

const revoke = (over: Partial<RuntimeRevocation> = {}): RuntimeRevocation => ({
  component: "cli",
  version: PINNED,
  targets: [TRIPLE],
  reason: "crashes on start",
  fixedIn: "denext 9.9.10",
  ...over,
});

interface World {
  pin: DenoToolchainPin;
  cacheRoot: string;
  keysFile: string;
  /** Sign `revoked` into the cached list (as a fetch would have left it). */
  list: (revoked: RuntimeRevocation[]) => Promise<void>;
  env: (vars?: Record<string, string>) => (k: string) => string | undefined;
  close: () => Promise<void>;
}

/** Two toolchain releases served locally, a pin naming the older one as its rollback, a test key. */
async function world(withRollback = true): Promise<World> {
  const body = (v: string) =>
    zip([{ name: "deno", data: `#!/bin/sh\necho ${v}\n`, unixMode: 0o100755 }]);
  const zips: Record<string, Uint8Array> = {
    [PINNED]: await body(PINNED),
    [ROLLBACK]: await body(ROLLBACK),
  };
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const v = new URL(req.url).pathname.slice(1);
    return zips[v] ? new Response(zips[v] as BodyInit) : new Response("no", { status: 404 });
  });
  const artifact = async (v: string) => ({
    file: `deno-${v}.zip`,
    url: `http://127.0.0.1:${server.addr.port}/${v}`,
    sha256: await sha256Hex(zips[v]),
    size: zips[v].byteLength,
    format: "zip" as const,
  });
  const denort = { file: "denort.zip", url: "https://example.invalid/d", sha256: "0" };
  const pin: DenoToolchainPin = {
    schema: 1,
    version: PINNED,
    targets: { [TARGET]: await artifact(PINNED) },
    denort: { [TARGET]: denort },
    ...(withRollback
      ? {
        rollback: {
          version: ROLLBACK,
          tag: `denext-runtime-v${ROLLBACK}`,
          targets: { [TARGET]: await artifact(ROLLBACK) },
          denort: { [TARGET]: denort },
        },
      }
      : {}),
  };
  const cacheRoot = await Deno.makeTempDir({ prefix: "denext-revoke-" });
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pub = toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const keysFile = join(cacheRoot, "test-keys.json");
  await Deno.writeTextFile(keysFile, JSON.stringify([pub]));
  return {
    pin,
    cacheRoot,
    keysFile,
    list: async (revoked) => {
      const list = freshRevocationList(revoked, new Date());
      const doc = await signRevocationList(list, pair.privateKey);
      await Deno.writeTextFile(join(cacheRoot, "revocations.json"), JSON.stringify(doc));
      await Deno.writeTextFile(
        join(cacheRoot, "revocations.state.json"),
        JSON.stringify({
          schema: 1,
          keys: await revocationKeySetId([pub]),
          sequence: list.sequence,
          fetchedAt: Date.now(),
        }),
      );
    },
    // No provenance check: the fixture archives carry no attestation (and `gh` stays unrun).
    env: (vars = {}) => (k) =>
      ({
        [REVOCATION_KEYS_FILE_ENV]: keysFile,
        DENEXT_DESKTOP_RUNTIME_ATTEST: "0",
        ...vars,
      })[k],
    close: async () => {
      await server.shutdown();
      await Deno.remove(cacheRoot, { recursive: true });
    },
  };
}

/** `resolveDenoToolchain` over the world's pin, the list read from the cache only. */
function resolve(w: World, vars: Record<string, string> = {}, extra = {}) {
  return resolveDenoToolchain({
    env: w.env(vars),
    pin: w.pin,
    target: TARGET,
    os: "linux",
    cacheRoot: w.cacheRoot,
    log: quiet,
    missingGrants: allGranted,
    revocations: { mode: "cache-only", fetch: noFetch },
    ...extra,
  });
}

/** What a choice ran: the version and the binary's output marker. */
async function ran(choice: DenoToolchainChoice): Promise<string> {
  assert(choice.kind === "toolchain");
  const text = await Deno.readTextFile(choice.deno);
  assertStringIncludes(text, choice.version);
  return choice.version;
}

Deno.test("a pinned toolchain revoked for this host runs the pin's rollback, with one notice", async () => {
  const w = await world();
  try {
    // Not revoked: the pinned toolchain, and the list's state reported.
    await w.list([]);
    const fine = await resolve(w);
    assertEquals(await ran(fine), PINNED);
    assert(fine.kind === "toolchain" && fine.warning === undefined);
    assertEquals(fine.revocation?.revoked, false);
    // Revoked for this target: the rollback, downloaded and verified like the pinned one.
    await w.list([revoke()]);
    const rolled = await resolve(w);
    assertEquals(await ran(rolled), ROLLBACK);
    assert(rolled.kind === "toolchain");
    assertEquals(
      rolled.warning,
      `denext: Deno toolchain ${PINNED} is revoked for ${TRIPLE} (crashes on start). ` +
        `Running ${ROLLBACK} instead. Fixed in denext 9.9.10: run \`denext upgrade\`.`,
    );
    assertEquals(
      [rolled.revocation?.runningRollback, rolled.revocation?.running],
      [true, ROLLBACK],
    );
    // A process the first one started says nothing again.
    const child = await resolve(w, { [REVOCATION_NOTICED_ENV]: "1" });
    assert(child.kind === "toolchain" && child.warning === undefined);
    assertEquals(child.version, ROLLBACK);
    // Revoked for another target only: nothing changes here.
    await w.list([revoke({ targets: ["aarch64-apple-darwin"] })]);
    assertEquals(await ran(await resolve(w)), PINNED);
  } finally {
    await w.close();
  }
});

Deno.test("no safe fallback: the revoked pin still runs, with a warning", async () => {
  const bare = await world(false);
  const w = await world();
  try {
    await bare.list([revoke()]);
    const stuck = await resolve(bare);
    assertEquals(await ran(stuck), PINNED);
    assert(stuck.kind === "toolchain");
    assertStringIncludes(stuck.warning!, "Still running it; no safe fallback is pinned");
    assertFalse(stuck.revocation!.runningRollback);
    // The rollback revoked too: no fallback either.
    await w.list([revoke(), revoke({ version: ROLLBACK, targets: undefined })]);
    const both = await resolve(w);
    assertEquals(await ran(both), PINNED);
    assert(both.kind === "toolchain");
    assertStringIncludes(both.warning!, "no safe fallback");
  } finally {
    await bare.close();
    await w.close();
  }
});

Deno.test("the list is not consulted for a pin override or a given pin; the toolchain marker decides nothing", async () => {
  const w = await world();
  try {
    await w.list([revoke()]);
    // A pin passed without asking for the check (tests) is never checked.
    const given = await resolve(w, {}, { revocations: undefined });
    assertEquals(await ran(given), PINNED);
    // A marker leaked from a parent shell (or a copied CI env) naming the rollback no longer
    // forces it: with nothing revoking the pin (no key configured here), the pin runs.
    const leaked = (k: string) => k === "DENEXT_TOOLCHAIN_ACTIVE" ? ROLLBACK : undefined;
    const forced = await selectToolchainPin(w.pin, leaked, {}, TARGET, "/nonexistent");
    assertEquals(forced.pin.version, PINNED);
    // Nor does a marker naming the pin skip the check: the list still moves it to the rollback.
    const pinnedChild = await selectToolchainPin(
      w.pin,
      w.env({ DENEXT_TOOLCHAIN_ACTIVE: PINNED }),
      { revocations: { mode: "cache-only" } },
      TARGET,
      w.cacheRoot,
    );
    assertEquals([pinnedChild.pin.version, pinnedChild.revocation?.revoked], [ROLLBACK, true]);
    // A child of the command that chose the rollback agrees with it (and stays quiet).
    const child = await selectToolchainPin(
      w.pin,
      w.env({ DENEXT_TOOLCHAIN_ACTIVE: ROLLBACK, [REVOCATION_NOTICED_ENV]: "1" }),
      { revocations: { mode: "cache-only" } },
      TARGET,
      w.cacheRoot,
    );
    assertEquals([child.pin.version, child.warning], [ROLLBACK, undefined]);
    // DENEXT_TOOLCHAIN_PIN_FILE (fork development) turns the check off.
    const file = await selectToolchainPin(
      w.pin,
      w.env({ DENEXT_TOOLCHAIN_PIN_FILE: "/x.json" }),
      { revocations: { mode: "cache-only" } },
      TARGET,
      w.cacheRoot,
    );
    assertEquals([file.pin.version, file.revocation], [PINNED, undefined]);
    // A pin with nothing pinned: nothing to check.
    const none = await selectToolchainPin(
      { schema: 1, version: null, targets: {} },
      w.env(),
      { revocations: {} },
      TARGET,
      w.cacheRoot,
    );
    assertEquals(none.revocation, undefined);
    // No key configured: the selection reports nothing.
    const off = await selectToolchainPin(
      w.pin,
      (k) => k === REVOCATION_KEYS_FILE_ENV ? "/nonexistent" : undefined,
      { revocations: { fetch: noFetch } },
      TARGET,
      w.cacheRoot,
    );
    assertEquals([off.pin.version, off.revocation], [PINNED, undefined]);
  } finally {
    await w.close();
  }
});

Deno.test("start and job read only the cached list: a stale list is never fetched at boot", async () => {
  assertEquals(revocationCheckFor({ name: "start" }), { mode: "cache-only", components: ["cli"] });
  assertEquals(revocationCheckFor({ name: "job" }).mode, "cache-only");
  assertEquals(revocationCheckFor({ name: "dev" }), { mode: "fetch", components: ["cli"] });
  assertEquals(revocationCheckFor({ name: "start", source: "project" }).mode, "fetch");
  assertEquals(revocationCheckFor({ name: "desktop" }).components, ["cli", "desktop"]);
  const w = await world();
  try {
    await w.list([revoke()]);
    // Make the cached list stale: a fetch would be due in `fetch` mode.
    await Deno.writeTextFile(
      join(w.cacheRoot, "revocations.state.json"),
      JSON.stringify({ schema: 1, sequence: 0, fetchedAt: 0 }),
    );
    let fetched = 0;
    const spy: typeof fetch = () => (fetched++, Promise.reject(new Error("offline")));
    const boot = await resolve(w, {}, {
      revocations: { ...revocationCheckFor({ name: "start" }), fetch: spy },
    });
    assertEquals([await ran(boot), fetched], [ROLLBACK, 0]);
    // `dev` would refresh it (within its budget), then still use the cached list.
    const dev = await resolve(w, {}, {
      revocations: {
        ...revocationCheckFor({ name: "dev" }),
        fetch: spy,
        netGranted: () => Promise.resolve(true),
      },
    });
    assertEquals(await ran(dev), ROLLBACK);
    assert(fetched > 0);
  } finally {
    await w.close();
  }
});

Deno.test("the desktop verbs roll the toolchain back with a revoked Deno Desktop runtime", async () => {
  const w = await world();
  try {
    const desktop = (rollback: string | null) =>
      ({
        version: PINNED,
        targets: {},
        ...(rollback
          ? { rollback: { targets: { [TRIPLE]: { runtimeLib: "x" } }, version: rollback } }
          : {}),
      }) as unknown as DesktopRuntimePin;
    await w.list([revoke({ component: "desktop" })]);
    const cli = await resolve(w);
    assertEquals(await ran(cli), PINNED, "a verb that is not a desktop verb is unaffected");
    const both = await resolve(w, {}, {
      revocations: {
        mode: "cache-only",
        components: ["cli", "desktop"],
        desktopPin: desktop(ROLLBACK),
      },
    });
    assertEquals(await ran(both), ROLLBACK);
    assert(both.kind === "toolchain");
    assertStringIncludes(both.warning!, `Deno Desktop runtime ${PINNED} is revoked`);
    // A desktop rollback of another release can't pair with the toolchain's: both stay.
    const odd = await resolve(w, {}, {
      revocations: {
        mode: "cache-only",
        components: ["cli", "desktop"],
        desktopPin: desktop("1.0.0"),
      },
    });
    assertEquals(await ran(odd), PINNED);
  } finally {
    await w.close();
  }
});

Deno.test("activeToolchainPin / rollbackToolchainPin: a child of a rollback run takes the rollback's pin", async () => {
  const w = await world();
  try {
    const file = join(w.cacheRoot, "pin.json");
    await Deno.writeTextFile(file, JSON.stringify({ ...w.pin, repository: "https://x" }));
    const env = (marker?: string) => (k: string) =>
      ({ DENEXT_TOOLCHAIN_PIN_FILE: file, ...(marker ? { DENEXT_TOOLCHAIN_ACTIVE: marker } : {}) })[
        k
      ];
    assertEquals(activeToolchainPin(env()).version, PINNED);
    assertEquals(activeToolchainPin(env(PINNED)).version, PINNED);
    const rb = activeToolchainPin(env(ROLLBACK));
    assertEquals([rb.version, rb.repository, rb.rollback], [ROLLBACK, "https://x", undefined]);
    assertEquals(rollbackToolchainPin({ schema: 1, version: "1", targets: {} }), null);
    assertEquals(toolchainTargetTriple("darwin-aarch64"), "aarch64-apple-darwin");
    assertEquals(toolchainTargetTriple("linux-riscv64"), undefined);
  } finally {
    await w.close();
  }
});

Deno.test("shippingToolchainPin: a marker naming the rollback ships it only while the list still picks it", async () => {
  const w = await world();
  try {
    const shipping = (vars: Record<string, string>) =>
      shippingToolchainPin(w.env(vars), {
        pin: w.pin,
        target: TARGET,
        cacheRoot: w.cacheRoot,
        revocations: { mode: "cache-only" },
      });
    // No marker, or the pin's own version: the pin.
    assertEquals((await shipping({})).version, PINNED);
    assertEquals((await shipping({ DENEXT_TOOLCHAIN_ACTIVE: PINNED })).version, PINNED);
    // The marker names the rollback but nothing revokes the pin: refused, not shipped.
    await w.list([]);
    const err = await assertRejects(() => shipping({ DENEXT_TOOLCHAIN_ACTIVE: ROLLBACK }));
    assertStringIncludes((err as Error).message, `refusing to ship ${ROLLBACK}`);
    assertStringIncludes((err as Error).message, "Unset DENEXT_TOOLCHAIN_ACTIVE");
    // The list revokes the pin: the rollback the parent chose is the one shipped.
    await w.list([revoke()]);
    const rb = await shipping({ DENEXT_TOOLCHAIN_ACTIVE: ROLLBACK });
    assertEquals([rb.version, rb.rollback], [ROLLBACK, undefined]);
    // The defaults: the pin in force (a pin file here, which the list never applies to, so a
    // marker naming its rollback is refused), this host, the toolchain cache.
    const file = join(w.cacheRoot, "pin.json");
    await Deno.writeTextFile(file, JSON.stringify(w.pin));
    const pinned = (vars: Record<string, string>) =>
      shippingToolchainPin(
        w.env({ DENEXT_TOOLCHAIN_PIN_FILE: file, DENO_DIR: w.cacheRoot, ...vars }),
      );
    assertEquals((await pinned({})).version, PINNED);
    await assertRejects(() => pinned({ DENEXT_TOOLCHAIN_ACTIVE: ROLLBACK }), Error, "refusing");
  } finally {
    await w.close();
  }
});

Deno.test("build --compile refuses a revoked denort unless DENEXT_ALLOW_REVOKED_RUNTIME names it", async () => {
  const w = await world();
  try {
    await w.list([revoke()]);
    const shippable = (vars: Record<string, string> = {}) => (version: string, triple: string) =>
      assertRuntimeShippable("cli", version, triple, "compile onto", {
        mode: "cache-only",
        cacheRoot: w.cacheRoot,
        env: w.env(vars),
      });
    const deps = (toolchain: string, vars: Record<string, string> = {}) => ({
      toolchain: () => toolchain,
      pin: () => toolchain === ROLLBACK ? rollbackToolchainPin(w.pin)! : w.pin,
      ensure: () => Promise.resolve({ denort: `/denort-${toolchain}` }),
      shippable: shippable(vars),
    });
    const err = await assertRejects(() => denortBinary(TRIPLE, deps(PINNED)));
    assertStringIncludes(
      (err as Error).message,
      `refusing to compile onto the Deno toolchain ${PINNED}`,
    );
    assertStringIncludes((err as Error).message, `DENEXT_ALLOW_REVOKED_RUNTIME=${PINNED}`);
    assertEquals(
      await denortBinary(TRIPLE, deps(PINNED, { DENEXT_ALLOW_REVOKED_RUNTIME: PINNED })),
      `/denort-${PINNED}`,
    );
    // Another target is not revoked; the rollback's own denort ships.
    assertEquals(await denortBinary("aarch64-apple-darwin", deps(PINNED)), undefined);
    assertEquals(await denortBinary(TRIPLE, deps(ROLLBACK)), `/denort-${ROLLBACK}`);
  } finally {
    await w.close();
  }
});

/** A desktop pin whose rollback is of another Deno (so the version gate names which one ran). */
function desktopPin(): DesktopRuntimePin {
  const base = {
    tag: "t",
    repository: "https://github.com/Brainwires/deno",
    denoSha: "",
    laufeySha: "",
    laufeyApiVersion: null,
    targets: { [TRIPLE]: { runtimeLib: "libdenort.so" } },
  };
  return {
    schema: 1,
    ...base,
    version: PINNED,
    deno: "9.9.9",
    rollback: { ...base, version: ROLLBACK, deno: "8.8.8" },
  };
}

Deno.test("desktop packaging refuses a revoked runtime; run / dev warn; a rolled-back toolchain takes the runtime's rollback", async () => {
  const w = await world();
  const project = await Deno.makeTempDir();
  try {
    await w.list([revoke({ component: "desktop" })]);
    const lines: string[] = [];
    const opts = (vars: Record<string, string>, over = {}) => ({
      projectDir: project,
      target: TRIPLE,
      hostOs: "linux",
      pin: desktopPin(),
      env: w.env(vars),
      revocations: { mode: "cache-only" as const, cacheRoot: w.cacheRoot },
      toolchainPin: { version: PINNED, rollback: { version: ROLLBACK } },
      // Every path ends at the version gate: what it names is the runtime that was chosen.
      denoVersion: () => Promise.resolve("7.7.7"),
      log: (l: string) => void lines.push(l),
      ...over,
    });
    const refused = await assertRejects(() => resolveDesktopRuntimeEnv(opts({})));
    assertStringIncludes(
      (refused as Error).message,
      `refusing to package on the Deno Desktop runtime ${PINNED}`,
    );
    assertStringIncludes((refused as Error).message, `fallback ${ROLLBACK} instead`);
    // Allowed explicitly: on to the version gate of the PINNED runtime.
    const allowed = await assertRejects(() =>
      resolveDesktopRuntimeEnv(opts({ DENEXT_ALLOW_REVOKED_RUNTIME: PINNED }))
    );
    assertStringIncludes((allowed as Error).message, `runtime ${PINNED} is built for Deno 9.9.9`);
    // `desktop run` / `dev` ship nothing: one warning, then the pinned runtime.
    await assertRejects(() => resolveDesktopRuntimeEnv(opts({}, { ship: false })));
    assertStringIncludes(lines.join("\n"), `Deno Desktop runtime ${PINNED} is revoked`);
    lines.length = 0;
    await assertRejects(() =>
      resolveDesktopRuntimeEnv(opts({ [REVOCATION_NOTICED_ENV]: "1" }, { ship: false }))
    );
    assertEquals(lines, [], "said once per process tree");
    // On the toolchain's rollback (the gate rolled both back): the runtime's rollback, no refusal.
    const rolled = await assertRejects(() =>
      resolveDesktopRuntimeEnv(opts({ DENEXT_TOOLCHAIN_ACTIVE: ROLLBACK }))
    );
    assertStringIncludes((rolled as Error).message, `runtime ${ROLLBACK} is built for Deno 8.8.8`);
    // Only the toolchain revoked: both still move back together.
    await w.list([revoke()]);
    const cliOnly = await assertRejects(() =>
      resolveDesktopRuntimeEnv(opts({ DENEXT_TOOLCHAIN_ACTIVE: ROLLBACK }))
    );
    assertStringIncludes((cliOnly as Error).message, `runtime ${ROLLBACK} is built for Deno 8.8.8`);
    // A marker the list doesn't back (nothing revoked; or a toolchain pin of another rollback):
    // packaging is not moved to the older runtime — on to the PINNED one's gate.
    await w.list([]);
    for (
      const over of [{}, { toolchainPin: { version: PINNED, rollback: { version: "0.0.1" } } }]
    ) {
      const leaked = await assertRejects(() =>
        resolveDesktopRuntimeEnv(opts({ DENEXT_TOOLCHAIN_ACTIVE: ROLLBACK }, over))
      );
      assertStringIncludes((leaked as Error).message, `runtime ${PINNED} is built for Deno 9.9.9`);
    }
    assertEquals(rollbackDesktopPin({ ...desktopPin(), rollback: undefined }), null);
  } finally {
    await w.close();
    await Deno.remove(project, { recursive: true });
  }
});

Deno.test("the gate says a revocation once and marks the process tree", async () => {
  const vars: Record<string, string> = {};
  const warned: string[] = [];
  const choice: DenoToolchainChoice = {
    kind: "toolchain",
    deno: "/cache/deno",
    version: ROLLBACK,
    warning: "denext: revoked",
    revocation: {
      configured: true,
      pinned: PINNED,
      revoked: true,
      reason: "x",
      advisory: null,
      fixedIn: null,
      runningRollback: true,
      running: ROLLBACK,
      listSequence: 1,
      listExpiresAt: "2099-01-01T00:00:00Z",
      expiredAt: null,
    },
  };
  const deps: ReexecToolchainDeps = {
    env: (k) => vars[k],
    setEnv: (k, v) => void (vars[k] = v),
    denoVersion: "2.9.6",
    pinnedVersion: PINNED,
    standalone: () => false,
    resolve: () => Promise.resolve(choice),
    spawn: () => Promise.resolve(0),
    exit: () => {},
    warn: (m) => void warned.push(m),
  };
  assert(await maybeReexecToolchain(true, deps));
  assertEquals(warned, ["denext: revoked"]);
  assertEquals(vars[REVOCATION_NOTICED_ENV], "1");
});

Deno.test("doctor: the revocation check is absent with no key, and reports a revoked pin", async () => {
  assertEquals(
    await runtimeRevocationsCheck(() =>
      Promise.resolve({ pin: { schema: 1, version: "1", targets: {} } })
    ),
    null,
  );
  assertEquals(await runtimeRevocationsCheck(() => Promise.reject(new Error("no cache"))), null);
  const w = await world();
  try {
    await w.list([revoke()]);
    const check = await runtimeRevocationsCheck(() =>
      selectToolchainPin(
        w.pin,
        w.env(),
        { revocations: { mode: "cache-only" } },
        TARGET,
        w.cacheRoot,
      )
    );
    assertEquals([check?.name, check?.ok, check?.critical], ["runtime revocations", false, false]);
    assertStringIncludes(check!.detail, `toolchain ${PINNED} REVOKED (crashes on start)`);
    assertStringIncludes(check!.detail, `running ${ROLLBACK} instead`);
  } finally {
    await w.close();
  }
});

/** A pin file pair of `version` (runtime + toolchain) with an optional rollback. */
function pins(
  version: string,
  rollback?: string,
): { runtime: PinFile; toolchain: ToolchainPinFile } {
  const runtime: PinFile = {
    schema: 1,
    version,
    tag: `denext-runtime-v${version}`,
    repository: "https://github.com/Brainwires/deno",
    deno: "9.9.9",
    denoSha: "",
    laufeySha: "",
    laufeyApiVersion: null,
    targets: {},
  };
  const toolchain: ToolchainPinFile = {
    schema: 1,
    version,
    tag: runtime.tag,
    repository: runtime.repository,
    deno: "9.9.9",
    targets: {},
  };
  if (!rollback) return { runtime, toolchain };
  const prev = pins(rollback);
  return {
    runtime: { ...runtime, rollback: runtimeRollbackOf(prev.runtime) },
    toolchain: { ...toolchain, rollback: toolchainRollbackOf(prev.toolchain) },
  };
}

Deno.test("rollbackFor: the replaced pin, unless it is the same release or itself revoked", async () => {
  const notRevoked = () => Promise.resolve(false);
  const revoked = (v: string) => Promise.resolve(v === "2.0.0");
  const old = pins("2.0.0", "1.0.0").toolchain;
  assertEquals(await rollbackFor(null, "3.0.0", notRevoked, toolchainRollbackOf), undefined);
  const next = await rollbackFor(old, "3.0.0", notRevoked, toolchainRollbackOf);
  assertEquals(next?.version, "2.0.0");
  assertEquals((next as Record<string, unknown>).rollback, undefined, "never nested");
  assertEquals((next as Record<string, unknown>).repository, undefined);
  assertEquals((await rollbackFor(old, "3.0.0", revoked, toolchainRollbackOf))?.version, "1.0.0");
  assertEquals(
    (await rollbackFor(old, "2.0.0", notRevoked, toolchainRollbackOf))?.version,
    "1.0.0",
  );
  const rt = runtimeRollbackOf(pins("2.0.0", "1.0.0").runtime);
  assertEquals([rt.version, (rt as Record<string, unknown>).rollback, rt.repository], [
    "2.0.0",
    undefined,
    "https://github.com/Brainwires/deno",
  ]);
});

/**
 * A release of `version` (`2.9.7-denext.N`) as the pin generator reads it: `manifest.json` and
 * `SHA256SUMS` written under `dir` (one target, one backend, one CLI archive).
 */
async function releaseFiles(
  dir: string,
  version: string,
): Promise<{ tag: string; args: string[] }> {
  const tag = `denext-runtime-v${version}`;
  const base = `https://github.com/Brainwires/deno/releases/download/${tag}`;
  const rt = `deno-desktop-runtime-${version}-x86_64-apple-darwin-webview.tar.gz`;
  const cli = `deno-cli-${version}-aarch64-apple-darwin.zip`;
  const sha = (n: number) => n.toString(16).padStart(64, "0");
  const manifest = {
    schema: 1,
    name: "deno-desktop-runtime",
    version,
    tag,
    deno: { version: "2.9.7", sha: "abc" },
    laufey: { sha: "def", apiVersion: 3 },
    targets: {
      "x86_64-apple-darwin": {
        runtimeLib: "libdenort.dylib",
        webview: { file: rt, url: `${base}/${rt}`, sha256: sha(1), size: 1001, format: "tar.gz" },
      },
    },
    cli: {
      version,
      targets: {
        "aarch64-apple-darwin": {
          binary: "deno",
          file: cli,
          url: `${base}/${cli}`,
          sha256: sha(2),
          size: 5002,
          format: "zip",
        },
      },
    },
  };
  const manifestFile = join(dir, `${version}.manifest.json`);
  const sumsFile = join(dir, `${version}.SHA256SUMS`);
  await Deno.writeTextFile(manifestFile, JSON.stringify(manifest));
  await Deno.writeTextFile(sumsFile, `${sha(1)}  ${rt}\n${sha(2)}  ${cli}\n`);
  return { tag, args: [manifestFile, sumsFile] };
}

Deno.test("desktop:pin-runtime writes the replaced pins as the new pins' rollback", async () => {
  const dir = await Deno.makeTempDir();
  const log = console.log;
  console.log = () => {};
  try {
    const out = join(dir, "runtime.json");
    const toolchainOut = join(dir, "toolchain.json");
    const write = async (p: { runtime: PinFile; toolchain: ToolchainPinFile }) => {
      await Deno.writeTextFile(out, JSON.stringify(p.runtime));
      await Deno.writeTextFile(toolchainOut, JSON.stringify(p.toolchain));
    };
    const fresh = await releaseFiles(dir, "2.9.7-denext.5");
    const attested: string[] = [];
    const run = async (revokedVersions: string[], extra: string[] = []) => {
      await pinMain(
        [fresh.tag, "--manifest", fresh.args[0], "--sums", fresh.args[1], ...extra],
        out,
        (pin) => (attested.push(pin.version), Promise.resolve()),
        toolchainOut,
        { revoked: (v) => Promise.resolve(revokedVersions.includes(v)) },
      );
      return {
        runtime: JSON.parse(await Deno.readTextFile(out)) as PinFile,
        toolchain: JSON.parse(await Deno.readTextFile(toolchainOut)) as ToolchainPinFile,
      };
    };
    await write(pins("2.9.7-denext.4", "2.9.7-denext.3"));
    const next = await run([]);
    assertEquals(next.runtime.version, "2.9.7-denext.5");
    assertEquals(
      [next.runtime.rollback?.version, next.toolchain.rollback?.version],
      ["2.9.7-denext.4", "2.9.7-denext.4"],
    );
    // The replaced release is revoked: its own fallback stays the fallback.
    await write(pins("2.9.7-denext.4", "2.9.7-denext.3"));
    const kept = await run(["2.9.7-denext.4"]);
    assertEquals(
      [kept.runtime.rollback?.version, kept.toolchain.rollback?.version],
      ["2.9.7-denext.3", "2.9.7-denext.3"],
    );
    // --rollback <tag>: that release, cross-checked and attested like the pinned one.
    const forced = await releaseFiles(dir, "2.9.7-denext.2");
    attested.length = 0;
    const named = await run([], [
      "--rollback",
      forced.tag,
      "--rollback-manifest",
      forced.args[0],
      "--rollback-sums",
      forced.args[1],
    ]);
    assertEquals(
      [named.runtime.rollback?.version, named.toolchain.rollback?.version],
      ["2.9.7-denext.2", "2.9.7-denext.2"],
    );
    assertEquals(attested, ["2.9.7-denext.5", "2.9.7-denext.2"]);
    await assertRejects(() => run([], ["--rollback", fresh.tag]));
  } finally {
    console.log = log;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the checked-in pins name one earlier release as their rollback, unnested", async () => {
  const { DENO_TOOLCHAIN: tc } = await import("../src/build/deno-toolchain.ts");
  const { DESKTOP_RUNTIME_PIN: rt } = await import("../src/build/desktop-runtime.ts");
  // Every pin from the first revocation-aware release (3.0.0-denext.3) on names a fallback: a pin
  // without one could only warn and keep running a revoked runtime.
  assert(tc.rollback && rt.rollback, "the pins name no rollback");
  // Both from the same release (libdenort must match the `deno desktop` CLI).
  assertEquals(tc.rollback?.version, rt.rollback?.version);
  assert(tc.rollback!.version !== tc.version);
  assertEquals((tc.rollback as unknown as Record<string, unknown>).rollback, undefined);
  assertEquals((rt.rollback as unknown as Record<string, unknown>).rollback, undefined);
  // Every target the pin runs on has a rollback build, each a https release asset of its tag.
  for (const key of Object.keys(tc.targets)) {
    const a = tc.rollback!.targets[key];
    assert(a, `${key}: no rollback build`);
    assert(/^[0-9a-f]{64}$/.test(a.sha256), `${key}: sha256`);
    assertStringIncludes(a.url, `/releases/download/${tc.rollback!.tag}/`);
  }
  for (const triple of Object.keys(rt.targets)) assert(rt.rollback!.targets[triple], triple);
  assertEquals(rollbackToolchainPin(tc)?.repository, tc.repository);
});
