// The SIGNED desktop UI self-updater (src/desktop/updater.ts): fetch + verify (version
// recomputation, ECDSA P-256 signature, monotonic sequence, per-file SHA-256), stage, atomic
// promote, boot watchdog + rollback, and path-traversal refusal. No network: the global `fetch`
// is routed to an in-process `createOtaHandler` over a temp export dir.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { osDataDir } from "../src/desktop/app-dirs.ts";
import {
  applyDesktopUpdate,
  checkForDesktopUpdate,
  desktopBooted,
  DesktopUpdateError,
  type DesktopUpdaterConfig,
  desktopUpdateReset,
  desktopUpdateStatus,
  openDesktopUi,
  prepareDesktopUpdate,
  resolveDesktopUiDir,
} from "../src/desktop/updater.ts";
import { desktopUiFiles } from "../src/build/desktop-ui-files.ts";
import { createDesktopHandler } from "../src/build/desktop.ts";
import { refuseReservedDataPath } from "../src/desktop/path-scope.ts";
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

Deno.test("desktop updater SECURITY (H3): a tampered active overlay is re-verified at launch and refused", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir();
  const data = await tmpData();
  await writeOtaManifest(feed, { sequence: 100 }, signingKey);
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    const version = (await checkForDesktopUpdate(config)).version!;
    await prepareDesktopUpdate(config);
    await applyDesktopUpdate(version, config);
    await desktopBooted(config);
    const good = await resolveDesktopUiDir("/bundled", config);
    assert(good !== "/bundled", "the verified overlay is served initially");

    // Tamper a served file AFTER apply — as a page write into the overlay dir would (the fs
    // reserved-path guard is the first line; launch re-verification is the defense in depth).
    await Deno.writeTextFile(join(good, "_denext", "client", "app.js"), "/* injected */ evil()");

    // Launch re-verification recomputes every file's SHA-256 against the signed manifest, so the
    // tampered overlay is NOT served — it falls back to the embedded bundle, and an injected script
    // cannot persist across relaunches or outlive a signed update.
    assertEquals(await resolveDesktopUiDir("/bundled", config), "/bundled");
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

// ---------------------------------------------------------------------------------------------
// Edge cases driven from hand-built overlay state: each test lays out the data dir (pointer,
// state, `versions/<v>`, `staging-<v>`) directly, so the updater's own guards are what is tested.

type Keys = Awaited<ReturnType<typeof keys>>;
type Files = Record<string, string>;

/** A manifest over `files` (path → text), signed with `k`. */
async function signedFiles(
  k: Keys,
  files: Files,
  meta: Parameters<typeof makeOtaManifest>[1] = {},
): Promise<OtaManifest> {
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      const bytes = encoder.encode(text);
      return { path, sha256: await sha256Hex(bytes), size: bytes.length };
    }),
  );
  return await signOtaManifest(await makeOtaManifest(entries, meta), k.signingKey);
}

/** Write `files` plus `manifest` (as `_denext/ota.json`) under `root`: an export or an overlay. */
async function layOut(root: string, manifest: OtaManifest, files: Files): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await Deno.mkdir(dirname(join(root, path)), { recursive: true });
    await Deno.writeTextFile(join(root, path), text);
  }
  await writeManifestJson(root, manifest);
}

function writePointer(
  data: string,
  version: string,
  pending: boolean,
  previous: { version: string | null; sequence: number | null } | null = null,
  sequence: number | null = null,
): Promise<void> {
  return Deno.writeTextFile(
    join(data, "current.json"),
    JSON.stringify({ version, sequence, pending, previous }),
  );
}

