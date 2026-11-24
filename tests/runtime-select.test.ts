// src/build/runtime-select.ts: the one resolver that picks the denext runtime release — the pin
// file, `DENEXT_RUNTIME`, the project pin (a lock in deno.json), the user default and the bundled
// pins, in that order — the release document checks behind each (the lock's hash, the channel's
// document checks), both compatibility directions (the floor, esbuild, laufey, minDenext /
// maxDenext), the held / floor rule of the user default, a lock with an expired channel, the
// revocation fallback, the child marker, and the "newer runtime available" notice. Every channel,
// document and revocation list is a fixture; nothing reaches the network.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  activeDesktopRuntimePin,
  activeDesktopRuntimePinOrBundled,
  activeRuntimeRelease,
  BUNDLED_RUNTIME,
  bundledRuntimeReleases,
  factsOfEntry,
  factsOfPins,
  fetchLockedReleaseDocument,
  lockOfPins,
  newestAvailableRelease,
  readCachedReleaseDocument,
  readProjectRuntimePin,
  readUserRuntimeDefault,
  releaseDocumentOf,
  releaseIntegrity,
  rememberRuntimeRelease,
  type ResolveRuntimeAsyncOptions,
  resolveRuntimeRelease,
  resolveRuntimeReleaseSync,
  runtimeIncompatibility,
  type RuntimeLock,
  type RuntimePins,
  RuntimeSelectError,
  runtimeUpdateNotice,
  USER_DEFAULT_FILE,
  verifyLockedDocument,
  writeUserRuntimeDefault,
} from "../src/build/runtime-select.ts";
import {
  CHANNEL_BASES,
  type LoadedChannel,
  releaseDocumentText,
  type RuntimeChannel,
  type RuntimeChannelRelease,
  type RuntimeReleaseDocument,
} from "../src/build/runtime-channel.ts";
import { MIN_RUNTIME } from "../src/build/deno-version.ts";
import { rollbackToolchainPin } from "../src/build/deno-toolchain.ts";
import { sha256Hex } from "../src/build/signed-envelope.ts";
import { toBase64 } from "../src/build/ota-signing.ts";
import { freshRevocationList, signRevocationList } from "../src/build/runtime-revocations.ts";

const BUNDLED = BUNDLED_RUNTIME.toolchain.version!;
const ROLLBACK = BUNDLED_RUNTIME.toolchain.rollback!.version;
const NEWER = "3.0.0-denext.31";
const NEWEST = "3.0.0-denext.33";
const OLD = "3.0.0-denext.20";

/** An env reader over `vars` (nothing else is set). */
const envOf = (vars: Record<string, string> = {}) => (k: string) => vars[k];

/** The bundled release document with every mention of its version replaced by `version`. */
function docFor(
  version: string,
  edit?: (doc: RuntimeReleaseDocument) => void,
): RuntimeReleaseDocument {
  const text = JSON.stringify(releaseDocumentOf(BUNDLED_RUNTIME)).replaceAll(BUNDLED, version);
  const doc = JSON.parse(text) as RuntimeReleaseDocument;
  edit?.(doc);
  return doc;
}

/** A document's served text and the lock that names it. */
async function locked(doc: RuntimeReleaseDocument): Promise<{ text: string; lock: RuntimeLock }> {
  const text = releaseDocumentText(doc);
  return {
    text,
    lock: { version: doc.toolchain.version!, integrity: releaseIntegrity(await sha256Hex(text)) },
  };
}

/** Cache `doc` under `root` the way the channel loader does; its lock. */
async function cache(root: string, doc: RuntimeReleaseDocument): Promise<RuntimeLock> {
  const { text, lock } = await locked(doc);
  await Deno.mkdir(join(root, "releases"), { recursive: true });
  await Deno.writeTextFile(join(root, "releases", `${lock.version}.json`), text);
  return lock;
}

/** A channel entry for `doc` (its real hash and size). */
async function entryFor(
  doc: RuntimeReleaseDocument,
  over: Partial<RuntimeChannelRelease> = {},
): Promise<RuntimeChannelRelease> {
  const text = releaseDocumentText(doc);
  const version = doc.toolchain.version!;
  return {
    version,
    tag: `denext-runtime-v${version}`,
    deno: doc.toolchain.deno!,
    releasedAt: "2026-11-01T00:00:00Z",
    minDenext: "4.19.0",
    esbuild: "0.25.5",
    laufeyApi: doc.desktop.laufeyApiVersion,
    minGlibc: "2.27",
    doc: { sha256: await sha256Hex(text), size: new TextEncoder().encode(text).byteLength },
    ...over,
  };
}

function channelOf(releases: RuntimeChannelRelease[]): RuntimeChannel {
  return {
    schema: 1,
    issuedAt: "2026-11-15T00:00:00Z",
    expiresAt: "2026-12-30T00:00:00Z",
    sequence: 1,
    releases,
  };
}

const loaded = (channel: RuntimeChannel | null, expired = false): LoadedChannel => ({
  channel: expired ? null : channel,
  source: channel ? "cache" : "none",
  absent: channel && !expired ? null : expired ? "expired" : "unavailable",
  expired: expired ? channel : null,
});

/** A temp dir for the cache and one for the project, removed after `fn`. */
async function withDirs(fn: (cacheRoot: string, project: string) => Promise<void>): Promise<void> {
  const cacheRoot = await Deno.makeTempDir({ prefix: "denext-rt-cache-" });
  const project = await Deno.makeTempDir({ prefix: "denext-rt-project-" });
  try {
    await fn(cacheRoot, project);
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
    await Deno.remove(project, { recursive: true });
  }
}

/** Write a project pin into `dir`'s deno.json. */
async function pinProject(dir: string, lock: unknown, extra: Record<string, unknown> = {}) {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ ...extra, denext: { runtime: lock } }, null, 2),
  );
}

