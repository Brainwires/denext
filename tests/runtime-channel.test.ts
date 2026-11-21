// src/build/runtime-channel.ts: the signed runtime channel index and its release documents —
// signatures (either key, both during a rotation, a withdrawn key refused), expiry, the replay
// floor, a future date, an unknown schema, the size cap, every entry field, the artifact URL
// allow-list, the document hash, and the cached loader over both bases. Every key is a throwaway
// generated here; nothing reaches the network.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  allowedArtifactUrl,
  CHANNEL_BASES,
  CHANNEL_KEYS_FILE_ENV,
  CHANNEL_MAX_BYTES,
  CHANNEL_SIGNATURE_DOMAIN,
  channelKeys,
  channelResignDue,
  checkChannelRelease,
  checkReleaseDocument,
  checkRuntimeChannel,
  freshRuntimeChannel,
  honourChannelKeysFileForTests,
  loadReleaseDocument,
  loadRuntimeChannel,
  partitionChannelKeys,
  RELEASE_DOCUMENT_MAX_BYTES,
  releaseDocumentText,
  releaseDocumentUrls,
  releaseEntryFor,
  type RuntimeChannel,
  RuntimeChannelError,
  type RuntimeChannelRelease,
  type RuntimeReleaseDocument,
  signRuntimeChannel,
  verifyReleaseDocument,
  verifyRuntimeChannel,
} from "../src/build/runtime-channel.ts";
import {
  keySetId,
  parseEnvelope,
  sha256Hex,
  signWithKeys,
  spkiSha256,
} from "../src/build/signed-envelope.ts";
import {
  checkRevocationList,
  freshRevocationList,
  REVOCATION_SIGNATURE_DOMAIN,
} from "../src/build/runtime-revocations.ts";
import { toBase64 } from "../src/build/ota-signing.ts";
import {
  RUNTIME_CHANNEL_MIN_SEQUENCE,
  RUNTIME_CHANNEL_PUBLIC_KEYS,
} from "../src/build/runtime-channel-keys.ts";
import toolchainPin from "../src/build/deno-toolchain-pin.json" with { type: "json" };
import desktopPin from "../src/build/desktop-runtime-pin.json" with { type: "json" };

const NOW = new Date("2026-11-20T00:00:00Z");
const T = NOW.getTime();
const DAY = 86_400_000;

interface Pair {
  priv: CryptoKey;
  pub: string;
}

async function pair(): Promise<Pair> {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    priv: k.privateKey,
    pub: toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", k.publicKey))),
  };
}

/** The bundled pins as a release document (each without its rollback). */
function bundledDocument(): RuntimeReleaseDocument {
  const { rollback: _t, ...toolchain } = structuredClone(toolchainPin) as Record<string, unknown>;
  const { rollback: _d, ...desktop } = structuredClone(desktopPin) as Record<string, unknown>;
  return { toolchain, desktop } as unknown as RuntimeReleaseDocument;
}

const META = { releasedAt: "2026-11-10T00:00:00Z", minDenext: "4.19.0" };

/** A plausible entry for `version` (its document hash need not exist). */
function entry(version: string, over: Partial<RuntimeChannelRelease> = {}): RuntimeChannelRelease {
  return {
    version,
    tag: `denext-runtime-v${version}`,
    deno: "2.9.8",
    releasedAt: "2026-11-01T00:00:00Z",
    minDenext: "4.19.0",
    esbuild: "0.25.5",
    laufeyApi: 58,
    minGlibc: "2.27",
    doc: { sha256: "a".repeat(64), size: 1000 },
    ...over,
  };
}

async function signed(channel: RuntimeChannel, ...keys: CryptoKey[]): Promise<string> {
  return JSON.stringify(await signRuntimeChannel(channel, keys));
}

const fresh = (releases: RuntimeChannelRelease[] = [entry("3.0.0-denext.27")], at = NOW) =>
  freshRuntimeChannel(releases, at);

async function refusal(p: Promise<unknown>): Promise<RuntimeChannelError> {
  const err = await assertRejects(() => p, RuntimeChannelError);
  return err as RuntimeChannelError;
}

// ---------------------------------------------------------------------------------------------
// Signatures.

Deno.test("an index signed by the active key verifies; entries come back newest first", async () => {
  const a = await pair();
  const channel = fresh([
    entry("3.0.0-denext.25"),
    entry("3.0.0-denext.27"),
    entry("3.0.0-denext.9"),
  ]);
  assertEquals(channel.releases.map((r) => r.version), [
    "3.0.0-denext.27",
    "3.0.0-denext.25",
    "3.0.0-denext.9",
  ]);
  const got = await verifyRuntimeChannel(await signed(channel, a.priv), [a.pub], { now: T });
  assertEquals(got, channel);
});

