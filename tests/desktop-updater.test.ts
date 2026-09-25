// The SIGNED desktop UI self-updater (src/desktop/updater.ts): fetch + verify (version
// recomputation, ECDSA P-256 signature, monotonic sequence, per-file SHA-256), stage, atomic
// promote, boot watchdog + rollback, and path-traversal refusal. No network: the global `fetch`
// is routed to an in-process `createOtaHandler` over a temp export dir.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  applyDesktopUpdate,
  checkForDesktopUpdate,
  desktopBooted,
  DesktopUpdateError,
  type DesktopUpdaterConfig,
  desktopUpdateReset,
  desktopUpdateStatus,
  prepareDesktopUpdate,
  resolveDesktopUiDir,
} from "../src/desktop/updater.ts";
import { makeOtaManifest, type OtaManifest, sha256Hex } from "../src/mobile/ota-manifest.ts";
import { writeOtaManifest } from "../src/build/ota-manifest.ts";
import {
  generateOtaKeyPair,
  importOtaSigningKey,
  signOtaManifest,
} from "../src/build/ota-signing.ts";
import { createOtaHandler } from "../src/server/ota-handler.ts";

const encoder = new TextEncoder();
const BASE = "/ui";
const FEED = `http://feed.test${BASE}`;

/** A fresh signing key pair plus its imported signing key. */
async function keys() {
  const pair = await generateOtaKeyPair();
  return { ...pair, signingKey: await importOtaSigningKey(pair.privateKeyPem) };
}

/** Route the global `fetch` to `serve`, restoring it when the returned dispose is called. */
function routeFetch(serve: () => (req: Request) => Promise<Response | null>): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(typeof input === "string" ? input : input.toString(), init);
    const res = await serve()(req);
    return res ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** Write two files into a fresh export dir. */
async function exportDir(appJs = "console.log(1)"): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_dupd_feed_" });
  await Deno.writeTextFile(join(dir, "index.html"), "<html></html>");
  await Deno.mkdir(join(dir, "_denext", "client"), { recursive: true });
  await Deno.writeTextFile(join(dir, "_denext", "client", "app.js"), appJs);
  return dir;
}

/** Write a hand-built manifest JSON to `<dir>/_denext/ota.json` (for tamper cases). */
async function writeManifestJson(dir: string, manifest: OtaManifest): Promise<void> {
  await Deno.mkdir(join(dir, "_denext"), { recursive: true });
  await Deno.writeTextFile(join(dir, "_denext", "ota.json"), JSON.stringify(manifest));
}

function cfg(dataDir: string, publicKey: string): DesktopUpdaterConfig {
  return { feedUrl: FEED, publicKey, dataDir, timeoutMs: 5_000 };
}

async function tmpData(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "denext_dupd_data_" });
}

