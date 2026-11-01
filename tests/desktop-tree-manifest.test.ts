// The Windows tree manifest (5.0-gate review A, M2; the denext.8 audit, F2): the app's identifier
// and version, and every file of a bundle but the .exe (DLLs included, as signed), with its size
// and SHA-256, embedded in the .exe as the RT_RCDATA resource DENEXT_TREE before signing, so the
// executable's Authenticode signature covers laufey-launch.json, CEF's resources, sidecar JS and
// which build each DLL came from. The runtime's check is runtime/ops/desktop_update/treecheck.rs
// in the fork; its tests read an executable this module wrote (testdata/tree_manifest_packaged.exe).

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  DESKTOP_TREE_RESOURCE,
  desktopTreeManifest,
  desktopTreeManifestProblem,
  embedDesktopTreeManifest,
  readDesktopTreeManifest,
  stampDesktopTreeManifest,
  windowsTreeManifestWarning,
} from "../src/build/desktop-tree-manifest.ts";
import { readPeResources, stampPeResources, writePeResources } from "../src/build/pe-resources.ts";
import { WINDOWS_PACKAGE_SCRIPT } from "../src/build/desktop-package-scripts.ts";
import { desktopPeFiles, desktopSignWindows } from "../src/build/desktop.ts";
import type { DesktopRunOptions } from "../src/build/desktop.ts";

/** The app the fixture bundle is packaged as. */
const ID = { appId: "com.example.myapp", version: "1.2.3" };
const EXE = "MyApp-x64.exe";

/** A minimal PE32+ image: headers, one `.text` section, an empty resource data directory. */
function minimalPe(): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(0x400);
  const v = new DataView(b.buffer);
  b.set([0x4d, 0x5a]);
  v.setUint32(0x3c, 0x40, true);
  b.set([0x50, 0x45, 0, 0], 0x40);
  const coff = 0x44;
  v.setUint16(coff, 0x8664, true);
  v.setUint16(coff + 2, 1, true);
  v.setUint16(coff + 16, 240, true);
  v.setUint16(coff + 18, 0x22, true);
  const opt = coff + 20;
  v.setUint16(opt, 0x20b, true);
  v.setUint32(opt + 4, 0x200, true);
  v.setUint32(opt + 16, 0x1000, true);
  v.setUint32(opt + 20, 0x1000, true);
  v.setBigUint64(opt + 24, 0x140000000n, true);
  v.setUint32(opt + 32, 0x1000, true);
  v.setUint32(opt + 36, 0x200, true);
  v.setUint16(opt + 40, 6, true);
  v.setUint16(opt + 48, 6, true);
  v.setUint32(opt + 56, 0x2000, true);
  v.setUint32(opt + 60, 0x200, true);
  v.setUint16(opt + 68, 2, true);
  v.setUint32(opt + 108, 16, true);
  const sec = opt + 240;
  b.set(new TextEncoder().encode(".text"), sec);
  v.setUint32(sec + 8, 0x200, true);
  v.setUint32(sec + 12, 0x1000, true);
  v.setUint32(sec + 16, 0x200, true);
  v.setUint32(sec + 20, 0x200, true);
  v.setUint32(sec + 36, 0x60000020, true);
  b[0x200] = 0xc3;
  return b;
}

const LAUNCH = '{"bridgeOrigins":["app://x"],"inspectable":false}';

