// OTA channels and staged rollouts: the stable rollout bucket (src/server/ota-rollout.ts),
// `createOtaHandler({ channels })` choosing a release per request (src/server/ota-handler.ts),
// the channels file edits behind `denext ota channel` / `denext ota promote`
// (src/build/ota-channels.ts) with their refusal rules, and the client sending the channel and
// install id (src/mobile/ota.ts).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  inOtaRollout,
  isOtaChannelsFile,
  type OtaChannelsFile,
  otaChannelsProblem,
  otaRolloutBucket,
} from "../src/server/ota-rollout.ts";
import { createOtaHandler } from "../src/server/ota-handler.ts";
import { writeOtaManifest } from "../src/build/ota-manifest.ts";
import { generateOtaKeyPair, importOtaSigningKey } from "../src/build/ota-signing.ts";
import {
  promoteOtaRelease,
  readOtaChannels,
  setOtaChannel,
  writeOtaChannels,
} from "../src/build/ota-channels.ts";
import { checkForUiUpdate, otaInstallId, prepareUiUpdate } from "../src/mobile/ota.ts";
import { type Any, withGlobals } from "./helpers/mobile-fakes.ts";

const V = "a".repeat(64);

// ---- bucket ---------------------------------------------------------------------------------

Deno.test("otaRolloutBucket: deterministic, a known vector, salted by channel", async () => {
  // SHA-256("denext-ota-rollout\nproduction\n<64 a>\ndevice-0001")[0..4] as uint32 % 10000.
  assertEquals(await otaRolloutBucket("production", V, "device-0001"), 2738);
  assertEquals(await otaRolloutBucket("production", V, "device-0001"), 2738);
  assertEquals(await otaRolloutBucket("beta", V, "device-0001"), 7243);
});

Deno.test("otaRolloutBucket: roughly uniform; raising the percent only adds devices", async () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `install-${String(i).padStart(6, "0")}`);
  const buckets = await Promise.all(ids.map((id) => otaRolloutBucket("production", V, id)));
  assert(buckets.every((b) => Number.isInteger(b) && b >= 0 && b < 10_000));
  const tenths = new Array(10).fill(0);
  for (const b of buckets) tenths[Math.floor(b / 1000)]++;
  for (const n of tenths) assert(n > 140 && n < 260, `decile count ${n}`);
  const inAt = async (percent: number) => {
    const set = new Set<string>();
    for (const id of ids) if (await inOtaRollout("production", V, id, percent)) set.add(id);
    return set;
  };
  const five = await inAt(5), twenty = await inAt(20), hundred = await inAt(100);
  for (const id of five) assert(twenty.has(id));
  assertEquals(hundred.size, ids.length);
  assert(twenty.size > 300 && twenty.size < 500, `20% → ${twenty.size}`);
  // A new candidate draws a new cohort.
  const other = new Set<string>();
  for (const id of ids) if (await inOtaRollout("production", "b".repeat(64), id, 20)) other.add(id);
  assert([...twenty].some((id) => !other.has(id)));
});

Deno.test("inOtaRollout: no, or an invalid, install id is never in a rollout", async () => {
  for (
    const id of [null, undefined, "", "short", "has space in it", "x".repeat(129), "é".repeat(9)]
  ) {
    assertEquals(await inOtaRollout("production", V, id, 100), false, String(id));
  }
  assertEquals(await inOtaRollout("production", V, "device-0001", 0), false);
  assertEquals(await inOtaRollout("production", V, "device-0001", 100), true);
});