// ---------------------------------------------------------------------------------------------
// Release documents and locks.

Deno.test("lockOfPins: the bundled rollback's lock is the integrity its channel entry records", async () => {
  // The rollback's pins are rebuilt from the bundled pins' `rollback` blocks; their lock must be
  // the hash of the published release document, or a project pinned to it with `runtime use
  // --project` fails on every other denext.
  const channel = JSON.parse(
    await Deno.readTextFile(new URL("../security/runtime-channel.json", import.meta.url)),
  ) as { releases: { version: string; doc: { sha256: string; size: number } }[] };
  const [, rollback] = bundledRuntimeReleases(BUNDLED_RUNTIME);
  assert(rollback, "the bundled pins carry a rollback release");
  const entry = channel.releases.find((r) => r.version === rollback.toolchain.version);
  assert(entry, `security/runtime-channel.json records ${rollback.toolchain.version}`);
  assertEquals(lockOfPins(rollback)!.integrity, `sha256-${entry.doc.sha256}`);
  const text = releaseDocumentText(releaseDocumentOf(rollback));
  assertEquals(new TextEncoder().encode(text).byteLength, entry.doc.size);
  // The bundled release itself, likewise.
  const own = channel.releases.find((r) => r.version === BUNDLED);
  if (own) assertEquals(lockOfPins(BUNDLED_RUNTIME)!.integrity, `sha256-${own.doc.sha256}`);
});

Deno.test("lockOfPins: the bundled pins without their rollback are a document of their release", async () => {
  const lock = lockOfPins(BUNDLED_RUNTIME)!;
  assertEquals(lock.version, BUNDLED);
  const text = releaseDocumentText(releaseDocumentOf(BUNDLED_RUNTIME));
  assertEquals(lock.integrity, `sha256-${await sha256Hex(text)}`);
  assertEquals(verifyLockedDocument(text, lock).toolchain.version, BUNDLED);
  assert(!("rollback" in releaseDocumentOf(BUNDLED_RUNTIME).toolchain));
  // Asked again: the same answer (cached per pin pair).
  assertEquals(lockOfPins(BUNDLED_RUNTIME), lock);
  const unversioned = {
    ...BUNDLED_RUNTIME,
    toolchain: { ...BUNDLED_RUNTIME.toolchain, version: null },
  };
  assertEquals(lockOfPins(unversioned), null);
});

Deno.test("verifyLockedDocument: the hash first, then the channel's document checks", async () => {
  const { text, lock } = await locked(docFor(NEWER));
  assertEquals(verifyLockedDocument(text, lock).desktop.version, NEWER);
  const refused = (t: string, l: RuntimeLock) =>
    assertThrows(() => verifyLockedDocument(t, l), RuntimeSelectError).message;
  assertStringIncludes(refused(text + " ", lock), "hashes to");
  assertStringIncludes(refused(text, { ...lock, integrity: "sha256-xyz" }), "bad integrity");
  assertStringIncludes(refused(" ".repeat(1024 * 1024 + 1), lock), "too large");
  // A document of another release than the lock names.
  assertStringIncludes(refused(text, { ...lock, version: NEWEST }), "refused");
  // A download URL off the allow-list, however well it hashes.
  const evil = await locked(docFor(NEWER, (d) => {
    const first = Object.values(d.toolchain.targets)[0] as { url: string };
    first.url = "https://evil.example/deno.zip";
  }));
  assertStringIncludes(refused(evil.text, evil.lock), "not an allowed download URL");
  assertStringIncludes(
    refused("not json", { ...lock, integrity: releaseIntegrity(await sha256Hex("not json")) }),
    "refused",
  );
});

Deno.test("readCachedReleaseDocument: verified on read; a missing or edited copy is not cached", async () => {
  await withDirs(async (root) => {
    const lock = await cache(root, docFor(NEWER));
    assertEquals(readCachedReleaseDocument(root, lock)?.toolchain.version, NEWER);
    assertEquals(readCachedReleaseDocument(root, { ...lock, version: NEWEST }), null);
    const path = join(root, "releases", `${NEWER}.json`);
    await Deno.writeTextFile(path, (await Deno.readTextFile(path)).replace("2.27", "2.17"));
    assertEquals(readCachedReleaseDocument(root, lock), null);
  });
});

