// src/build/runtime-revocations.ts: the signed revoked-runtimes list — what a list must be to be
// believed (the signature over the domain-prefixed bytes, size, fields, expiry, sequence), how it
// is cached and fetched (a TTL, a budget no server can stretch, cache-only, no permission, no key
// configured), and what it decides (which runtime runs, the messages, the shipping refusal).

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  ALLOW_REVOKED_RUNTIME_ENV,
  assertRuntimeShippable,
  checkRevocationList,
  decideRevocation,
  findRevocation,
  freshRevocationList,
  honourRevocationKeysFileForTests,
  loadRuntimeRevocations,
  REVOCATION_CHECK_ENV,
  REVOCATION_DEFAULT_EXPIRY_DAYS,
  REVOCATION_FETCH_BUDGET_MS,
  REVOCATION_KEYS_FILE_ENV,
  REVOCATION_MAX_BYTES,
  REVOCATION_MAX_FUTURE_MS,
  REVOCATION_RESIGN_DAYS,
  REVOCATION_SIGNATURE_DOMAIN,
  revocationCacheRoot,
  revocationKeys,
  revocationKeySetId,
  RevocationListError,
  revocationNotice,
  revocationResignDue,
  revocationStatus,
  revocationStatusLine,
  revokedShipRefusal,
  type RuntimeRevocation,
  type RuntimeRevocationList,
  signRevocationList,
  verifyRevocationDocument,
} from "../src/build/runtime-revocations.ts";
import {
  RUNTIME_REVOCATION_MIN_SEQUENCE,
  RUNTIME_REVOCATION_PUBLIC_KEYS,
} from "../src/build/runtime-revocation-keys.ts";
import { toBase64 } from "../src/build/ota-signing.ts";

const LINUX = "x86_64-unknown-linux-gnu";
const MAC = "aarch64-apple-darwin";
const NOW = Date.parse("2026-10-30T00:00:00Z");
const DAY = 24 * 3600_000;

/** A fresh P-256 key pair: the private key and the base64 SPKI public key. */
async function keyPair(): Promise<{ key: CryptoKey; pub: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { key: pair.privateKey, pub: toBase64(spki) };
}

const ENTRY: RuntimeRevocation = {
  component: "cli",
  version: "3.0.0-denext.3",
  targets: [LINUX],
  reason: "crashes on start under glibc 2.27",
  advisory: "https://example.test/advisory",
  fixedIn: "denext 4.10.3",
};

/** A list signed at `now` (default NOW) with `revoked` entries. */
function listAt(
  revoked: readonly RuntimeRevocation[] = [ENTRY],
  now = NOW,
  previous?: { sequence: number },
): RuntimeRevocationList {
  return freshRevocationList(revoked, new Date(now), previous);
}

/** The served document for `list`, signed with `key`. */
async function signed(list: RuntimeRevocationList, key: CryptoKey): Promise<string> {
  return JSON.stringify(await signRevocationList(list, key));
}

/** Signs an arbitrary payload string with `key` under `domain` (to forge bad documents). */
async function rawSigned(payload: string, key: CryptoKey, domain = REVOCATION_SIGNATURE_DOMAIN) {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(domain + payload),
  );
  return JSON.stringify({ signed: payload, signature: toBase64(new Uint8Array(sig)) });
}

/** The code of the `RevocationListError` `p` rejects with. */
async function refused(p: Promise<unknown>): Promise<string> {
  const err = await assertRejects(() => p, RevocationListError);
  return err.code;
}

Deno.test("the compiled-in keys are the filled slots, and the active slot is filled", () => {
  assertEquals(RUNTIME_REVOCATION_PUBLIC_KEYS.length, 2);
  assertEquals(RUNTIME_REVOCATION_PUBLIC_KEYS[0] !== "", true);
  assertEquals(
    revocationKeys(() => undefined),
    RUNTIME_REVOCATION_PUBLIC_KEYS.filter((k) => k !== ""),
  );
});

Deno.test("verifyRevocationDocument: a list signed by either key verifies, as signed", async () => {
  const active = await keyPair();
  const backup = await keyPair();
  const list = listAt();
  const opts = { now: NOW + 1000 };
  assertEquals(
    await verifyRevocationDocument(await signed(list, active.key), [active.pub], opts),
    list,
  );
  // The backup key verifies too: a rotation needs no gap.
  assertEquals(
    await verifyRevocationDocument(await signed(list, backup.key), [active.pub, backup.pub], opts),
    list,
  );
});