Deno.test("otaChannelsProblem: the file's shape is validated", () => {
  const good: OtaChannelsFile = {
    default: "production",
    channels: {
      production: { release: "a", rollout: { release: "b", percent: 12.5 } },
      beta: { release: "b" },
    },
  };
  assert(isOtaChannelsFile(good));
  const bad: unknown[] = [
    null,
    [],
    { default: "x", channels: {} },
    { default: "p", channels: { p: {} } },
    { default: "P", channels: { P: { release: "a" } } },
    { default: "p", channels: { p: { release: "a", rollout: { release: "b", percent: 0 } } } },
    { default: "p", channels: { p: { release: "a", rollout: { release: "b", percent: 101 } } } },
    { default: "p", channels: { p: { release: "" } } },
  ];
  for (const value of bad) assert(otaChannelsProblem(value) !== null, JSON.stringify(value));
});

// ---- fixtures -------------------------------------------------------------------------------

/** Write an export at `root/<name>` with `marker` in its files and a manifest. */
async function release(
  root: string,
  name: string,
  meta: { sequence?: number } = {},
  key?: CryptoKey,
): Promise<string> {
  const dir = join(root, name);
  await Deno.mkdir(join(dir, "_denext", "client"), { recursive: true });
  await Deno.writeTextFile(join(dir, "index.html"), `<html>${name}</html>`);
  await Deno.writeTextFile(join(dir, "_denext", "client", `${name}.js`), `// ${name}`);
  await writeOtaManifest(dir, meta, key);
  return dir;
}

async function manifestVersion(dir: string): Promise<string> {
  return JSON.parse(await Deno.readTextFile(join(dir, "_denext", "ota.json"))).version;
}

async function inTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "denext_ota_channels_" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** An install id inside (or outside) a `percent` rollout of `version` on `channel`. */
async function idFor(channel: string, version: string, percent: number, inside: boolean) {
  for (let i = 0;; i++) {
    const id = `probe-install-${i}`;
    if (await inOtaRollout(channel, version, id, percent) === inside) return id;
  }
}

// ---- handler --------------------------------------------------------------------------------

Deno.test("createOtaHandler: exactly one of dir and channels", () => {
  assertThrows(() => createOtaHandler({}), TypeError);
  assertThrows(() => createOtaHandler({ dir: "out", channels: "c.json" }), TypeError);
});

Deno.test("createOtaHandler channels: stable vs candidate by install id, same release per request", async () => {
  await inTemp(async (root) => {
    const stable = await release(root, "stable");
    const candidate = await release(root, "candidate");
    const beta = await release(root, "beta");
    const file = join(root, "ota-channels.json");
    await writeOtaChannels(file, {
      default: "production",
      channels: {
        production: { release: "stable", rollout: { release: "candidate", percent: 30 } },
        beta: { release: "beta" },
      },
    });
    const ota = createOtaHandler({ channels: file, basePath: "/ui" });
    const get = (path: string, headers: Record<string, string> = {}) =>
      ota(new Request(`http://host/ui/${path}`, { headers }));
    const candidateVersion = await manifestVersion(candidate);
    const inside = await idFor("production", candidateVersion, 30, true);
    const outside = await idFor("production", candidateVersion, 30, false);

    const versionFor = async (headers: Record<string, string>) =>
      (await (await get("_denext/ota.json", headers))!.json()).version;
    assertEquals(await versionFor({ "x-denext-ota-install-id": inside }), candidateVersion);
    assertEquals(
      await versionFor({ "x-denext-ota-install-id": outside }),
      await manifestVersion(stable),
    );
    // No id, or an invalid one: the stable release.
    assertEquals(await versionFor({}), await manifestVersion(stable));
    assertEquals(
      await versionFor({ "x-denext-ota-install-id": "bad id!" }),
      await manifestVersion(stable),
    );
    // Explicit channel.
    assertEquals(
      await versionFor({ "x-denext-ota-channel": "beta", "x-denext-ota-install-id": inside }),
      await manifestVersion(beta),
    );
    // Files come from the chosen release only.
    const insideHeaders = { "x-denext-ota-install-id": inside };
    assertEquals(await (await get("index.html", insideHeaders))!.text(), "<html>candidate</html>");
    assertEquals(await get("_denext/client/stable.js", insideHeaders), null);
    assertEquals(await (await get("_denext/client/stable.js"))!.text(), "// stable");
    assertEquals(await get("_denext/client/candidate.js"), null);
    // Unknown or malformed channel: not served, never a fallback.
    assertEquals(await get("_denext/ota.json", { "x-denext-ota-channel": "nightly" }), null);
    assertEquals(await get("_denext/ota.json", { "x-denext-ota-channel": "Bad Name" }), null);
    // Vary names both headers (and no-store stays).
    const res = await get("index.html");
    assertEquals(res?.headers.get("vary"), "x-denext-ota-channel, x-denext-ota-install-id");
    assertEquals(res?.headers.get("cache-control"), "no-store");

    // Re-read on change: halting the rollout sends everyone to stable.
    await new Promise((r) => setTimeout(r, 20));
    await promoteOtaRelease({ file, to: "production", halt: true });
    const touched = new Date(Date.now() + 5000);
    await Deno.utime(file, touched, touched);
    assertEquals(await versionFor(insideHeaders), await manifestVersion(stable));
  });
});