Deno.test("either compiled-in key verifies, and a rotation index carries both signatures", async () => {
  const active = await pair();
  const backup = await pair();
  const keys = [active.pub, backup.pub];
  const byBackup = await signed(fresh(), backup.priv);
  assert(await verifyRuntimeChannel(byBackup, keys, { now: T }));
  const both = await signed(fresh(), active.priv, backup.priv);
  assertEquals((JSON.parse(both).signatures as string[]).length, 2);
  assert(await verifyRuntimeChannel(both, [active.pub], { now: T }), "the active key alone");
  assert(await verifyRuntimeChannel(both, [backup.pub], { now: T }), "the backup key alone");
  // A key that is malformed is skipped, never fatal.
  assert(await verifyRuntimeChannel(both, ["not-base64!", backup.pub], { now: T }));
});

Deno.test("a wrong key, a tampered payload or another document kind's domain does not verify", async () => {
  const a = await pair();
  const other = await pair();
  const text = await signed(fresh(), a.priv);
  assertEquals(
    (await refusal(verifyRuntimeChannel(text, [other.pub], { now: T }))).code,
    "signature",
  );
  const env = JSON.parse(text);
  env.signed = env.signed.replace("4.19.0", "4.18.0");
  assertEquals(
    (await refusal(verifyRuntimeChannel(JSON.stringify(env), [a.pub], { now: T }))).code,
    "signature",
  );
  // The same payload signed under the revocation list's domain is not a channel signature.
  const payload = JSON.stringify(fresh());
  const [sig] = await signWithKeys(payload, REVOCATION_SIGNATURE_DOMAIN, [a.priv]);
  const cross = JSON.stringify({ signed: payload, signatures: [sig] });
  assertEquals((await refusal(verifyRuntimeChannel(cross, [a.pub], { now: T }))).code, "signature");
  // Under the channel's own domain the single-signature spelling is accepted too.
  const [own] = await signWithKeys(payload, CHANNEL_SIGNATURE_DOMAIN, [a.priv]);
  assert(
    await verifyRuntimeChannel(JSON.stringify({ signed: payload, signature: own }), [a.pub], {
      now: T,
    }),
  );
  // Garbage signatures verify nothing.
  const junk = JSON.stringify({ signed: payload, signatures: ["@@@", "AAAA"] });
  assertEquals((await refusal(verifyRuntimeChannel(junk, [a.pub], { now: T }))).code, "signature");
});

Deno.test("a channel key the revocation list withdrew: an index only it signs is refused", async () => {
  const active = await pair();
  const backup = await pair();
  const gone = (await spkiSha256(active.pub))!;
  const keys = [active.pub, backup.pub];
  const byActive = await signed(fresh(), active.priv);
  const err = await refusal(verifyRuntimeChannel(byActive, keys, { now: T, revokedKeys: [gone] }));
  assertEquals(err.code, "revoked-key");
  // The id is matched case-insensitively.
  assertEquals(
    (await refusal(
      verifyRuntimeChannel(byActive, keys, { now: T, revokedKeys: [gone.toUpperCase()] }),
    ))
      .code,
    "revoked-key",
  );
  // Signed by both, the backup still carries it.
  const both = await signed(fresh(), active.priv, backup.priv);
  assert(await verifyRuntimeChannel(both, keys, { now: T, revokedKeys: [gone] }));
  const split = await partitionChannelKeys(keys, [gone]);
  assertEquals(split, { live: [backup.pub], withdrawn: [active.pub] });
  assertEquals(await partitionChannelKeys(["%%"], [gone]), { live: ["%%"], withdrawn: [] });
});

// ---------------------------------------------------------------------------------------------
// Freshness, schema, size.

