// The over-the-air UI manifest: the pinned version algorithm (src/mobile/ota-manifest.ts),
// the directory walk that writes `_denext/ota.json` (src/build/ota-manifest.ts), manifest
// signing (src/build/ota-signing.ts), the `denext ota manifest` / `denext ota keygen` verbs,
// and `createOtaHandler`'s serving rules (src/server/ota-handler.ts).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  isExcludedFromOtaManifest,
  isOtaManifest,
  isOtaManifestPath,
  makeOtaManifest,
  OTA_MANIFEST_PATH,
  OTA_NOTES_MAX_LENGTH,
  type OtaManifest,
  otaManifestVersion,
  otaSignaturePayload,
  sha256Hex,
} from "../src/mobile/ota-manifest.ts";
import {
  collectOtaManifest,
  defaultOtaSequence,
  writeOtaManifest,
} from "../src/build/ota-manifest.ts";
import {
  generateOtaKeyPair,
  importOtaSigningKey,
  loadOtaSigningKey,
  OTA_SIGNING_KEY_ENV,
  parseOtaPublicKey,
  signOtaManifest,
  verifyOtaManifest,
} from "../src/build/ota-signing.ts";
import { createOtaHandler } from "../src/server/ota-handler.ts";
import { buildRegistry } from "../src/cli/register.ts";

const encoder = new TextEncoder();

// Pinned: the build stamp, every server and every installed app compare versions derived by
// this algorithm, and an installed app compares against stamps written by older builds.
// Changing the output here makes every phone re-download a UI it already has. (The same
// fixture pins the T3 Code prototype this algorithm was ported from.)
const INDEX_HTML_SHA = "b633a587c652d02386c4f16f8c6f6aab7352d97f16367c3c40576214372dd628";
const APP_JS_SHA = "0a286891c11c056e1ab5bfc25bf5d6b2f5b06d38eac10944f678fd8a2e70c393";
const FIXTURE_VERSION = "ea8c7ce6dad4c988f73137f27a971e6840a0b5343fb10ce7a7fc6b5648372a9f";

Deno.test("ota manifest: hashes file bytes as lowercase hex SHA-256", async () => {
  assertEquals(await sha256Hex(encoder.encode("<html></html>")), INDEX_HTML_SHA);
  assertEquals(await sha256Hex(encoder.encode("console.log(1)")), APP_JS_SHA);
});

Deno.test("ota manifest: versions the sorted path/sha lines, independent of input order", async () => {
  const files = [
    { path: "index.html", sha256: INDEX_HTML_SHA },
    { path: "_denext/client/app.js", sha256: APP_JS_SHA },
  ];
  assertEquals(await otaManifestVersion(files), FIXTURE_VERSION);
  assertEquals(await otaManifestVersion(files.toReversed()), FIXTURE_VERSION);
  // By construction: SHA-256 over "<path>\t<sha>\n" lines in path order.
  const lines = `_denext/client/app.js\t${APP_JS_SHA}\nindex.html\t${INDEX_HTML_SHA}\n`;
  assertEquals(await sha256Hex(encoder.encode(lines)), FIXTURE_VERSION);
});

Deno.test("ota manifest: any changed file changes the version", async () => {
  const changed = await otaManifestVersion([
    { path: "index.html", sha256: INDEX_HTML_SHA },
    { path: "_denext/client/app.js", sha256: INDEX_HTML_SHA },
  ]);
  assert(changed !== FIXTURE_VERSION);
});

Deno.test("ota manifest: makeOtaManifest sorts by path and stamps the version", async () => {
  const manifest = await makeOtaManifest([
    { path: "index.html", sha256: INDEX_HTML_SHA, size: 13 },
    { path: "_denext/client/app.js", sha256: APP_JS_SHA, size: 14 },
  ]);
  assertEquals(manifest.version, FIXTURE_VERSION);
  assertEquals(manifest.files.map((f) => f.path), ["_denext/client/app.js", "index.html"]);
});

Deno.test("ota manifest: leaves out .gz siblings and the manifest itself", () => {
  assertEquals(OTA_MANIFEST_PATH, "_denext/ota.json");
  assert(isExcludedFromOtaManifest("_denext/client/app.js.gz"));
  assert(isExcludedFromOtaManifest("_denext/ota.json"));
  assert(!isExcludedFromOtaManifest("_denext/client/app.js"));
  assert(!isExcludedFromOtaManifest("index.html"));
  assert(!isExcludedFromOtaManifest("nested/_denext/ota.json"));
});

Deno.test("ota manifest: isOtaManifest checks the shape", () => {
  const file = { path: "index.html", sha256: INDEX_HTML_SHA, size: 13 };
  assert(isOtaManifest({ version: FIXTURE_VERSION, files: [file] }));
  assert(!isOtaManifest(null));
  assert(!isOtaManifest({ version: "not-hex", files: [file] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION.toUpperCase(), files: [file] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION, files: [] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION, files: [{ ...file, size: -1 }] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION, files: [{ ...file, size: 1.5 }] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION, files: [{ ...file, path: "" }] }));
  assert(!isOtaManifest({ version: FIXTURE_VERSION, files: [{ ...file, sha256: "x" }] }));
});

