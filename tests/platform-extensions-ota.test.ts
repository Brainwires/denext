// Platform exports over the air: a platform export carries the `_denext/platform.txt` stamp, its
// OTA manifest names the target (covered by the signed version through the stamp), the mobile
// and desktop clients refuse another target's UI (`platform_mismatch`) and send their own, and
// `createOtaHandler({ platforms })` serves each target its export.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  isOtaManifest,
  makeOtaManifest,
  OTA_PLATFORM_PATH,
  type OtaManifest,
  otaPlatformMismatch,
  sha256Hex,
} from "../src/mobile/ota-manifest.ts";
import { writeOtaManifest, writePlatformStamp } from "../src/build/ota-manifest.ts";
import { generateOtaKeyPair, importOtaSigningKey } from "../src/build/ota-signing.ts";
import { createOtaHandler } from "../src/server/ota-handler.ts";
import { checkForUiUpdate } from "../src/mobile/ota.ts";
import {
  checkForDesktopUpdate,
  DesktopUpdateError,
  prepareDesktopUpdate,
} from "../src/desktop/updater.ts";
import { walk } from "@std/fs";
import { buildRegistry } from "../src/cli/register.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;
const hex = (c: string) => c.repeat(64);

/** A manifest file entry for the stamp of `platform`. */
async function stampEntry(platform: string) {
  const bytes = new TextEncoder().encode(platform);
  return { path: OTA_PLATFORM_PATH, sha256: await sha256Hex(bytes), size: bytes.byteLength };
}

const INDEX = { path: "index.html", sha256: hex("c"), size: 13 };

/** A web root with an index.html and, when `platform` is given, its stamp. */
async function exportDir(platform?: string, body = "<html></html>"): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_platform_ota_" });
  await Deno.writeTextFile(join(dir, "index.html"), body);
  if (platform) await writePlatformStamp(dir, platform);
  return dir;
}

Deno.test("manifest: a platform needs the export's stamp, and the stamp must match it", async () => {
  const ios = await makeOtaManifest([INDEX, await stampEntry("ios")], { platform: "ios" });
  assertEquals(ios.platform, "ios");
  assert(isOtaManifest(ios));
  await assertRejects(() => makeOtaManifest([INDEX], { platform: "ios" }), RangeError, "stamp");
  await assertRejects(
    async () => makeOtaManifest([INDEX, await stampEntry("android")], { platform: "ios" }),
    RangeError,
    "stamp",
  );
  await assertRejects(() => makeOtaManifest([INDEX], { platform: "phone" }), RangeError);
  assert(!isOtaManifest({ ...ios, platform: "phone" }), "an unknown target is malformed");

  assertEquals(await otaPlatformMismatch(ios, "ios"), null);
  assertStringIncludes((await otaPlatformMismatch(ios, "android"))!, "built for ios");
  // Relabelled without its (signed) stamp changing: refused even for the named target.
  const relabelled = { ...ios, platform: "android" };
  assertStringIncludes((await otaPlatformMismatch(relabelled, "android"))!, "no matching");
  // No platform: a web export every shell takes.
  assertEquals(await otaPlatformMismatch({ files: [INDEX] }, "android"), null);
});

Deno.test("writeOtaManifest: the stamp names the target; --platform stamps; a conflict throws", async () => {
  const stamped = await exportDir("android");
  const plain = await exportDir();
  try {
    assertEquals((await writeOtaManifest(stamped)).platform, "android");
    const named = await writeOtaManifest(plain, { platform: "linux" });
    assertEquals(named.platform, "linux");
    assertEquals(await Deno.readTextFile(join(plain, OTA_PLATFORM_PATH)), "linux");
    assert(named.files.some((f) => f.path === OTA_PLATFORM_PATH), "the version covers the stamp");
    await assertRejects(
      () => writeOtaManifest(stamped, { platform: "ios" }),
      Error,
      "is the android export",
    );
    const web = await exportDir();
    try {
      assertEquals((await writeOtaManifest(web)).platform, undefined);
    } finally {
      await Deno.remove(web, { recursive: true });
    }
  } finally {
    await Deno.remove(stamped, { recursive: true });
    await Deno.remove(plain, { recursive: true });
  }
});