Deno.test("fetchLockedReleaseDocument: the first base whose copy hashes to the lock, cached", async () => {
  await withDirs(async (root) => {
    const { text, lock } = await locked(docFor(NEWER));
    const urls: string[] = [];
    const fake = ((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      // denext.dev serves a tampered copy; the mirror the real one.
      const body = url.startsWith(CHANNEL_BASES[0]) ? text.replace("2.27", "2.17") : text;
      return Promise.resolve(new Response(body));
    }) as typeof fetch;
    const doc = await fetchLockedReleaseDocument(lock, { cacheRoot: root, fetch: fake });
    assertEquals(doc.toolchain.version, NEWER);
    assertEquals(urls.length, 2);
    assertEquals(readCachedReleaseDocument(root, lock)?.toolchain.version, NEWER);
    const offline = (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
    const err = await assertRejects(
      () =>
        fetchLockedReleaseDocument({ ...lock, version: NEWEST }, {
          cacheRoot: root,
          fetch: offline,
        }),
      RuntimeSelectError,
    );
    assertStringIncludes(err.message, "no copy");
  });
});

// ---------------------------------------------------------------------------------------------
// Compatibility.

Deno.test("runtimeIncompatibility: the floor, esbuild, laufey and the denext range", async () => {
  const facts = factsOfPins(BUNDLED_RUNTIME);
  assertEquals(runtimeIncompatibility(facts), null);
  const kind = (f: Parameters<typeof runtimeIncompatibility>[0], t = {}) =>
    runtimeIncompatibility(f, t)?.kind ?? null;
  assertEquals(kind({ ...facts, version: OLD }), "below-floor");
  assertStringIncludes(runtimeIncompatibility({ ...facts, version: OLD })!.message, MIN_RUNTIME);
  assertEquals(kind({ ...facts, version: OLD }, { minRuntime: "3.0.0-denext.1" }), null);
  assertEquals(kind({ ...facts, esbuild: "0.26.0" }), "esbuild");
  assertEquals(kind({ ...facts, esbuild: null }), "esbuild");
  assertEquals(kind({ ...facts, laufeyApi: 40 }), "laufey");
  assertEquals(kind({ ...facts, laufeyApi: null }), "laufey");
  assertEquals(kind({ ...facts, minDenext: "4.22.0" }, { denext: "4.20.1" }), "needs-denext");
  assertStringIncludes(
    runtimeIncompatibility({ ...facts, minDenext: "4.22.0" }, { denext: "4.20.1" })!.message,
    'needs denext 4.22.0 or newer: run "denext upgrade"',
  );
  assertEquals(kind({ ...facts, maxDenext: "4.19.9" }, { denext: "4.20.1" }), "drops-denext");
  assertEquals(
    kind({ ...facts, minDenext: "4.19.0", maxDenext: "4.21.0" }, { denext: "4.20.1" }),
    null,
  );
  // Facts from an entry carry the range; mixed esbuilds in a document read as none.
  const entry = await entryFor(docFor(NEWER), { maxDenext: "5.0.0" });
  assertEquals(factsOfEntry(entry).maxDenext, "5.0.0");
  const mixed = docFor(NEWER, (d) => {
    const [a] = Object.values(d.toolchain.targets) as { esbuild?: { version: string } }[];
    a.esbuild = { ...a.esbuild!, version: "0.1.0" };
  });
  assertEquals(factsOfPins(mixed).esbuild, null);
});

// ---------------------------------------------------------------------------------------------
// The project pin and the user default.

Deno.test("readProjectRuntimePin: the workspace root's deno.json(c), as text; malformed is an error", async () => {
  await withDirs(async (_root, project) => {
    assertEquals(readProjectRuntimePin(project), null);
    const { lock } = await locked(docFor(NEWER));
    // A JSONC root with comments, and a member that reads the root's pin.
    await Deno.writeTextFile(
      join(project, "deno.jsonc"),
      `{\n  // the runtime every machine runs\n  "workspace": ["./apps/web"],\n  "denext": { "runtime": ${
        JSON.stringify(lock)
      } }\n}\n`,
    );
    await Deno.mkdir(join(project, "apps", "web"), { recursive: true });
    await Deno.writeTextFile(join(project, "apps", "web", "deno.json"), "{}");
    const pin = readProjectRuntimePin(join(project, "apps", "web"));
    assertEquals(pin?.lock, lock);
    assertEquals(pin?.configPath, join(project, "deno.jsonc"));
    // A config without a runtime pin.
    await Deno.writeTextFile(join(project, "deno.jsonc"), `{ "denext": {} }`);
    assertEquals(readProjectRuntimePin(project), null);
    await Deno.remove(join(project, "deno.jsonc"));
    for (const bad of [{ version: "2.9.8", integrity: lock.integrity }, { version: NEWER }, "x"]) {
      await pinProject(project, bad);
      const err = assertThrows(() => readProjectRuntimePin(project), RuntimeSelectError);
      assertStringIncludes(err.message, "denext runtime use <version> --project");
    }
    await Deno.writeTextFile(join(project, "deno.json"), "{ not json");
    assertEquals(readProjectRuntimePin(project), null);
  });
});

Deno.test("the user default: written atomically, read back, malformed ignored", async () => {
  await withDirs(async (root) => {
    assertEquals(readUserRuntimeDefault(root), null);
    const { lock } = await locked(docFor(NEWER));
    await writeUserRuntimeDefault(root, { ...lock, held: true });
    assertEquals(readUserRuntimeDefault(root), { ...lock, held: true });
    assertEquals(JSON.parse(await Deno.readTextFile(join(root, USER_DEFAULT_FILE))).schema, 1);
    await assertRejects(
      () => writeUserRuntimeDefault(root, { version: "x", integrity: lock.integrity, held: false }),
      RuntimeSelectError,
    );
    for (const text of ["{}", `{"schema":2}`, `{"schema":1,"version":"${NEWER}"}`, "nope"]) {
      await Deno.writeTextFile(join(root, USER_DEFAULT_FILE), text);
      assertEquals(readUserRuntimeDefault(root), null, text);
    }
    assertEquals([...Deno.readDirSync(root)].filter((e) => e.name.startsWith(".tmp-")), []);
  });
});

// ---------------------------------------------------------------------------------------------
// The synchronous resolver, rung by rung.

Deno.test("resolve: no pin and no default runs the bundled pins, rollback included", async () => {
  await withDirs((root, project) => {
    const r = resolveRuntimeReleaseSync({ env: envOf(), cacheRoot: root, projectDir: project });
    assertEquals([r.source, r.version, r.integrity, r.notices], ["bundled", BUNDLED, null, []]);
    assertEquals(r.toolchain, BUNDLED_RUNTIME.toolchain);
    assertEquals(r.desktop.rollback?.version, ROLLBACK);
    return Promise.resolve();
  });
});

Deno.test("resolve: the pin file override wins over everything, with the bundled desktop pin", async () => {
  await withDirs(async (root, project) => {
    const file = join(root, "pin.json");
    await Deno.writeTextFile(file, JSON.stringify({ schema: 1, version: "9.9.9", targets: {} }));
    const env = envOf({ DENEXT_TOOLCHAIN_PIN_FILE: file, DENEXT_RUNTIME: NEWER });
    const r = resolveRuntimeReleaseSync({ env, cacheRoot: root, projectDir: project });
    assertEquals([r.source, r.version], ["override", "9.9.9"]);
    assertEquals(r.desktop, BUNDLED_RUNTIME.desktop);
    await Deno.writeTextFile(file, "{}");
    assertThrows(() => resolveRuntimeReleaseSync({ env, cacheRoot: root }), Error, "schema-1");
    await Deno.writeTextFile(file, "nope");
    assertThrows(() => resolveRuntimeReleaseSync({ env, cacheRoot: root }), Error, "readable pin");
  });
});

Deno.test("resolve: DENEXT_RUNTIME — bundled, the rollback, an installed release, or an error with the fix", async () => {
  await withDirs(async (root, project) => {
    const o = (vars: Record<string, string>) => ({
      env: envOf(vars),
      cacheRoot: root,
      projectDir: project,
    });
    for (const v of ["bundled", "BUNDLED", BUNDLED]) {
      const r = resolveRuntimeReleaseSync(o({ DENEXT_RUNTIME: v }));
      assertEquals([r.source, r.version, r.toolchain], ["env", BUNDLED, BUNDLED_RUNTIME.toolchain]);
    }
    const back = resolveRuntimeReleaseSync(o({ DENEXT_RUNTIME: ROLLBACK }));
    assertEquals([back.source, back.version, back.toolchain.rollback], [
      "env",
      ROLLBACK,
      undefined,
    ]);
    assertMatch(back.integrity!, /^sha256-[0-9a-f]{64}$/);
    assertThrows(
      () => resolveRuntimeReleaseSync(o({ DENEXT_RUNTIME: "2.9.8" })),
      RuntimeSelectError,
      "not a denext runtime version",
    );
    const missing = assertThrows(
      () => resolveRuntimeReleaseSync(o({ DENEXT_RUNTIME: NEWER })),
      RuntimeSelectError,
    );
    assertStringIncludes(missing.message, `denext runtime install ${NEWER}`);
    // Installed, and named by the user default's lock (or the async resolver's envLock).
    const lock = await cache(root, docFor(NEWER));
    await writeUserRuntimeDefault(root, { ...lock, held: false });
    const viaDefault = resolveRuntimeReleaseSync(o({ DENEXT_RUNTIME: NEWER }));
    assertEquals([viaDefault.source, viaDefault.version, viaDefault.integrity], [
      "env",
      NEWER,
      lock.integrity,
    ]);
    await Deno.remove(join(root, USER_DEFAULT_FILE));
    const viaLock = resolveRuntimeReleaseSync({ ...o({ DENEXT_RUNTIME: NEWER }), envLock: lock });
    assertEquals(viaLock.version, NEWER);
    // A child handed the release by the marker and its integrity.
    const child = resolveRuntimeReleaseSync(
      o({
        DENEXT_RUNTIME: NEWER,
        DENEXT_TOOLCHAIN_ACTIVE: NEWER,
        DENEXT_RUNTIME_INTEGRITY: lock.integrity,
      }),
    );
    assertEquals(child.version, NEWER);
    // Incompatible: refused with the reason.
    const needs = new Map([[NEWER, await entryFor(docFor(NEWER), { minDenext: "9.0.0" })]]);
    assertThrows(
      () =>
        resolveRuntimeReleaseSync({
          ...o({ DENEXT_RUNTIME: NEWER }),
          envLock: lock,
          entries: needs,
        }),
      RuntimeSelectError,
      "needs denext 9.0.0",
    );
  });
});

Deno.test("resolve: a project pin is a lock — cached, the bundled release, or an error naming the fix", async () => {
  await withDirs(async (root, project) => {
    const o = { env: envOf(), cacheRoot: root, projectDir: project };
    const lock = await cache(root, docFor(NEWER));
    await pinProject(project, lock);
    const r = resolveRuntimeReleaseSync(o);
    assertEquals([r.source, r.version, r.integrity], ["project", NEWER, lock.integrity]);
    assertEquals(r.toolchain.version, NEWER);
    assertEquals(r.desktop.version, NEWER);
    // The project pin beats the user default; DENEXT_RUNTIME beats the project pin.
    const other = await cache(root, docFor(NEWEST));
    await writeUserRuntimeDefault(root, { ...other, held: true });
    assertEquals(resolveRuntimeReleaseSync(o).version, NEWER);
    assertEquals(
      resolveRuntimeReleaseSync({ ...o, env: envOf({ DENEXT_RUNTIME: "bundled" }) }).version,
      BUNDLED,
    );
    // A lock on the bundled release needs no cache, and keeps the rollback.
    await pinProject(project, lockOfPins(BUNDLED_RUNTIME));
    const own = resolveRuntimeReleaseSync(o);
    assertEquals([own.source, own.toolchain], ["project", BUNDLED_RUNTIME.toolchain]);
    // Not installed (nor bundled): an error naming the install.
    await pinProject(project, { version: "3.0.0-denext.40", integrity: lock.integrity });
    const err = assertThrows(() => resolveRuntimeReleaseSync(o), RuntimeSelectError);
    assertStringIncludes(err.message, "denext runtime install");
    // A pinned hash that no longer matches the cached copy is not used.
    await pinProject(project, { ...lock, integrity: releaseIntegrity("b".repeat(64)) });
    assertThrows(() => resolveRuntimeReleaseSync(o), RuntimeSelectError, "not installed");
  });
});

Deno.test("resolve: a newer project pin runs its own release; the bundled rollback stays out of it", async () => {
  await withDirs(async (root, project) => {
    const before = structuredClone(BUNDLED_RUNTIME.toolchain.rollback);
    // Even with a user default set, the project pin is chosen before the default and the bundled pins.
    await writeUserRuntimeDefault(root, { ...await cache(root, docFor(NEWEST)), held: true });
    await pinProject(project, await cache(root, docFor(NEWER)));
    const r = resolveRuntimeReleaseSync({ env: envOf(), cacheRoot: root, projectDir: project });
    assertEquals([r.source, r.version], ["project", NEWER]);
    // A release document carries no rollback, so nothing falls back to the bundled one's.
    assertEquals([r.toolchain.rollback, r.desktop.rollback], [undefined, undefined]);
    assertEquals(rollbackToolchainPin(r.toolchain), null);
    assertEquals(BUNDLED_RUNTIME.toolchain.rollback, before, "the bundled rollback is untouched");
  });
});

Deno.test("resolve: a project pin this denext can't run is an error, in both directions", async () => {
  await withDirs(async (root, project) => {
    const o = { env: envOf(), cacheRoot: root, projectDir: project };
    // Below MIN_RUNTIME: names `runtime use --project`.
    await pinProject(project, await cache(root, docFor(OLD)));
    const floor = assertThrows(() => resolveRuntimeReleaseSync(o), RuntimeSelectError);
    assertStringIncludes(floor.message, MIN_RUNTIME);
    assertStringIncludes(floor.message, "denext runtime use <version> --project");
    // Another esbuild.
    await pinProject(
      project,
      await cache(
        root,
        docFor(NEWER, (d) => {
          for (
            const a of Object.values(d.toolchain.targets) as { esbuild?: { version: string } }[]
          ) {
            a.esbuild = { ...a.esbuild!, version: "0.26.0" };
          }
        }),
      ),
    );
    assertThrows(() => resolveRuntimeReleaseSync(o), RuntimeSelectError, "esbuild 0.26.0");
    // A release that needs a newer denext: names `denext upgrade`, not `runtime use`.
    const doc = docFor(NEWEST);
    await pinProject(project, await cache(root, doc));
    const entries = new Map([[NEWEST, await entryFor(doc, { minDenext: "4.99.0" })]]);
    const newer = assertThrows(
      () => resolveRuntimeReleaseSync({ ...o, entries, compat: { denext: "4.20.1" } }),
      RuntimeSelectError,
    );
    assertStringIncludes(newer.message, '"denext upgrade"');
    assert(!newer.message.includes("runtime use"));
    // Yanked but runnable: one notice naming `runtime upgrade`.
    const yanked = new Map([[NEWEST, await entryFor(doc, { yanked: { reason: "crashes" } })]]);
    const r = resolveRuntimeReleaseSync({ ...o, entries: yanked });
    assertEquals(r.version, NEWEST);
    assertStringIncludes(r.notices[0], "crashes");
    assertStringIncludes(r.notices[0], "denext runtime upgrade");
  });
});

Deno.test("resolve: the user default — at or above the bundled pin, or held; else skipped", async () => {
  await withDirs(async (root, project) => {
    const o = { env: envOf(), cacheRoot: root, projectDir: project };
    const lock = await cache(root, docFor(NEWER));
    await writeUserRuntimeDefault(root, { ...lock, held: false });
    const r = resolveRuntimeReleaseSync(o);
    assertEquals([r.source, r.version, r.notices], ["default", NEWER, []]);
    // Below the bundled pin and not held: the newer denext's bundled pin wins, silently.
    const older = await cache(root, docFor(ROLLBACK));
    await writeUserRuntimeDefault(root, { ...older, held: false });
    const silent = resolveRuntimeReleaseSync(o);
    assertEquals([silent.source, silent.notices], ["bundled", []]);
    // Held below the bundled pin: used (when this denext still runs it).
    await writeUserRuntimeDefault(root, { ...older, held: true });
    const held = resolveRuntimeReleaseSync({ ...o, compat: { minRuntime: ROLLBACK } });
    assertEquals([held.source, held.version], ["default", ROLLBACK]);
    // Held below MIN_RUNTIME: skipped with one notice, never an error.
    const floor = resolveRuntimeReleaseSync({ ...o, compat: { minRuntime: BUNDLED } });
    assertEquals(floor.source, "bundled");
    assertStringIncludes(floor.notices[0], "skipped");
    // Not installed: the bundled pins, with a notice naming the install.
    await writeUserRuntimeDefault(root, { version: NEWEST, integrity: lock.integrity, held: true });
    const gone = resolveRuntimeReleaseSync(o);
    assertEquals(gone.source, "bundled");
    assertStringIncludes(gone.notices[0], "denext runtime install");
  });
});

// ---------------------------------------------------------------------------------------------
// The async resolver.

Deno.test("resolveRuntimeRelease: a lock not cached is fetched by its hash; offline it is the sync error", async () => {
  await withDirs(async (root, project) => {
    const doc = docFor(NEWER);
    const { text, lock } = await locked(doc);
    await pinProject(project, lock);
    const fetched: string[] = [];
    const o: ResolveRuntimeAsyncOptions = {
      env: envOf(),
      cacheRoot: root,
      projectDir: project,
      loadChannel: () => Promise.resolve(loaded(null)),
      fetchLocked: async (l) => {
        fetched.push(l.version);
        await Deno.mkdir(join(root, "releases"), { recursive: true });
        await Deno.writeTextFile(join(root, "releases", `${l.version}.json`), text);
        return verifyLockedDocument(text, l);
      },
    };
    assertEquals((await resolveRuntimeRelease(o)).version, NEWER);
    assertEquals(fetched, [NEWER]);
    // Cached now: no fetch.
    assertEquals((await resolveRuntimeRelease(o)).version, NEWER);
    assertEquals(fetched, [NEWER]);
    await Deno.remove(join(root, "releases"), { recursive: true });
    const offline = { ...o, fetchLocked: () => Promise.reject(new Error("offline")) };
    await assertRejects(() => resolveRuntimeRelease(offline), RuntimeSelectError, "not installed");
  });
});

Deno.test("resolveRuntimeRelease: a lock runs with an expired channel; its entry still decides compatibility", async () => {
  await withDirs(async (root, project) => {
    const doc = docFor(NEWER);
    await pinProject(project, await cache(root, doc));
    const entry = await entryFor(doc);
    const o = { env: envOf(), cacheRoot: root, projectDir: project };
    // Expired (still authentic): the lock runs.
    const expired = { ...o, loadChannel: () => Promise.resolve(loaded(channelOf([entry]), true)) };
    assertEquals((await resolveRuntimeRelease(expired)).source, "project");
    // No channel at all: the lock runs.
    const none = { ...o, loadChannel: () => Promise.reject(new Error("no")) };
    assertEquals((await resolveRuntimeRelease(none)).version, NEWER);
    // The held index says it needs a newer denext.
    const strict = channelOf([{ ...entry, minDenext: "9.0.0" }]);
    await assertRejects(
      () => resolveRuntimeRelease({ ...o, loadChannel: () => Promise.resolve(loaded(strict)) }),
      RuntimeSelectError,
      "needs denext 9.0.0",
    );
  });
});

Deno.test("resolveRuntimeRelease: DENEXT_RUNTIME is found through the channel, fetched once, then cached", async () => {
  await withDirs(async (root, project) => {
    const doc = docFor(NEWER);
    const entry = await entryFor(doc);
    const modes: string[] = [];
    const listed: string[] = [];
    const o: ResolveRuntimeAsyncOptions = {
      env: envOf({ DENEXT_RUNTIME: NEWER }),
      cacheRoot: root,
      projectDir: project,
      // The cached index lacks it; a fetch finds it.
      loadChannel: (mode) => {
        modes.push(mode);
        return Promise.resolve(loaded(mode === "fetch" ? channelOf([entry]) : channelOf([])));
      },
      fetchListed: async (e) => {
        listed.push(e.version);
        await cache(root, doc);
        return doc;
      },
    };
    const r = await resolveRuntimeRelease(o);
    assertEquals([r.source, r.version, r.integrity], [
      "env",
      NEWER,
      releaseIntegrity(entry.doc.sha256),
    ]);
    assertEquals([modes, listed], [["cache-only", "fetch"], [NEWER]]);
    // Not listed anywhere: not installed, with the fix.
    const unknown = { ...o, env: envOf({ DENEXT_RUNTIME: NEWEST }) };
    await assertRejects(
      () => resolveRuntimeRelease(unknown),
      RuntimeSelectError,
      "runtime install",
    );
    // Listed but its document can't be had.
    const broken = { ...o, fetchListed: () => Promise.reject(new Error("offline")) };
    await Deno.remove(join(root, "releases"), { recursive: true });
    await assertRejects(
      () => resolveRuntimeRelease(broken),
      RuntimeSelectError,
      "can't be fetched",
    );
  });
});

/** A signed revocation list revoking `revoked`, and the options that serve it. */
async function revoking(revoked: { component: "cli" | "desktop"; version: string }[]) {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pub = toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", k.publicKey)));
  const list = freshRevocationList(
    revoked.map((r) => ({ ...r, reason: "a test revocation" })),
    new Date(),
  );
  const body = JSON.stringify(await signRevocationList(list, k.privateKey));
  return {
    keys: [pub],
    urls: ["https://revocations.test/list.json"],
    mode: "force" as const,
    fetch: (() => Promise.resolve(new Response(body))) as typeof fetch,
    netGranted: () => Promise.resolve(true),
  };
}

Deno.test("resolveRuntimeRelease: a revoked selection runs the newest installed safe release, else the bundled pins", async () => {
  await withDirs(async (root, project) => {
    const target = "darwin-aarch64";
    const triple = "aarch64-apple-darwin";
    const [mid, top] = [docFor(NEWER), docFor(NEWEST)];
    await cache(root, mid);
    await pinProject(project, await cache(root, top));
    const channel = channelOf([await entryFor(top), await entryFor(mid)]);
    const base: ResolveRuntimeAsyncOptions = {
      env: envOf(),
      cacheRoot: root,
      projectDir: project,
      target,
      triple,
      loadChannel: () => Promise.resolve(loaded(channel)),
    };
    // Not revoked: the pin runs.
    const clean = await resolveRuntimeRelease({ ...base, revocations: await revoking([]) });
    assertEquals([clean.version, clean.notices], [NEWEST, []]);
    const revocations = await revoking([{ component: "cli", version: NEWEST }]);
    // Revoked, nothing else installed: the bundled pins, with the notice.
    const bundled = await resolveRuntimeRelease({ ...base, revocations });
    assertEquals([bundled.version, bundled.source], [BUNDLED, "project"]);
    assertStringIncludes(bundled.notices[0], "denext runtime upgrade");
    assertStringIncludes(bundled.notices[0], `Running ${BUNDLED} instead`);
    // The older release installed (its stamp): it runs instead.
    await Deno.mkdir(join(root, NEWER, target), { recursive: true });
    await Deno.writeTextFile(join(root, NEWER, target, ".denext-toolchain.json"), "{}");
    const alt = await resolveRuntimeRelease({ ...base, revocations });
    assertEquals([alt.version, alt.integrity], [
      NEWER,
      releaseIntegrity(channel.releases[1].doc.sha256),
    ]);
    // Said once per process tree.
    const quiet = await resolveRuntimeRelease({
      ...base,
      env: envOf({ DENEXT_REVOCATION_NOTICED: "1" }),
      revocations,
    });
    assertEquals([quiet.version, quiet.notices], [NEWER, []]);
    // The desktop verbs: a revoked desktop runtime counts too.
    const desktop = await revoking([{ component: "desktop", version: NEWEST }]);
    const both = await resolveRuntimeRelease({
      ...base,
      revocations: { ...desktop, components: ["cli", "desktop"] },
    });
    assertEquals(both.version, NEWER);
    assertEquals(
      (await resolveRuntimeRelease({ ...base, revocations: desktop })).version,
      NEWEST,
      "a cli-only command ignores a desktop revocation",
    );
    // No check asked: the pin runs whatever the list says.
    assertEquals((await resolveRuntimeRelease(base)).version, NEWEST);
  });
});

// ---------------------------------------------------------------------------------------------
// The synchronous readers.

Deno.test("activeRuntimeRelease: a child follows its parent's marker + integrity; the bundled fallback too", async () => {
  await withDirs(async (root, project) => {
    const top = await cache(root, docFor(NEWEST));
    const mid = await cache(root, docFor(NEWER));
    await pinProject(project, top);
    const o = { cacheRoot: root, projectDir: project };
    // No marker: what this process picks.
    assertEquals(activeRuntimeRelease(envOf(), o).version, NEWEST);
    // The parent ran another release (a revocation fallback): the child follows it.
    const child = activeRuntimeRelease(
      envOf({ DENEXT_TOOLCHAIN_ACTIVE: NEWER, DENEXT_RUNTIME_INTEGRITY: mid.integrity }),
      o,
    );
    assertEquals([child.source, child.version], ["inherited", NEWER]);
    // A marker whose integrity does not match the cached copy is not followed.
    const forged = activeRuntimeRelease(
      envOf({ DENEXT_TOOLCHAIN_ACTIVE: NEWER, DENEXT_RUNTIME_INTEGRITY: top.integrity }),
      o,
    );
    assertEquals(forged.version, NEWEST);
    // The parent fell back to the bundled pins (or their rollback).
    for (const marker of [BUNDLED, ROLLBACK]) {
      const r = activeRuntimeRelease(envOf({ DENEXT_TOOLCHAIN_ACTIVE: marker }), o);
      assertEquals([r.source, r.toolchain], ["inherited", BUNDLED_RUNTIME.toolchain]);
    }
    // A broken selection with nothing handed down throws; handed down, the child still runs.
    await pinProject(project, { version: "3.0.0-denext.40", integrity: top.integrity });
    assertThrows(() => activeRuntimeRelease(envOf(), o), RuntimeSelectError);
    const handed = activeRuntimeRelease(
      envOf({ DENEXT_TOOLCHAIN_ACTIVE: NEWER, DENEXT_RUNTIME_INTEGRITY: mid.integrity }),
      o,
    );
    assertEquals(handed.version, NEWER);
    // A marker that is no release (`path`) changes nothing.
    await pinProject(project, top);
    assertEquals(
      activeRuntimeRelease(envOf({ DENEXT_TOOLCHAIN_ACTIVE: "path" }), o).version,
      NEWEST,
    );
  });
});

Deno.test("activeRuntimeRelease: the process's own resolution is remembered; the desktop pin follows it", () => {
  const remembered = {
    source: "project" as const,
    version: NEWER,
    ...(docFor(NEWER) as unknown as RuntimePins),
    integrity: releaseIntegrity("c".repeat(64)),
    notices: [],
  };
  // The process's own environment is what this reads: a pin file in it (the runtime-compat
  // workflow points DENEXT_TOOLCHAIN_PIN_FILE at the candidate's pin) wins over any remembered
  // resolution by design, so it is set aside for the test.
  const pinFile = Deno.env.get("DENEXT_TOOLCHAIN_PIN_FILE");
  Deno.env.delete("DENEXT_TOOLCHAIN_PIN_FILE");
  try {
    rememberRuntimeRelease(remembered);
    assertEquals(activeRuntimeRelease(), remembered);
    assertEquals(activeDesktopRuntimePin().version, NEWER);
    assertEquals(activeDesktopRuntimePinOrBundled().version, NEWER);
  } finally {
    rememberRuntimeRelease(null);
    if (pinFile !== undefined) Deno.env.set("DENEXT_TOOLCHAIN_PIN_FILE", pinFile);
  }
});

Deno.test("activeRuntimeRelease: a pin file in the environment wins over a remembered resolution", () => {
  const remembered = {
    source: "project" as const,
    version: NEWER,
    ...(docFor(NEWER) as unknown as RuntimePins),
    integrity: releaseIntegrity("c".repeat(64)),
    notices: [],
  };
  const file = Deno.makeTempFileSync({ suffix: ".json" });
  try {
    Deno.writeTextFileSync(file, JSON.stringify(docFor(NEWEST).toolchain));
    rememberRuntimeRelease(remembered);
    const release = activeRuntimeRelease(envOf({ DENEXT_TOOLCHAIN_PIN_FILE: file }));
    assertEquals(release.toolchain.version, NEWEST);
  } finally {
    rememberRuntimeRelease(null);
    Deno.removeSync(file);
  }
});

Deno.test("activeDesktopRuntimePinOrBundled: a broken selection reads as the bundled pin", async () => {
  await withDirs(async (root, project) => {
    await pinProject(project, {
      version: "3.0.0-denext.40",
      integrity: releaseIntegrity("d".repeat(64)),
    });
    const env = envOf({ DENO_DIR: root });
    assertThrows(() => activeDesktopRuntimePin(env, project), RuntimeSelectError);
    assertEquals(activeDesktopRuntimePinOrBundled(env, project), BUNDLED_RUNTIME.desktop);
  });
});

// ---------------------------------------------------------------------------------------------
// Floating upgrades and the notice.

Deno.test("newestAvailableRelease: compatible, not yanked, and past the dependency-age hold", async () => {
  const at = (version: string, releasedAt: string, over: Partial<RuntimeChannelRelease> = {}) =>
    entryFor(docFor(version), { releasedAt, ...over });
  const releases = [
    await at("3.0.0-denext.35", "2026-11-19T23:00:00Z"), // too fresh
    await at("3.0.0-denext.34", "2026-11-10T00:00:00Z", { minDenext: "9.0.0" }), // incompatible
    await at(NEWEST, "2026-11-10T00:00:00Z", { yanked: { reason: "broken" } }),
    await at("3.0.0-denext.32", "2026-11-19T12:00:00Z", { security: true }), // too fresh, no exemption
    await at(NEWER, "2026-11-01T00:00:00Z"),
  ];
  const cutoff = new Date("2026-11-19T00:00:00Z");
  const got = newestAvailableRelease(releases, { rule: { cutoff } });
  assertEquals(got.pick?.version, NEWER);
  assertEquals(got.held?.version, "3.0.0-denext.35");
  assertEquals(
    newestAvailableRelease(releases, { rule: { cutoff: null } }).pick?.version,
    "3.0.0-denext.35",
  );
  const none = newestAvailableRelease(releases.slice(0, 1), { rule: { cutoff } });
  assertEquals([none.pick, none.held?.version], [null, "3.0.0-denext.35"]);
});

Deno.test("runtimeUpdateNotice: once a day per release, per process tree, never for an explicit choice", async () => {
  await withDirs(async (root) => {
    const channel = channelOf([await entryFor(docFor(NEWEST)), await entryFor(docFor(NEWER))]);
    let now = Date.parse("2026-11-20T00:00:00Z");
    const selected = activeRuntimeRelease(envOf(), { cacheRoot: root, projectDir: root });
    const o = {
      selected,
      env: envOf(),
      cacheRoot: root,
      now: () => now,
      loadChannel: () => Promise.resolve(loaded(channel)),
      rule: () => Promise.resolve({ cutoff: new Date(now - 86_400_000) }),
    };
    assertEquals(
      await runtimeUpdateNotice(o),
      `denext: runtime ${NEWEST} is available: denext runtime upgrade`,
    );
    // The same release within a day: nothing; a day later: again.
    assertEquals(await runtimeUpdateNotice(o), null);
    now += 25 * 3600_000;
    assertStringIncludes((await runtimeUpdateNotice(o))!, NEWEST);
    now += 25 * 3600_000;
    // A project pin is moved with --project.
    const project = { ...o, selected: { ...selected, source: "project" as const } };
    assertStringIncludes((await runtimeUpdateNotice(project))!, "upgrade --project");
    now += 25 * 3600_000;
    // Already said in this process tree, an explicit choice, nothing newer, no channel, a failure.
    assertEquals(
      await runtimeUpdateNotice({ ...o, env: envOf({ DENEXT_RUNTIME_NOTICED: "1" }) }),
      null,
    );
    assertEquals(
      await runtimeUpdateNotice({ ...o, selected: { ...selected, source: "env" } }),
      null,
    );
    assertEquals(
      await runtimeUpdateNotice({ ...o, selected: { ...selected, version: NEWEST } }),
      null,
    );
    assertEquals(
      await runtimeUpdateNotice({ ...o, loadChannel: () => Promise.resolve(loaded(null)) }),
      null,
    );
    assertEquals(
      await runtimeUpdateNotice({ ...o, loadChannel: () => Promise.reject(new Error("x")) }),
      null,
    );
    // Held back by the dependency-age rule: nothing yet.
    assertEquals(
      await runtimeUpdateNotice({ ...o, rule: () => Promise.resolve({ cutoff: new Date(0) }) }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The places that pick a runtime, on a non-bundled release.

Deno.test("build --compile ships the project pin's release: shippingToolchainPin and its denort", async () => {
  const { shippingToolchainPin } = await import("../src/build/deno-toolchain.ts");
  const { denortBinary } = await import("../src/build/compile-app.ts");
  await withDirs(async (root, project) => {
    await pinProject(project, await cache(root, docFor(NEWER)));
    const env = envOf({ DENO_DIR: join(root, "..") });
    const pin = await shippingToolchainPin(env, {
      projectDir: project,
      cacheRoot: root,
      revocations: { mode: "off" },
    });
    assertEquals([pin.version, pin.tag], [NEWER, `denext-runtime-v${NEWER}`]);
    const ensured: string[] = [];
    const denort = await denortBinary("x86_64-unknown-linux-gnu", {
      toolchain: () => NEWER,
      pin: () => pin,
      shippable: () => Promise.resolve(),
      ensure: ({ pin, target }) => {
        ensured.push(`${pin.version} ${target}`);
        return Promise.resolve({ denort: "/cache/denort" });
      },
    });
    assertEquals([denort, ensured], ["/cache/denort", [`${NEWER} linux-x86_64`]]);
    // Running another toolchain than the pinned release: compile picks its own denort.
    assertEquals(
      await denortBinary(undefined, { toolchain: () => BUNDLED, pin: () => pin }),
      undefined,
    );
  });
});

Deno.test("the desktop verbs build on the project pin's Deno Desktop runtime", async () => {
  const { desktopRuntimeStatus } = await import("../src/build/desktop-runtime.ts");
  await withDirs(async (denoDir, project) => {
    const root = join(denoDir, "denext-deno");
    await pinProject(project, await cache(root, docFor(NEWER)));
    const status = await desktopRuntimeStatus({
      projectDir: project,
      env: envOf({ DENO_DIR: denoDir }),
      target: "aarch64-apple-darwin",
      backend: "webview",
      cacheRoot: join(denoDir, "desktop"),
      denoVersion: () => Promise.resolve({ deno: NEWER, denext: NEWER }),
    });
    assertEquals([status.version, status.deno.required], [NEWER, docFor(NEWER).desktop.deno]);
    // The same project, unpinned: the bundled runtime.
    await Deno.writeTextFile(join(project, "deno.json"), "{}");
    const bundled = await desktopRuntimeStatus({
      projectDir: project,
      env: envOf({ DENO_DIR: denoDir }),
      target: "aarch64-apple-darwin",
      backend: "webview",
      cacheRoot: join(denoDir, "desktop"),
      denoVersion: () => Promise.resolve({ deno: BUNDLED, denext: BUNDLED }),
    });
    assertEquals(bundled.version, BUNDLED_RUNTIME.desktop.version);
  });
});