Deno.test("expired, replayed and future-dated indexes are refused; an expired one is handed back", async () => {
  const a = await pair();
  const old = freshRuntimeChannel([entry("3.0.0-denext.27")], new Date(T - 50 * DAY));
  const expired = await refusal(
    verifyRuntimeChannel(await signed(old, a.priv), [a.pub], { now: T }),
  );
  assertEquals(expired.code, "expired");
  assertEquals(expired.channel?.sequence, old.sequence);
  const current = fresh();
  const replayed = await refusal(
    verifyRuntimeChannel(await signed(current, a.priv), [a.pub], {
      now: T,
      minSequence: current.sequence + 1,
    }),
  );
  assertEquals(replayed.code, "replayed");
  assert(
    await verifyRuntimeChannel(await signed(current, a.priv), [a.pub], {
      now: T,
      minSequence: current.sequence,
    }),
    "equal to the floor is fine",
  );
  const ahead = freshRuntimeChannel([], new Date(T + 2 * DAY));
  assertEquals(
    (await refusal(verifyRuntimeChannel(await signed(ahead, a.priv), [a.pub], { now: T }))).code,
    "future",
  );
  // A day of clock skew is tolerated.
  const skewed = freshRuntimeChannel([], new Date(T + DAY / 2));
  assert(await verifyRuntimeChannel(await signed(skewed, a.priv), [a.pub], { now: T }));
  // A future sequence with an honest issuedAt is refused as well.
  const seq = { ...fresh(), sequence: Math.floor(T / 1000) + 3 * 86_400 };
  assertEquals(
    (await refusal(verifyRuntimeChannel(await signed(seq, a.priv), [a.pub], { now: T }))).code,
    "future",
  );
});

Deno.test("an unknown schema is ignored as a whole; bad JSON, a bad envelope or an oversized one is refused", async () => {
  const a = await pair();
  const v2 = JSON.stringify({ schema: 2, anything: true });
  const [sig] = await signWithKeys(v2, CHANNEL_SIGNATURE_DOMAIN, [a.priv]);
  assertEquals(
    await verifyRuntimeChannel(JSON.stringify({ signed: v2, signatures: [sig] }), [a.pub]),
    null,
  );
  const notJson = "{";
  const [sig2] = await signWithKeys(notJson, CHANNEL_SIGNATURE_DOMAIN, [a.priv]);
  assertEquals(
    (await refusal(
      verifyRuntimeChannel(JSON.stringify({ signed: notJson, signatures: [sig2] }), [a.pub]),
    ))
      .code,
    "invalid",
  );
  for (
    const bad of [
      "nope",
      "{}",
      '{"signed":"x"}',
      '{"signed":"x","signatures":[]}',
      '{"signed":1,"signature":"a"}',
    ]
  ) {
    assertEquals((await refusal(verifyRuntimeChannel(bad, [a.pub]))).code, "format", bad);
  }
  const big = JSON.stringify({ signed: "x".repeat(CHANNEL_MAX_BYTES), signatures: ["a"] });
  assertEquals((await refusal(verifyRuntimeChannel(big, [a.pub]))).code, "size");
});

// ---------------------------------------------------------------------------------------------
// Entry fields.

Deno.test("checkChannelRelease: every field is checked; unknown fields are dropped", () => {
  const ok = entry("3.0.0-denext.31", {
    maxDenext: "4.30.0",
    security: true,
    yanked: { reason: "crashes" },
  });
  assertEquals(checkChannelRelease({ ...ok, extra: 1 }), ok);
  assertEquals(checkChannelRelease({ ...ok, laufeyApi: null, minGlibc: null }).laufeyApi, null);
  const bad: [Partial<Record<keyof RuntimeChannelRelease, unknown>>, string][] = [
    [{ version: "3.0.0-rc.6" }, "bad version"],
    [{ version: "2.9.7-denext.22" }, "bad version"],
    [{ version: "3.0.0-denext.0" }, "bad version"],
    [{ tag: "denext-runtime-v3.0.0-denext.30" }, "tag must be"],
    [{ releasedAt: "yesterday" }, "bad releasedAt"],
    [{ deno: "2.9" }, "bad deno"],
    [{ minDenext: "four" }, "bad minDenext"],
    [{ maxDenext: 4 }, "bad maxDenext"],
    [{ esbuild: "latest" }, "bad esbuild"],
    [{ laufeyApi: -1 }, "laufeyApi"],
    [{ laufeyApi: "58" }, "laufeyApi"],
    [{ minGlibc: "2" }, "minGlibc"],
    [{ security: false }, "security must be true"],
    [{ yanked: {} }, "yanked needs a reason"],
    [{ yanked: { reason: " " } }, "yanked needs a reason"],
    [{ doc: { sha256: "A".repeat(64), size: 1 } }, "bad doc"],
    [{ doc: { sha256: "a".repeat(64), size: 0 } }, "bad doc"],
    [{ doc: { sha256: "a".repeat(64), size: RELEASE_DOCUMENT_MAX_BYTES + 1 } }, "bad doc"],
    [{ doc: null }, "bad doc"],
  ];
  for (const [over, why] of bad) {
    const err = assertThrows(() => checkChannelRelease({ ...ok, ...over }), RuntimeChannelError);
    assertStringIncludes((err as Error).message, why, JSON.stringify(over));
  }
  assertThrows(() => checkChannelRelease(null), RuntimeChannelError, "not an object");
});