/** Run `fn` inside a stubbed native shell of `platform` whose DenextOta plugin records applies. */
async function inShell(platform: string, fn: (applies: Any[]) => Promise<void>): Promise<void> {
  const saved = Object.getOwnPropertyDescriptor(g, "Capacitor");
  const applies: Any[] = [];
  g.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: {
      DenextOta: {
        status: () => Promise.resolve({ current: null, bundled: hex("b"), pending: null }),
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
  }
}

Deno.test("checkForUiUpdate: another target's UI is refused (platform_mismatch); its own applies", async () => {
  const android = await makeOtaManifest([INDEX, await stampEntry("android")], {
    platform: "android",
  });
  const calls: RequestInit[] = [];
  const serve = (
    m: OtaManifest,
  ) => ((
    _: unknown,
    init: RequestInit = {},
  ) => (calls.push(init), Promise.resolve(Response.json(m))));
  await inShell("ios", async (applies) => {
    const r = await checkForUiUpdate({ baseUrl: "https://ui.test", fetch: serve(android) as Any });
    assertEquals(r.kind, "error");
    assertEquals((r as { code?: string }).code, "platform_mismatch");
    assertEquals(applies.length, 0, "nothing reaches the native side");
    assertEquals((calls[0].headers as Record<string, string>)["x-denext-ota-platform"], "ios");
  });
  await inShell("android", async (applies) => {
    const r = await checkForUiUpdate({ baseUrl: "https://ui.test", fetch: serve(android) as Any });
    assertEquals(r, { kind: "applied", version: android.version });
    assertEquals(applies[0].headers["x-denext-ota-platform"], "android");
  });
});

Deno.test("createOtaHandler({ platforms }): each target gets its export; web without the header", async () => {
  const ios = await exportDir("ios", "<html>IOS</html>");
  const web = await exportDir(undefined, "<html>WEB</html>");
  try {
    await writeOtaManifest(ios);
    await writeOtaManifest(web);
    const ota = createOtaHandler({ platforms: { ios, web } });
    const get = async (path: string, platform?: string) =>
      await ota(
        new Request(`http://ota.test/${path}`, {
          headers: platform ? { "x-denext-ota-platform": platform } : {},
        }),
      );
    const iosManifest = await (await get("_denext/ota.json", "ios"))!.json();
    assertEquals(iosManifest.platform, "ios");
    assertEquals(await (await get("index.html", "ios"))!.text(), "<html>IOS</html>");
    assertEquals(await (await get("index.html"))!.text(), "<html>WEB</html>");
    assertEquals(await get("index.html", "android"), null, "a target with no export");
    assertStringIncludes(
      (await get("index.html", "ios"))!.headers.get("vary") ?? "",
      "x-denext-ota-platform",
    );
    assertThrowsType(() => createOtaHandler({ dir: web, platforms: { ios } }));
  } finally {
    await Deno.remove(ios, { recursive: true });
    await Deno.remove(web, { recursive: true });
  }
});

function assertThrowsType(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    assert(err instanceof TypeError);
    return;
  }
  throw new Error("expected a TypeError");
}