/** Run `f` with fresh keys and data dir, the global fetch routed to a feed served from `feed`. */
async function withFeed(
  f: (ctx: { k: Keys; data: string; feed: string; fetched: string[] }) => Promise<void>,
): Promise<void> {
  const k = await keys();
  const data = await tmpData();
  const feed = await Deno.makeTempDir({ prefix: "denext_dupd_feed_" });
  const fetched: string[] = [];
  const handler = createOtaHandler({ dir: feed, basePath: BASE });
  const restore = routeFetch(() => (req) => {
    fetched.push(new URL(req.url).pathname.slice(BASE.length + 1));
    return handler(req);
  });
  try {
    await f({ k, data, feed, fetched });
  } finally {
    restore();
    await Deno.remove(feed, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
}

/** Set (or, with `undefined`, delete) env vars for the duration of `f`. */
async function withEnv(
  vars: Record<string, string | undefined>,
  f: () => Promise<void>,
): Promise<void> {
  const saved = Object.keys(vars).map((name) => [name, Deno.env.get(name)] as const);
  const apply = (name: string, value: string | undefined) =>
    value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
  // Deletions first: Windows env names are case-insensitive, so deleting `http_proxy` after
  // setting `HTTP_PROXY` would delete the value just set.
  const deletionsFirst = <T>(list: ReadonlyArray<readonly [string, T | undefined]>) =>
    [...list].sort(([, a], [, b]) => Number(a !== undefined) - Number(b !== undefined));
  for (const [name, value] of deletionsFirst(Object.entries(vars))) apply(name, value);
  try {
    await f();
  } finally {
    for (const [name, value] of deletionsFirst(saved)) apply(name, value);
  }
}

const UI: Files = { "index.html": "<html>v1</html>", "a.js": "a()", "b.js": "b()" };

Deno.test("desktop updater: without dataDir the overlay lives in the OS app-support dir for appId", async () => {
  const home = await Deno.makeTempDir({ prefix: "denext_dupd_home_" });
  const noDir = { HOME: home, USERPROFILE: home, APPDATA: undefined, XDG_DATA_HOME: undefined };
  try {
    await withEnv(noDir, async () => {
      for (const appId of ["com.example.ui", undefined]) {
        const config: DesktopUpdaterConfig = { feedUrl: FEED, publicKey: "unused", appId };
        const expected = join(osDataDir(appId ?? "denext-desktop"), "ui-updates");
        assert(expected.startsWith(home), expected);
        // Nothing there yet: an empty status, and a reset is a no-op.
        assertEquals((await desktopUpdateStatus(config)).staged, null);
        await desktopUpdateReset(config);
        // A staging dir in exactly that directory is what status reports, and reset removes it.
        await Deno.mkdir(join(expected, "staging-abc"), { recursive: true });
        assertEquals((await desktopUpdateStatus(config)).staged, "abc");
        await desktopUpdateReset(config);
        assertEquals((await desktopUpdateStatus(config)).staged, null);
      }
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("desktop updater: transport failures are typed `network` (HTTP error, thrown fetch, timeout, bad JSON)", async () => {
  const data = await tmpData();
  // No timeoutMs: the 30 s default applies (the requests below settle long before it).
  const config: DesktopUpdaterConfig = { feedUrl: `${FEED}/`, publicKey: "k", dataDir: data };
  let serve: (req: Request) => Promise<Response | null> = () =>
    Promise.resolve(new Response("boom", { status: 503 }));
  const restore = routeFetch(() => serve);
  try {
    const http = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals(http.code, "network");
    assertStringIncludes(http.message, `HTTP 503 for ${FEED}/_denext/ota.json`);

    serve = () => Promise.reject(new TypeError("connection refused"));
    const refused = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals([refused.code, refused.message], [
      "network",
      "request failed: connection refused",
    ]);

    serve = () => Promise.reject("socket hang up"); // a non-Error rejection is stringified
    const hangUp = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals(hangUp.message, "request failed: socket hang up");

    serve = (req) =>
      new Promise((_, reject) =>
        req.signal.addEventListener("abort", () => reject(req.signal.reason))
      );
    const slow = await assertRejects(
      () => checkForDesktopUpdate({ ...config, timeoutMs: 20 }),
      DesktopUpdateError,
    );
    assertEquals([slow.code, slow.message], ["network", "request timed out after 20 ms"]);

    serve = () => Promise.resolve(new Response("{not json"));
    const json = await assertRejects(() => prepareDesktopUpdate(config), DesktopUpdateError);
    assertEquals([json.code, json.message], ["network", "the manifest is not valid JSON"]);

    serve = () => Promise.resolve(Response.json({ version: 1 }));
    const shape = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals(shape.code, "invalid");
  } finally {
    restore();
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("desktop updater: an invalid public key or a non-base64 signature is refused as `signature`", async () => {
  await withFeed(async ({ k, data, feed }) => {
    const manifest = await signedFiles(k, UI, { sequence: 1 });
    await layOut(feed, manifest, UI);
    const badKey = await assertRejects(
      () => checkForDesktopUpdate(cfg(data, "definitely not a key")),
      DesktopUpdateError,
    );
    assertEquals(badKey.code, "signature");
    assertStringIncludes(badKey.message, "the public key is invalid");

    await writeManifestJson(feed, { ...manifest, signature: "%%% not base64 %%%" });
    const garbled = await assertRejects(
      () => checkForDesktopUpdate(cfg(data, k.publicKey)),
      DesktopUpdateError,
    );
    assertEquals([garbled.code, garbled.message], [
      "signature",
      "the manifest signature does not verify",
    ]);
  });
});

Deno.test("desktop updater: HTTP(S)_PROXY routes through a proxy client (closed after), NO_PROXY bypasses it", async () => {
  const k = await keys();
  const feed = await Deno.makeTempDir({ prefix: "denext_dupd_feed_" });
  const data = await tmpData();
  await layOut(feed, await signedFiles(k, UI), UI);
  const handler = createOtaHandler({ dir: feed, basePath: BASE });
  const created: unknown[] = [];
  let closed = 0;
  const seenClients: unknown[] = [];
  const realFetch = globalThis.fetch;
  const realCreate = Object.getOwnPropertyDescriptor(Deno, "createHttpClient")!;
  Object.defineProperty(Deno, "createHttpClient", {
    configurable: true,
    value: (options: unknown) => {
      created.push(options);
      return { close: () => void closed++ };
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { client, ...rest } = init as RequestInit & { client?: unknown };
    seenClients.push(client);
    const url = new URL(String(input));
    url.protocol = "http:"; // the in-process feed answers either scheme
    return (await handler(new Request(url, rest))) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  const clear = {
    HTTP_PROXY: undefined,
    http_proxy: undefined,
    HTTPS_PROXY: undefined,
    https_proxy: undefined,
    NO_PROXY: undefined,
    no_proxy: undefined,
  };
  const check = (feedUrl = FEED) =>
    checkForDesktopUpdate({ feedUrl, publicKey: k.publicKey, dataDir: data });
  try {
    await withEnv({ ...clear, HTTP_PROXY: " http://proxy.corp:3128 " }, async () => {
      assert((await check()).available);
      assertEquals(created, [{ proxy: { url: "http://proxy.corp:3128" } }]);
      assertEquals(closed, 1, "the proxy client is closed once the body was read");
      assert(seenClients[0] !== undefined, "the request rides the proxy client");
    });
    for (const noProxy of ["intranet.example, ,.test", "feed.test", "*"]) {
      await withEnv(
        { ...clear, HTTP_PROXY: "http://proxy.corp:3128", NO_PROXY: noProxy },
        async () => {
          assert((await check()).available);
        },
      );
    }
    // An https feed reads HTTPS_PROXY (blank → no proxy), not HTTP_PROXY.
    await withEnv({ ...clear, HTTP_PROXY: "http://wrong:1", HTTPS_PROXY: "   " }, async () => {
      assert((await check("https://feed.test/ui")).available);
    });
    // A non-matching NO_PROXY entry leaves the proxy in place.
    await withEnv(
      { ...clear, HTTPS_PROXY: "http://tls.corp:8080", NO_PROXY: "other.example" },
      async () => {
        assert((await check("https://feed.test/ui")).available);
      },
    );
    assertEquals(created, [
      { proxy: { url: "http://proxy.corp:3128" } },
      { proxy: { url: "http://tls.corp:8080" } },
    ]);
    assertEquals(closed, 2);
    assertEquals(seenClients.filter((c) => c !== undefined).length, 2);
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(Deno, "createHttpClient", realCreate);
    await Deno.remove(feed, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("desktop updater: prepare reuses unchanged overlay files; a failed trial rolls back to the previous overlay", async () => {
  await withFeed(async ({ k, data, feed, fetched }) => {
    const config = cfg(data, k.publicKey);
    const v1 = await signedFiles(k, UI, { sequence: 1 });
    await layOut(feed, v1, UI);
    await prepareDesktopUpdate(config);
    await applyDesktopUpdate(v1.version, config);
    await resolveDesktopUiDir("/bundled", config);
    await desktopBooted(config);

    // v2 changes only b.js, is required and carries no notes.
    const ui2 = { ...UI, "b.js": "b2()" };
    const v2 = await signedFiles(k, ui2, { sequence: 2, required: true });
    await layOut(feed, v2, ui2);
    const check = await checkForDesktopUpdate(config);
    assertEquals([check.available, check.required, "notes" in check], [true, true, false]);

    fetched.length = 0;
    const prepared = await prepareDesktopUpdate(config);
    assertEquals(prepared, { version: v2.version, required: true, notes: null });
    assertEquals(fetched, ["_denext/ota.json", "b.js"], "unchanged files come from the overlay");

    // An overlay file that vanished is downloaded instead of reused.
    const v1Dir = join(data, "versions", v1.version);
    await Deno.remove(join(v1Dir, "a.js"));
    fetched.length = 0;
    await prepareDesktopUpdate(config);
    assertEquals(fetched.sort(), ["_denext/ota.json", "a.js", "b.js"]);
    await Deno.writeTextFile(join(v1Dir, "a.js"), UI["a.js"]);

    await applyDesktopUpdate(v2.version, config);
    assertEquals((await desktopUpdateStatus(config)).current, v1.version, "v1 until v2 boots");
    assert((await resolveDesktopUiDir("/bundled", config)).endsWith(v2.version));
    // v2 never confirmed: the next launch rolls back to the re-verified v1 overlay.
    assertEquals(await resolveDesktopUiDir("/bundled", config), v1Dir);
    const status = await desktopUpdateStatus(config);
    assertEquals(
      [status.current, status.pending, status.rejected, status.highestSequence],
      [v1.version, null, v2.version, 2],
    );
    // The rejected version cannot be applied again until a reset.
    const again = await assertRejects(() => applyDesktopUpdate(v2.version, config));
    assertEquals((again as DesktopUpdateError).code, "rejected");
  });
});

/** The rejected version and the active pointer's, after a launch rolled something back. */
async function rolledBack(config: DesktopUpdaterConfig): Promise<[string | null, string | null]> {
  const status = await desktopUpdateStatus(config);
  return [status.rejected, status.current ?? status.pending];
}

/** Whether `path` exists. */
function exists(path: string): Promise<boolean> {
  return Deno.lstat(path).then(() => true, () => false);
}

Deno.test("desktop updater: launch re-verification serves only a complete, signed overlay with an index.html; anything else is rolled back", async () => {
  await withFeed(async ({ k, data }) => {
    const config = cfg(data, k.publicKey);
    const resolveFor = async (version: string) => {
      await writePointer(data, version, false);
      return await resolveDesktopUiDir("/bundled", config);
    };
    // A malformed pointer is no pointer.
    await Deno.writeTextFile(join(data, "current.json"), "42");
    assertEquals(await resolveDesktopUiDir("/bundled", config), "/bundled");

    const good = await signedFiles(k, UI);
    // The pointer names a version with no overlay dir at all: rolled back, reported as rejected.
    assertEquals(await resolveFor(good.version), "/bundled");
    assertEquals(await rolledBack(config), [good.version, null]);
    // The overlay's manifest is for another version: rolled back, its folder deleted.
    await layOut(join(data, "versions", "other"), good, UI);
    assertEquals(await resolveFor("other"), "/bundled");
    assertEquals(await rolledBack(config), ["other", null]);
    assertEquals(await exists(join(data, "versions", "other")), false);
    // A signed manifest that names an escaping path.
    const escaping = await signedFiles(k, { "../escape.js": "x" });
    await writeManifestJson(join(data, "versions", escaping.version), escaping);
    assertEquals(await resolveFor(escaping.version), "/bundled");
    assertEquals(await rolledBack(config), [escaping.version, null]);
    // A listed file is missing from disk.
    const vdir = join(data, "versions", good.version);
    await layOut(vdir, good, UI);
    await Deno.remove(join(vdir, "b.js"));
    assertEquals(await resolveFor(good.version), "/bundled");
    assertEquals(await exists(vdir), false);
    await layOut(vdir, good, UI);
    assertEquals(await resolveFor(good.version), vdir, "control: the complete overlay is served");
    // Signed and intact, but the shell the runtime serves is absent.
    const shellless = await signedFiles(k, { "a.js": "a()" });
    await layOut(join(data, "versions", shellless.version), shellless, { "a.js": "a()" });
    assertEquals(await resolveFor(shellless.version), "/bundled");
    assertEquals(await rolledBack(config), [shellless.version, null]);
  });
});

Deno.test("desktop updater: launch re-verification refuses an overlay whose stored manifest changed after apply", async () => {
  await withFeed(async ({ k, data }) => {
    const config = cfg(data, k.publicKey);
    const good = await signedFiles(k, UI, { sequence: 5, notes: "signed notes" });
    const vdir = join(data, "versions", good.version);
    /** Lay the intact overlay out as the confirmed one, then apply `edit` to it and launch. */
    const launchAfter = async (edit: () => Promise<void>) => {
      await layOut(vdir, good, UI);
      await writePointer(data, good.version, false);
      await edit();
      return await resolveDesktopUiDir("/bundled", config);
    };
    assertEquals(await launchAfter(async () => {}), vdir, "control: the intact overlay");
    // A signed field edited in the stored manifest: the signature no longer verifies.
    assertEquals(
      await launchAfter(() => writeManifestJson(vdir, { ...good, notes: "edited notes" })),
      "/bundled",
    );
    assertEquals(await rolledBack(config), [good.version, null]);
    // The signature stripped.
    const { signature: _dropped, ...unsigned } = good;
    assertEquals(
      await launchAfter(() => writeManifestJson(vdir, unsigned as OtaManifest)),
      "/bundled",
    );
    // Re-signed by another key (the files and version intact).
    const other = await keys();
    const foreign = await signedFiles(other, UI, { sequence: 5, notes: "signed notes" });
    assertEquals(await launchAfter(() => writeManifestJson(vdir, foreign)), "/bundled");
    // A file and its manifest entry changed together: the version no longer matches.
    const forged = {
      ...good,
      files: await Promise.all(
        good.files.map(async (f) =>
          f.path === "a.js"
            ? { ...f, sha256: await sha256Hex(encoder.encode("evil()")), size: 6 }
            : f
        ),
      ),
    };
    assertEquals(
      await launchAfter(async () => {
        await Deno.writeTextFile(join(vdir, "a.js"), "evil()");
        await writeManifestJson(vdir, forged);
      }),
      "/bundled",
    );
    // Every launch checks again: intact, it is served again.
    assertEquals(await launchAfter(async () => {}), vdir);
  });
});

Deno.test("desktop updater: apply re-verifies the staging dir (missing, unsafe, absent or altered files)", async () => {
  await withFeed(async ({ k, data }) => {
    const config = cfg(data, k.publicKey);
    const code = async (version: string) =>
      ((await assertRejects(() => applyDesktopUpdate(version, config))) as DesktopUpdateError)
        .code;
    const manifest = await signedFiles(k, UI);
    const staging = join(data, `staging-${manifest.version}`);

    assertEquals(await code(manifest.version), "not_staged");
    const escaping = await signedFiles(k, { "../x.js": "x" });
    await writeManifestJson(join(data, `staging-${escaping.version}`), escaping);
    assertEquals(await code(escaping.version), "invalid");

    await layOut(staging, manifest, UI);
    await Deno.remove(join(staging, "a.js"));
    assertEquals(await code(manifest.version), "integrity");
    await Deno.writeTextFile(join(staging, "a.js"), "tampered()");
    assertEquals(await code(manifest.version), "integrity");

    // Restored, it applies; with no sequence accepted yet an unsequenced manifest has no floor.
    await Deno.writeTextFile(join(staging, "a.js"), UI["a.js"]);
    await applyDesktopUpdate(manifest.version, config);
    const status = await desktopUpdateStatus(config);
    assertEquals([status.pending, status.current, status.highestSequence], [
      manifest.version,
      null,
      null,
    ]);
  });
});

Deno.test("desktop updater: a pending overlay that fails re-verification on its first launch is rolled back", async () => {
  await withFeed(async ({ k, data }) => {
    const config = cfg(data, k.publicKey);
    // A malformed state file reads as the empty state.
    await Deno.writeTextFile(join(data, "state.json"), '"corrupt"');
    // Unsequenced, pending, nothing on disk, no previous overlay → the bundle, and it is rejected.
    await writePointer(data, "gone", true, null, null);
    assertEquals(await resolveDesktopUiDir("/bundled", config), "/bundled");
    let status = await desktopUpdateStatus(config);
    assertEquals([status.rejected, status.highestSequence, status.current], ["gone", null, null]);

    // With a previous, still-valid overlay the rollback serves it; the bad sequence is kept.
    const prev = await signedFiles(k, UI);
    await layOut(join(data, "versions", prev.version), prev, UI);
    await writePointer(data, "gone2", true, { version: prev.version, sequence: null }, 9);
    assertEquals(
      await resolveDesktopUiDir("/bundled", config),
      join(data, "versions", prev.version),
    );
    status = await desktopUpdateStatus(config);
    assertEquals([status.current, status.rejected, status.highestSequence], [
      prev.version,
      "gone2",
      9,
    ]);
  });
});

Deno.test("desktop updater: desktopBooted is best effort, and status/reset tolerate a missing data dir", async () => {
  await withFeed(async ({ k, data }) => {
    const config = cfg(data, k.publicKey);
    await desktopBooted(config); // nothing pending: a no-op
    await writePointer(data, "v", true);
    // The atomic write's temp path is occupied by a directory, so confirming cannot write.
    await Deno.mkdir(join(data, "current.json.tmp"));
    await desktopBooted(config); // must not throw
    assertEquals((await desktopUpdateStatus(config)).pending, "v");

    const missing = cfg(join(data, "does", "not", "exist"), k.publicKey);
    assertEquals(await desktopUpdateStatus(missing), {
      current: null,
      pending: null,
      staged: null,
      rejected: null,
      highestSequence: null,
    });
    await desktopUpdateReset(missing);
  });
});

Deno.test("desktop updater: an overlay is dropped once the app's bundled export changes (a new app)", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir("console.log('overlay')");
  const data = await tmpData();
  const bundled = await exportDir("console.log('app v1')");
  await writeOtaManifest(feed, { sequence: 100 }, signingKey);
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    // The app v1 launch records its bundle (index.html hash: the bundle is not stamped).
    assertEquals(await resolveDesktopUiDir(bundled, config), bundled);
    const version = (await checkForDesktopUpdate(config)).version!;
    await prepareDesktopUpdate(config);
    await applyDesktopUpdate(version, config);
    const overlay = await resolveDesktopUiDir(bundled, config);
    assert(overlay !== bundled, "the overlay is served over the bundle it was installed over");
    await desktopBooted(config);
    assertEquals(await resolveDesktopUiDir(bundled, config), overlay);

    // A newer app is installed: its bundle differs (here stamped, so its ota.json version names it).
    await Deno.writeTextFile(join(bundled, "index.html"), "<html>v2</html>");
    await writeOtaManifest(bundled, { sequence: 1 }, signingKey);
    assertEquals(await resolveDesktopUiDir(bundled, config), bundled);
    const status = await desktopUpdateStatus(config);
    assertEquals([status.current, status.pending, status.staged], [null, null, null]);
    // The accepted sequence survives, so the old overlay cannot be replayed onto the new app.
    assertEquals(status.highestSequence, 100);
    await assertRejects(() => prepareDesktopUpdate(config), DesktopUpdateError);
    // Same bundle on the next launch: nothing more is dropped.
    assertEquals(await resolveDesktopUiDir(bundled, config), bundled);
    // A reset forgets the bundle record too.
    await desktopUpdateReset(config);
    await Deno.stat(join(data, "bundle.json")).then(
      () => assert(false, "bundle.json survives a reset"),
      () => {},
    );
  } finally {
    restore();
    for (const d of [feed, data, bundled]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("desktop updater SECURITY (AU6-M1): an overlay older than the bundled export is a downgrade", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir("console.log('old overlay')");
  const bundled = await exportDir("console.log('bundled, newer')");
  const data = await tmpData();
  // The app ships a UI stamped with sequence 200; the feed offers an older signed UI (sequence 50).
  await writeOtaManifest(bundled, { sequence: 200 }, signingKey);
  await writeOtaManifest(feed, { sequence: 50 }, signingKey);
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    // First launch records the bundle; no overlay has been accepted yet.
    assertEquals(await resolveDesktopUiDir(bundled, config), bundled);
    assertEquals((await desktopUpdateStatus(config)).highestSequence, null);
    const err = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals((err as DesktopUpdateError).code, "downgrade");
    const prep = await assertRejects(() => prepareDesktopUpdate(config), DesktopUpdateError);
    assertEquals((prep as DesktopUpdateError).code, "downgrade");
    // A newer one is offered as usual.
    await writeOtaManifest(feed, { sequence: 201 }, signingKey);
    assertEquals((await checkForDesktopUpdate(config)).available, true);
  } finally {
    restore();
    for (const d of [feed, bundled, data]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("desktop updater: the feed offering the bundled export itself is not an update", async () => {
  const { publicKey, signingKey } = await keys();
  const bundled = await exportDir("console.log('same')");
  const data = await tmpData();
  await writeOtaManifest(bundled, { sequence: 300 }, signingKey);
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: bundled, basePath: BASE }));
  try {
    assertEquals(await resolveDesktopUiDir(bundled, config), bundled);
    assertEquals(await checkForDesktopUpdate(config), { available: false });
  } finally {
    restore();
    for (const d of [bundled, data]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("desktop updater SECURITY (AU6-L): apply refuses a version that is not a manifest version", async () => {
  const { publicKey } = await keys();
  const data = await tmpData();
  try {
    for (const version of ["../../etc", "x/../y", "", "ABC"]) {
      const err = await assertRejects(
        () => applyDesktopUpdate(version, cfg(data, publicKey)),
        DesktopUpdateError,
      );
      assertEquals((err as DesktopUpdateError).code, "not_staged");
    }
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("desktop updater SECURITY (AU6-L1): an expired manifest is refused, the running one included", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir("console.log('overlay')");
  const bundled = await exportDir("console.log('bundled')");
  const data = await tmpData();
  const past = Math.floor(Date.now() / 1000) - 60;
  await writeOtaManifest(bundled, { sequence: 100 }, signingKey);
  await writeOtaManifest(feed, { sequence: 101, expiresAt: past }, signingKey);
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    assertEquals(await resolveDesktopUiDir(bundled, config), bundled);
    const err = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals((err as DesktopUpdateError).code, "expired");
    const prep = await assertRejects(() => prepareDesktopUpdate(config), DesktopUpdateError);
    assertEquals((prep as DesktopUpdateError).code, "expired");
    // Re-signed with a fresh expiry: offered as usual.
    await writeOtaManifest(feed, { sequence: 102 }, signingKey);
    assertEquals((await checkForDesktopUpdate(config)).available, true);
  } finally {
    restore();
    for (const d of [feed, bundled, data]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("desktop updater SECURITY (AU6-L1): an expiry-aware bundle refuses an unexpiring overlay; an older bundle takes it", async () => {
  const { publicKey, signingKey } = await keys();
  const feed = await exportDir("console.log('overlay, no expiry')");
  const bundled = await exportDir("console.log('bundled')");
  const data = await tmpData();
  // The feed's manifest comes from older tooling: signed (v2), but without an expiry.
  const unexpiring = async () => {
    const stamped = await writeOtaManifest(feed, { sequence: 101 });
    const signed = await signOtaManifest(stamped, signingKey);
    await Deno.writeTextFile(join(feed, "_denext", "ota.json"), JSON.stringify(signed));
  };
  await unexpiring();
  const config = cfg(data, publicKey);
  const restore = routeFetch(() => createOtaHandler({ dir: feed, basePath: BASE }));
  try {
    // A bundle whose manifest carries an expiry (this tooling, signed): no unexpiring overlay.
    await writeOtaManifest(bundled, { sequence: 100 }, signingKey);
    assertEquals(await resolveDesktopUiDir(bundled, config), bundled);
    const err = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals((err as DesktopUpdateError).code, "expired");
    // A bundle from older tooling (no expiry): the migration path keeps taking it.
    const older = await signOtaManifest(
      await writeOtaManifest(bundled, { sequence: 100 }),
      signingKey,
    );
    await Deno.writeTextFile(join(bundled, "_denext", "ota.json"), JSON.stringify(older));
    assertEquals(await resolveDesktopUiDir(bundled, config), bundled);
    assertEquals((await checkForDesktopUpdate(config)).available, true);
  } finally {
    restore();
    for (const d of [feed, bundled, data]) await Deno.remove(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The overlay holds nothing but its signed files, each verified again when it is served (M1), and
// apply re-checks the downgrade floor and the expiry (L2).

const PRELOAD_PATH = "_denext/desktop-preload.js";

/** A bundled export (the app's own UI) in a fresh temp dir. */
async function bundledExport(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_dupd_bundle_" });
  await Deno.writeTextFile(join(dir, "index.html"), "<html>bundled</html>");
  await Deno.writeTextFile(join(dir, "a.js"), "bundled()");
  return dir;
}

/** Lay `files` out as the confirmed overlay in `data` and open the UI over `bundled`. */
async function openConfirmed(
  k: Keys,
  data: string,
  bundled: string,
  files: Files = UI,
  plant?: (vdir: string) => Promise<void>,
) {
  const manifest = await signedFiles(k, files, { sequence: 10 });
  const vdir = join(data, "versions", manifest.version);
  await layOut(vdir, manifest, files);
  await plant?.(vdir);
  await writePointer(data, manifest.version, false, null, 10);
  return { manifest, vdir, ui: await openDesktopUi(bundled, cfg(data, k.publicKey)) };
}

Deno.test("desktop updater SECURITY (M1): an overlay holding a file its manifest does not list is refused at launch", async () => {
  await withFeed(async ({ k, data }) => {
    const bundled = await bundledExport();
    try {
      const plants: Array<[string, (vdir: string) => Promise<void>]> = [
        ["an extra page", (v) => Deno.writeTextFile(join(v, "evil.html"), "<script>x()</script>")],
        ["an extra script", async (v) => {
          await Deno.mkdir(join(v, "_denext", "client"), { recursive: true });
          await Deno.writeTextFile(join(v, "_denext", "client", "evil.js"), "x()");
        }],
        // The preload is injected into every top-level page with the bridge token.
        ["a planted preload", (v) => Deno.writeTextFile(join(v, PRELOAD_PATH), "steal()")],
        ["a precompressed sibling", (v) => Deno.writeTextFile(join(v, "a.js.gz"), "gz")],
      ];
      for (const [what, plant] of plants) {
        const { manifest, vdir, ui } = await openConfirmed(k, data, bundled, UI, plant);
        assertEquals(ui.overlay, null, what);
        assertEquals(await rolledBack(cfg(data, k.publicKey)), [manifest.version, null], what);
        assertEquals(await exists(vdir), false, `${what}: the overlay folder is deleted`);
      }
      // Control: the same overlay without the plant is served.
      const { vdir, ui } = await openConfirmed(k, data, bundled);
      assertEquals(ui.overlay?.dir, vdir);
    } finally {
      await Deno.remove(bundled, { recursive: true });
    }
  });
});

Deno.test({
  name:
    "desktop updater SECURITY (M1): a symbolic link anywhere in the overlay is refused at launch",
  ignore: Deno.build.os === "windows", // creating a symlink needs a privilege there
  fn: async () => {
    await withFeed(async ({ k, data }) => {
      const bundled = await bundledExport();
      const outside = await Deno.makeTempDir({ prefix: "denext_dupd_outside_" });
      try {
        await Deno.writeTextFile(join(outside, "b.js"), UI["b.js"]);
        // A listed file replaced by a link to identical bytes elsewhere, and a linked directory.
        const linkedFile = await openConfirmed(k, data, bundled, UI, async (v) => {
          await Deno.remove(join(v, "b.js"));
          await Deno.symlink(join(outside, "b.js"), join(v, "b.js"));
        });
        assertEquals(linkedFile.ui.overlay, null);
        const linkedDir = await openConfirmed(k, data, bundled, UI, async (v) => {
          await Deno.symlink(outside, join(v, "assets"));
        });
        assertEquals(linkedDir.ui.overlay, null);
        assertEquals(
          (await desktopUpdateStatus(cfg(data, k.publicKey))).rejected,
          linkedDir.manifest.version,
        );
      } finally {
        for (const d of [bundled, outside]) await Deno.remove(d, { recursive: true });
      }
    });
  },
});

Deno.test("desktop updater SECURITY (M1): a file changed after launch is never served; the bundled UI is", async () => {
  await withFeed(async ({ k, data }) => {
    const bundled = await bundledExport();
    try {
      const { manifest, vdir, ui } = await openConfirmed(k, data, bundled);
      const files = desktopUiFiles(ui);
      const handle = createDesktopHandler({}, files, undefined, "token");
      const get = async (path: string) => {
        const res = await handle(
          new Request(`http://127.0.0.1:8000${path}`),
          new URL(`http://127.0.0.1:8000${path}`),
        );
        return [res.status, await res.text()] as const;
      };
      assertEquals(await get("/a.js"), [200, "a()"], "the verified overlay file");
      // Once the file is older than the settle window its stamp stands in for the hash…
      await new Promise((r) => setTimeout(r, 2_100));
      assertEquals(await get("/a.js"), [200, "a()"], "verified, its stamp recorded");
      assertEquals(await get("/a.js"), [200, "a()"], "again, by its verified stamp");
      // …until it is rewritten in place, size and mtime kept: the stamp's ctime still moves.
      const info = await Deno.stat(join(vdir, "a.js"));
      await Deno.writeTextFile(join(vdir, "a.js"), "x()");
      await Deno.utime(join(vdir, "a.js"), info.atime!, info.mtime!);
      assertEquals(await get("/a.js"), [200, "bundled()"], "the bundled export, not the change");
      assertEquals(ui.overlay!.withdrawn, true);
      assertEquals(await files.text("/index.html"), "<html>bundled</html>");
      assertEquals(await rolledBack(cfg(data, k.publicKey)), [manifest.version, null]);
    } finally {
      await Deno.remove(bundled, { recursive: true });
    }
  });
});

Deno.test("desktop updater SECURITY (M1): a file added or removed after launch withdraws the overlay", async () => {
  await withFeed(async ({ k, data }) => {
    const bundled = await bundledExport();
    try {
      // Added: a page the signed manifest does not list.
      const added = await openConfirmed(k, data, bundled);
      await Deno.writeTextFile(join(added.vdir, "evil.html"), "<script>x()</script>");
      assertEquals(await added.ui.overlay!.read("evil.html"), { status: "withdrawn" });
      assertEquals(await added.ui.overlay!.read("a.js"), { status: "withdrawn" });
      // Removed: a listed file gone.
      const removed = await openConfirmed(k, data, bundled);
      assertEquals((await removed.ui.overlay!.read("b.js")).status, "ok");
      await Deno.remove(join(removed.vdir, "b.js"));
      assertEquals(await removed.ui.overlay!.read("b.js"), { status: "withdrawn" });
      // A path that names nothing is only missing; a directory of the UI too.
      const intact = await openConfirmed(k, data, bundled, { ...UI, "assets/c.js": "c()" });
      assertEquals(await intact.ui.overlay!.read("nope.js"), { status: "missing" });
      assertEquals(await intact.ui.overlay!.read("assets"), { status: "missing" });
      assertEquals(await intact.ui.overlay!.read("../escape"), { status: "missing" });
      assertEquals(intact.ui.overlay!.withdrawn, false);
    } finally {
      await Deno.remove(bundled, { recursive: true });
    }
  });
});

Deno.test("desktop updater SECURITY (M1): the preload comes only from a verified manifest entry", async () => {
  await withFeed(async ({ k, data }) => {
    const bundled = await bundledExport();
    try {
      // Listed and intact: the overlay's own preload.
      const listed = await openConfirmed(k, data, bundled, { ...UI, [PRELOAD_PATH]: "bridge()" });
      assertEquals(await desktopUiFiles(listed.ui).preload(), "bridge()");
      // Not listed, planted after launch: never read; the overlay is withdrawn and the bundled
      // export (which has none) is what remains.
      const unlisted = await openConfirmed(k, data, bundled);
      await Deno.mkdir(join(unlisted.vdir, "_denext"), { recursive: true });
      await Deno.writeTextFile(join(unlisted.vdir, PRELOAD_PATH), "steal()");
      assertEquals(await desktopUiFiles(unlisted.ui).preload(), undefined);
      assertEquals(unlisted.ui.overlay!.withdrawn, true);
      // Listed but changed after launch: the bundled export's preload, not the change.
      await Deno.mkdir(join(bundled, "_denext"), { recursive: true });
      await Deno.writeTextFile(join(bundled, PRELOAD_PATH), "bundledBridge()");
      const changed = await openConfirmed(k, data, bundled, { ...UI, [PRELOAD_PATH]: "bridge()" });
      await Deno.writeTextFile(join(changed.vdir, PRELOAD_PATH), "steal()");
      assertEquals(await desktopUiFiles(changed.ui).preload(), "bundledBridge()");
    } finally {
      await Deno.remove(bundled, { recursive: true });
    }
  });
});

Deno.test("desktop updater SECURITY (M1): a custom dataDir is reserved from the page's capabilities", async () => {
  await withFeed(async ({ k }) => {
    const appData = await Deno.makeTempDir({ prefix: "denext_dupd_appdata_" });
    const bundled = await bundledExport();
    try {
      // The overlay kept outside the app-support folder's reserved `ui-updates`, under a folder the
      // page's fs capability may otherwise reach.
      const custom = join(appData, "my-ui");
      const target = join(custom, "versions", "v", "index.html");
      await refuseReservedDataPath(appData, target); // not reserved before the runtime opens it
      await openDesktopUi(bundled, { ...cfg(custom, k.publicKey) });
      const err = await assertRejects(() => refuseReservedDataPath(appData, target));
      assertStringIncludes((err as Error).message, "reserved for the desktop runtime");
      await assertRejects(() => refuseReservedDataPath(appData, custom));
      await refuseReservedDataPath(appData, join(appData, "my-ui-notes.txt")); // a sibling is not
    } finally {
      for (const d of [appData, bundled]) await Deno.remove(d, { recursive: true });
    }
  });
});

Deno.test("desktop updater SECURITY (L2): apply refuses a staged version that is now a downgrade or expired", async () => {
  await withFeed(async ({ k, data }) => {
    const config = cfg(data, k.publicKey);
    const code = async (version: string) =>
      ((await assertRejects(() => applyDesktopUpdate(version, config))) as DesktopUpdateError)
        .code;
    const stage = async (manifest: OtaManifest) =>
      await layOut(join(data, `staging-${manifest.version}`), manifest, UI);
    await Deno.writeTextFile(
      join(data, "state.json"),
      JSON.stringify({ highestSequence: 7, rejected: null }),
    );
    // Staged earlier, but a newer sequence was accepted since.
    const older = await signedFiles(k, UI, { sequence: 6 });
    await stage(older);
    assertEquals(await code(older.version), "downgrade");
    const same = await signedFiles(k, UI, { sequence: 7, notes: "same" });
    await stage(same);
    assertEquals(await code(same.version), "downgrade");
    const unsequenced = await signedFiles(k, UI, { notes: "none" });
    await stage(unsequenced);
    assertEquals(await code(unsequenced.version), "downgrade");
    // The bundled export's sequence is the floor too.
    await Deno.writeTextFile(
      join(data, "state.json"),
      JSON.stringify({ highestSequence: null, rejected: null }),
    );
    await Deno.writeTextFile(
      join(data, "bundle.json"),
      JSON.stringify({ bundle: "ota:x", sequence: 9 }),
    );
    const belowBundle = await signedFiles(k, UI, { sequence: 8, notes: "below" });
    await stage(belowBundle);
    assertEquals(await code(belowBundle.version), "downgrade");
    // Expired since it was staged.
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = await signedFiles(k, UI, { sequence: 20, expiresAt: past });
    await stage(expired);
    assertEquals(await code(expired.version), "expired");
    // None was applied.
    assertEquals((await desktopUpdateStatus(config)).pending, null);
  });
});

Deno.test("desktop updater SECURITY (L2): apply deletes every other staged version", async () => {
  await withFeed(async ({ k, data }) => {
    const config = cfg(data, k.publicKey);
    const v1 = await signedFiles(k, UI, { sequence: 1 });
    const ui2 = { ...UI, "b.js": "b2()" };
    const v2 = await signedFiles(k, ui2, { sequence: 2 });
    await layOut(join(data, `staging-${v1.version}`), v1, UI);
    await layOut(join(data, `staging-${v2.version}`), v2, ui2);
    await applyDesktopUpdate(v2.version, config);
    // v1 stays staged no longer: an apply call cannot bring it back.
    assertEquals(await exists(join(data, `staging-${v1.version}`)), false);
    assertEquals((await desktopUpdateStatus(config)).staged, null);
    assertEquals(await code(), "not_staged");
    async function code() {
      return ((await assertRejects(() =>
        applyDesktopUpdate(v1.version, config)
      )) as DesktopUpdateError)
        .code;
    }
  });
});
