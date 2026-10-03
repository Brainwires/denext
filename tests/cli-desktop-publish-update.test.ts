// `denext desktop publish-update` (src/cli/commands/desktop-publish-update.ts) driven through the
// `desktop` verb: the flags it requires, the defaults it reads from the project (the identifier
// from `desktop.app.identifier`, the version from deno.json), that nothing is written without a
// signing key, and that a signed run writes an archive + a manifest the public key verifies.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { desktopCommand } from "../src/cli/commands/desktop.ts";
import { APP_UPDATE_MANIFEST_FILE, verifyAppUpdateEnvelope } from "../src/build/app-update.ts";
import { generateOtaKeyPair, OTA_SIGNING_KEY_ENV } from "../src/build/ota-signing.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

const PLATFORM = "aarch64-apple-darwin-webview";

/** A project with an optional identifier / version and a fake packaged app. */
async function project(opts: { identifier?: string; version?: string; jsonc?: boolean } = {}) {
  const dir = await Deno.makeTempDir({ prefix: "denext_publish_update_" });
  const denoJson = opts.version === undefined ? {} : { version: opts.version };
  await Deno.writeTextFile(
    join(dir, opts.jsonc ? "deno.jsonc" : "deno.json"),
    (opts.jsonc ? "// a comment\n" : "") + JSON.stringify(denoJson),
  );
  if (opts.identifier) {
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default { desktop: { app: { identifier: ${JSON.stringify(opts.identifier)} } } };\n`,
    );
  }
  const app = join(dir, "dist", "My App.app", "Contents", "MacOS");
  await Deno.mkdir(app, { recursive: true });
  await Deno.writeTextFile(join(app, "app"), "#!/bin/sh\necho v2\n");
  return dir;
}

/** Run `desktop publish-update` in `dir`; returns the exit code (0 when it returned) and output. */
async function publish(dir: string, flags: Record<string, string>) {
  const cap = capture();
  const exit = stubExit();
  let code = 0;
  try {
    await desktopCommand.run(
      makeCtx({ positionals: ["publish-update"], flags, global: { cwd: dir } }),
    );
  } catch (err) {
    if (!String(err).includes("__exit__")) throw err;
    code = exit.calls[0];
  } finally {
    exit.restore();
    cap.restore();
  }
  return { code, out: cap.logs.join("\n"), err: cap.errs.join("\n") };
}

/** Run `fn` with the signing-key env var unset (restored after). */
async function withoutKeyEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get(OTA_SIGNING_KEY_ENV);
  Deno.env.delete(OTA_SIGNING_KEY_ENV);
  try {
    return await fn();
  } finally {
    if (prev !== undefined) Deno.env.set(OTA_SIGNING_KEY_ENV, prev);
  }
}

Deno.test("publish-update: --artifact and --url-base are required", async () => {
  const dir = await project({ identifier: "com.example.pub", version: "1.0.0" });
  try {
    let r = await publish(dir, {});
    assertEquals(r.code, 1);
    assertStringIncludes(
      r.err,
      "denext desktop publish-update: pass the packaged app with --artifact",
    );
    r = await publish(dir, { artifact: "dist/My App.app", "url-base": "" }); // empty = unset
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, "--url-base <https url>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publish-update: the identifier and version come from the project or the flags", async () => {
  const dir = await project({});
  const base = { artifact: "dist/My App.app", "url-base": "https://u.example.com/" };
  try {
    let r = await publish(dir, base);
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, "no app identifier: set desktop.app.identifier or pass --app-id");
    r = await publish(dir, { ...base, "app-id": "com.example.flag" });
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, 'no version: set deno.json "version" or pass --app-version');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publish-update: unsigned is refused — nothing is written without a key", async () => {
  const dir = await project({ identifier: "com.example.pub", version: "1.2.3" });
  try {
    const r = await withoutKeyEnv(() =>
      publish(dir, { artifact: "dist/My App.app", "url-base": "https://u.example.com/" })
    );
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, "a signing key is required (full-app updates are always signed)");
    assertStringIncludes(r.err, OTA_SIGNING_KEY_ENV);
    let wrote = true;
    await Deno.stat(join(dir, "dist", "updates")).catch(() => (wrote = false));
    assertEquals(wrote, false);
    // A key file that is not a key is an error too (never a silent unsigned publish).
    await Deno.writeTextFile(join(dir, "bad.pem"), "not a pem");
    const bad = await publish(dir, {
      artifact: "dist/My App.app",
      "url-base": "https://u.example.com/",
      key: join(dir, "bad.pem"),
    });
    assertEquals(bad.code, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publish-update: a signed run writes the archive and a manifest the public key verifies", async () => {
  const pair = await generateOtaKeyPair();
  const dir = await project({ identifier: "com.example.pub", version: "1.2.3", jsonc: true });
  try {
    const keyFile = join(dir, "update-key.pem");
    await Deno.writeTextFile(keyFile, pair.privateKeyPem);
    const r = await withoutKeyEnv(() =>
      publish(dir, {
        artifact: "dist/My App.app",
        "url-base": "https://u.example.com/rel/",
        key: keyFile,
        platform: PLATFORM,
        "min-version": "1.0.0",
        notes: "Faster.",
        out: "release",
      })
    );
    assertEquals(r.code, 0, r.err);
    // The version came from deno.jsonc (comments allowed), the identifier from the config.
    assertStringIncludes(r.out, `published com.example.pub 1.2.3 for ${PLATFORM}`);
    assertStringIncludes(r.out, `point desktop.update.manifestUrl at ${APP_UPDATE_MANIFEST_FILE}`);
    // The fake .app is not notarized (spctl rejects it, or is missing off macOS): published with
    // a warning, not refused.
    assertStringIncludes(r.err, "publish-update: warning:");
    assertStringIncludes(r.err, "DENEXT_NOTARY_PROFILE");
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "release", APP_UPDATE_MANIFEST_FILE)),
    );
    const payload = await verifyAppUpdateEnvelope(manifest, pair.publicKey);
    assertEquals(payload.app, "com.example.pub");
    assertEquals(payload.version, "1.2.3");
    assertEquals(payload.minVersion, "1.0.0");
    assertEquals(payload.releaseNotes, "Faster.");
    const entry = payload.platforms[PLATFORM];
    assert(entry.url.startsWith("https://u.example.com/rel/"));
    const archive = join(dir, "release", entry.url.slice("https://u.example.com/rel/".length));
    assertEquals((await Deno.stat(archive)).size, entry.size);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publish-update: --app-id / --app-version override the project; the env key signs", async () => {
  const pair = await generateOtaKeyPair();
  const dir = await project({ identifier: "com.example.pub", version: "1.2.3" });
  const prev = Deno.env.get(OTA_SIGNING_KEY_ENV);
  Deno.env.set(OTA_SIGNING_KEY_ENV, pair.privateKeyPem);
  try {
    const r = await publish(dir, {
      artifact: "dist/My App.app",
      "url-base": "https://u.example.com/",
      "app-id": "com.example.other",
      "app-version": "9.0.0",
      platform: PLATFORM,
    });
    assertEquals(r.code, 0, r.err);
    assertStringIncludes(r.out, `published com.example.other 9.0.0 for ${PLATFORM}`);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "dist", "updates", APP_UPDATE_MANIFEST_FILE)),
    );
    assertEquals(
      (await verifyAppUpdateEnvelope(manifest, pair.publicKey)).app,
      "com.example.other",
    );
    // An http URL base is refused by the publisher, surfaced as a CLI error.
    const insecure = await publish(dir, {
      artifact: "dist/My App.app",
      "url-base": "http://u.example.com/",
      platform: PLATFORM,
    });
    assertEquals(insecure.code, 1);
    assertStringIncludes(insecure.err, "https");
  } finally {
    if (prev === undefined) Deno.env.delete(OTA_SIGNING_KEY_ENV);
    else Deno.env.set(OTA_SIGNING_KEY_ENV, prev);
    await Deno.remove(dir, { recursive: true });
  }
});
