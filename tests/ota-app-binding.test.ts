// OTA app binding: a signed manifest names the app it is for (`appId`) and signs it in its own
// `appSignature` (the v5 payload), beside the v1–v4 `signature` older shells verify. A shell that
// knows its own id refuses another app's release (`app_mismatch`), and one that verifies
// signatures requires it, so a feed for app A cannot hand app B (sharing A's signing key) a
// validly signed UI. The native halves are covered by tests/ota-reverify.test.ts's harnesses.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  isOtaManifest,
  makeOtaManifest,
  otaAppMismatch,
  otaAppSignaturePayload,
  type OtaManifest,
  otaSignaturePayload,
} from "../src/mobile/ota-manifest.ts";
import { writeOtaManifest, writePlatformStamp } from "../src/build/ota-manifest.ts";
import {
  generateOtaKeyPair,
  importOtaSigningKey,
  signOtaManifest,
  verifyOtaManifest,
} from "../src/build/ota-signing.ts";
import { OTA_APP_ID_ENV, otaAppIdFor } from "../src/build/ota-app-id.ts";
import { createOtaHandler } from "../src/server/ota-handler.ts";
import { checkForUiUpdate, resetOtaStampForTesting } from "../src/mobile/ota.ts";
import { checkForDesktopUpdate, DesktopUpdateError } from "../src/desktop/updater.ts";
import { planMobileBuild } from "../src/build/mobile-build.ts";
import { buildRegistry } from "../src/cli/register.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;
const hex = (c: string) => c.repeat(64);
const INDEX = { path: "index.html", sha256: hex("c"), size: 13 };
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A web root with an index.html and, when `platform` is given, its stamp. */
async function exportDir(platform?: string, body = "<html></html>"): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_app_" });
  await Deno.writeTextFile(join(dir, "index.html"), body);
  if (platform) await writePlatformStamp(dir, platform);
  return dir;
}

Deno.test("otaAppSignaturePayload: the v5 bytes add the app id under their own first line", async () => {
  const version = hex("a");
  const notes = decode(await otaSignaturePayload({ version })).split("\n")[3];
  const v5 = decode(
    await otaAppSignaturePayload({
      version,
      required: true,
      sequence: 7,
      minNative: 3,
      expiresAt: 1_800_000_000,
      appId: "com.example.app",
    }),
  );
  assertEquals(v5, `denext-ota-v5\n${version}\n1\n${notes}\n7\n3\n\n1800000000\ncom.example.app`);
  // Absent fingerprint and expiry are empty lines; the v4 bytes never carry an app id.
  const bare = decode(await otaAppSignaturePayload({ version, sequence: 7, appId: "a.b" }));
  assertEquals(bare.split("\n").slice(-4), ["", "", "", "a.b"]);
  const v4 = decode(
    await otaSignaturePayload({ version, sequence: 7, expiresAt: 1, appId: "a.b" } as Any),
  );
  assert(v4.startsWith("denext-ota-v4\n") && !v4.includes("a.b"), v4);
  for (const bad of [undefined, "", "com.example/app", "a\nb", "x".repeat(256)]) {
    await assertRejects(
      () => otaAppSignaturePayload({ version, sequence: 7, appId: bad }),
      RangeError,
      "appId",
    );
  }
  await assertRejects(() => otaAppSignaturePayload({ version, appId: "a.b" }), RangeError);
});

Deno.test("manifest: an appId needs a sequence and an app id's characters; isOtaManifest checks it", async () => {
  const bound = await makeOtaManifest([INDEX], { sequence: 1, appId: "com.example.app" });
  assertEquals(bound.appId, "com.example.app");
  assert(isOtaManifest(bound));
  assert(!isOtaManifest({ ...bound, appId: "com example" }), "a space is not an app id");
  assert(!isOtaManifest({ ...bound, appSignature: 1 }), "appSignature is a string");
  await assertRejects(() => makeOtaManifest([INDEX], { appId: "com.example.app" }), RangeError);
  await assertRejects(
    () => makeOtaManifest([INDEX], { sequence: 1, appId: "com/example" }),
    RangeError,
    "appId",
  );
  assertEquals(bound.version, (await makeOtaManifest([INDEX])).version, "not part of the version");
});

