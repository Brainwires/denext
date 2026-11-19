// desktop.bundle.libraries on a real macOS bundle, without `deno desktop` and without launching
// anything: tiny dylibs compiled here (`cc -dynamiclib`) are copied by `bundleDesktopLibraries` into
// stand-in .app bundles, merged by the scaffolded package-macos.ts's own `mergeUniversal` and
// signed (ad-hoc) by its own `sign`, then checked with `lipo` and `codesign --verify`. Skipped off
// macOS and where no C compiler is installed.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join, toFileUrl } from "@std/path";
import { bundleDesktopLibraries } from "../src/build/desktop-bundle-libraries.ts";
import { MACOS_PACKAGE_SCRIPT } from "../src/build/desktop-package-scripts.ts";

/** Run a tool; its exit code and output. */
async function tool(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const o = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
    const text = new TextDecoder();
    return { code: o.code, out: text.decode(o.stdout) + text.decode(o.stderr) };
  } catch {
    return { code: -1, out: "" };
  }
}

const CAN_BUILD = Deno.build.os === "darwin" && (await tool("cc", ["--version"])).code === 0;

/** The script's helpers, loaded from its scaffolded text (its `main` never runs). */
interface ScriptHelpers {
  sign(app: string, identity: string | undefined): Promise<void>;
  mergeUniversal(armApp: string, x86App: string, dest: string): Promise<void>;
}

/** Load package-macos.ts as a module that exports `sign` and `mergeUniversal`. */
async function loadScript(dir: string): Promise<ScriptHelpers> {
  const desktop = new URL("../src/build/desktop.ts", import.meta.url).href;
  const file = join(dir, "package-macos.mod.ts");
  await Deno.writeTextFile(
    file,
    MACOS_PACKAGE_SCRIPT.replaceAll('"denext/desktop"', JSON.stringify(desktop)) +
      "\nexport { mergeUniversal, sign };\n",
  );
  // The script re-runs itself under --node-modules-dir=none unless this is set.
  const before = Deno.env.get("DENEXT_DESKTOP_NPM");
  Deno.env.set("DENEXT_DESKTOP_NPM", "none");
  try {
    return await import(toFileUrl(file).href) as ScriptHelpers;
  } finally {
    if (before === undefined) Deno.env.delete("DENEXT_DESKTOP_NPM");
    else Deno.env.set("DENEXT_DESKTOP_NPM", before);
  }
}

/** Compile `source` into `out` for `arch` (`-dynamiclib` for a library). */
async function cc(source: string, out: string, arch: string, lib: boolean): Promise<void> {
  await Deno.mkdir(dirname(out), { recursive: true });
  const r = await tool("cc", [...(lib ? ["-dynamiclib"] : []), "-arch", arch, "-o", out, source]);
  assertEquals(r.code, 0, r.out);
}