Deno.test("ota manifest: required/notes are carried but never change the version", async () => {
  const files = [
    { path: "index.html", sha256: INDEX_HTML_SHA, size: 13 },
    { path: "_denext/client/app.js", sha256: APP_JS_SHA, size: 14 },
  ];
  const plain = await makeOtaManifest(files);
  assert(!("required" in plain) && !("notes" in plain), "no metadata keys unless given");
  const tagged = await makeOtaManifest(files, { required: true, notes: "Fixes sign-in" });
  assertEquals(tagged.version, FIXTURE_VERSION);
  assertEquals(tagged.required, true);
  assertEquals(tagged.notes, "Fixes sign-in");
  assertEquals((await makeOtaManifest(files, { required: false })).required, false);
  assertEquals(OTA_NOTES_MAX_LENGTH, 2000);
  await makeOtaManifest(files, { notes: "x".repeat(OTA_NOTES_MAX_LENGTH) });
  await assertRejects(
    () => makeOtaManifest(files, { notes: "x".repeat(OTA_NOTES_MAX_LENGTH + 1) }),
    RangeError,
    "limit is 2000",
  );
});

Deno.test("ota manifest: isOtaManifest checks required/notes and tolerates unknown keys", () => {
  const base = {
    version: FIXTURE_VERSION,
    files: [{ path: "index.html", sha256: INDEX_HTML_SHA, size: 13 }],
  };
  assert(isOtaManifest({ ...base, required: true, notes: "hi" }));
  assert(isOtaManifest({ ...base, required: false, notes: "" }));
  assert(isOtaManifest({ ...base, notes: "x".repeat(OTA_NOTES_MAX_LENGTH) }));
  assert(isOtaManifest({ ...base, somethingNew: 1 }));
  assert(!isOtaManifest({ ...base, required: "true" }));
  assert(!isOtaManifest({ ...base, required: null }));
  assert(!isOtaManifest({ ...base, notes: 1 }));
  assert(!isOtaManifest({ ...base, notes: null }));
  assert(!isOtaManifest({ ...base, notes: "x".repeat(OTA_NOTES_MAX_LENGTH + 1) }));
});

/** A web root with the two fixture files, a .gz sibling and a stale manifest. */
async function webRoot(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_" });
  await Deno.writeTextFile(join(dir, "index.html"), "<html></html>");
  await Deno.mkdir(join(dir, "_denext", "client"), { recursive: true });
  await Deno.writeTextFile(join(dir, "_denext", "client", "app.js"), "console.log(1)");
  await Deno.writeTextFile(join(dir, "_denext", "client", "app.js.gz"), "gz bytes");
  await Deno.writeTextFile(join(dir, "_denext", "ota.json"), "{stale}");
  return dir;
}

