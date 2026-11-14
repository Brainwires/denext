// Signing a bundled Node backend sidecar's copied native code before it is archived
// (src/build/desktop-sidecar-sign.ts): Mach-O found by magic (not extension) and code bundles,
// innermost first; a Developer ID identity signs everything with the Hardened Runtime, a timestamp
// and the code's own entitlements kept, then verifies; without one only unsigned code is signed
// ad-hoc; Windows PE files go through Authenticode when a certificate is configured. Real
// `codesign` runs on a compiled universal `.node` on macOS hosts with a C compiler (ad-hoc only:
// nothing touches a keychain identity), through the bundler too.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  sidecarMachOTargets,
  type SidecarSigningDeps,
  signSidecarNativeCode,
} from "../src/build/desktop-sidecar-sign.ts";
import { bundleDesktopSidecar } from "../src/build/desktop-sidecar-bundle.ts";
import { prepareSidecarModules } from "../src/desktop/sidecar-modules.ts";

const MACHO_64 = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
const FAT = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]);

/** Write `files` (path → bytes or text) under `root`. */
async function writeTree(root: string, files: Record<string, Uint8Array | string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    if (typeof body === "string") await Deno.writeTextFile(path, body);
    else await Deno.writeFile(path, body);
  }
}

/** A staged `node_modules` tree with Mach-O by magic, a framework, and look-alikes. */
const TREE: Record<string, Uint8Array | string> = {
  "node_modules/node-pty/build/Release/pty.node": MACHO_64,
  "node_modules/node-pty/build/Release/spawn-helper": FAT, // no extension: still Mach-O
  "node_modules/node-pty/lib/index.js": "module.exports = {};\n",
  "node_modules/msgpackr-extract/prebuilds/linux-x64/node.abi.node": ELF, // not Mach-O
  "node_modules/fff/lib/Fff.framework/Versions/A/Fff": MACHO_64,
  "node_modules/fff/lib/Fff.framework/Versions/A/Resources/Info.plist": "<plist/>",
  "node_modules/fff/lib/Fff.framework/Versions/A/Libraries/libz.dylib": MACHO_64,
  "node_modules/fff/lib/Fff.framework/Resources/Info.plist": "<plist/>",
  "node_modules/markdown.plugin/index.js": "", // a folder named like a bundle: not one
};