Deno.test("desktop updater: a valid signed update downloads, verifies, applies and resolves the overlay", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir();
  const data = await tmpData();
  await writeOtaManifest(
    feed,
    { sequence: 100, required: false, notes: "First overlay" },
    signingKey,
  );
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    const check = await checkForDesktopUpdate(config);
    assert(check.available);
    assertEquals(check.notes, "First overlay");
    const version = check.version!;

    const prepared = await prepareDesktopUpdate(config);
    assertEquals(prepared.version, version);
    assertEquals(prepared.required, false);

    // A version is staged, none active yet.
    let status = await desktopUpdateStatus(config);
    assertEquals(status.staged, version);
    assertEquals(status.current, null);

    await applyDesktopUpdate(version, config);
    status = await desktopUpdateStatus(config);
    assertEquals(status.pending, version); // on trial until booted
    assertEquals(status.highestSequence, 100);

    // First trial launch: the overlay is served and the boot marker armed.
    const trialDir = await resolveDesktopUiDir("/bundled", config);
    assertEquals(await Deno.readTextFile(join(trialDir, "index.html")), "<html></html>");
    assertEquals(
      await Deno.readTextFile(join(trialDir, "_denext", "client", "app.js")),
      "console.log(1)",
    );

    // Confirm the boot; the overlay is now the confirmed active dir.
    await desktopBooted(config);
    status = await desktopUpdateStatus(config);
    assertEquals(status.current, version);
    assertEquals(status.pending, null);
    const goodDir = await resolveDesktopUiDir("/bundled", config);
    assertEquals(goodDir, trialDir);

    // Re-checking the same version is not an update.
    assertEquals((await checkForDesktopUpdate(config)).available, false);
  } finally {
    restore();
    await Deno.remove(feed, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("desktop updater: a tampered file (wrong SHA-256) is refused and staging discarded", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir();
  const data = await tmpData();
  await writeOtaManifest(feed, { sequence: 5 }, signingKey);
  // Change a file's bytes AFTER stamping: the served bytes no longer match the manifest SHA.
  await Deno.writeTextFile(join(feed, "_denext", "client", "app.js"), "TAMPERED");
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    // The check passes (it only verifies the manifest itself); prepare downloads and catches it.
    assert((await checkForDesktopUpdate(config)).available);
    const err = await assertRejects(() => prepareDesktopUpdate(config), DesktopUpdateError);
    assertEquals((err as DesktopUpdateError).code, "integrity");
    // Staging was discarded, nothing staged.
    assertEquals((await desktopUpdateStatus(config)).staged, null);
  } finally {
    restore();
    await Deno.remove(feed, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("desktop updater: a bad signature is refused", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir();
  const data = await tmpData();
  const signed = await writeOtaManifest(feed, { sequence: 3 }, signingKey);
  // Corrupt the signature (flip its first base64 char) — still a string, still 64-hex version.
  const badChar = signed.signature![0] === "A" ? "B" : "A";
  await writeManifestJson(feed, { ...signed, signature: badChar + signed.signature!.slice(1) });
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    const err = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals((err as DesktopUpdateError).code, "signature");
  } finally {
    restore();
    await Deno.remove(feed, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("desktop updater: an unsigned manifest is refused when a public key is configured", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir();
  const data = await tmpData();
  const signed = await writeOtaManifest(feed, { sequence: 3 }, signingKey);
  await writeManifestJson(feed, { ...signed, signature: undefined });
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    const err = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals((err as DesktopUpdateError).code, "unsigned");
  } finally {
    restore();
    await Deno.remove(feed, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("desktop updater: a version that does not match recomputation is refused (integrity)", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir();
  const data = await tmpData();
  const signed = await writeOtaManifest(feed, { sequence: 3 }, signingKey);
  // A wrong `version` (integrity is checked BEFORE the signature).
  await writeManifestJson(feed, { ...signed, version: "0".repeat(64) });
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    const err = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals((err as DesktopUpdateError).code, "integrity");
  } finally {
    restore();
    await Deno.remove(feed, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("desktop updater: a lower sequence is refused (downgrade)", async () => {
  const { publicKey, signingKey } = await keys();
  const dataA = await exportDir(); // version A, sequence 100
  const data = await tmpData();
  await writeOtaManifest(dataA, { sequence: 100 }, signingKey);
  const config = cfg(data, publicKey);

  // A separate, differently-versioned feed with a LOWER sequence.
  const dataB = await exportDir("console.log('B')");
  await writeOtaManifest(dataB, { sequence: 50 }, signingKey);

  let feedDir = dataA;
  const restore = routeFetch(() => createOtaHandler({ dir: feedDir, basePath: BASE }));
  try {
    // Accept A (sequence 100).
    const a = await checkForDesktopUpdate(config);
    await prepareDesktopUpdate(config);
    await applyDesktopUpdate(a.version!, config);
    assertEquals((await desktopUpdateStatus(config)).highestSequence, 100);

    // Now offer B (sequence 50 <= 100): refused as a downgrade.
    feedDir = dataB;
    const err = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals((err as DesktopUpdateError).code, "downgrade");
  } finally {
    restore();
    await Deno.remove(dataA, { recursive: true });
    await Deno.remove(dataB, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("desktop updater: a version that fails to boot rolls back and refuses its sequence", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir();
  const data = await tmpData();
  await writeOtaManifest(feed, { sequence: 100 }, signingKey);
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    const check = await checkForDesktopUpdate(config);
    const version = check.version!;
    await prepareDesktopUpdate(config);
    await applyDesktopUpdate(version, config);

    // First trial launch: the overlay is served, the marker armed.
    const trialDir = await resolveDesktopUiDir("/bundled", config);
    assert(trialDir !== "/bundled");

    // Simulate a crash: NO desktopBooted. The next launch detects the failed trial and rolls back.
    const rolled = await resolveDesktopUiDir("/bundled", config);
    assertEquals(rolled, "/bundled"); // no previous overlay → back to the bundle

    const status = await desktopUpdateStatus(config);
    assertEquals(status.current, null);
    assertEquals(status.pending, null);
    assertEquals(status.rejected, version);

    // The bad version's sequence stays refused, so it is never retried in a loop.
    const err = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals((err as DesktopUpdateError).code, "downgrade");

    // A reset clears the overlay state entirely.
    await desktopUpdateReset(config);
    assertEquals((await desktopUpdateStatus(config)).rejected, null);
  } finally {
    restore();
    await Deno.remove(feed, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("desktop updater: a traversal path in the manifest is refused", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir();
  const data = await tmpData();
  // A signed manifest whose file path escapes the export dir. `makeOtaManifest` allows the path
  // (it only bans control characters); the updater's `safeJoin` rejects the `..` segment.
  const evilSha = await sha256Hex(encoder.encode("evil"));
  const manifest = await signOtaManifest(
    await makeOtaManifest([{ path: "../evil.txt", sha256: evilSha, size: 4 }], { sequence: 9 }),
    signingKey,
  );
  await writeManifestJson(feed, manifest);
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    // The check passes (signature + version are valid); prepare refuses the unsafe path.
    assert((await checkForDesktopUpdate(config)).available);
    const err = await assertRejects(() => prepareDesktopUpdate(config), DesktopUpdateError);
    assertEquals((err as DesktopUpdateError).code, "invalid");
    assertEquals((await desktopUpdateStatus(config)).staged, null);
  } finally {
    restore();
    await Deno.remove(feed, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});