Deno.test("checkRuntimeChannel: the payload's fields, and one entry per version", () => {
  const base = fresh();
  assertThrows(() => checkRuntimeChannel({ ...base, schema: 2 }), RuntimeChannelError, "schema");
  assertThrows(
    () => checkRuntimeChannel({ ...base, issuedAt: "x" }),
    RuntimeChannelError,
    "issuedAt",
  );
  assertThrows(
    () => checkRuntimeChannel({ ...base, sequence: -1 }),
    RuntimeChannelError,
    "sequence",
  );
  assertThrows(
    () => checkRuntimeChannel({ ...base, sequence: 1.5 }),
    RuntimeChannelError,
    "sequence",
  );
  assertThrows(() => checkRuntimeChannel({ ...base, releases: {} }), RuntimeChannelError, "list");
  const twice = { ...base, releases: [entry("3.0.0-denext.27"), entry("3.0.0-denext.27")] };
  assertThrows(() => checkRuntimeChannel(twice), RuntimeChannelError, "listed twice");
});

Deno.test("freshRuntimeChannel: 45 days, a sequence above the previous whatever the clock, newest first", () => {
  const c = freshRuntimeChannel([entry("3.0.0-denext.9"), entry("3.0.0-denext.10")], NOW);
  assertEquals(c.sequence, T / 1000);
  assertEquals(Date.parse(c.expiresAt) - T, 45 * DAY);
  assertEquals(c.releases.map((r) => r.version), ["3.0.0-denext.10", "3.0.0-denext.9"]);
  assertEquals(freshRuntimeChannel([], NOW, { sequence: T / 1000 + 99 }).sequence, T / 1000 + 100);
  assert(!channelResignDue(c, T));
  assert(channelResignDue(c, T + 31 * DAY), "under 15 days left");
  assert(channelResignDue({ expiresAt: "x" }, T));
  assert(!channelResignDue(c, T + 31 * DAY, 10));
});

// ---------------------------------------------------------------------------------------------
// Release documents.

Deno.test("allowedArtifactUrl: only this release's GitHub downloads and denext.dev/runtime/", () => {
  const tag = "denext-runtime-v3.0.0-denext.27";
  const gh = `https://github.com/Brainwires/deno/releases/download/${tag}`;
  const yes = [
    `${gh}/deno-cli-x.zip`,
    "https://denext.dev/runtime/files/a.zip",
    "https://denext.dev/runtime/a.zip",
  ];
  const no = [
    `${gh}/sub/deno-cli-x.zip`,
    `${gh}/`,
    `https://github.com/Brainwires/deno/releases/download/denext-runtime-v3.0.0-denext.26/a.zip`,
    `https://github.com/Evil/deno/releases/download/${tag}/a.zip`,
    `http://github.com/Brainwires/deno/releases/download/${tag}/a.zip`,
    `https://github.com:8443/Brainwires/deno/releases/download/${tag}/a.zip`,
    `https://user@github.com/Brainwires/deno/releases/download/${tag}/a.zip`,
    `${gh}/a.zip?x=1`,
    `${gh}/a.zip#frag`,
    `${gh}/%2e%2e/a.zip`,
    `${gh}/../../x/a.zip`,
    "https://denext.dev/runtime/",
    "https://denext.dev/other/a.zip",
    "https://evil.denext.dev/runtime/a.zip",
    "https://denext.dev/runtime//a.zip",
    "https://denext.dev\\runtime\\a.zip",
    "not a url",
  ];
  for (const u of yes) assert(allowedArtifactUrl(u, tag), u);
  for (const u of no) assert(!allowedArtifactUrl(u, tag), u);
});

Deno.test("the bundled pins make a valid release document, and its entry matches them", async () => {
  const doc = bundledDocument();
  const { entry: e, text } = await releaseEntryFor(doc, { ...META, security: true });
  assertEquals(e.version, toolchainPin.version);
  assertEquals(e.tag, toolchainPin.tag);
  assertEquals(e.deno, toolchainPin.deno);
  assertEquals(e.esbuild, "0.25.5");
  assertEquals(e.laufeyApi, desktopPin.laufeyApiVersion);
  assertEquals(e.minGlibc, toolchainPin.minGlibc ?? null);
  assertEquals(e.security, true);
  assertEquals(e.doc.sha256, await sha256Hex(text));
  assertEquals(text, releaseDocumentText(doc));
  assert(!text.includes('"rollback"'));
  assertEquals(await verifyReleaseDocument(text, e), JSON.parse(text));
});