Deno.test("verifyRevocationDocument refuses a bad signature, a wrong domain, expiry, a replay and oversize", async () => {
  const { key, pub } = await keyPair();
  const other = await keyPair();
  const list = listAt();
  const opts = { now: NOW + 1000 };
  // Signed by a key that is not compiled in.
  assertEquals(
    await refused(verifyRevocationDocument(await signed(list, other.key), [pub], opts)),
    "signature",
  );
  // A tampered payload: the signature covers the exact bytes.
  const good = JSON.parse(await signed(list, key));
  const tampered = JSON.stringify({ ...good, signed: good.signed.replace("glibc", "GLIBC") });
  assertEquals(await refused(verifyRevocationDocument(tampered, [pub], opts)), "signature");
  // The same payload signed for another protocol (no domain, or the app-update one).
  const payload = JSON.stringify(list);
  for (const domain of ["", "denext-app-update-v1\n"]) {
    assertEquals(
      await refused(verifyRevocationDocument(await rawSigned(payload, key, domain), [pub], opts)),
      "signature",
    );
  }
  // Expired: at its expiry, and after.
  const doc = await signed(list, key);
  const expired = await assertRejects(
    () => verifyRevocationDocument(doc, [pub], { now: Date.parse(list.expiresAt) }),
    RevocationListError,
  );
  assertEquals(expired.code, "expired");
  assertEquals(expired.list, list, "an expired list is handed back for `doctor`");
  // A sequence below the highest one seen.
  assertEquals(
    await refused(
      verifyRevocationDocument(doc, [pub], { ...opts, minSequence: list.sequence + 1 }),
    ),
    "replayed",
  );
  // Over 64 KiB, before any signature work.
  const big = JSON.stringify({ signed: "x".repeat(REVOCATION_MAX_BYTES), signature: "AA==" });
  assertEquals(await refused(verifyRevocationDocument(big, [pub], opts)), "size");
  // Not an envelope; a malformed key and signature verify nothing.
  assertEquals(await refused(verifyRevocationDocument("nope", [pub], opts)), "format");
  assertEquals(await refused(verifyRevocationDocument('{"signed":1}', [pub], opts)), "format");
  assertEquals(
    await refused(
      verifyRevocationDocument(JSON.stringify({ ...good, signature: "!" }), [pub], opts),
    ),
    "signature",
  );
  assertEquals(await refused(verifyRevocationDocument(doc, ["not-a-key"], opts)), "signature");
});

Deno.test("verifyRevocationDocument: unknown fields are ignored, an unknown schema as a whole", async () => {
  const { key, pub } = await keyPair();
  const list = listAt();
  const opts = { now: NOW + 1000 };
  const extra = JSON.stringify({
    ...list,
    future: true,
    revoked: [{ ...ENTRY, note: "x" }, { component: "denort", version: "1", reason: "later" }],
  });
  assertEquals(
    await verifyRevocationDocument(await rawSigned(extra, key), [pub], opts),
    list,
    "unknown fields and components are dropped",
  );
  const v2 = JSON.stringify({ ...list, schema: 2 });
  assertEquals(await verifyRevocationDocument(await rawSigned(v2, key), [pub], opts), null);
  assertEquals(
    await refused(verifyRevocationDocument(await rawSigned("not json", key), [pub], opts)),
    "invalid",
  );
});

Deno.test("checkRevocationList refuses malformed known fields", () => {
  const list = listAt();
  const bad: unknown[] = [
    { ...list, schema: 2 },
    { ...list, issuedAt: "yesterday" },
    { ...list, sequence: -1 },
    { ...list, sequence: 1.5 },
    { ...list, revoked: {} },
    { ...list, revoked: [null] },
    { ...list, revoked: [{ ...ENTRY, version: "" }] },
    { ...list, revoked: [{ ...ENTRY, reason: 1 }] },
    { ...list, revoked: [{ ...ENTRY, targets: "all" }] },
    { ...list, revoked: [{ ...ENTRY, targets: [""] }] },
    { ...list, revoked: [{ ...ENTRY, advisory: "http://insecure.test" }] },
    { ...list, revoked: [{ ...ENTRY, fixedIn: "" }] },
  ];
  for (const raw of bad) {
    const err = (() => {
      try {
        checkRevocationList(raw);
        return null;
      } catch (e) {
        return e as RevocationListError;
      }
    })();
    assertEquals(err?.code, "invalid", JSON.stringify(raw));
  }
});