Deno.test("createOtaHandler: a manifest rewritten without an mtime change is re-read until it settles", async () => {
  await inTemp(async (root) => {
    const dir = await release(root, "rel", { sequence: 1 });
    const manifestFile = join(dir, "_denext", "ota.json");
    const ota = createOtaHandler({ dir, basePath: "/" });
    const sequence = async () =>
      (await (await ota(new Request("http://host/_denext/ota.json")))!.json()).sequence;
    // Pin the mtime, as a coarse filesystem clock (or a rewrite within the same millisecond) would.
    const pin = async (at: Date) => await Deno.utime(manifestFile, at, at);
    const now = new Date();
    await pin(now);
    assertEquals(await sequence(), 1);
    await writeOtaManifest(dir, { sequence: 2 });
    await pin(now); // same mtime as the cached copy: the new manifest must still be served
    assertEquals(await sequence(), 2);
    // A manifest read well after its mtime is settled: cached while the mtime holds.
    const old = new Date(Date.now() - 60_000);
    await pin(old);
    assertEquals(await sequence(), 2);
    await writeOtaManifest(dir, { sequence: 3 });
    await pin(old);
    assertEquals(await sequence(), 2, "a settled manifest is not re-read");
    await pin(new Date());
    assertEquals(await sequence(), 3, "a changed mtime always re-reads");
  });
});

Deno.test("createOtaHandler channels: an object, a missing candidate, a missing file", async () => {
  await inTemp(async (root) => {
    const stable = await release(root, "stable");
    const ota = createOtaHandler({
      channels: {
        default: "production",
        channels: {
          production: {
            release: stable,
            rollout: { release: join(root, "nowhere"), percent: 100 },
          },
        },
      },
    });
    const res = await ota(
      new Request("http://host/_denext/ota.json", {
        headers: { "x-denext-ota-install-id": "device-0001" },
      }),
    );
    assertEquals((await res!.json()).version, await manifestVersion(stable));
    const missing = createOtaHandler({ channels: join(root, "none.json") });
    assertEquals(await missing(new Request("http://host/_denext/ota.json")), null);
    await Deno.writeTextFile(join(root, "bad.json"), "{ not json");
    const bad = createOtaHandler({ channels: join(root, "bad.json") });
    assertEquals(await bad(new Request("http://host/_denext/ota.json")), null);
  });
});