Deno.test("a release document is refused when its bytes, size or pins disagree with the entry", async () => {
  const doc = bundledDocument();
  const { entry: e, text } = await releaseEntryFor(doc, META);
  const err = await refusal(verifyReleaseDocument(text.replace("0.25.5", "0.25.6"), e));
  assertEquals(err.code, "document");
  assertStringIncludes(err.message, "sha256");
  assertStringIncludes((await refusal(verifyReleaseDocument(text + " ", e))).message, "bytes");
  const notJson = "x".repeat(e.doc.size);
  const forged = { ...e, doc: { size: e.doc.size, sha256: await sha256Hex(notJson) } };
  assertStringIncludes((await refusal(verifyReleaseDocument(notJson, forged))).message, "not JSON");

  // deno-lint-ignore no-explicit-any
  type Loose = any;
  const mutate = (fn: (d: Loose) => void): Record<string, unknown> => {
    const d: Loose = structuredClone(doc);
    fn(d);
    return d;
  };
  const target = Object.keys(toolchainPin.targets)[0];
  const desktopTarget = Object.keys(desktopPin.targets)[0];
  const cases: [Record<string, unknown>, string][] = [
    [{ toolchain: doc.toolchain }, "expected { toolchain, desktop }"],
    [mutate((d) => (d.toolchain.schema = 2)), "not schema 1"],
    [mutate((d) => (d.desktop.version = "3.0.0-denext.26")), "the index says"],
    [mutate((d) => (d.toolchain.tag = "x")), "the index says"],
    [mutate((d) => (d.desktop.deno = "2.9.7")), "deno"],
    [mutate((d) => (d.toolchain.rollback = { version: "x" })), "carries a rollback"],
    [mutate((d) => (d.toolchain.targets = {})), "names no target"],
    [mutate((d) => (d.toolchain.targets[target].esbuild.version = "0.26.0")), "esbuild"],
    [mutate((d) => (d.toolchain.minGlibc = "2.99")), "minGlibc"],
    [mutate((d) => (d.desktop.laufeyApiVersion = 1)), "laufey API"],
    [
      mutate((d) => (d.toolchain.targets[target].url = "https://evil.example/deno.zip")),
      "not an allowed",
    ],
    [
      mutate((
        d,
      ) => (d.toolchain.targets[target].fallbacks = [{ url: "https://evil.example/x.zip" }])),
      "not an allowed",
    ],
    [mutate((d) => (d.toolchain.targets[target].headers = { a: "b" })), "headers"],
    [
      mutate((
        d,
      ) => (d.toolchain.targets[target].fallbacks = [{
        url: d.toolchain.targets[target].url,
        headers: {},
      }])),
      "headers",
    ],
    [mutate((d) => (d.toolchain.targets[target].sha256 = "nope")), "bad sha256"],
    [mutate((d) => (d.toolchain.targets[target].size = 0)), "bad size"],
    [
      mutate((d) => {
        const t = d.desktop.targets[desktopTarget];
        (t.webview ?? t.cef).url = "https://denext.dev.evil/x";
      }),
      "not an allowed",
    ],
  ];
  if ((toolchainPin as { denort?: Record<string, unknown> }).denort) {
    const k = Object.keys((toolchainPin as { denort: Record<string, unknown> }).denort)[0];
    cases.push([mutate((d) => (d.toolchain.denort[k].url = "https://x.example/d.zip")), "denort"]);
  }
  for (const [raw, why] of cases) {
    const err = assertThrows(() => checkReleaseDocument(raw, e), RuntimeChannelError);
    assertStringIncludes((err as Error).message, why);
  }
  // releaseEntryFor runs the same checks: a document with a stray URL never gets an entry.
  await assertRejects(
    () =>
      releaseEntryFor(
        mutate((d) => (d.toolchain.targets[target].url = "https://x.example/a.zip")) as never,
        META,
      ),
    RuntimeChannelError,
    "not an allowed",
  );
});

Deno.test("releaseDocumentUrls: the document under each base, in order", () => {
  assertEquals(releaseDocumentUrls("3.0.0-denext.27"), [
    "https://denext.dev/runtime/releases/3.0.0-denext.27.json",
    "https://raw.githubusercontent.com/Brainwires/deno/denext-runtime-channel/releases/3.0.0-denext.27.json",
  ]);
  assertEquals(CHANNEL_BASES.length, 2);
});

// ---------------------------------------------------------------------------------------------
// The shared envelope and the revocation list's withdrawn channel keys.