Deno.test("sidecarMachOTargets: Mach-O by magic and code bundles, innermost first", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-sign-" });
  try {
    await writeTree(root, TREE);
    if (Deno.build.os !== "windows") {
      await Deno.symlink(
        join(root, "node_modules/node-pty/build/Release/pty.node"),
        join(root, "node_modules/node-pty/pty-link.node"),
      );
    }
    const rel = (await sidecarMachOTargets(root)).map((p) =>
      p.slice(root.length + 1).replaceAll("\\", "/")
    );
    assertEquals(rel, [
      "node_modules/fff/lib/Fff.framework/Versions/A/Libraries/libz.dylib",
      "node_modules/fff/lib/Fff.framework/Versions/A/Fff",
      "node_modules/node-pty/build/Release/pty.node",
      "node_modules/node-pty/build/Release/spawn-helper",
      "node_modules/fff/lib/Fff.framework",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** A recording runner: `codesign -dv` answers "not signed at all" for paths in `unsigned`. */
function recorder(unsigned: readonly string[] = []) {
  const calls: string[][] = [];
  const deps: SidecarSigningDeps = {
    has: () => Promise.resolve(true),
    run: (argv) => {
      calls.push([...argv]);
      const path = argv[argv.length - 1];
      const text = argv[1] === "-dv" && unsigned.some((u) => path.endsWith(u))
        ? `${path}: code object is not signed at all`
        : "";
      return Promise.resolve({ code: 0, text });
    },
  };
  return { calls, deps };
}

Deno.test("signSidecarNativeCode: a Developer ID signs every target hardened + timestamped, keeping entitlements, then verifies", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-sign-" });
  try {
    await writeTree(root, TREE);
    const { calls, deps } = recorder();
    const identity = "Developer ID Application: Example (TEAMID1234)";
    const report = await signSidecarNativeCode(root, "darwin", {
      ...deps,
      env: (n) => n === "DENEXT_CODESIGN_IDENTITY" ? identity : undefined,
    });
    assertEquals(report.how, "identity");
    assertEquals(report.signed, await sidecarMachOTargets(root));
    const signs = calls.filter((c) => c.includes("-s"));
    assertEquals(signs.length, 5);
    for (const [i, c] of signs.entries()) {
      assertEquals(c, [
        "codesign",
        "--force",
        "--timestamp",
        "--options",
        "runtime",
        "--preserve-metadata=entitlements",
        "-s",
        identity,
        report.signed[i],
      ]);
    }
    const verifies = calls.filter((c) => c[1] === "--verify");
    assertEquals(verifies.map((c) => c[3]), report.signed);
    assert(
      calls.indexOf(verifies[0]) > calls.indexOf(signs[4]),
      "verified once everything is signed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("signSidecarNativeCode: ad-hoc signs only unsigned code; a failure names the command", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-sign-" });
  try {
    await writeTree(root, TREE);
    const { calls, deps } = recorder(["spawn-helper"]);
    const report = await signSidecarNativeCode(root, "darwin", { ...deps, env: () => "-" });
    assertEquals(report.how, "ad-hoc");
    assertEquals(report.signed.length, 1);
    assert(report.signed[0].endsWith("spawn-helper"));
    assertEquals(calls.filter((c) => c.includes("--sign")).length, 1);

    await assertRejects(
      () =>
        signSidecarNativeCode(root, "darwin", {
          has: () => Promise.resolve(true),
          env: () => "Developer ID Application: X (Y)",
          run: () => Promise.resolve({ code: 1, text: "errSecInternalComponent" }),
        }),
      Error,
      "errSecInternalComponent",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("signSidecarNativeCode: no codesign fails only with an identity; nothing to sign is a no-op", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-sign-" });
  try {
    const none = await signSidecarNativeCode(root, "darwin", { has: () => Promise.resolve(false) });
    assertEquals(none, { how: "none", signed: [] });
    await writeTree(root, TREE);
    const noTool = { has: () => Promise.resolve(false) };
    assertEquals(
      await signSidecarNativeCode(root, "darwin", { ...noTool, env: () => undefined }),
      { how: "none", signed: [] },
    );
    await assertRejects(
      () => signSidecarNativeCode(root, "darwin", { ...noTool, env: () => "Developer ID X" }),
      Error,
      "codesign is not available",
    );
    assertEquals(await signSidecarNativeCode(root, "linux"), { how: "none", signed: [] });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("signSidecarNativeCode: Windows PE files are Authenticode-signed with a certificate, never with --no-sign", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-sign-" });
  try {
    const pe = [join(root, "a.node"), join(root, "b.dll")];
    const signed: string[][] = [];
    const deps = (cert: string | undefined, args: string[] = []): SidecarSigningDeps => ({
      env: (n) => n === "DENEXT_WINDOWS_CERT" ? cert : undefined,
      args,
      peFiles: () => Promise.resolve(pe),
      signWindows: (f) => {
        signed.push([...f]);
        return Promise.resolve(true);
      },
    });
    assertEquals(await signSidecarNativeCode(root, "windows", deps("cert.pfx")), {
      how: "authenticode",
      signed: pe,
    });
    assertEquals(signed, [pe]);
    assertEquals(
      await signSidecarNativeCode(root, "windows", deps("cert.pfx", ["--no-sign"])),
      { how: "none", signed: [] },
    );
    assertEquals(await signSidecarNativeCode(root, "windows", deps(undefined)), {
      how: "none",
      signed: [],
    });
    assertEquals(signed.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** Whether a real macOS `codesign` and a C compiler are here. */
const REAL = Deno.build.os === "darwin" && await (async () => {
  try {
    const cc = await new Deno.Command("cc", { args: ["--version"], stdout: "null", stderr: "null" })
      .output();
    const cs = await new Deno.Command("/usr/bin/codesign", {
      args: ["-h"],
      stdout: "null",
      stderr: "null",
    }).output().then(() => true, () => false);
    return cc.success && cs;
  } catch {
    return false;
  }
})();

/** Compile a universal (arm64 + x86_64) Mach-O dylib at `out`, then strip its signature. */
async function universalAddon(out: string): Promise<void> {
  const src = `${out}.c`;
  await Deno.writeTextFile(src, "int denext_probe(void) { return 42; }\n");
  const cc = await new Deno.Command("cc", {
    args: ["-dynamiclib", "-arch", "arm64", "-arch", "x86_64", "-o", out, src],
  }).output();
  assert(cc.success, new TextDecoder().decode(cc.stderr));
  const strip = await new Deno.Command("/usr/bin/codesign", { args: ["--remove-signature", out] })
    .output();
  assert(strip.success);
}

/** `codesign --verify --strict` on `path`, and `-dv`'s report. */
async function verify(path: string): Promise<{ ok: boolean; info: string }> {
  const v = await new Deno.Command("/usr/bin/codesign", { args: ["--verify", "--strict", path] })
    .output();
  const d = await new Deno.Command("/usr/bin/codesign", { args: ["-dv", path] }).output();
  return { ok: v.success, info: new TextDecoder().decode(d.stderr) };
}

Deno.test({
  name: "signSidecarNativeCode: real codesign signs an unsigned universal addon ad-hoc (macOS)",
  ignore: !REAL,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "denext-sidecar-sign-real-" });
    try {
      const addon = join(root, "node_modules", "native", "build", "Release", "addon.node");
      await Deno.mkdir(join(addon, ".."), { recursive: true });
      await universalAddon(addon);
      assert((await verify(addon)).info.includes("not signed at all"));
      const report = await signSidecarNativeCode(root, "darwin", { env: () => undefined });
      assertEquals(report, { how: "ad-hoc", signed: [addon] });
      const after = await verify(addon);
      assert(after.ok, after.info);
      assert(after.info.includes("Mach-O universal (x86_64 arm64)"), after.info);
      // Signed already: a second pass leaves it alone.
      assertEquals(
        (await signSidecarNativeCode(root, "darwin", { env: () => undefined })).signed,
        [],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "bundleDesktopSidecar: packaging signs the copied addon before it is archived (macOS)",
  ignore: !REAL,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "denext-sidecar-sign-bundle-" });
    try {
      await writeTree(root, {
        "server/main.mjs": 'import native from "nativepkg";\nconsole.log(native);\n',
        "server/node_modules/nativepkg/package.json":
          '{"name":"nativepkg","main":"index.js","gypfile":true}',
        "server/node_modules/nativepkg/index.js": 'module.exports = "native";\n',
      });
      const addon = join(root, "server/node_modules/nativepkg/build/Release/addon.node");
      await Deno.mkdir(join(addon, ".."), { recursive: true });
      await universalAddon(addon);
      const report = await bundleDesktopSidecar({
        projectDir: root,
        definition: {
          name: "api",
          run: { module: "server/main.mjs", nodeModules: "server/node_modules" },
        },
        os: "darwin",
        ffiGranted: true,
        sign: { env: () => undefined },
      });
      assertEquals(report.signing.how, "ad-hoc");
      assertEquals(report.signing.signed.length, 1);
      const out = join(root, ".deno-desktop/sidecars/api");
      const mods = await prepareSidecarModules(out, "api", join(root, ".test-cache"));
      assert(mods);
      const unpacked = await verify(join(mods, "node_modules/nativepkg/build/Release/addon.node"));
      assert(unpacked.ok, `the archived copy is the signed one: ${unpacked.info}`);
      // The project's own installed copy is untouched.
      assert((await verify(addon)).info.includes("not signed at all"));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