Deno.test("writeOtaManifest: walks the web root and writes _denext/ota.json", async () => {
  const dir = await webRoot();
  try {
    const manifest = await writeOtaManifest(dir);
    assertEquals(manifest, {
      version: FIXTURE_VERSION,
      files: [
        { path: "_denext/client/app.js", sha256: APP_JS_SHA, size: 14 },
        { path: "index.html", sha256: INDEX_HTML_SHA, size: 13 },
      ],
    });
    const written = JSON.parse(await Deno.readTextFile(join(dir, "_denext", "ota.json")));
    assertEquals(written, manifest);
    // Rewriting is stable: the manifest never covers itself.
    assertEquals(await collectOtaManifest(dir), manifest);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeOtaManifest: refuses a directory without index.html", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_noindex_" });
  try {
    await assertRejects(() => writeOtaManifest(dir), Error, "has no index.html");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext ota manifest <dir> (re)writes the manifest", async () => {
  const dir = await webRoot();
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await buildRegistry().get("ota")!.run({
      positionals: ["manifest", dir],
      flags: {},
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
    const written = JSON.parse(await Deno.readTextFile(join(dir, "_denext", "ota.json")));
    assertEquals(written.version, FIXTURE_VERSION);
    assert(lines.some((l) => l.includes(FIXTURE_VERSION)), lines.join("\n"));
  } finally {
    console.log = log;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext ota manifest --required --notes writes the metadata; omitted flags omit the keys", async () => {
  const dir = await webRoot();
  const log = console.log;
  console.log = () => {};
  const run = (flags: Record<string, string | boolean>) =>
    buildRegistry().get("ota")!.run({
      positionals: ["manifest", dir],
      flags,
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
  const written = async () =>
    JSON.parse(await Deno.readTextFile(join(dir, "_denext", "ota.json"))) as Record<
      string,
      unknown
    >;
  try {
    await run({ required: true, notes: "Fixes sign-in" });
    const tagged = await written();
    assertEquals(tagged.version, FIXTURE_VERSION);
    assertEquals(tagged.required, true);
    assertEquals(tagged.notes, "Fixes sign-in");
    assert(isOtaManifest(tagged));

    await run({ notes: "Just notes" });
    const notesOnly = await written();
    assert(!("required" in notesOnly), JSON.stringify(notesOnly));
    assertEquals(notesOnly.notes, "Just notes");

    await run({});
    const plain = await written();
    assert(!("required" in plain) && !("notes" in plain), JSON.stringify(plain));
    assertEquals(plain.version, FIXTURE_VERSION);
  } finally {
    console.log = log;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext ota: --required and --notes are declared flags", () => {
  const flags = buildRegistry().get("ota")!.flags ?? [];
  assertEquals(
    flags.map((f) => [f.name, f.type]),
    [
      ["required", "boolean"],
      ["notes", "string"],
      ["sign", "string"],
      ["sequence", "number"],
      ["min-native", "number"],
      ["native-fingerprint", "string"],
      ["dir", "string"],
      ["force", "boolean"],
    ],
  );
});

Deno.test("createOtaHandler: serves the manifest and only the files it lists, no-store", async () => {
  const dir = await webRoot();
  try {
    await writeOtaManifest(dir);
    await Deno.writeTextFile(join(dir, "later.txt"), "added after the manifest");
    const ota = createOtaHandler({ dir, basePath: "/ui/" });
    const get = (path: string, method = "GET") =>
      ota(new Request(`http://host${path}`, { method }));

    const manifest = await get("/ui/_denext/ota.json");
    assertEquals(manifest?.status, 200);
    assertEquals(manifest?.headers.get("cache-control"), "no-store");
    assert(isOtaManifest(await manifest!.json()));

    const app = await get("/ui/_denext/client/app.js");
    assertEquals(await app?.text(), "console.log(1)");
    assertEquals(app?.headers.get("cache-control"), "no-store");
    assertEquals(app?.headers.get("content-type")?.split(";")[0], "text/javascript");
    const head = await get("/ui/index.html", "HEAD");
    assertEquals(head?.status, 200);
    assertEquals(await head?.text(), "");

    // A file written after the stamp, the .gz sibling, a traversal and anything outside the
    // base path or not GET/HEAD are not the handler's.
    assertEquals(await get("/ui/later.txt"), null);
    assertEquals(await get("/ui/_denext/client/app.js.gz"), null);
    assertEquals(await get("/ui/../index.html"), null);
    assertEquals(await get("/index.html"), null);
    assertEquals(await get("/ui/index.html", "POST"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createOtaHandler: nothing is served without a manifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_none_" });
  try {
    await Deno.writeTextFile(join(dir, "index.html"), "<html></html>");
    const ota = createOtaHandler({ dir });
    assertEquals(await ota(new Request("http://host/index.html")), null);
    assertEquals(await ota(new Request("http://host/_denext/ota.json")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Signing: ECDSA P-256 / SHA-256 over the canonical payload (the native side builds the same).

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

Deno.test("ota signature: the canonical payload is the tagged version, required flag and notes hash", async () => {
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const notesSha = await sha256Hex(encoder.encode("Fixes sign-in"));
  assertEquals(
    text(
      await otaSignaturePayload({
        version: FIXTURE_VERSION,
        required: true,
        notes: "Fixes sign-in",
      }),
    ),
    `denext-ota-v1\n${FIXTURE_VERSION}\n1\n${notesSha}`,
  );
  // No notes hash as the empty string; an absent or false `required` is "0". No trailing newline.
  assertEquals(await sha256Hex(encoder.encode("")), EMPTY_SHA);
  assertEquals(
    text(await otaSignaturePayload({ version: FIXTURE_VERSION })),
    `denext-ota-v1\n${FIXTURE_VERSION}\n0\n${EMPTY_SHA}`,
  );
  assertEquals(
    await otaSignaturePayload({ version: FIXTURE_VERSION, required: false, notes: "" }),
    await otaSignaturePayload({ version: FIXTURE_VERSION }),
  );
  // Notes are hashed as UTF-8, and never embedded raw.
  const payload = text(await otaSignaturePayload({ version: FIXTURE_VERSION, notes: "Größe ✓" }));
  assertEquals(payload.split("\n")[3], await sha256Hex(encoder.encode("Größe ✓")));
  assertEquals(payload.split("\n").length, 4);
});

const FILES = [
  { path: "index.html", sha256: INDEX_HTML_SHA, size: 13 },
  { path: "_denext/client/app.js", sha256: APP_JS_SHA, size: 14 },
];

/** A fresh key pair plus its imported signing key. */
async function keys() {
  const pair = await generateOtaKeyPair();
  return { ...pair, signingKey: await importOtaSigningKey(pair.privateKeyPem) };
}

Deno.test("ota signature: sign/verify round-trips and binds version, required and notes", async () => {
  const { publicKey, signingKey } = await keys();
  const manifest = await signOtaManifest(
    await makeOtaManifest(FILES, { required: true, notes: "Fixes sign-in" }),
    signingKey,
  );
  assert(isOtaManifest(manifest));
  // Standard padded base64 of the raw 64-byte r‖s WebCrypto produces.
  assert(/^[A-Za-z0-9+/]{86}==$/.test(manifest.signature!), manifest.signature);
  assert(await verifyOtaManifest(manifest, publicKey));

  // Independently of the helper: WebCrypto verifies the raw signature over the payload.
  const spki = Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const raw = Uint8Array.from(atob(manifest.signature!), (c) => c.charCodeAt(0));
  assertEquals(raw.byteLength, 64);
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      raw,
      await otaSignaturePayload(manifest) as BufferSource,
    ),
  );

  const tampered: Array<[string, OtaManifest]> = [
    ["required flipped", { ...manifest, required: false }],
    ["required dropped", { ...manifest, required: undefined }],
    ["notes changed", { ...manifest, notes: "Fixes sign-in!" }],
    ["notes dropped", { ...manifest, notes: undefined }],
    ["version changed", { ...manifest, version: "0".repeat(64) }],
    [
      "a file swapped (version recomputed from the files)",
      { ...manifest, files: [{ ...FILES[0], sha256: APP_JS_SHA }, FILES[1]] },
    ],
    ["signature dropped", { ...manifest, signature: undefined }],
    ["signature garbage", { ...manifest, signature: "not base64!" }],
  ];
  for (const [label, bad] of tampered) assert(!(await verifyOtaManifest(bad, publicKey)), label);
  // Another key's public half rejects it.
  assert(!(await verifyOtaManifest(manifest, (await keys()).publicKey)), "wrong key");
});

Deno.test("ota signature: public keys parse from base64 SPKI or PEM, and only P-256", async () => {
  const { publicKey } = await keys();
  assertEquals(await parseOtaPublicKey(publicKey), publicKey);
  assertEquals(await parseOtaPublicKey(`  ${publicKey}\n`), publicKey);
  const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g)!.join("\n")}\n` +
    "-----END PUBLIC KEY-----\n";
  assertEquals(await parseOtaPublicKey(pem), publicKey);
  const p384 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, [
    "sign",
    "verify",
  ]);
  const p384Spki = btoa(
    String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("spki", p384.publicKey))),
  );
  await assertRejects(() => parseOtaPublicKey(p384Spki), Error, "P-256");
  await assertRejects(() => parseOtaPublicKey("hello"), Error, "P-256");
  await assertRejects(() => importOtaSigningKey(publicKey), Error, "PRIVATE KEY");
});

/** Run `denext ota <positionals>` with `flags`, returning what it logged. */
async function ota(
  positionals: string[],
  flags: Record<string, string | boolean | number> = {},
  json = false,
): Promise<string[]> {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await buildRegistry().get("ota")!.run({
      positionals,
      flags,
      global: { json, verbose: false, quiet: false },
      rest: [],
    });
  } finally {
    console.log = log;
  }
  return lines;
}

/** Run `fn` with DENEXT_OTA_SIGNING_KEY set to `value` (unset for undefined), then restore it. */
async function withSigningEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = Deno.env.get(OTA_SIGNING_KEY_ENV);
  if (value === undefined) Deno.env.delete(OTA_SIGNING_KEY_ENV);
  else Deno.env.set(OTA_SIGNING_KEY_ENV, value);
  try {
    await fn();
  } finally {
    if (saved === undefined) Deno.env.delete(OTA_SIGNING_KEY_ENV);
    else Deno.env.set(OTA_SIGNING_KEY_ENV, saved);
  }
}

Deno.test("denext ota keygen <out>: a 0600 PKCS#8 PEM, a one-line base64 SPKI .pub, the key printed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_keygen_" });
  const out = join(dir, "ota.key");
  try {
    const lines = await ota(["keygen", out]);
    const pem = await Deno.readTextFile(out);
    assert(pem.startsWith("-----BEGIN PRIVATE KEY-----\n"), pem);
    assert(pem.endsWith("-----END PRIVATE KEY-----\n"), pem);
    if (Deno.build.os !== "windows") assertEquals((await Deno.stat(out)).mode! & 0o777, 0o600);
    const pub = await Deno.readTextFile(`${out}.pub`);
    assertEquals(pub.split("\n").length, 2, "one line plus its newline");
    const publicKey = pub.trim();
    assertEquals(await parseOtaPublicKey(publicKey), publicKey);
    assert(lines.some((l) => l.includes(publicKey)), lines.join("\n"));
    // The pair belongs together.
    const signed = await signOtaManifest(
      await makeOtaManifest(FILES),
      await importOtaSigningKey(pem),
    );
    assert(await verifyOtaManifest(signed, publicKey));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext ota keygen: refuses to overwrite without --force; --force replaces with 0600", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_keygen_force_" });
  const out = join(dir, "ota.key");
  const exit = Deno.exit;
  const error = console.error;
  const errors: string[] = [];
  try {
    await Deno.writeTextFile(out, "keep me", { mode: 0o644 });
    Deno.exit = ((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof Deno.exit;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    await assertRejects(() => ota(["keygen", out]), Error, "exit 1");
    assertEquals(await Deno.readTextFile(out), "keep me");
    assert(errors.some((e) => e.includes("--force")), errors.join("\n"));
    await ota(["keygen", out], { force: true });
    assert((await Deno.readTextFile(out)).startsWith("-----BEGIN PRIVATE KEY-----"));
    if (Deno.build.os !== "windows") assertEquals((await Deno.stat(out)).mode! & 0o777, 0o600);
    // Rotation is loud: every binary embedding the old public key stops accepting updates.
    assert(errors.some((e) => e.includes("embeds the old")), errors.join("\n"));
    // Replaced through a temporary file: nothing is left behind.
    const names = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names.sort(), ["ota.key", "ota.key.pub"]);
  } finally {
    Deno.exit = exit;
    console.error = error;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext ota manifest --sign <keyfile> signs; DENEXT_OTA_SIGNING_KEY is the fallback; --sign wins", async () => {
  const dir = await webRoot();
  const flagKey = await keys();
  const envKey = await keys();
  const keyFile = join(dir, "..", `${dir.split(/[\\/]/).pop()}.key`);
  const written = async () =>
    JSON.parse(await Deno.readTextFile(join(dir, "_denext", "ota.json"))) as OtaManifest;
  try {
    await Deno.writeTextFile(keyFile, flagKey.privateKeyPem);
    await withSigningEnv(undefined, async () => {
      const lines = await ota(["manifest", dir], { sign: keyFile, notes: "hi" });
      assert(lines.some((l) => l.includes("signed")), lines.join("\n"));
      assert(await verifyOtaManifest(await written(), flagKey.publicKey));

      // No flag, no env: unsigned, as before.
      await ota(["manifest", dir]);
      assert(!("signature" in await written()));
      assertEquals(await loadOtaSigningKey(), undefined);
    });
    await withSigningEnv(envKey.privateKeyPem, async () => {
      const [json] = await ota(["manifest", dir], {}, true);
      assertEquals(JSON.parse(json).signed, true);
      assert(await verifyOtaManifest(await written(), envKey.publicKey));
      // --sign wins over the env var.
      await ota(["manifest", dir], { sign: keyFile });
      const manifest = await written();
      assert(await verifyOtaManifest(manifest, flagKey.publicKey));
      assert(!(await verifyOtaManifest(manifest, envKey.publicKey)));
    });
    await withSigningEnv("not a key", async () => {
      await assertRejects(() => loadOtaSigningKey(), Error, OTA_SIGNING_KEY_ENV);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(keyFile).catch(() => {});
  }
});

Deno.test("createOtaHandler: passes the manifest's signature through", async () => {
  const dir = await webRoot();
  try {
    const { publicKey, signingKey } = await keys();
    await writeOtaManifest(dir, { required: true }, signingKey);
    const ota = createOtaHandler({ dir });
    const served = await (await ota(new Request("http://host/_denext/ota.json")))!.json();
    assert(isOtaManifest(served));
    assert(typeof served.signature === "string");
    assert(await verifyOtaManifest(served, publicKey));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ota manifest: isOtaManifest accepts a string signature only", () => {
  const base = {
    version: FIXTURE_VERSION,
    files: [{ path: "index.html", sha256: INDEX_HTML_SHA, size: 13 }],
  };
  assert(isOtaManifest({ ...base, signature: "c2ln" }));
  assert(!isOtaManifest({ ...base, signature: 1 }));
  assert(!isOtaManifest({ ...base, signature: null }));
});

// ---------------------------------------------------------------------------------------------
// Control characters in paths: a tab or newline could forge the "<path>\t<sha256>\n" lines.

Deno.test("ota manifest: a path with a control character is refused everywhere (the \\t/\\n collision)", async () => {
  const H1 = INDEX_HTML_SHA;
  const H2 = APP_JS_SHA;
  // The repro: one entry whose path smuggles a second line hashes like two honest entries.
  const honest = [
    { path: "a.js", sha256: H1, size: 1 },
    { path: "b.js", sha256: H2, size: 1 },
  ];
  const forged = [{ path: `a.js\t${H1}\nb.js`, sha256: H2, size: 1 }];
  assertEquals(await otaManifestVersion(forged), await otaManifestVersion(honest));
  // ...so no side accepts such a path.
  const version = await otaManifestVersion(forged);
  assert(!isOtaManifest({ version, files: forged }));
  await assertRejects(() => makeOtaManifest(forged), RangeError, "control character");
  for (const bad of ["a\tb", "a\nb", "a\rb", "a\u0000b", "a\u001fb", "a\u007fb"]) {
    assert(!isOtaManifestPath(bad), JSON.stringify(bad));
    assert(!isOtaManifest({ version, files: [{ path: bad, sha256: H1, size: 1 }] }));
  }
  for (const good of ["index.html", "_denext/client/app.js", "héllo wörld.js", "a\u0080b"]) {
    assert(isOtaManifestPath(good), good);
  }
  assert(!isOtaManifestPath(""));
  assert(!isOtaManifestPath(1));
});

Deno.test("collectOtaManifest / createOtaHandler: a file named with a control character", async () => {
  const dir = await webRoot();
  try {
    // A POSIX file name may hold a tab; Windows refuses it, so there is nothing to test there.
    if (Deno.build.os === "windows") return;
    await Deno.writeTextFile(join(dir, "evil\tname.js"), "x");
    await assertRejects(() => collectOtaManifest(dir), RangeError, "control character");
    await Deno.remove(join(dir, "evil\tname.js"));
    await writeOtaManifest(dir);
    const ota = createOtaHandler({ dir });
    assertEquals(await ota(new Request("http://host/evil%09name.js")), null);
    assertEquals(await ota(new Request("http://host/index%00.html")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Signature payload v2: sequence (downgrade protection) and minNative (the native gate).

Deno.test("ota signature v2: the exact bytes, with and without minNative", async () => {
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const notesSha = await sha256Hex(encoder.encode("Fixes sign-in"));
  assertEquals(
    text(
      await otaSignaturePayload({
        version: FIXTURE_VERSION,
        required: true,
        notes: "Fixes sign-in",
        sequence: 1758700000,
        minNative: 42,
      }),
    ),
    `denext-ota-v2\n${FIXTURE_VERSION}\n1\n${notesSha}\n1758700000\n42`,
  );
  // No minNative: an empty last line (the payload still has six lines, no trailing newline).
  const bare = text(await otaSignaturePayload({ version: FIXTURE_VERSION, sequence: 0 }));
  assertEquals(bare, `denext-ota-v2\n${FIXTURE_VERSION}\n0\n${EMPTY_SHA}\n0\n`);
  assertEquals(bare.split("\n").length, 6);
  // No sequence: v1, byte-for-byte what 2.8 signed.
  assertEquals(
    text(await otaSignaturePayload({ version: FIXTURE_VERSION })),
    `denext-ota-v1\n${FIXTURE_VERSION}\n0\n${EMPTY_SHA}`,
  );
  // minNative alone cannot be signed (v1 has no room for it); malformed integers are refused.
  await assertRejects(
    () => otaSignaturePayload({ version: FIXTURE_VERSION, minNative: 3 }),
    RangeError,
    "sequence",
  );
  for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    await assertRejects(
      () => otaSignaturePayload({ version: FIXTURE_VERSION, sequence }),
      RangeError,
    );
  }
  await assertRejects(
    () => otaSignaturePayload({ version: FIXTURE_VERSION, sequence: 1, minNative: -2 }),
    RangeError,
  );
  // The public entry point exports the same function (the CHANGELOG promised it).
  const mobile = await import("../src/mobile/mod.ts");
  assertEquals(mobile.otaSignaturePayload, otaSignaturePayload);
});

Deno.test("ota signature v2: sign/verify binds sequence and minNative; v1 still verifies", async () => {
  const { publicKey, signingKey } = await keys();
  const v2 = await signOtaManifest(
    await makeOtaManifest(FILES, { sequence: 1758700000, minNative: 42, notes: "n" }),
    signingKey,
  );
  assert(isOtaManifest(v2));
  assert(await verifyOtaManifest(v2, publicKey));
  const tampered: Array<[string, OtaManifest]> = [
    ["sequence lowered", { ...v2, sequence: 1 }],
    ["sequence dropped (a v2 signature does not verify as v1)", { ...v2, sequence: undefined }],
    ["minNative changed", { ...v2, minNative: 41 }],
    ["minNative dropped", { ...v2, minNative: undefined }],
  ];
  for (const [label, bad] of tampered) assert(!(await verifyOtaManifest(bad, publicKey)), label);
  // A v1 manifest (no sequence) signs and verifies as before, and cannot gain a sequence.
  const v1 = await signOtaManifest(await makeOtaManifest(FILES), signingKey);
  assert(await verifyOtaManifest(v1, publicKey));
  assert(!(await verifyOtaManifest({ ...v1, sequence: 5 }, publicKey)));
  // minNative without a sequence cannot be signed.
  await assertRejects(
    async () => signOtaManifest(await makeOtaManifest(FILES, { minNative: 1 }), signingKey),
    RangeError,
  );
  await assertRejects(() => makeOtaManifest(FILES, { sequence: -1 }), RangeError, "sequence");
});

Deno.test("isOtaManifest: sequence and minNative are non-negative safe integers", () => {
  const base = {
    version: FIXTURE_VERSION,
    files: [{ path: "index.html", sha256: INDEX_HTML_SHA, size: 13 }],
  };
  assert(isOtaManifest({ ...base, sequence: 0, minNative: 7 }));
  for (const bad of [-1, 1.5, "1", null, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert(!isOtaManifest({ ...base, sequence: bad }), `sequence ${bad}`);
    assert(!isOtaManifest({ ...base, minNative: bad }), `minNative ${bad}`);
  }
});

Deno.test("writeOtaManifest: signing stamps a sequence (the Unix time) unless one is given", async () => {
  const dir = await webRoot();
  try {
    const { publicKey, signingKey } = await keys();
    const before = defaultOtaSequence();
    const signed = await writeOtaManifest(dir, {}, signingKey);
    assert(
      signed.sequence! >= before && signed.sequence! <= defaultOtaSequence(),
      `${signed.sequence}`,
    );
    assert(await verifyOtaManifest(signed, publicKey));
    assertEquals((await writeOtaManifest(dir, { sequence: 7 }, signingKey)).sequence, 7);
    // Unsigned: no sequence unless asked for.
    assert(!("sequence" in await writeOtaManifest(dir)));
    assertEquals((await writeOtaManifest(dir, { sequence: 3, minNative: 2 })).minNative, 2);
    assertEquals(defaultOtaSequence(1_758_700_000_999), 1_758_700_000);
    // Written atomically: no temporary file is left next to the manifest.
    const names = [];
    for await (const entry of Deno.readDir(join(dir, "_denext"))) names.push(entry.name);
    assertEquals(names.sort(), ["client", "ota.json"]);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(join(dir, "_denext", "ota.json"))).mode! & 0o777, 0o644);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext ota manifest --sequence / --min-native; --sign stamps a sequence by default", async () => {
  const dir = await webRoot();
  const { publicKey, privateKeyPem } = await keys();
  const keyFile = `${dir}.key`;
  const written = async () =>
    JSON.parse(await Deno.readTextFile(join(dir, "_denext", "ota.json"))) as OtaManifest;
  try {
    await Deno.writeTextFile(keyFile, privateKeyPem);
    await withSigningEnv(undefined, async () => {
      const lines = await ota(["manifest", dir], { sequence: 12, "min-native": 34 });
      assertEquals((await written()).sequence, 12);
      assertEquals((await written()).minNative, 34);
      assert(
        lines.some((l) => l.includes("sequence 12") && l.includes("min native 34")),
        lines.join("\n"),
      );
      const [json] = await ota(["manifest", dir], { sign: keyFile }, true);
      const report = JSON.parse(json);
      assert(report.sequence >= defaultOtaSequence() - 5, json);
      assertEquals(report.minNative, null);
      assert(await verifyOtaManifest(await written(), publicKey));
      await ota(["manifest", dir], { sign: keyFile, sequence: 99, "min-native": 3 });
      const manifest = await written();
      assertEquals([manifest.sequence, manifest.minNative], [99, 3]);
      assert(await verifyOtaManifest(manifest, publicKey));
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(keyFile).catch(() => {});
  }
});

// ---------------------------------------------------------------------------------------------
// Signature payload v3: nativeFingerprint (the native-layer gate), backward compatible with v2.

const FINGERPRINT = "ab".repeat(32);

Deno.test("ota signature v3: the exact bytes; without a fingerprint the payload stays v2", async () => {
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const notesSha = await sha256Hex(encoder.encode("Fixes sign-in"));
  assertEquals(
    text(
      await otaSignaturePayload({
        version: FIXTURE_VERSION,
        required: true,
        notes: "Fixes sign-in",
        sequence: 1758700000,
        minNative: 42,
        nativeFingerprint: FINGERPRINT,
      }),
    ),
    `denext-ota-v3\n${FIXTURE_VERSION}\n1\n${notesSha}\n1758700000\n42\n${FINGERPRINT}`,
  );
  // No minNative: its line stays, empty (seven lines, no trailing newline).
  const bare = text(
    await otaSignaturePayload({
      version: FIXTURE_VERSION,
      sequence: 0,
      nativeFingerprint: FINGERPRINT,
    }),
  );
  assertEquals(bare, `denext-ota-v3\n${FIXTURE_VERSION}\n0\n${EMPTY_SHA}\n0\n\n${FINGERPRINT}`);
  assertEquals(bare.split("\n").length, 7);
  // No fingerprint: byte-for-byte the v2 payload 2.9 signs.
  assertEquals(
    text(await otaSignaturePayload({ version: FIXTURE_VERSION, sequence: 5, minNative: 1 })),
    `denext-ota-v2\n${FIXTURE_VERSION}\n0\n${EMPTY_SHA}\n5\n1`,
  );
  // A fingerprint needs a sequence, and must be 64 lowercase hex digits.
  await assertRejects(
    () => otaSignaturePayload({ version: FIXTURE_VERSION, nativeFingerprint: FINGERPRINT }),
    RangeError,
    "sequence",
  );
  for (const bad of ["AB".repeat(32), "ab".repeat(31), `${"ab".repeat(31)}a\n`]) {
    await assertRejects(
      () => otaSignaturePayload({ version: FIXTURE_VERSION, sequence: 1, nativeFingerprint: bad }),
      RangeError,
      "nativeFingerprint",
    );
  }
});

Deno.test("ota signature v3: sign/verify binds nativeFingerprint; v2 manifests still verify", async () => {
  const { publicKey, signingKey } = await keys();
  const v3 = await signOtaManifest(
    await makeOtaManifest(FILES, {
      sequence: 1758700000,
      minNative: 42,
      nativeFingerprint: FINGERPRINT,
    }),
    signingKey,
  );
  assertEquals(v3.nativeFingerprint, FINGERPRINT);
  assert(isOtaManifest(v3));
  assert(await verifyOtaManifest(v3, publicKey));
  const tampered: Array<[string, OtaManifest]> = [
    ["fingerprint changed", { ...v3, nativeFingerprint: "cd".repeat(32) }],
    ["fingerprint dropped (a v3 signature does not verify as v2)", {
      ...v3,
      nativeFingerprint: undefined,
    }],
    ["minNative changed", { ...v3, minNative: 41 }],
    ["sequence changed", { ...v3, sequence: 1758700001 }],
  ];
  for (const [label, bad] of tampered) assert(!(await verifyOtaManifest(bad, publicKey)), label);
  // A v2 manifest (signed before v3 existed) verifies unchanged, and cannot gain a fingerprint.
  const v2 = await signOtaManifest(
    await makeOtaManifest(FILES, { sequence: 1758700000, minNative: 42 }),
    signingKey,
  );
  assertEquals(
    new TextDecoder().decode(await otaSignaturePayload(v2)).split("\n")[0],
    "denext-ota-v2",
  );
  assert(await verifyOtaManifest(v2, publicKey));
  assert(!(await verifyOtaManifest({ ...v2, nativeFingerprint: FINGERPRINT }, publicKey)));
  // Unsigned, a fingerprint may ride without a sequence; signing that is refused.
  const unsigned = await makeOtaManifest(FILES, { nativeFingerprint: FINGERPRINT });
  assertEquals(unsigned.nativeFingerprint, FINGERPRINT);
  await assertRejects(() => signOtaManifest(unsigned, signingKey), RangeError);
  await assertRejects(
    () => makeOtaManifest(FILES, { nativeFingerprint: "nope" }),
    RangeError,
    "nativeFingerprint",
  );
});

Deno.test("isOtaManifest: nativeFingerprint is 64 lowercase hex digits", () => {
  const base = {
    version: FIXTURE_VERSION,
    files: [{ path: "index.html", sha256: INDEX_HTML_SHA, size: 13 }],
  };
  assert(isOtaManifest({ ...base, nativeFingerprint: FINGERPRINT }));
  for (const bad of ["AB".repeat(32), "ab", 1, null, true]) {
    assert(!isOtaManifest({ ...base, nativeFingerprint: bad }), `nativeFingerprint ${bad}`);
  }
});

Deno.test("denext ota manifest --native-fingerprint <fp|auto> stamps the signed manifest", async () => {
  const dir = await webRoot();
  const project = await Deno.makeTempDir();
  const { publicKey, privateKeyPem } = await keys();
  const keyFile = `${dir}.key`;
  const written = async () =>
    JSON.parse(await Deno.readTextFile(join(dir, "_denext", "ota.json"))) as OtaManifest;
  try {
    await Deno.writeTextFile(keyFile, privateKeyPem);
    await Deno.writeTextFile(join(project, "capacitor.config.json"), `{"appId":"a.b"}`);
    await withSigningEnv(undefined, async () => {
      // An explicit value is normalised to lowercase.
      const [json] = await ota(
        ["manifest", dir],
        { sign: keyFile, "native-fingerprint": FINGERPRINT.toUpperCase() },
        true,
      );
      assertEquals(JSON.parse(json).nativeFingerprint, FINGERPRINT);
      assertEquals((await written()).nativeFingerprint, FINGERPRINT);
      assert(await verifyOtaManifest(await written(), publicKey));
      // auto: the fingerprint of the Capacitor project at --dir.
      const { computeNativeFingerprint } = await import("../src/build/mobile-fingerprint.ts");
      const expected = (await computeNativeFingerprint(project)).fingerprint;
      const lines = await ota(["manifest", dir], {
        sign: keyFile,
        "native-fingerprint": "auto",
        dir: project,
      });
      assertEquals((await written()).nativeFingerprint, expected);
      assert(await verifyOtaManifest(await written(), publicKey));
      assert(lines.some((l) => l.includes(`native ${expected.slice(0, 12)}`)), lines.join("\n"));
      // Without the flag, no fingerprint.
      await ota(["manifest", dir], { sign: keyFile });
      assert(!("nativeFingerprint" in await written()));
    });
    // A malformed value, or auto without a Capacitor project, exits non-zero.
    const failing: Array<Record<string, string>> = [
      { "native-fingerprint": "xyz" },
      { "native-fingerprint": "auto", dir },
    ];
    for (const flags of failing) {
      const exit = Deno.exit;
      const error = console.error;
      const errors: string[] = [];
      Deno.exit = ((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as typeof Deno.exit;
      console.error = (...a: unknown[]) => void errors.push(a.join(" "));
      try {
        await assertRejects(() => ota(["manifest", dir], flags), Error, "exit 1");
      } finally {
        Deno.exit = exit;
        console.error = error;
      }
      assert(errors.join("\n").includes("--native-fingerprint"), errors.join("\n"));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(project, { recursive: true });
    await Deno.remove(keyFile).catch(() => {});
  }
});

// ---------------------------------------------------------------------------------------------
// createOtaHandler CORS: the web app fetches the manifest with an Authorization header.

Deno.test("createOtaHandler: cors answers the preflight and tags responses for allowed origins", async () => {
  const dir = await webRoot();
  try {
    await writeOtaManifest(dir);
    const preflight = (ota: (r: Request) => Promise<Response | null>, origin: string) =>
      ota(
        new Request("http://host/ui/_denext/ota.json", {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        }),
      );
    const withCors = createOtaHandler({ dir, basePath: "/ui", cors: true });
    for (const origin of ["capacitor://localhost", "https://localhost", "http://localhost"]) {
      const res = await preflight(withCors, origin);
      assertEquals(res?.status, 204, origin);
      assertEquals(res?.headers.get("access-control-allow-origin"), origin);
      assertEquals(res?.headers.get("access-control-allow-headers"), "authorization");
      assertEquals(res?.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
      assertEquals(res?.headers.get("vary"), "Origin");
    }
    // Not an allowed origin, or no origin: not the handler's (the app answers it).
    assertEquals(await preflight(withCors, "https://evil.example"), null);
    const get = await withCors(
      new Request("http://host/ui/_denext/ota.json", {
        headers: { origin: "capacitor://localhost" },
      }),
    );
    assertEquals(get?.headers.get("access-control-allow-origin"), "capacitor://localhost");
    assertEquals(get?.headers.get("cache-control"), "no-store");
    const foreign = await withCors(
      new Request("http://host/ui/index.html", { headers: { origin: "https://evil.example" } }),
    );
    assertEquals(foreign?.status, 200);
    assertEquals(foreign?.headers.get("access-control-allow-origin"), null);
    assertEquals(foreign?.headers.get("vary"), "Origin");

    // An explicit origin (or list) allows exactly those.
    const one = createOtaHandler({ dir, basePath: "/ui", cors: "https://app.example" });
    assertEquals((await preflight(one, "https://app.example"))?.status, 204);
    assertEquals(await preflight(one, "capacitor://localhost"), null);
    const list = createOtaHandler({ dir, basePath: "/ui", cors: ["a://x", "b://y"] });
    assertEquals((await preflight(list, "b://y"))?.status, 204);

    // No cors option: no CORS headers, OPTIONS is not answered.
    const plain = createOtaHandler({ dir, basePath: "/ui" });
    assertEquals(await preflight(plain, "capacitor://localhost"), null);
    const res = await plain(
      new Request("http://host/ui/index.html", { headers: { origin: "capacitor://localhost" } }),
    );
    assertEquals(res?.headers.get("access-control-allow-origin"), null);
    assertEquals(res?.headers.get("vary"), null);
    // Outside the base path, even OPTIONS is not the handler's.
    assertEquals(
      await withCors(
        new Request("http://host/other", {
          method: "OPTIONS",
          headers: { origin: "capacitor://localhost" },
        }),
      ),
      null,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