Deno.test("signed-envelope: shape, key-set ids and SPKI ids", async () => {
  assertEquals(parseEnvelope('{"signed":"x","signatures":["a",1]}', 1000), "format");
  assertEquals(parseEnvelope('{"signed":"x","signature":"a"}', 10), "size");
  assertEquals(parseEnvelope('{"signed":"x","signature":"a"}', 1000), {
    signed: "x",
    signatures: ["a"],
  });
  assertEquals(await keySetId(["b", "a"]), await keySetId(["a", "b"]));
  assert(await keySetId(["a"]) !== await keySetId(["b"]));
  assertEquals(await spkiSha256("not base64!"), null);
  assertEquals((await spkiSha256((await pair()).pub))?.length, 64);
  await assertRejects(() => signWithKeys("x", "d\n", []), Error, "no signing key");
});

Deno.test("the revocation list carries withdrawn channel keys: checked, lower-cased, de-duplicated", () => {
  const id = "AB".repeat(32);
  const list = freshRevocationList([], NOW, undefined, [id.toLowerCase()]);
  assertEquals(list.revokedChannelKeys, [id.toLowerCase()]);
  assertEquals(
    checkRevocationList({ ...list, revokedChannelKeys: [id, id.toLowerCase()] }).revokedChannelKeys,
    [
      id.toLowerCase(),
    ],
  );
  assertEquals(
    checkRevocationList({ ...list, revokedChannelKeys: [] }).revokedChannelKeys,
    undefined,
  );
  assertEquals("revokedChannelKeys" in freshRevocationList([], NOW), false);
  assertThrows(
    () => checkRevocationList({ ...list, revokedChannelKeys: ["short"] }),
    Error,
    "SHA-256",
  );
  assertThrows(() => checkRevocationList({ ...list, revokedChannelKeys: "x" }), Error, "SHA-256");
});

// ---------------------------------------------------------------------------------------------
// The loader.

/** A fake network: `url → text` (absent: 404), counting requests. */
function fakeNet(served: Map<string, string>) {
  const hits: string[] = [];
  const f = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    hits.push(url);
    const body = served.get(url);
    return Promise.resolve(
      body === undefined ? new Response("no", { status: 404 }) : new Response(body),
    );
  }) as typeof fetch;
  return { fetch: f, hits };
}

const indexUrl = (base: string) => new URL("channel.json", base).href;
const granted = () => Promise.resolve(true);
/**
 * The loader's replay floor, injected: the fixtures are dated `NOW`, and `deno task release`
 * raises the compiled-in {@linkcode RUNTIME_CHANNEL_MIN_SEQUENCE} to the live index's sequence at
 * every release, so a test that left the default in place would start failing the day a release
 * passed `NOW`. The default itself is pinned by its own test below, relative to the floor.
 */
const NO_FLOOR = { minSequence: 0 } as const;

async function withCache(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "denext-channel-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("loadRuntimeChannel: both bases at once, the higher sequence wins, cached and re-verified", async () => {
  const a = await pair();
  await withCache(async (root) => {
    const older = await signed(
      freshRuntimeChannel([entry("3.0.0-denext.25")], new Date(T - DAY)),
      a.priv,
    );
    const newer = await signed(fresh(), a.priv);
    const net = fakeNet(
      new Map([[indexUrl(CHANNEL_BASES[0]), older], [indexUrl(CHANNEL_BASES[1]), newer]]),
    );
    const o = {
      ...NO_FLOOR,
      keys: [a.pub],
      revokedKeys: [],
      cacheRoot: root,
      now: () => T,
      fetch: net.fetch,
      netGranted: granted,
    };
    const got = await loadRuntimeChannel(o);
    assertEquals(got.source, "network");
    assertEquals(got.absent, null);
    assertEquals(got.channel?.releases[0].version, "3.0.0-denext.27");
    assertEquals(await Deno.readTextFile(join(root, "channel.json")), newer);
    const state = JSON.parse(await Deno.readTextFile(join(root, "channel.state.json")));
    assertEquals(state.keys, await keySetId([a.pub]));
    // Within 12 hours the cache answers, without a request.
    net.hits.length = 0;
    const again = await loadRuntimeChannel({ ...o, now: () => T + 3600_000 });
    assertEquals([again.source, net.hits.length], ["cache", 0]);
    // cache-only never fetches; force always does.
    assertEquals(
      (await loadRuntimeChannel({ ...o, mode: "cache-only", now: () => T + 20 * 3600_000 })).source,
      "cache",
    );
    assertEquals(net.hits.length, 0);
    await loadRuntimeChannel({ ...o, mode: "force" });
    assertEquals(net.hits.length, 2);
    // A copy someone edited in the cache no longer verifies.
    await Deno.writeTextFile(join(root, "channel.json"), newer.replace("4.19.0", "4.18.0"));
    const tampered = await loadRuntimeChannel({ ...o, mode: "cache-only" });
    assertEquals([tampered.channel, tampered.absent], [null, "unavailable"]);
  });
});