Deno.test("signing: an appId gets its own appSignature; the v1–v4 signature is unchanged", async () => {
  const pair = await generateOtaKeyPair();
  const key = await importOtaSigningKey(pair.privateKeyPem);
  const verifyKey = await crypto.subtle.importKey(
    "spki",
    Uint8Array.from(atob(pair.publicKey), (c) => c.charCodeAt(0)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verifies = async (signature: string, payload: Uint8Array) =>
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
      payload as BufferSource,
    );
  const unsigned = await makeOtaManifest([INDEX], {
    sequence: 9,
    expiresAt: 2_000_000_000,
    appId: "com.example.app",
  });
  const signed = await signOtaManifest(unsigned, key);
  assert(signed.appSignature !== undefined);
  assert(await verifyOtaManifest(signed, pair.publicKey));
  // What a shell from before appId existed verifies: the v4 payload, without the app id.
  assert(await verifies(signed.signature!, await otaSignaturePayload(signed)));
  assert(await verifies(signed.appSignature!, await otaAppSignaturePayload(signed)));
  assert(!await verifies(signed.signature!, await otaAppSignaturePayload(signed)), "domains");
  // Another app's id under this appSignature, or none at all, does not verify.
  assert(!await verifyOtaManifest({ ...signed, appId: "com.example.other" }, pair.publicKey));
  const { appSignature: _, ...stripped } = signed;
  assert(!await verifyOtaManifest(stripped, pair.publicKey));
  // Re-signing without the app id drops the stale appSignature.
  const { appId: __, ...unbound } = signed;
  assertEquals((await signOtaManifest(unbound as OtaManifest, key)).appSignature, undefined);
});

Deno.test("otaAppMismatch: another app is refused; a missing id only when required", () => {
  const own = "com.example.app";
  assertEquals(otaAppMismatch({ appId: own }, own), null);
  assertStringIncludes(otaAppMismatch({ appId: "com.example.other" }, own)!, "released for");
  assertEquals(otaAppMismatch({}, own), null);
  assertStringIncludes(otaAppMismatch({}, own, true)!, "--app-id com.example.app --sign");
  assertEquals(otaAppMismatch({ appId: "x" }, undefined, true), null, "an unknown own id");
});

/** Run `fn` in a fake iOS shell whose DenextOta plugin reports `appId` and records applies. */
async function inShell(appId: string | undefined, fn: (applies: Any[]) => Promise<void>) {
  const saved = Object.getOwnPropertyDescriptor(g, "Capacitor");
  resetOtaStampForTesting();
  const applies: Any[] = [];
  g.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: {
      DenextOta: {
        status: () =>
          Promise.resolve({
            current: null,
            bundled: hex("b"),
            pending: null,
            ...(appId === undefined ? {} : { appId }),
          }),
        apply: (o: Any) => (applies.push(o), Promise.resolve({})),
        booted: () => Promise.resolve(),
        reset: () => Promise.resolve(),
      },
    },
  };
  try {
    await fn(applies);
  } finally {
    if (saved) Object.defineProperty(g, "Capacitor", saved);
    else delete g.Capacitor;
    resetOtaStampForTesting();
  }
}

Deno.test("checkForUiUpdate: another app's release is refused (app_mismatch) before the native side", async () => {
  const other = await makeOtaManifest([INDEX], { sequence: 3, appId: "com.example.other" });
  const own = await makeOtaManifest([INDEX], { sequence: 3, appId: "com.example.app" });
  const serve = (m: OtaManifest) => (() => Promise.resolve(Response.json(m))) as Any;
  await inShell("com.example.app", async (applies) => {
    const r = await checkForUiUpdate({ baseUrl: "https://ui.test", fetch: serve(other) });
    assertEquals(r.kind, "error");
    assertEquals((r as { code?: string }).code, "app_mismatch");
    assertEquals(applies.length, 0, "nothing reaches the native side");
    const ok = await checkForUiUpdate({ baseUrl: "https://ui.test", fetch: serve(own) });
    assertEquals(ok, { kind: "applied", version: own.version });
  });
  // A shell whose status predates appId: the app's own option decides.
  await inShell(undefined, async (applies) => {
    const r = await checkForUiUpdate({
      baseUrl: "https://ui.test",
      fetch: serve(other),
      appId: "com.example.app",
    });
    assertEquals((r as { code?: string }).code, "app_mismatch");
    // Without either, the page cannot tell: the native side checks it.
    const passed = await checkForUiUpdate({ baseUrl: "https://ui.test", fetch: serve(other) });
    assertEquals(passed.kind, "applied");
    assertEquals(applies.length, 1);
  });
  // A release naming no app is the native side's call (it requires one only with a key).
  await inShell("com.example.app", async () => {
    const unbound = await makeOtaManifest([INDEX], { sequence: 3 });
    const r = await checkForUiUpdate({ baseUrl: "https://ui.test", fetch: serve(unbound) });
    assertEquals(r.kind, "applied");
  });
});