/** A stand-in .app: Info.plist and a main executable for `arch`. */
async function fakeApp(app: string, arch: string, main: string): Promise<void> {
  await Deno.mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await Deno.writeTextFile(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>app</string>
<key>CFBundleIdentifier</key><string>com.example.libs</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  await cc(main, join(app, "Contents", "MacOS", "app"), arch, false);
}

Deno.test({
  name:
    "macOS: bundled dylibs land in Contents/Frameworks, merge universal and pass codesign --verify",
  ignore: !CAN_BUILD,
  fn: async () => {
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-libs-mac-" }));
    try {
      const lib = join(dir, "src", "tiny.c");
      const main = join(dir, "src", "main.c");
      await Deno.mkdir(join(dir, "src"));
      await Deno.writeTextFile(lib, "int tiny_add(int a, int b) { return a + b; }\n");
      await Deno.writeTextFile(main, "int main(void) { return 0; }\n");
      const proj = join(dir, "proj");
      await cc(lib, join(proj, "native/aarch64-apple-darwin/libtiny.dylib"), "arm64", true);
      await cc(lib, join(proj, "native/x86_64-apple-darwin/libtiny.dylib"), "x86_64", true);
      // An already-universal library, the same file for both arches; one for arm64 alone.
      await cc(lib, join(dir, "uni-arm.dylib"), "arm64", true);
      await cc(lib, join(dir, "uni-x86.dylib"), "x86_64", true);
      await Deno.mkdir(join(proj, "native/universal"), { recursive: true });
      const lipo = await tool("lipo", [
        "-create",
        join(dir, "uni-arm.dylib"),
        join(dir, "uni-x86.dylib"),
        "-output",
        join(proj, "native/universal/libuni.dylib"),
      ]);
      assertEquals(lipo.code, 0, lipo.out);
      await cc(lib, join(proj, "native/arm/libarmonly.dylib"), "arm64", true);
      await Deno.writeTextFile(
        join(proj, "denext.config.ts"),
        `export default ${
          JSON.stringify({
            desktop: {
              bundle: {
                libraries: [
                  "native/{target}/libtiny.{ext}",
                  {
                    name: "uni",
                    files: {
                      "darwin-arm64": "native/universal/libuni.dylib",
                      "darwin-x64": "native/universal/libuni.dylib",
                    },
                  },
                  { name: "armonly", files: { "darwin-arm64": "native/arm/libarmonly.dylib" } },
                ],
              },
              extraPermissions: { ffi: ["*"] },
            },
          })
        };\n`,
      );
      const entry = toFileUrl(join(proj, "scripts", "package-macos.ts")).href;
      const script = await loadScript(dir);

      const arm = join(dir, "dist", ".tmp-arm64.app");
      const x86 = join(dir, "dist", ".tmp-x86_64.app");
      await fakeApp(arm, "arm64", main);
      await fakeApp(x86, "x86_64", main);
      const quiet = () => {};
      const armOut = await bundleDesktopLibraries(
        entry,
        "darwin",
        arm,
        "aarch64-apple-darwin",
        quiet,
      );
      const x86Out = await bundleDesktopLibraries(
        entry,
        "darwin",
        x86,
        "x86_64-apple-darwin",
        quiet,
      );
      assertEquals(armOut.copied.length, 3);
      assertEquals(x86Out.copied.length, 2);
      const frameworks = (app: string, file: string) => join(app, "Contents", "Frameworks", file);
      assertEquals(
        (await tool("lipo", ["-archs", frameworks(arm, "libtiny.dylib")])).out.trim(),
        "arm64",
      );

      // The universal merge (before any signing, as the script runs it): a lipo of the per-arch
      // builds, the already-universal file kept, the arm64-only one carried over.
      const uni = join(dir, "dist", "Libs.app");
      await script.mergeUniversal(arm, x86, uni);
      const archs = (file: string) =>
        tool("lipo", ["-archs", frameworks(uni, file)]).then((r) =>
          r.out.trim().split(/\s+/).sort()
        );
      assertEquals(await archs("libtiny.dylib"), ["arm64", "x86_64"]);
      assertEquals(await archs("libuni.dylib"), ["arm64", "x86_64"]);
      assertEquals(await archs("libarmonly.dylib"), ["arm64"]);
      // A single-arch bundle, then the universal one, signed by the script's own inside-out pass
      // (ad-hoc here).
      await script.sign(arm, undefined);
      const verify = await tool("codesign", ["--verify", "--deep", "--strict", arm]);
      assertEquals(verify.code, 0, verify.out);
      const libSig = await tool("codesign", ["-dv", frameworks(arm, "libtiny.dylib")]);
      assertEquals(libSig.code, 0, libSig.out);
      assertStringIncludes(libSig.out, "Signature=adhoc");

      await script.sign(uni, undefined);
      const verifyUni = await tool("codesign", ["--verify", "--deep", "--strict", uni]);
      assertEquals(verifyUni.code, 0, verifyUni.out);
      for (const file of ["libtiny.dylib", "libuni.dylib", "libarmonly.dylib"]) {
        const sig = await tool("codesign", ["--verify", "--strict", frameworks(uni, file)]);
        assert(sig.code === 0, `${file}: ${sig.out}`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