async function sha256(text: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A bundle: the .exe, a DLL, a PE renamed to .bin, and loose files a manifest must list. */
async function fakeBundle(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-tree-" });
  const app = join(dir, "MyApp-x64");
  await Deno.mkdir(join(app, "locales"), { recursive: true });
  await Deno.mkdir(join(app, "sidecar"), { recursive: true });
  const pe = stampPeResources(minimalPe(), {
    version: [1, 0, 0, 0],
    strings: { ProductName: "My" },
  });
  await Deno.writeFile(join(app, "MyApp-x64.exe"), pe);
  await Deno.writeFile(join(app, "MyApp-x64.dll"), minimalPe());
  await Deno.writeFile(join(app, "renamed.bin"), minimalPe());
  await Deno.writeTextFile(join(app, "laufey-launch.json"), LAUNCH);
  await Deno.writeTextFile(join(app, "locales", "en-US.pak"), "PAK");
  await Deno.writeTextFile(join(app, "sidecar", "main.js"), "serve()");
  await Deno.writeTextFile(join(app, ".deno-desktop-app"), "");
  // Starts with MZ but is not a PE image: a data file, listed.
  await Deno.writeFile(join(app, "mz.dat"), new Uint8Array([0x4d, 0x5a, 1, 2, 3]));
  return app;
}

Deno.test("desktopTreeManifest: the app and version, and every file but the .exe with its size and SHA-256, sorted", async () => {
  const app = await fakeBundle();
  try {
    const m = await desktopTreeManifest(app, EXE, ID);
    assertEquals(m.v, 1);
    assertEquals([m.appId, m.version], [ID.appId, ID.version]);
    // PE images too (the DLL, a PE renamed .bin): which build they came from is bound, not only
    // who signed them. The .exe carries the manifest and is never listed.
    assertEquals(m.files.map((f) => f.path), [
      ".deno-desktop-app",
      "MyApp-x64.dll",
      "laufey-launch.json",
      "locales/en-US.pak",
      "mz.dat",
      "renamed.bin",
      "sidecar/main.js",
    ]);
    const launch = m.files.find((f) => f.path === "laufey-launch.json")!;
    assertEquals(launch.size, LAUNCH.length);
    assertEquals(launch.sha256, await sha256(LAUNCH));
    const dll = m.files.find((f) => f.path === "MyApp-x64.dll")!;
    assertEquals(dll.sha256, await sha256(minimalPe()));
    // No identity, no manifest: the runtime refuses one without an app or a version.
    await assertRejects(
      () => desktopTreeManifest(app, EXE, { ...ID, appId: "" }),
      Error,
      "identifier",
    );
    await assertRejects(
      () => desktopTreeManifest(app, EXE, { ...ID, version: "latest" }),
      Error,
      "semver",
    );
  } finally {
    await Deno.remove(join(app, ".."), { recursive: true });
  }
});

Deno.test("desktopTreeManifest: a symlink in the bundle is refused (the runtime refuses it)", async () => {
  const app = await fakeBundle();
  try {
    await Deno.symlink("laufey-launch.json", join(app, "link.json"));
    await assertRejects(() => desktopTreeManifest(app, EXE, ID), Error, "is a symlink");
  } finally {
    await Deno.remove(join(app, ".."), { recursive: true });
  }
});

Deno.test("embedDesktopTreeManifest: an RT_RCDATA DENEXT_TREE resource, other resources kept, replaced on re-embed", async () => {
  const pe = stampPeResources(minimalPe(), {
    version: [2, 0, 0, 0],
    strings: { ProductName: "A" },
  });
  const one = {
    v: 1 as const,
    ...ID,
    files: [{ path: "a.json", size: 2, sha256: await sha256("{}") }],
  };
  const embedded = embedDesktopTreeManifest(pe, one);
  assertEquals(readDesktopTreeManifest(embedded), one);
  const tree = readPeResources(embedded);
  assert(tree.get(16), "the version resource is kept");
  assertEquals([...tree.get(10)!.keys()], [DESKTOP_TREE_RESOURCE]);
  // Embedding again replaces it (also one written under another case).
  const two = { v: 1 as const, ...ID, files: [] };
  const again = embedDesktopTreeManifest(embedded, two);
  assertEquals(readDesktopTreeManifest(again), two);
  assertEquals(readPeResources(again).get(10)!.size, 1);
  const lower = readPeResources(pe);
  lower.set(
    10,
    new Map([["denext_tree", new Map([[0, { data: new Uint8Array(), codepage: 0 }]])]]),
  );
  const replaced = embedDesktopTreeManifest(writePeResources(pe, lower), two);
  assertEquals([...readPeResources(replaced).get(10)!.keys()], [DESKTOP_TREE_RESOURCE]);
  // None, ambiguous, not a manifest.
  assertEquals(readDesktopTreeManifest(pe), null);
  const twoLangs = readPeResources(pe);
  const data = { data: new TextEncoder().encode(JSON.stringify(two)), codepage: 0 };
  twoLangs.set(10, new Map([[DESKTOP_TREE_RESOURCE, new Map([[0, data], [1033, data]])]]));
  assertThrows(() => readDesktopTreeManifest(writePeResources(pe, twoLangs)), Error, "ambiguous");
  const bad = readPeResources(pe);
  bad.set(
    10,
    new Map([[
      DESKTOP_TREE_RESOURCE,
      new Map([[1033, {
        data: new TextEncoder().encode('{"v":2}'),
        codepage: 0,
      }]]),
    ]]),
  );
  assertThrows(() => readDesktopTreeManifest(writePeResources(pe, bad)), Error, "version-1");
  // The unreleased draft without the app and version is not a manifest either.
  const draft = readPeResources(pe);
  draft.set(
    10,
    new Map([[
      DESKTOP_TREE_RESOURCE,
      new Map([[1033, {
        data: new TextEncoder().encode('{"v":1,"files":[]}'),
        codepage: 0,
      }]]),
    ]]),
  );
  assertThrows(() => readDesktopTreeManifest(writePeResources(pe, draft)), Error, "version-1");
});

Deno.test("stampDesktopTreeManifest + desktopTreeManifestProblem: a tampered, extra or missing file after stamping", async () => {
  const app = await fakeBundle();
  const exe = "MyApp-x64.exe";
  try {
    const unstamped = await desktopTreeManifestProblem(app, exe);
    assert(unstamped?.unlisted, "no manifest yet");
    assertStringIncludes(unstamped.problem, "carries no DENEXT_TREE");

    const m = await stampDesktopTreeManifest(app, exe, ID);
    assertEquals(readDesktopTreeManifest(await Deno.readFile(join(app, exe))), m);
    assertEquals(await desktopTreeManifestProblem(app, exe), undefined);
    assertEquals(await desktopTreeManifestProblem(app, exe, ID), undefined);
    // The .exe is never listed in its own manifest (it changed by being stamped).
    assertEquals((await desktopTreeManifest(app, exe, ID)).files, m.files);
    // A manifest for another app or version is a problem for the one being published.
    assertStringIncludes(
      (await desktopTreeManifestProblem(app, exe, { ...ID, version: "1.2.4" }))!.problem,
      "is for com.example.myapp 1.2.3, not com.example.myapp 1.2.4",
    );
    // A DLL from another build (same signer, say): listed, so a change is a problem.
    const dll = await Deno.readFile(join(app, "MyApp-x64.dll"));
    await Deno.writeFile(join(app, "MyApp-x64.dll"), new Uint8Array([...dll, 0]));
    assertStringIncludes(
      (await desktopTreeManifestProblem(app, exe))!.problem,
      "MyApp-x64.dll changed",
    );
    await Deno.writeFile(join(app, "MyApp-x64.dll"), dll);

    // One byte of the launch policy flipped.
    await Deno.writeTextFile(join(app, "laufey-launch.json"), LAUNCH.replace("false", "true "));
    const changed = await desktopTreeManifestProblem(app, exe);
    assertEquals(changed?.unlisted, false);
    assertStringIncludes(changed!.problem, "laufey-launch.json changed");
    await Deno.writeTextFile(join(app, "laufey-launch.json"), LAUNCH);

    await Deno.writeTextFile(join(app, "sidecar", "evil.js"), "x");
    assertStringIncludes(
      (await desktopTreeManifestProblem(app, exe))!.problem,
      "evil.js is not in",
    );
    await Deno.remove(join(app, "sidecar", "evil.js"));

    await Deno.remove(join(app, "locales", "en-US.pak"));
    assertStringIncludes(
      (await desktopTreeManifestProblem(app, exe))!.problem,
      "locales/en-US.pak is listed",
    );
    await Deno.writeTextFile(join(app, "locales", "en-US.pak"), "PAK");
    assertEquals(await desktopTreeManifestProblem(app, exe), undefined);

    await Deno.symlink("laufey-launch.json", join(app, "link.json"));
    assertStringIncludes((await desktopTreeManifestProblem(app, exe))!.problem, "symlink");
    await Deno.remove(join(app, "link.json"));

    await Deno.writeFile(join(app, exe), new Uint8Array([1, 2, 3]));
    assertStringIncludes((await desktopTreeManifestProblem(app, exe))!.problem, exe);
  } finally {
    await Deno.remove(join(app, ".."), { recursive: true });
  }
});

Deno.test("windowsTreeManifestWarning: publish-update refuses a bundle changed after its manifest, warns without one", async () => {
  const app = await fakeBundle();
  const platform = "x86_64-pc-windows-msvc-webview";
  try {
    // Other platforms and a directory without <dir>.exe are not checked.
    assertEquals(await windowsTreeManifestWarning(app, "aarch64-apple-darwin-webview"), undefined);
    assertEquals(await windowsTreeManifestWarning(join(app, "locales"), platform), undefined);
    assertStringIncludes((await windowsTreeManifestWarning(app, platform))!, "carries no");
    await stampDesktopTreeManifest(app, EXE, ID);
    assertEquals(await windowsTreeManifestWarning(app, platform), undefined);
    assertEquals(await windowsTreeManifestWarning(app, platform, ID), undefined);
    await assertRejects(
      () => windowsTreeManifestWarning(app, platform, { ...ID, appId: "com.example.other" }),
      Error,
      "is for com.example.myapp",
    );
    await Deno.writeTextFile(join(app, "sidecar", "main.js"), "evil()");
    await assertRejects(
      () => windowsTreeManifestWarning(app, platform),
      Error,
      "installed apps would refuse this update",
    );
  } finally {
    await Deno.remove(join(app, ".."), { recursive: true });
  }
});

Deno.test("buildDesktopBundle stamps a Windows bundle's tree manifest last, after laufey-launch.json", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/build/desktop-package-script.ts", import.meta.url),
  );
  const body = src.slice(src.indexOf("export async function buildDesktopBundle("));
  const end = body.indexOf("\n}\n");
  const fn = body.slice(0, end);
  const launch = fn.indexOf("await writeLaufeyLaunchConfig(");
  const stamp = fn.indexOf("await stampDesktopTreeManifest(o.out, `${basename(o.out)}.exe`, {");
  assert(launch > 0 && stamp > launch, "laufey-launch.json, then the manifest");
  assertStringIncludes(fn.slice(fn.lastIndexOf("if (", stamp), stamp), "meta.identifier");
  assertStringIncludes(fn.slice(stamp, stamp + 200), "appId: meta.identifier");
  assertStringIncludes(fn.slice(stamp, stamp + 200), "version: meta.version");
  // The package script signs after buildDesktopBundle and adds only PE images in between.
  const script = WINDOWS_PACKAGE_SCRIPT;
  const built = script.indexOf("const dir = await buildBundle(name, arch);");
  const vc = script.indexOf("await bundleDesktopVcRuntime(dir, arch)");
  const sign = script.indexOf("await signBundle(dir,");
  assert(built > 0 && vc > built && sign > vc, "build → VC++ runtime DLLs → sign");
});