Deno.test("loadRuntimeChannel: an older index is a replay once a newer one is held; a failure keeps the cache", async () => {
  const a = await pair();
  await withCache(async (root) => {
    const newer = await signed(fresh(), a.priv);
    const o = { ...NO_FLOOR, keys: [a.pub], revokedKeys: [], cacheRoot: root, netGranted: granted };
    await loadRuntimeChannel({
      ...o,
      now: () => T,
      fetch: fakeNet(new Map([[indexUrl(CHANNEL_BASES[0]), newer]])).fetch,
    });
    // Later, both bases serve an older (still valid) index: refused, the held one stays.
    const older = await signed(freshRuntimeChannel([], new Date(T - DAY)), a.priv);
    const net = fakeNet(new Map(CHANNEL_BASES.map((b) => [indexUrl(b), older])));
    const later = await loadRuntimeChannel({
      ...o,
      now: () => T + 13 * 3600_000,
      fetch: net.fetch,
    });
    assertEquals(later.source, "cache");
    assertEquals(later.channel?.releases.length, 1);
    const state = JSON.parse(await Deno.readTextFile(join(root, "channel.state.json")));
    assertEquals(state.failedAt, T + 13 * 3600_000);
    // Within an hour of a failure nothing is fetched again.
    net.hits.length = 0;
    await loadRuntimeChannel({ ...o, now: () => T + 13.5 * 3600_000, fetch: net.fetch });
    assertEquals(net.hits.length, 0);
    // The compiled-in floor refuses even a cached index below it.
    const floored = await loadRuntimeChannel({
      ...o,
      mode: "cache-only",
      minSequence: T / 1000 + 1,
      now: () => T,
    });
    assertEquals(floored.channel, null);
  });
});

Deno.test("loadRuntimeChannel: absent with no key, when off, with every key withdrawn, and expired", async () => {
  const a = await pair();
  await withCache(async (root) => {
    const net = fakeNet(new Map());
    const base = {
      ...NO_FLOOR,
      cacheRoot: root,
      fetch: net.fetch,
      netGranted: granted,
      revokedKeys: [],
    };
    assertEquals((await loadRuntimeChannel({ ...base, keys: [] })).absent, "no-key");
    assertEquals((await loadRuntimeChannel({ ...base, keys: [a.pub], mode: "off" })).absent, "off");
    assertEquals(
      (await loadRuntimeChannel({
        ...base,
        keys: [a.pub],
        env: (k) => (k === "DENEXT_RUNTIME_CHANNEL" ? "0" : undefined),
      })).absent,
      "off",
    );
    const id = (await spkiSha256(a.pub))!;
    assertEquals(
      (await loadRuntimeChannel({ ...base, keys: [a.pub], revokedKeys: [id] })).absent,
      "revoked-key",
    );
    assertEquals(net.hits.length, 0, "none of these touch the network");
    // Served but signed only by a withdrawn key (the other key still trusted): revoked-key.
    const b = await pair();
    const served = fakeNet(new Map([[indexUrl(CHANNEL_BASES[0]), await signed(fresh(), a.priv)]]));
    const withdrawn = await loadRuntimeChannel({
      ...base,
      keys: [a.pub, b.pub],
      revokedKeys: [id],
      fetch: served.fetch,
      now: () => T,
    });
    assertEquals(withdrawn.absent, "revoked-key");
    // An index that expired: absent, and handed back as `expired`.
    const old = await signed(freshRuntimeChannel([], new Date(T - 60 * DAY)), a.priv);
    const expired = await loadRuntimeChannel({
      ...base,
      keys: [a.pub],
      mode: "force",
      now: () => T,
      fetch: fakeNet(new Map([[indexUrl(CHANNEL_BASES[1]), old]])).fetch,
    });
    assertEquals(expired.absent, "expired");
    assert(expired.expired);
    // No permission to reach a base: nothing is asked.
    const denied = await loadRuntimeChannel({
      ...base,
      keys: [a.pub],
      mode: "force",
      netGranted: () => Promise.resolve(false),
      now: () => T,
    });
    assertEquals([denied.absent, denied.source], ["unavailable", "none"]);
  });
});

Deno.test("loadRuntimeChannel: a run on test keys never writes the cache", async () => {
  const a = await pair();
  await withCache(async (root) => {
    const net = fakeNet(new Map([[indexUrl(CHANNEL_BASES[0]), await signed(fresh(), a.priv)]]));
    const got = await loadRuntimeChannel({
      ...NO_FLOOR,
      keys: [a.pub],
      revokedKeys: [],
      cacheRoot: root,
      now: () => T,
      fetch: net.fetch,
      netGranted: granted,
      env: (k) => (k === CHANNEL_KEYS_FILE_ENV ? "/keys.json" : undefined),
    });
    assert(got.channel);
    assertEquals([...Deno.readDirSync(root)].length, 0);
  });
});