Deno.test("createOtaHandler channels: CORS preflight allows the channel headers; vary merges", async () => {
  await inTemp(async (root) => {
    await release(root, "stable");
    const file = join(root, "ota-channels.json");
    await setOtaChannel({ file, channel: "production", release: join(root, "stable") });
    const ota = createOtaHandler({ channels: file, cors: true });
    const pre = await ota(
      new Request("http://host/_denext/ota.json", {
        method: "OPTIONS",
        headers: { origin: "capacitor://localhost", "access-control-request-method": "GET" },
      }),
    );
    assertEquals(pre?.status, 204);
    assertEquals(
      pre?.headers.get("access-control-allow-headers"),
      "authorization, x-denext-ota-channel, x-denext-ota-install-id, x-denext-ota-platform",
    );
    const res = await ota(
      new Request("http://host/index.html", { headers: { origin: "capacitor://localhost" } }),
    );
    assertEquals(res?.headers.get("vary"), "Origin, x-denext-ota-channel, x-denext-ota-install-id");
    assertEquals(res?.headers.get("access-control-allow-origin"), "capacitor://localhost");
  });
});

// ---- channels file edits --------------------------------------------------------------------

Deno.test("setOtaChannel: creates the file with a default, relative paths, atomic write", async () => {
  await inTemp(async (root) => {
    await release(root, "r1");
    const file = join(root, "deploy", "ota-channels.json");
    const doc = await setOtaChannel({ file, channel: "beta", release: join(root, "r1") });
    assertEquals(doc, { default: "beta", channels: { beta: { release: "../r1" } } });
    assertEquals(await readOtaChannels(file), doc);
    const leftovers = [...Deno.readDirSync(join(root, "deploy"))].map((e) => e.name);
    assertEquals(leftovers, ["ota-channels.json"]);
    await release(root, "r2");
    const two = await setOtaChannel({ file, channel: "production", release: join(root, "r2") });
    assertEquals(two.default, "beta");
    assertEquals(two.channels.production, { release: "../r2" });
    await assertRejects(
      () => setOtaChannel({ file, channel: "Prod", release: join(root, "r2") }),
      Error,
      "not a channel name",
    );
    await assertRejects(
      () => setOtaChannel({ file, channel: "x", release: join(root, "nothing") }),
      Error,
      "no valid",
    );
    assertEquals(await readOtaChannels(join(root, "absent.json")), null);
    await Deno.writeTextFile(join(root, "broken.json"), JSON.stringify({ default: "x" }));
    await assertRejects(() => readOtaChannels(join(root, "broken.json")));
  });
});

Deno.test("promoteOtaRelease: staged rollout, raise, 100%, halt, new channel", async () => {
  await inTemp(async (root) => {
    await release(root, "old", { sequence: 10 });
    await release(root, "new", { sequence: 20 });
    const file = join(root, "ota-channels.json");
    await setOtaChannel({ file, channel: "production", release: join(root, "old") });
    await setOtaChannel({ file, channel: "beta", release: join(root, "new") });

    let doc = await promoteOtaRelease({
      file,
      from: { channel: "beta" },
      to: "production",
      percent: 20,
    });
    assertEquals(doc.channels.production, {
      release: "old",
      rollout: { release: "new", percent: 20 },
    });
    doc = await promoteOtaRelease({
      file,
      from: { channel: "beta" },
      to: "production",
      percent: 50,
    });
    assertEquals(doc.channels.production.rollout?.percent, 50);
    doc = await promoteOtaRelease({ file, to: "production", halt: true });
    assertEquals(doc.channels.production, { release: "old" });
    await promoteOtaRelease({ file, from: { channel: "beta" }, to: "production", percent: 5 });
    doc = await promoteOtaRelease({ file, to: "production", percent: 0 });
    assertEquals(doc.channels.production, { release: "old" });
    doc = await promoteOtaRelease({ file, from: { channel: "beta" }, to: "production" });
    assertEquals(doc.channels.production, { release: "new" });
    // A new channel from an export dir, fully; a staged rollout onto a missing one is refused.
    doc = await promoteOtaRelease({ file, from: { release: join(root, "new") }, to: "qa" });
    assertEquals(doc.channels.qa, { release: "new" });
    await assertRejects(
      () => promoteOtaRelease({ file, from: { channel: "beta" }, to: "nightly", percent: 10 }),
      Error,
      "does not exist yet",
    );
    assertEquals(await readOtaChannels(file), doc);
  });
});