Deno.test("desktopSignWindows signs the DLLs first, writes the manifest again with their signed bytes, then signs the .exe", async () => {
  const app = await fakeBundle();
  try {
    await stampDesktopTreeManifest(app, EXE, ID);
    const before = readDesktopTreeManifest(await Deno.readFile(join(app, EXE)))!;
    // A fake signtool: "signing" appends a signature blob, as a real one changes the bytes.
    const batches: string[][] = [];
    const run = async (cmd: string[], _env?: Record<string, string>, _o?: DesktopRunOptions) => {
      const files = cmd.slice(cmd.indexOf("/td") + 2);
      batches.push(files);
      for (const f of files) {
        await Deno.writeFile(f, new Uint8Array([...(await Deno.readFile(f)), 0x53, 0x49, 0x47]));
      }
    };
    const env: Record<string, string> = { DENEXT_WINDOWS_CERT_THUMBPRINT: "AB".repeat(20) };
    const files = await desktopPeFiles(app);
    assert(files.includes(join(app, EXE)) && files.includes(join(app, "MyApp-x64.dll")));
    assert(
      await desktopSignWindows(files, {
        run,
        has: (cmd) => Promise.resolve(cmd === "signtool"),
        env: (name) => env[name],
        warn: () => {},
      }),
    );
    // Every other PE file in the first batch, the .exe alone in the last.
    assertEquals(batches.length, 2);
    assertEquals(batches[0], files.filter((f) => f !== join(app, EXE)));
    assertEquals(batches[1], [join(app, EXE)]);
    // The manifest the signed .exe carries lists the DLL as signed, so the bundle matches it; the
    // one written before signing listed the unsigned DLL.
    const after = readDesktopTreeManifest(await Deno.readFile(join(app, EXE)))!;
    assertEquals([after.appId, after.version], [ID.appId, ID.version]);
    const dll = (m: { files: readonly { path: string; sha256: string }[] }) =>
      m.files.find((f) => f.path === "MyApp-x64.dll")!.sha256;
    assertEquals(dll(after), await sha256(await Deno.readFile(join(app, "MyApp-x64.dll"))));
    assert(dll(before) !== dll(after), "the DLL's hash changed with its signature");
    assertEquals(await desktopTreeManifestProblem(app, EXE, ID), undefined);
    // Files that carry no manifest (an .msi, a plain .exe) are signed as they are listed.
    const plain = join(app, "cef");
    await Deno.mkdir(plain, { recursive: true });
    await Deno.writeFile(join(plain, "helper.exe"), minimalPe());
    batches.length = 0;
    await desktopSignWindows([join(plain, "helper.exe"), join(app, "MyApp-x64.dll")], {
      run,
      has: (cmd) => Promise.resolve(cmd === "signtool"),
      env: (name) => env[name],
      warn: () => {},
    });
    assertEquals(batches, [[join(plain, "helper.exe"), join(app, "MyApp-x64.dll")]]);
  } finally {
    await Deno.remove(join(app, ".."), { recursive: true });
  }
});