Deno.test("signRevocationList refuses an invalid payload; freshRevocationList dates and sequences", async () => {
  const { key } = await keyPair();
  await assertRejects(
    () => signRevocationList({ ...listAt(), sequence: -2 }, key),
    RevocationListError,
  );
  const first = listAt([], NOW);
  assertEquals(first.issuedAt, "2026-10-30T00:00:00.000Z");
  assertEquals(Date.parse(first.expiresAt) - NOW, 21 * DAY);
  assertEquals(REVOCATION_DEFAULT_EXPIRY_DAYS, 21);
  assertEquals(first.sequence, NOW / 1000);
  // Never at or below the list it replaces, whatever the clock says.
  assertEquals(listAt([], NOW - DAY, { sequence: NOW / 1000 + 5 }).sequence, NOW / 1000 + 6);
});

Deno.test("revocationResignDue: fewer than 10 days left (or an unreadable expiry)", () => {
  const at = (days: number) => ({ expiresAt: new Date(NOW + days * DAY).toISOString() });
  assertEquals(REVOCATION_RESIGN_DAYS, 10);
  assertFalse(revocationResignDue(at(21), NOW), "a fresh list");
  assertFalse(revocationResignDue(at(10), NOW));
  assert(revocationResignDue(at(9), NOW));
  assert(revocationResignDue(at(-1), NOW));
  assert(revocationResignDue({ expiresAt: "?" }, NOW));
  assert(revocationResignDue(at(10), NOW, 7) === false);
});

Deno.test("revocationKeys: the test-only keys file replaces the compiled-in keys, under the test switch only", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "keys.json");
    await Deno.writeTextFile(file, JSON.stringify(["a", "", 3, "b"]));
    const env = (k: string) => k === REVOCATION_KEYS_FILE_ENV ? file : undefined;
    // The variable alone does nothing: production code never turns the switch on.
    assertEquals(revocationKeys(env), revocationKeys(() => undefined));
    honourRevocationKeysFileForTests();
    assertEquals(revocationKeys(env), ["a", "b"]);
    await Deno.writeTextFile(file, "{}");
    assertEquals(revocationKeys(env), []);
    assertEquals(
      revocationKeys((k) => k === REVOCATION_KEYS_FILE_ENV ? join(dir, "x") : undefined),
      [],
    );
    assertEquals(
      revocationCacheRoot((k) => k === "DENO_DIR" ? dir : undefined),
      join(dir, "denext-deno"),
    );
  } finally {
    honourRevocationKeysFileForTests(false);
    await Deno.remove(dir, { recursive: true });
  }
});

/** A local server that answers with `respond` (a hanging one never answers). */
function server(respond: (req: Request) => Response | Promise<Response>) {
  let hits = 0;
  const s = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    hits++;
    return respond(req);
  });
  return {
    url: `http://127.0.0.1:${s.addr.port}/revocations.json`,
    hits: () => hits,
    close: () => s.shutdown(),
  };
}

const granted = () => Promise.resolve(true);
const noFetch: typeof fetch = () => Promise.reject(new Error("must not fetch"));