Deno.test("promoteOtaRelease: the refusal rules, and force", async () => {
  await inTemp(async (root) => {
    const { privateKeyPem } = await generateOtaKeyPair();
    const key = await importOtaSigningKey(privateKeyPem);
    await release(root, "signed", { sequence: 100 }, key);
    await release(root, "unsigned", { sequence: 200 });
    await release(root, "older", { sequence: 50 }, key);
    const file = join(root, "ota-channels.json");
    await setOtaChannel({ file, channel: "production", release: join(root, "signed") });
    await setOtaChannel({ file, channel: "beta", release: join(root, "unsigned"), force: true });
    await setOtaChannel({ file, channel: "legacy", release: join(root, "older"), force: true });

    const refuse = (options: Parameters<typeof promoteOtaRelease>[0], message: string) =>
      assertRejects(() => promoteOtaRelease(options), Error, message);
    await refuse({ file, from: { channel: "beta" }, to: "production" }, "code signature");
    await refuse(
      { file, from: { channel: "legacy" }, to: "production", percent: 10 },
      "code downgrade",
    );
    await refuse({ file, from: { channel: "production" }, to: "production" }, "onto itself");
    await refuse({ file, from: { channel: "ghost" }, to: "production" }, 'no channel "ghost"');
    await refuse({ file, from: { channel: "beta" }, to: "Prod" }, "not a channel name");
    await refuse({ file, from: { release: join(root, "nothing") }, to: "production" }, "no valid");
    await refuse({ file, to: "production" }, "pass the source");
    await assertRejects(
      () => promoteOtaRelease({ file, from: { channel: "beta" }, to: "production", percent: 150 }),
      RangeError,
    );
    await refuse(
      { file: join(root, "none.json"), from: { channel: "beta" }, to: "x" },
      "does not exist",
    );
    // A rollout candidate counts too: once 300 rolls out, a 200 is a downgrade for that cohort.
    await release(root, "newer", { sequence: 300 }, key);
    await promoteOtaRelease({
      file,
      from: { release: join(root, "newer") },
      to: "production",
      percent: 10,
    });
    await release(root, "mid", { sequence: 250 }, key);
    await refuse(
      { file, from: { release: join(root, "mid") }, to: "production", percent: 20 },
      "code downgrade",
    );
    // setOtaChannel applies the same rules.
    await assertRejects(
      () => setOtaChannel({ file, channel: "production", release: join(root, "unsigned") }),
      Error,
      "code signature",
    );
    // force overrides signature and sequence.
    const forced = await promoteOtaRelease({
      file,
      from: { channel: "beta" },
      to: "production",
      force: true,
    });
    assertEquals(forced.channels.production, { release: "unsigned" });
  });
});

// ---- client ---------------------------------------------------------------------------------

/** A fake localStorage over a Map (optionally throwing). */
function fakeStorage(throws = false) {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: (k: string) => {
        if (throws) throw new Error("denied");
        return map.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (throws) throw new Error("denied");
        map.set(k, v);
      },
    },
  };
}

const SERVER = "c".repeat(64);
const MANIFEST = {
  version: SERVER,
  files: [{ path: "index.html", sha256: "d".repeat(64), size: 1 }],
};

function shell(extra: Record<string, unknown> = {}) {
  const applied: Any[] = [];
  const downloaded: Any[] = [];
  const plugin = {
    status: () => Promise.resolve({ current: null, bundled: "e".repeat(64), pending: null }),
    apply: (o: Any) => (applied.push(o), Promise.resolve({})),
    download: (o: Any) => (downloaded.push(o), Promise.resolve({})),
    activate: () => Promise.resolve({}),
    booted: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    ...extra,
  };
  const Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: { DenextOta: plugin },
  };
  return { Capacitor, applied, downloaded };
}