Deno.test("loadRuntimeChannel: the default floor is the compiled-in minimum sequence", async () => {
  const a = await pair();
  // Dated relative to whatever the last release raised the floor to: one second below is a
  // replay, exactly at it is taken.
  const floor = RUNTIME_CHANNEL_MIN_SEQUENCE;
  assert(Number.isSafeInteger(floor) && floor >= 0);
  const at = (sequence: number) => new Date(Math.max(sequence, 0) * 1000);
  for (const [sequence, taken] of [[floor - 1, floor === 0], [floor, true]] as const) {
    await withCache(async (root) => {
      const index = await signed(fresh(undefined, at(sequence)), a.priv);
      const got = await loadRuntimeChannel({
        keys: [a.pub],
        revokedKeys: [],
        cacheRoot: root,
        mode: "force",
        now: () => at(sequence).getTime(),
        fetch: fakeNet(new Map([[indexUrl(CHANNEL_BASES[0]), index]])).fetch,
        netGranted: granted,
      });
      assertEquals(got.channel !== null, taken, `sequence ${sequence} against floor ${floor}`);
    });
  }
});

Deno.test("RUNTIME_CHANNEL_PUBLIC_KEYS: two distinct ECDSA P-256 SPKI keys", async () => {
  const [active, backup] = RUNTIME_CHANNEL_PUBLIC_KEYS;
  assert(active !== backup, "the backup is its own key pair");
  for (const key of [active, backup]) {
    const spki = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    const imported = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    assertEquals((imported.algorithm as EcKeyAlgorithm).namedCurve, "P-256");
  }
});

Deno.test("channelKeys: the compiled-in keys unless a test opts in to the keys file", async () => {
  await withCache(async (root) => {
    const file = join(root, "keys.json");
    await Deno.writeTextFile(file, JSON.stringify(["k1", "", 3, "k2"]));
    const env = (k: string) => (k === CHANNEL_KEYS_FILE_ENV ? file : undefined);
    assertEquals(
      channelKeys(env),
      RUNTIME_CHANNEL_PUBLIC_KEYS.filter((k) => k !== ""),
      "ignored without the opt-in: the compiled-in keys",
    );
    assertEquals(channelKeys(env).length, 2, "both slots are filled");
    honourChannelKeysFileForTests();
    try {
      assertEquals(channelKeys(env), ["k1", "k2"]);
      assertEquals(channelKeys(() => join(root, "missing.json")), []);
      await Deno.writeTextFile(file, "{}");
      assertEquals(channelKeys(env), []);
    } finally {
      honourChannelKeysFileForTests(false);
    }
  });
});

Deno.test("loadReleaseDocument: the first copy that hashes right, cached; a tampered or missing one is skipped", async () => {
  const doc = bundledDocument();
  const { entry: e, text } = await releaseEntryFor(doc, META);
  const [web, mirror] = releaseDocumentUrls(e.version);
  await withCache(async (root) => {
    const net = fakeNet(new Map([[web, text.replace("2.9.8", "2.9.9")], [mirror, text]]));
    const got = await loadReleaseDocument(e, { cacheRoot: root, fetch: net.fetch });
    assertEquals(got.toolchain.version, e.version);
    assertEquals(net.hits, [web, mirror]);
    assertEquals(await Deno.readTextFile(join(root, "releases", `${e.version}.json`)), text);
    // Offline, the cache answers; a cached copy that no longer hashes right is refetched.
    net.hits.length = 0;
    assert(await loadReleaseDocument(e, { cacheRoot: root, offline: true }));
    await Deno.writeTextFile(join(root, "releases", `${e.version}.json`), "{}");
    await assertRejects(
      () => loadReleaseDocument(e, { cacheRoot: root, offline: true }),
      RuntimeChannelError,
      "not cached",
    );
    await loadReleaseDocument(e, { cacheRoot: root, fetch: net.fetch });
    assertEquals(net.hits, [web, mirror]);
    // No base serves a verifying copy: refused, naming each.
    const none = await refusal(
      loadReleaseDocument({
        ...e,
        version: "3.0.0-denext.99",
        tag: "denext-runtime-v3.0.0-denext.99",
      }, {
        cacheRoot: root,
        fetch: fakeNet(new Map()).fetch,
      }),
    );
    assertStringIncludes(none.message, "HTTP 404");
  });
});
