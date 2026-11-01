// The iOS half of denext's encrypted key-value stores (`denext mobile add storage [--encrypted]`):
// DenextStorageStore.swift compiled for macOS and driven by tests/fixtures/storage-cipher/
// StorageHarness.swift twice, against the system SQLite (a key is refused with
// ENCRYPTION_UNAVAILABLE and nothing is written in the clear) and against SQLCipher through the
// same Swift package `--encrypted` links into the app (the store's rows move into an encrypted
// file that holds no plaintext and that a wrong key does not open, and the plain database keeps
// no copy); and the plugin type-checked against the iOS SDK and a Capacitor stub. The Android
// half compiles in the native-plugins workflow (Gradle, with net.zetetic:sqlcipher-android).
// Each case runs where its toolchain is: swiftc / swift / the iOS SDK on macOS.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  SQLCIPHER_SWIFT_PACKAGE,
  STORAGE_IOS_FILES,
} from "../src/build/storage-native-templates.ts";

const HARNESS = new URL("./fixtures/storage-cipher/StorageHarness.swift", import.meta.url).pathname;
const STORE = STORAGE_IOS_FILES["DenextStorageStore.swift"];

/** Whether `tool args` runs. */
function has(tool: string, args: string[]): boolean {
  try {
    return new Deno.Command(tool, { args, stdout: "null", stderr: "null" }).outputSync().success;
  } catch {
    return false;
  }
}

/** Run `cmd` to completion; a failure throws with its output. */
async function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  // swift build clones its packages with git; a pre-push hook's GIT_* would point those at this repo.
  const env = Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([name]) => !name.startsWith("GIT_")),
  );
  const out = await new Deno.Command(cmd, {
    args,
    cwd,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  if (!out.success) throw new Error(`${cmd} ${args.join(" ")} failed:\n${text}`);
  return text;
}

/** Run a harness binary (it exits non-zero on a failed check, so read its output either way). */
async function harness(bin: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(bin, { args, stdout: "piped", stderr: "piped" }).output();
  return new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
}

/** No failures, and a clean tally. */
function assertHarness(output: string): void {
  const lines = output.trim().split("\n");
  assertEquals(lines.filter((l) => l.startsWith("FAIL")), [], output);
  assertEquals(lines.at(-1), "done 0", output);
}

const MAC_SWIFT = Deno.build.os === "darwin" && has("swiftc", ["--version"]);

Deno.test({
  name: "storage (iOS): without SQLCipher a key is refused and nothing is written in the clear",
  ignore: !MAC_SWIFT,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_storage_plain_" });
    try {
      await Deno.writeTextFile(join(dir, "DenextStorageStore.swift"), STORE);
      await Deno.copyFile(HARNESS, join(dir, "main.swift"));
      const bin = join(dir, "harness");
      await run("swiftc", [
        "-swift-version",
        "5",
        "-o",
        bin,
        join(dir, "main.swift"),
        join(dir, "DenextStorageStore.swift"),
      ]);
      const work = join(dir, "work");
      await Deno.mkdir(work);
      const out = await harness(bin, ["plain", work]);
      assertHarness(out);
      assert(out.includes("ok a key is refused without SQLCipher"), out);
      assert(out.includes("ok a rekey is refused without SQLCipher"), out);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

const MAC_SWIFTPM = Deno.build.os === "darwin" && has("swift", ["--version"]);

Deno.test({
  name: "storage (iOS): with SQLCipher (the Swift package) a store is encrypted, moved and keyed",
  ignore: !MAC_SWIFTPM,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_storage_cipher_" });
    try {
      const src = join(dir, "Sources", "StorageHarness");
      await Deno.mkdir(src, { recursive: true });
      await Deno.writeTextFile(join(src, "DenextStorageStore.swift"), STORE);
      await Deno.copyFile(HARNESS, join(src, "main.swift"));
      const { url, minimumVersion, product } = SQLCIPHER_SWIFT_PACKAGE;
      const major = Number(minimumVersion.split(".")[0]);
      await Deno.writeTextFile(
        join(dir, "Package.swift"),
        `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "StorageHarness",
    platforms: [.macOS(.v12)],
    dependencies: [
        .package(url: "${url}", "${minimumVersion}"..<"${major + 1}.0.0")
    ],
    targets: [
        .executableTarget(
            name: "StorageHarness",
            dependencies: [.product(name: "${product}", package: "SQLCipher.swift")]
        )
    ]
)
`,
      );
      // The package's framework lands beside the executable, which the app's Xcode build embeds.
      // Only the Swift Build engine's plain `swift build` leaves that folder off the rpath (dyld:
      // `Library not loaded: @rpath/SQLCipher.framework/…`), so the harness names it itself.
      const rpath = ["-Xlinker", "-rpath", "-Xlinker", "@executable_path"];
      await run("swift", ["build", "--package-path", dir, "-c", "debug", ...rpath]);
      const bin = (await run("swift", ["build", "--package-path", dir, "--show-bin-path"])).trim()
        .split("\n").at(-1)!;
      const work = join(dir, "work");
      await Deno.mkdir(work);
      const out = await harness(join(bin, "StorageHarness"), ["cipher", work]);
      assertHarness(out);
      assert(out.includes("ok the encrypted file holds no plaintext"), out);
      assert(out.includes("ok a wrong key is refused"), out);
      assert(out.includes("ok the old key no longer opens the rekeyed file"), out);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

const IOS_SDK = Deno.build.os === "darwin" &&
  has("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]);

Deno.test({
  name: "storage (iOS): the plugin and the store type-check against UIKit and a Capacitor stub",
  ignore: !IOS_SDK,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_storage_ios_" });
    try {
      const xcrun = (args: string[]) =>
        run("xcrun", ["--sdk", "iphoneos", "swiftc", "-target", "arm64-apple-ios15.0", ...args]);
      await Deno.copyFile(
        new URL("./fixtures/capacitor-ios/Capacitor.swift", import.meta.url).pathname,
        join(dir, "Capacitor.swift"),
      );
      await xcrun([
        "-emit-module",
        "-parse-as-library",
        "-module-name",
        "Capacitor",
        "-emit-module-path",
        join(dir, "Capacitor.swiftmodule"),
        join(dir, "Capacitor.swift"),
      ]);
      for (const [name, text] of Object.entries(STORAGE_IOS_FILES)) {
        await Deno.writeTextFile(join(dir, name), text);
      }
      for (const version of ["5", "6"]) {
        await xcrun([
          "-typecheck",
          "-swift-version",
          version,
          "-I",
          dir,
          ...Object.keys(STORAGE_IOS_FILES).map((name) => join(dir, name)),
        ]);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
