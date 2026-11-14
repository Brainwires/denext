// The paths of src/build/desktop-sidecar-sign.ts that tests/desktop-sidecar-sign.test.ts leaves to
// one OS: which folders count as code bundles (a framework by its `Versions/` or its
// `Resources/Info.plist`, a `.bundle` by `Contents/Info.plist`), the order of targets at one depth,
// the default tool probe and runner (the OS's own `codesign`, absent off macOS), and the Windows
// defaults (the PE walk, the certificate read from the same settings, `--no-sign` from the
// process's own arguments).

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { sidecarMachOTargets, signSidecarNativeCode } from "../src/build/desktop-sidecar-sign.ts";

const MACHO_64 = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);

/** Write `files` (path → bytes or text) under `root`. */
async function writeTree(root: string, files: Record<string, Uint8Array | string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    if (typeof body === "string") await Deno.writeTextFile(path, body);
    else await Deno.writeFile(path, body);
  }
}

/** Run `fn` on a fresh temporary folder, removed after. */
async function inTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-sign-paths-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("sidecarMachOTargets: a framework by Versions/ or Resources/Info.plist, a .bundle by Contents/Info.plist; one depth sorts by name", async () => {
  await inTemp(async (root) => {
    await writeTree(root, {
      "m/b/Zed.framework/Versions/A/Zed": MACHO_64, // a framework with Versions/ only
      "m/b/Res.framework/Resources/Info.plist": "<plist/>", // a framework with its Resources plist
      "m/b/Plain.framework/readme.txt": "", // neither: not a bundle
      "m/b/Tool.bundle/Contents/Info.plist": "<plist/>",
      "m/b/Bare.bundle/readme.txt": "", // no Contents/Info.plist: not a bundle
      "m/b/z.node": MACHO_64,
      "m/b/a.node": MACHO_64,
    });
    const rel = (await sidecarMachOTargets(root)).map((p) =>
      p.slice(root.length + 1).replaceAll("\\", "/")
    );
    assertEquals(rel, [
      "m/b/Zed.framework/Versions/A/Zed",
      "m/b/Res.framework",
      "m/b/Tool.bundle",
      "m/b/Zed.framework",
      "m/b/a.node",
      "m/b/z.node",
    ]);
  });
});

Deno.test("signSidecarNativeCode: the default probe and runner use the OS's own codesign", async () => {
  await inTemp(async (root) => {
    await writeTree(root, { "node_modules/x/build/Release/x.node": MACHO_64 });
    if (Deno.build.os === "darwin") {
      // macOS: the system codesign is probed and run (ad-hoc: no identity, nothing in a keychain).
      const report = await signSidecarNativeCode(root, "darwin", { env: () => undefined });
      assertEquals(report.how, "ad-hoc");
    } else {
      // Elsewhere there is no codesign: without an identity nothing is signed ...
      assertEquals(await signSidecarNativeCode(root, "darwin", { env: () => undefined }), {
        how: "none",
        signed: [],
      });
      // ... and when the probe is told it is there, the default runner can't start it.
      await assertRejects(() =>
        signSidecarNativeCode(root, "darwin", {
          env: () => undefined,
          has: () => Promise.resolve(true),
        })
      );
    }
  });
});

Deno.test("signSidecarNativeCode: Windows defaults: the PE walk, the thumbprint setting, --no-sign from the process", async () => {
  await inTemp(async (root) => {
    await writeTree(root, { "node_modules/x/readme.txt": "not a PE file" });
    const thumbprintOnly = (n: string) => n === "DENEXT_WINDOWS_CERT_THUMBPRINT" ? "" : undefined;
    // A thumbprint setting asks for signing; the default walk finds no PE file: nothing to sign.
    assertEquals(
      await signSidecarNativeCode(root, "windows", { env: thumbprintOnly, args: [] }),
      { how: "none", signed: [] },
    );
    // A PE file found, and the default signer reads the same (empty) setting: no certificate,
    // so it signs nothing and says so.
    const pe = [join(root, "a.node")];
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => void warned.push(m);
    try {
      assertEquals(
        await signSidecarNativeCode(root, "windows", {
          env: thumbprintOnly,
          args: [],
          peFiles: () => Promise.resolve(pe),
        }),
        { how: "none", signed: [] },
      );
    } finally {
      console.warn = warn;
    }
    assertEquals(warned.length, 1);
    // No arguments given: the process's own are read for --no-sign (this test runner has none).
    assertEquals(
      await signSidecarNativeCode(root, "windows", {
        env: (n) => n === "DENEXT_WINDOWS_CERT" ? "cert.pfx" : undefined,
        peFiles: () => Promise.resolve(pe),
        signWindows: () => Promise.resolve(true),
      }),
      { how: "authenticode", signed: pe },
    );
  });
});