Deno.test("loadRuntimeRevocations: no key or the check off → nothing read, nothing fetched", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const none = await loadRuntimeRevocations({
      cacheRoot: dir,
      keys: [],
      fetch: noFetch,
      netGranted: granted,
    });
    assertEquals(none, { configured: false, list: null, source: "none", expired: null });
    const off = await loadRuntimeRevocations({
      cacheRoot: dir,
      keys: ["k"],
      env: (k) => k === REVOCATION_CHECK_ENV ? "0" : undefined,
      fetch: noFetch,
    });
    assertFalse(off.configured);
    assertFalse((await loadRuntimeRevocations({ mode: "off", keys: ["k"] })).configured);
    // No cache directory to be had: nothing either.
    const homeless = await loadRuntimeRevocations({
      env: () => undefined,
      keys: ["k"],
      fetch: noFetch,
    });
    assertEquals(homeless.list, null);
    assertEquals([...Deno.readDirSync(dir)], [], "nothing written");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadRuntimeRevocations: fetches, caches for 12 h, re-verifies the cache, cache-only never fetches", async () => {
  const { key, pub } = await keyPair();
  const doc = await signed(listAt(), key);
  const srv = server(() => new Response(doc));
  const dir = await Deno.makeTempDir();
  try {
    let now = NOW + 1000;
    const base = {
      cacheRoot: dir,
      keys: [pub],
      urls: [srv.url],
      netGranted: granted,
      now: () => now,
      env: () => undefined,
    };
    const first = await loadRuntimeRevocations(base);
    assertEquals([first.source, first.list?.revoked[0].version], ["network", "3.0.0-denext.3"]);
    assertEquals(srv.hits(), 1);
    // Within the TTL: the cache, no request.
    now += 11 * 3600_000;
    assertEquals((await loadRuntimeRevocations(base)).source, "cache");
    assertEquals(srv.hits(), 1);
    // Past it: fetched again. Cache-only never is.
    now += 2 * 3600_000;
    assertEquals((await loadRuntimeRevocations({ ...base, mode: "cache-only" })).source, "cache");
    assertEquals(srv.hits(), 1);
    assertEquals((await loadRuntimeRevocations(base)).source, "network");
    assertEquals(srv.hits(), 2);
    // `force` always fetches.
    await loadRuntimeRevocations({ ...base, mode: "force" });
    assertEquals(srv.hits(), 3);
    // A cache changed on disk is re-verified on read, and ignored.
    await Deno.writeTextFile(join(dir, "revocations.json"), doc.replace("glibc", "GLIBC"));
    const tampered = await loadRuntimeRevocations({ ...base, mode: "cache-only" });
    assertEquals(tampered.list, null);
    // A cache read with another key verifies nothing either.
    const other = await keyPair();
    await Deno.writeTextFile(join(dir, "revocations.json"), doc);
    assertEquals(
      (await loadRuntimeRevocations({ ...base, mode: "cache-only", keys: [other.pub] })).list,
      null,
    );
  } finally {
    await srv.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadRuntimeRevocations: a hanging server costs at most the budget; offline keeps the cached list", async () => {
  const { key, pub } = await keyPair();
  const doc = await signed(listAt(), key);
  let hang = false;
  const pending: Array<() => void> = [];
  const srv = server(() =>
    hang
      ? new Promise<Response>((resolve) => pending.push(() => resolve(new Response(doc))))
      : new Response(doc)
  );
  const dir = await Deno.makeTempDir();
  try {
    let now = NOW + 1000;
    const base = {
      cacheRoot: dir,
      keys: [pub],
      urls: [srv.url, srv.url],
      netGranted: granted,
      now: () => now,
      env: () => undefined,
    };
    assertEquals((await loadRuntimeRevocations(base)).source, "network");
    // The server stops answering; the cache is stale.
    hang = true;
    now += 13 * 3600_000;
    const started = performance.now();
    const slow = await loadRuntimeRevocations(base);
    const took = performance.now() - started;
    assert(took < REVOCATION_FETCH_BUDGET_MS + 700, `took ${took} ms`);
    assert(took >= REVOCATION_FETCH_BUDGET_MS - 100, `gave up early: ${took} ms`);
    assertEquals(slow.source, "cache");
    assertEquals(slow.list?.sequence, listAt().sequence, "the cached list is still in force");
    // A failed fetch is not retried on every command: an hour of quiet.
    const hits = srv.hits();
    now += 10 * 60_000;
    assertEquals((await loadRuntimeRevocations(base)).source, "cache");
    assertEquals(srv.hits(), hits);
    // No network permission (`--deny-net`, a least-privilege process): not even tried.
    now += 2 * 3600_000;
    const denied = await loadRuntimeRevocations({
      ...base,
      netGranted: () => Promise.resolve(false),
    });
    assertEquals([denied.source, srv.hits()], ["cache", hits]);
    // Offline: the cached list.
    const offline = await loadRuntimeRevocations({
      ...base,
      mode: "force",
      fetch: () => Promise.reject(new TypeError("network unreachable")),
    });
    assertEquals(offline.source, "cache");
    assertEquals(offline.list?.revoked.length, 1);
  } finally {
    for (const r of pending) r();
    await srv.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadRuntimeRevocations: the mirror when the primary fails; replays, oversize and expiry refused", async () => {
  const { key, pub } = await keyPair();
  const older = listAt([], NOW - 2 * DAY);
  const newer = listAt([ENTRY], NOW);
  let primary: () => Response = () => new Response("down", { status: 503 });
  const one = server(() => primary());
  const two = server(async () => new Response(await signed(newer, key)));
  const dir = await Deno.makeTempDir();
  try {
    let now = NOW + 1000;
    const base = {
      cacheRoot: dir,
      keys: [pub],
      urls: [one.url, two.url],
      netGranted: granted,
      now: () => now,
      env: () => undefined,
      mode: "force" as const,
    };
    const mirrored = await loadRuntimeRevocations(base);
    assertEquals([mirrored.source, mirrored.list?.sequence], ["network", newer.sequence]);
    assertEquals([one.hits(), two.hits()], [1, 1]);
    // An older list (a replay) from the primary is refused: the mirror's newer one stands.
    const olderDoc = await signed(older, key);
    primary = () => new Response(olderDoc);
    assertEquals((await loadRuntimeRevocations(base)).list?.sequence, newer.sequence);
    // An oversized body is refused while it streams.
    primary = () => new Response("x".repeat(REVOCATION_MAX_BYTES + 1));
    assertEquals((await loadRuntimeRevocations(base)).list?.sequence, newer.sequence);
    // Once every copy has expired, none is in force, and the expired one is reported.
    now = Date.parse(newer.expiresAt) + 1;
    primary = () => new Response("down", { status: 500 });
    const lapsed = await loadRuntimeRevocations(base);
    assertEquals(lapsed.list, null);
    assertEquals(lapsed.expired?.sequence, newer.sequence);
    const status = revocationStatus(lapsed, decideRevocation(null, []), "1.0.0", null);
    const line = revocationStatusLine(status);
    assertFalse(line.ok);
    assertStringIncludes(line.detail, "EXPIRED");
  } finally {
    await one.close();
    await two.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("verifyRevocationDocument refuses a list dated more than a day ahead of the clock", async () => {
  const { key, pub } = await keyPair();
  // A signer whose clock ran two days fast: its sequence (Unix seconds) and issuedAt are ahead.
  const ahead = listAt([ENTRY], NOW + 2 * DAY);
  const doc = await signed(ahead, key);
  assertEquals(await refused(verifyRevocationDocument(doc, [pub], { now: NOW })), "future");
  // A sequence forged far ahead with an honest issuedAt is refused the same way.
  const forged = { ...listAt(), sequence: Number.MAX_SAFE_INTEGER };
  assertEquals(
    await refused(verifyRevocationDocument(await signed(forged, key), [pub], { now: NOW })),
    "future",
  );
  // Within a day of skew: accepted.
  const slightly = listAt([ENTRY], NOW + REVOCATION_MAX_FUTURE_MS - 1000);
  assertEquals(
    (await verifyRevocationDocument(await signed(slightly, key), [pub], { now: NOW }))?.sequence,
    slightly.sequence,
  );
});

Deno.test("loadRuntimeRevocations: a forged bookkeeping sequence can't raise the replay floor", async () => {
  const { key, pub } = await keyPair();
  let served = await signed(listAt([], NOW), key);
  const srv = server(() => new Response(served));
  const dir = await Deno.makeTempDir();
  try {
    let now = NOW + 1000;
    const base = {
      cacheRoot: dir,
      keys: [pub],
      urls: [srv.url],
      netGranted: granted,
      now: () => now,
      env: () => undefined,
      mode: "force" as const,
    };
    assertEquals((await loadRuntimeRevocations(base)).source, "network");
    // Something with a same-user write sets the floor to the largest sequence there is, under
    // the right key set — every genuine list would be a replay from then on.
    const statePath = join(dir, "revocations.state.json");
    const state = JSON.parse(await Deno.readTextFile(statePath));
    assertEquals(state.keys, await revocationKeySetId([pub]));
    await Deno.writeTextFile(
      statePath,
      JSON.stringify({ ...state, sequence: Number.MAX_SAFE_INTEGER }),
    );
    now += DAY;
    const newer = listAt([ENTRY], now - 1000);
    served = await signed(newer, key);
    const after = await loadRuntimeRevocations(base);
    assertEquals([after.source, after.list?.sequence], ["network", newer.sequence]);
    // An older list is still a replay: the floor is the cached list's own (signed) sequence.
    served = await signed(listAt([], NOW - DAY), key);
    assertEquals((await loadRuntimeRevocations(base)).list?.sequence, newer.sequence);
  } finally {
    await srv.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadRuntimeRevocations: bookkeeping written under another key set is ignored", async () => {
  const { key, pub } = await keyPair();
  const doc = await signed(listAt(), key);
  const srv = server(() => new Response(doc));
  const dir = await Deno.makeTempDir();
  try {
    const now = NOW + 1000;
    // Fresh (fetched a minute ago) and far ahead — but written under other keys (a test's).
    await Deno.writeTextFile(
      join(dir, "revocations.state.json"),
      JSON.stringify({
        schema: 1,
        keys: await revocationKeySetId(["someone-else"]),
        sequence: Number.MAX_SAFE_INTEGER,
        fetchedAt: now - 60_000,
      }),
    );
    const got = await loadRuntimeRevocations({
      cacheRoot: dir,
      keys: [pub],
      urls: [srv.url],
      netGranted: granted,
      now: () => now,
      env: () => undefined,
    });
    // Its fetch time didn't hold the fetch off, and its sequence didn't refuse the list.
    assertEquals([got.source, srv.hits()], ["network", 1]);
    assertEquals(got.list?.sequence, listAt().sequence);
  } finally {
    await srv.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadRuntimeRevocations: a run on the test keys file writes nothing to the cache", async () => {
  const { key, pub } = await keyPair();
  const doc = await signed(listAt(), key);
  const srv = server(() => new Response(doc));
  const dir = await Deno.makeTempDir();
  try {
    const got = await loadRuntimeRevocations({
      cacheRoot: dir,
      keys: [pub],
      urls: [srv.url],
      netGranted: granted,
      now: () => NOW + 1000,
      env: (k) => k === REVOCATION_KEYS_FILE_ENV ? "/test/keys.json" : undefined,
    });
    assertEquals(got.source, "network");
    assertEquals([...Deno.readDirSync(dir)], [], "no list, no bookkeeping");
    // A failed fetch on test keys records nothing either.
    await loadRuntimeRevocations({
      cacheRoot: dir,
      keys: [pub],
      urls: [srv.url],
      netGranted: () => Promise.resolve(false),
      now: () => NOW + 1000,
      env: (k) => k === REVOCATION_KEYS_FILE_ENV ? "/test/keys.json" : undefined,
    });
    assertEquals([...Deno.readDirSync(dir)], []);
  } finally {
    await srv.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadRuntimeRevocations asks every source at once: a stale primary can't hide a newer mirror list", async () => {
  const { key, pub } = await keyPair();
  const older = await signed(listAt([], NOW - 2 * DAY), key);
  const newer = listAt([ENTRY], NOW);
  let hang = false;
  const pending: Array<() => void> = [];
  const primary = server(() =>
    hang
      ? new Promise<Response>((resolve) => pending.push(() => resolve(new Response(older))))
      : new Response(older)
  );
  const mirror = server(async () => new Response(await signed(newer, key)));
  const dir = await Deno.makeTempDir();
  try {
    const base = {
      cacheRoot: dir,
      keys: [pub],
      urls: [primary.url, mirror.url],
      netGranted: granted,
      now: () => NOW + 1000,
      env: () => undefined,
      mode: "force" as const,
    };
    // A fresh machine (no floor yet): the primary's older, still-valid list answers first, yet
    // the mirror's newer one is taken.
    const got = await loadRuntimeRevocations(base);
    assertEquals([got.source, got.list?.sequence], ["network", newer.sequence]);
    assertEquals([primary.hits(), mirror.hits()], [1, 1]);
    // A primary that never answers doesn't use up the mirror's time: one budget for both.
    await Deno.remove(dir, { recursive: true });
    await Deno.mkdir(dir);
    hang = true;
    const started = performance.now();
    const slow = await loadRuntimeRevocations({ ...base, budgetMs: 800 });
    const took = performance.now() - started;
    assertEquals(slow.list?.sequence, newer.sequence);
    assert(took < 800 + 700, `took ${took} ms`);
  } finally {
    for (const r of pending) r();
    await primary.close();
    await mirror.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadRuntimeRevocations: a list below the compiled-in floor is never taken, cached or fetched", async () => {
  const { key, pub } = await keyPair();
  const list = listAt();
  const doc = await signed(list, key);
  const srv = server(() => new Response(doc));
  const dir = await Deno.makeTempDir();
  try {
    const base = {
      cacheRoot: dir,
      keys: [pub],
      urls: [srv.url],
      netGranted: granted,
      now: () => NOW + 1000,
      env: () => undefined,
      mode: "force" as const,
    };
    // At the floor: taken (and cached).
    assertEquals(
      (await loadRuntimeRevocations({ ...base, minSequence: list.sequence })).source,
      "network",
    );
    // A release cut after a newer list was published: this one is a replay, fetched or cached.
    const above = { ...base, minSequence: list.sequence + 1 };
    assertEquals((await loadRuntimeRevocations(above)).list, null);
    assertEquals((await loadRuntimeRevocations({ ...above, mode: "cache-only" })).list, null);
    // The default is the floor compiled into this release.
    assertEquals(RUNTIME_REVOCATION_MIN_SEQUENCE, 0);
  } finally {
    await srv.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findRevocation / decideRevocation: targets, rollback, and moving together", () => {
  const list = listAt([
    ENTRY,
    { component: "desktop", version: "3.0.0-denext.3", reason: "laufey crash" },
    { component: "cli", version: "3.0.0-denext.1", reason: "older bug" },
  ]);
  assertEquals(findRevocation(list, "cli", "3.0.0-denext.3", LINUX), ENTRY);
  assertEquals(findRevocation(list, "cli", "3.0.0-denext.3", MAC), null, "another target");
  assertEquals(findRevocation(list, "cli", "3.0.0-denext.3", undefined), null);
  assertEquals(
    findRevocation(list, "desktop", "3.0.0-denext.3", undefined)?.reason,
    "laufey crash",
  );
  assertEquals(findRevocation(null, "cli", "3.0.0-denext.3", LINUX), null);

  const cli = (rollback: string | null, triple = LINUX) => ({
    component: "cli" as const,
    version: "3.0.0-denext.3",
    rollback,
    triple,
  });
  assertEquals(decideRevocation(list, [cli("3.0.0-denext.2")]), {
    hit: ENTRY,
    triple: LINUX,
    useRollback: true,
  });
  assertFalse(decideRevocation(list, [cli(null)]).useRollback, "no rollback pinned");
  assertFalse(decideRevocation(list, [cli("3.0.0-denext.1")]).useRollback, "a revoked rollback");
  assertEquals(decideRevocation(list, [cli("3.0.0-denext.2", MAC)]).hit, null);
  // The desktop runtime revoked alone takes the CLI back with it; one without a rollback holds both.
  const desktop = (rollback: string | null) => ({
    component: "desktop" as const,
    version: "3.0.0-denext.3",
    rollback,
    triple: MAC,
  });
  const both = decideRevocation(list, [cli("3.0.0-denext.2", MAC), desktop("3.0.0-denext.2")]);
  assertEquals([both.hit?.component, both.useRollback], ["desktop", true]);
  assertFalse(decideRevocation(list, [cli("3.0.0-denext.2", MAC), desktop(null)]).useRollback);
  assertEquals(decideRevocation(null, [cli("x")]), { hit: null, useRollback: false });
});

Deno.test("revocationNotice / revokedShipRefusal: one line each, with the fix", () => {
  assertEquals(
    revocationNotice(ENTRY, LINUX, "3.0.0-denext.2"),
    "denext: Deno toolchain 3.0.0-denext.3 is revoked for x86_64-unknown-linux-gnu (crashes on " +
      "start under glibc 2.27; https://example.test/advisory). Running 3.0.0-denext.2 instead. " +
      "Fixed in denext 4.10.3: run `denext upgrade`.",
  );
  const stuck = revocationNotice(
    { ...ENTRY, component: "desktop", fixedIn: undefined },
    undefined,
    null,
  );
  assertStringIncludes(stuck, "Deno Desktop runtime 3.0.0-denext.3 is revoked for this host");
  assertStringIncludes(
    stuck,
    "Still running it; no safe fallback is pinned. `denext upgrade`, or DENEXT_DENO=<path>.",
  );
  assertFalse(stuck.includes("Fixed in"));

  const refusal = revokedShipRefusal(ENTRY, LINUX, "compile onto", () => undefined)!;
  assertStringIncludes(refusal, "refusing to compile onto the Deno toolchain 3.0.0-denext.3");
  assertStringIncludes(refusal, `${ALLOW_REVOKED_RUNTIME_ENV}=3.0.0-denext.3`);
  const allow = (v: string) => (k: string) => k === ALLOW_REVOKED_RUNTIME_ENV ? v : undefined;
  assertEquals(revokedShipRefusal(ENTRY, LINUX, "compile onto", allow("3.0.0-denext.3")), null);
  assert(revokedShipRefusal(ENTRY, undefined, "x", allow("3.0.0-denext.2")), "another version");
});

Deno.test("assertRuntimeShippable: refuses a revoked runtime for the target, unless allowed", async () => {
  const { key, pub } = await keyPair();
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "revocations.json"), await signed(listAt(), key));
    const opts = (env: Record<string, string> = {}) => ({
      mode: "cache-only" as const,
      cacheRoot: dir,
      keys: [pub],
      now: () => NOW + 1000,
      env: (k: string) => env[k],
    });
    const err = await assertRejects(() =>
      assertRuntimeShippable("cli", "3.0.0-denext.3", LINUX, "compile onto", opts())
    );
    assertStringIncludes((err as Error).message, "refusing to compile onto");
    await assertRuntimeShippable("cli", "3.0.0-denext.3", MAC, "compile onto", opts());
    await assertRuntimeShippable("cli", "3.0.0-denext.2", LINUX, "compile onto", opts());
    await assertRuntimeShippable(
      "cli",
      "3.0.0-denext.3",
      LINUX,
      "compile onto",
      opts({ [ALLOW_REVOKED_RUNTIME_ENV]: "3.0.0-denext.3" }),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("revocationStatus / revocationStatusLine", () => {
  const list = listAt();
  const loaded = { configured: true, list, source: "cache" as const, expired: null };
  const subject = { component: "cli" as const, version: "3.0.0-denext.3", triple: LINUX };
  const rolled = revocationStatus(
    loaded,
    decideRevocation(list, [{ ...subject, rollback: "3.0.0-denext.2" }]),
    "3.0.0-denext.3",
    "3.0.0-denext.2",
  );
  assertEquals(rolled, {
    configured: true,
    pinned: "3.0.0-denext.3",
    revoked: true,
    reason: ENTRY.reason,
    advisory: ENTRY.advisory!,
    fixedIn: ENTRY.fixedIn!,
    runningRollback: true,
    running: "3.0.0-denext.2",
    listSequence: list.sequence,
    listExpiresAt: list.expiresAt,
    expiredAt: null,
  });
  const line = revocationStatusLine(rolled);
  assertFalse(line.ok);
  assertStringIncludes(line.detail, `list #${list.sequence}`);
  assertStringIncludes(line.detail, "toolchain 3.0.0-denext.3 REVOKED");
  assertStringIncludes(line.detail, "running 3.0.0-denext.2 instead");
  const stuck = revocationStatus(
    loaded,
    decideRevocation(list, [{ ...subject, rollback: null }]),
    "3.0.0-denext.3",
    null,
  );
  assertStringIncludes(revocationStatusLine(stuck).detail, "still running it");
  const fine = revocationStatus(
    loaded,
    decideRevocation(list, [{ ...subject, triple: MAC, rollback: null }]),
    "3.0.0-denext.3",
    null,
  );
  assertEquals(revocationStatusLine(fine).ok, true);
  assertStringIncludes(revocationStatusLine(fine, "runtime X").detail, "runtime X not revoked");
  const empty = { configured: true, list: null, source: "none" as const, expired: null };
  assertStringIncludes(
    revocationStatusLine(revocationStatus(empty, decideRevocation(null, []), "1", null)).detail,
    "no list",
  );
  const off = { ...empty, configured: false };
  assertStringIncludes(
    revocationStatusLine(revocationStatus(off, decideRevocation(null, []), "1", null)).detail,
    "no revocation key configured",
  );
});