function recordingFetch(body: unknown = MANIFEST) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = ((url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(Response.json(body));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

Deno.test("otaInstallId: made once, persisted, in memory when storage fails", async () => {
  const { storage, map } = fakeStorage();
  await withGlobals({ localStorage: storage }, () => {
    const id = otaInstallId();
    assert(/^[A-Za-z0-9_-]{22}$/.test(id), id);
    assertEquals(map.get("denext:ota-install-id"), id);
    assertEquals(otaInstallId(), id);
    map.set("denext:ota-install-id", "kept-from-earlier-install");
    assertEquals(otaInstallId(), "kept-from-earlier-install");
    map.set("denext:ota-install-id", "bad!");
    assert(otaInstallId() !== "bad!");
  });
  const broken = fakeStorage(true);
  await withGlobals({ localStorage: broken.storage }, () => {
    const id = otaInstallId();
    assertEquals(otaInstallId(), id);
  });
});

Deno.test("checkForUiUpdate: channel sends both headers on the fetch and to the native plugin", async () => {
  const { storage, map } = fakeStorage();
  const s = shell();
  await withGlobals({ localStorage: storage, Capacitor: s.Capacitor }, async () => {
    const f = recordingFetch();
    const r = await checkForUiUpdate({
      baseUrl: "https://ui.example.com",
      headers: { authorization: "Bearer t" },
      channel: "beta",
      fetch: f.fetch,
    });
    assertEquals(r, { kind: "applied", version: SERVER });
    const id = map.get("denext:ota-install-id")!;
    const expected = {
      authorization: "Bearer t",
      "x-denext-ota-channel": "beta",
      "x-denext-ota-install-id": id,
    };
    assertEquals(f.calls[0].init.headers, expected);
    assertEquals(s.applied[0].headers, expected);

    // An explicit install id, no channel; and neither → no extra headers.
    const g = recordingFetch();
    await prepareUiUpdate({
      baseUrl: "https://ui.example.com",
      installId: "my-own-id-123",
      fetch: g.fetch,
    });
    assertEquals(g.calls[0].init.headers, { "x-denext-ota-install-id": "my-own-id-123" });
    assertEquals(s.downloaded[0].headers, { "x-denext-ota-install-id": "my-own-id-123" });
    const h = recordingFetch();
    await checkForUiUpdate({ baseUrl: "https://ui.example.com", fetch: h.fetch });
    assertEquals(h.calls[0].init.headers, {});
  });
});

Deno.test("onNativeUpdateRequired: fired for native_too_old / native_mismatch only; a throw is swallowed", async () => {
  for (const code of ["native_too_old", "native_mismatch", "integrity"]) {
    const refusal = Object.assign(new Error(`refused ${code}`), { code });
    const s = shell({
      apply: () => Promise.reject(refusal),
      download: () => Promise.reject(refusal),
    });
    await withGlobals({ Capacitor: s.Capacitor }, async () => {
      const seen: Any[] = [];
      const r = await checkForUiUpdate({
        baseUrl: "https://ui.example.com",
        fetch: recordingFetch().fetch,
        onNativeUpdateRequired: (x) => void seen.push(x),
      });
      assertEquals(r, { kind: "error", reason: `refused ${code}`, code: code as Any });
      if (code === "integrity") assertEquals(seen, []);
      else assertEquals(seen, [{ code, reason: `refused ${code}` }]);

      const p = await prepareUiUpdate({
        baseUrl: "https://ui.example.com",
        fetch: recordingFetch().fetch,
        onNativeUpdateRequired: () => {
          throw new Error("app bug");
        },
      });
      assertEquals(p, { kind: "error", reason: `refused ${code}`, code: code as Any });
      const q = await checkForUiUpdate({
        baseUrl: "https://ui.example.com",
        fetch: recordingFetch().fetch,
        onNativeUpdateRequired: () => Promise.reject(new Error("async bug")),
      });
      assertEquals(q.kind, "error");
    });
  }
});