Deno.test("desktop updater: a feed of another OS's export is refused; its own is offered", async () => {
  const pair = await generateOtaKeyPair();
  const signingKey = await importOtaSigningKey(pair.privateKeyPem);
  const linux = await exportDir("linux", "<html>LINUX</html>");
  const macos = await exportDir("macos", "<html>MACOS</html>");
  const data = await Deno.makeTempDir({ prefix: "denext_platform_ota_data_" });
  const real = globalThis.fetch;
  try {
    await writeOtaManifest(linux, { sequence: 5 }, signingKey);
    await writeOtaManifest(macos, { sequence: 5 }, signingKey);
    let ota = createOtaHandler({ dir: linux, basePath: "/ui" });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      (await ota(new Request(String(input), init))) ??
        new Response("missing", { status: 404 })) as typeof fetch;
    const config = {
      feedUrl: "http://feed.test/ui",
      publicKey: pair.publicKey,
      dataDir: data,
      platform: "macos" as const,
    };
    const err = await assertRejects(() =>
      checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals(err.code, "platform_mismatch");
    // A per-target feed serves the macOS export to the macOS app.
    ota = createOtaHandler({ platforms: { linux, macos }, basePath: "/ui" });
    const check = await checkForDesktopUpdate(config);
    assert(check.available);
    assertEquals(check.manifest?.platform, "macos");
  } finally {
    globalThis.fetch = real;
    for (const d of [linux, macos, data]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("denext ota manifest: --platform names the target; an unnamed export of an app with platform files warns", async () => {
  const project = await Deno.makeTempDir({ prefix: "denext_platform_ota_cli_" });
  const out = join(project, "out");
  await Deno.mkdir(out);
  await Deno.writeTextFile(join(out, "index.html"), "<html></html>");
  await Deno.mkdir(join(project, "app"));
  await Deno.writeTextFile(join(project, "app", "Pad.ios.tsx"), "");
  const errors: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = () => {};
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  const run = (flags: Record<string, string | boolean>) =>
    buildRegistry().get("ota")!.run({
      positionals: ["manifest", out],
      flags: { dir: project, ...flags },
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
  try {
    await run({});
    assertStringIncludes(errors.join("\n"), "names no target");
    assertStringIncludes(errors.join("\n"), "denext export --platform");
    errors.length = 0;
    await run({ platform: "ios" });
    const written = JSON.parse(await Deno.readTextFile(join(out, "_denext", "ota.json")));
    assertEquals(written.platform, "ios");
    assertEquals(errors, [], "a named target does not warn");
  } finally {
    console.log = log;
    console.error = error;
    await Deno.remove(project, { recursive: true });
  }
});

// The `platform` field is not signed; the stamp file is (the version covers it). Deleting the
// field from another target's manifest must not make it installable: the stamp decides.
Deno.test("otaPlatformMismatch: a stamped export without its platform field is still its target's", async () => {
  const android = await makeOtaManifest([INDEX, await stampEntry("android")], {
    platform: "android",
  });
  const { platform: _, ...stripped } = android;
  assert(isOtaManifest(stripped));
  assertStringIncludes((await otaPlatformMismatch(stripped, "ios"))!, "another target's");
  assertEquals(await otaPlatformMismatch(stripped, "android"), null);
  // A field naming the shell's own target cannot launder another target's stamp either.
  assertStringIncludes(
    (await otaPlatformMismatch({ ...stripped, platform: "ios" }, "ios"))!,
    "no matching",
  );
});

Deno.test("checkForUiUpdate: a stamped manifest stripped of its platform field is refused", async () => {
  const android = await makeOtaManifest([INDEX, await stampEntry("android")], {
    platform: "android",
  });
  const { platform: _, ...stripped } = android;
  const serve = () => Promise.resolve(Response.json(stripped));
  await inShell("ios", async (applies) => {
    const r = await checkForUiUpdate({ baseUrl: "https://ui.test", fetch: serve as Any });
    assertEquals(r.kind, "error");
    assertEquals((r as { code?: string }).code, "platform_mismatch");
    assertEquals(applies.length, 0);
  });
});

Deno.test("desktop updater: a signed export stripped of its platform field is refused, nothing staged", async () => {
  const pair = await generateOtaKeyPair();
  const signingKey = await importOtaSigningKey(pair.privateKeyPem);
  const linux = await exportDir("linux", "<html>LINUX</html>");
  const data = await Deno.makeTempDir({ prefix: "denext_platform_ota_strip_" });
  const real = globalThis.fetch;
  try {
    await writeOtaManifest(linux, { sequence: 7 }, signingKey);
    const ota = createOtaHandler({ dir: linux, basePath: "/ui" });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = (await ota(new Request(String(input), init))) ??
        new Response("missing", { status: 404 });
      if (!String(input).endsWith("/_denext/ota.json")) return res;
      const { platform: _, ...stripped } = await res.json(); // the signature still verifies
      return Response.json(stripped);
    }) as typeof fetch;
    const config = {
      feedUrl: "http://feed.test/ui",
      publicKey: pair.publicKey,
      dataDir: data,
      platform: "macos" as const,
    };
    const checked = await assertRejects(() => checkForDesktopUpdate(config), DesktopUpdateError);
    assertEquals(checked.code, "platform_mismatch");
    const prepared = await assertRejects(() => prepareDesktopUpdate(config), DesktopUpdateError);
    assertEquals(prepared.code, "platform_mismatch");
    const left: string[] = [];
    for await (const e of walk(data)) if (e.path !== data) left.push(e.path);
    assertEquals(left, [], "a refused update stages nothing");
    // The app of the stamp's own target still takes it.
    assert((await checkForDesktopUpdate({ ...config, platform: "linux" })).available);
  } finally {
    globalThis.fetch = real;
    for (const d of [linux, data]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("platform stamps: web writes none, an unknown target is refused, a stamp is trimmed", async () => {
  const web = await exportDir();
  const padded = await exportDir();
  try {
    await writePlatformStamp(web, "web");
    await assertRejects(() => Deno.stat(join(web, OTA_PLATFORM_PATH)), Deno.errors.NotFound);
    const manifest = await writeOtaManifest(web, { platform: "web" });
    assertEquals(manifest.platform, undefined, "web names no target");
    assert(!manifest.files.some((f) => f.path === OTA_PLATFORM_PATH));
    await assertRejects(() => writePlatformStamp(web, "phone"), RangeError, "not an export target");
    await assertRejects(
      async () => makeOtaManifest([INDEX, await stampEntry("ios")], { platform: "web" }),
      RangeError,
      "carries no",
    );
    // A hand-edited stamp with a newline names its target, and fails the stamp check loudly.
    await Deno.mkdir(join(padded, "_denext"), { recursive: true });
    await Deno.writeTextFile(join(padded, OTA_PLATFORM_PATH), "ios\n");
    await assertRejects(() => writeOtaManifest(padded), RangeError, `stamp holding "ios"`);
  } finally {
    for (const d of [web, padded]) await Deno.remove(d, { recursive: true });
  }
});