Deno.test("desktop updater: with desktop.app.identifier only a release signed for this app is offered", async () => {
  const pair = await generateOtaKeyPair();
  const key = await importOtaSigningKey(pair.privateKeyPem);
  const mine = await exportDir("macos", "<html>MINE</html>");
  const theirs = await exportDir("macos", "<html>THEIRS</html>");
  const unbound = await exportDir("macos", "<html>OLD</html>");
  const data = await Deno.makeTempDir({ prefix: "denext_ota_app_data_" });
  const real = globalThis.fetch;
  let dir = theirs;
  let rewrite = (m: Any) => m;
  try {
    await writeOtaManifest(mine, { sequence: 5, appId: "com.example.app" }, key);
    await writeOtaManifest(theirs, { sequence: 5, appId: "com.example.other" }, key);
    await writeOtaManifest(unbound, { sequence: 5 }, key);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = (await createOtaHandler({ dir, basePath: "/ui" })(
        new Request(String(input), init),
      )) ?? new Response("missing", { status: 404 });
      if (!String(input).endsWith("/_denext/ota.json")) return res;
      return Response.json(rewrite(await res.json()));
    }) as typeof fetch;
    const config = {
      feedUrl: "http://feed.test/ui",
      publicKey: pair.publicKey,
      dataDir: data,
      platform: "macos" as const,
      appId: "com.example.app",
    };
    const code = async () =>
      (await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError)).code;
    assertEquals(await code(), "app_mismatch", "another app's validly signed release");
    dir = unbound;
    assertEquals(await code(), "app_mismatch", "a release that names no app");
    // The other app's appSignature relabelled with this app's id does not verify.
    dir = theirs;
    rewrite = (m) => ({ ...m, appId: "com.example.app" });
    assertEquals(await code(), "signature");
    rewrite = (m) => {
      const { appSignature: _, ...rest } = m;
      return rest;
    };
    dir = mine;
    assertEquals(await code(), "signature", "an appId without its appSignature");
    rewrite = (m) => m;
    const check = await checkForDesktopUpdate(config);
    assert(check.available);
    assertEquals(check.manifest?.appId, "com.example.app");
    // An updater configured without an app id keeps taking an unbound release.
    dir = unbound;
    const { appId: _, ...legacy } = config;
    assert((await checkForDesktopUpdate(legacy)).available);
  } finally {
    globalThis.fetch = real;
    for (const d of [mine, theirs, unbound, data]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("otaAppIdFor: the env wins; the Capacitor appId for a mobile export; desktop.app.identifier otherwise", async () => {
  const project = await Deno.makeTempDir({ prefix: "denext_ota_app_project_" });
  const saved = Deno.env.get(OTA_APP_ID_ENV);
  try {
    Deno.env.delete(OTA_APP_ID_ENV);
    await Deno.writeTextFile(
      join(project, "capacitor.config.json"),
      JSON.stringify({ appId: "com.example.app", appName: "App", webDir: "out" }),
    );
    const config = { desktop: { app: { identifier: "com.example.desktop" } } };
    assertEquals(await otaAppIdFor(project, "ios", config), "com.example.app");
    assertEquals(await otaAppIdFor(project, "android"), "com.example.app");
    assertEquals(await otaAppIdFor(project, "macos", config), "com.example.desktop");
    assertEquals(await otaAppIdFor(project, null, config), "com.example.desktop");
    assertEquals(await otaAppIdFor(project, "linux"), undefined);
    Deno.env.set(OTA_APP_ID_ENV, "com.example.app.beta");
    assertEquals(await otaAppIdFor(project, "ios"), "com.example.app.beta");
    Deno.env.set(OTA_APP_ID_ENV, "not an id");
    await assertRejects(() => otaAppIdFor(project, "ios"), RangeError, OTA_APP_ID_ENV);
  } finally {
    if (saved === undefined) Deno.env.delete(OTA_APP_ID_ENV);
    else Deno.env.set(OTA_APP_ID_ENV, saved);
    await Deno.remove(project, { recursive: true });
  }
});

Deno.test("denext ota manifest: --app-id signs the app; --sign alone takes the Capacitor appId; unbound warns", async () => {
  const project = await Deno.makeTempDir({ prefix: "denext_ota_app_cli_" });
  const out = join(project, "out");
  const pair = await generateOtaKeyPair();
  const keyFile = join(project, "ota.key");
  await Deno.writeTextFile(keyFile, pair.privateKeyPem);
  await exportInto(out, "ios");
  const errors: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = () => {};
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  const saved = Deno.env.get(OTA_APP_ID_ENV);
  Deno.env.delete(OTA_APP_ID_ENV);
  const run = (flags: Record<string, string | boolean>) =>
    buildRegistry().get("ota")!.run({
      positionals: ["manifest", out],
      flags: { dir: project, ...flags },
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
  const written = async (): Promise<OtaManifest> =>
    JSON.parse(await Deno.readTextFile(join(out, "_denext", "ota.json")));
  try {
    await run({ sign: keyFile });
    assertEquals((await written()).appId, undefined);
    assertStringIncludes(errors.join("\n"), "names no app");
    errors.length = 0;
    await Deno.writeTextFile(
      join(project, "capacitor.config.json"),
      JSON.stringify({ appId: "com.example.app", appName: "App", webDir: "out" }),
    );
    await run({ sign: keyFile });
    const auto = await written();
    assertEquals(auto.appId, "com.example.app");
    assert(await verifyOtaManifest(auto, pair.publicKey));
    assertEquals(errors, []);
    await run({ sign: keyFile, "app-id": "com.example.other" });
    assertEquals((await written()).appId, "com.example.other");
    // Unsigned: no app id unless asked for (an unsigned release keeps its old shape).
    await run({});
    assertEquals((await written()).appId, undefined);
  } finally {
    console.log = log;
    console.error = error;
    if (saved !== undefined) Deno.env.set(OTA_APP_ID_ENV, saved);
    await Deno.remove(project, { recursive: true });
  }
});

/** An export at `out` (index.html), stamped for `platform`. */
async function exportInto(out: string, platform: string): Promise<void> {
  await Deno.mkdir(out, { recursive: true });
  await Deno.writeTextFile(join(out, "index.html"), "<html></html>");
  await writePlatformStamp(out, platform);
}

Deno.test("mobile build: the export step names the build's app id (the flavor's) for a signed manifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_app_build_" });
  try {
    await Deno.writeTextFile(
      join(dir, "capacitor.config.json"),
      JSON.stringify({ appId: "dev.example", appName: "Receipts", webDir: "out" }),
    );
    await Deno.mkdir(join(dir, "android", "app"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "android", "app", "build.gradle"),
      'android {\n  defaultConfig {\n    versionCode 7\n    versionName "1.4"\n  }\n}\n',
    );
    const base = { root: dir, appDir: dir, platform: "android" as const, cli: ["x"], deno: "deno" };
    const plain = await planMobileBuild(base);
    assertEquals(plain.commands[0].env?.DENEXT_OTA_APP_ID, "dev.example");
    const flavored = await planMobileBuild({
      ...base,
      flavor: { name: "beta", config: { appIdSuffix: ".beta", env: { API: "b" } } },
    });
    assertEquals(flavored.commands[0].env, { API: "b", DENEXT_OTA_APP_ID: "dev.example.beta" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
