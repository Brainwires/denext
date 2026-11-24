// desktop.bundle.libraries: the config's shape (src/desktop/bundled-libraries.ts), each entry
// resolved for every target, the packager's copy into each OS's bundle layout and the installers
// built from it (src/build/desktop-bundle-libraries.ts), the run-time table the desktop sync writes,
// `bundledLibraryPath` in a packaged and a `desktop run` / `dev` layout, the doctor's check, and the
// package scripts that call the copy before signing.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join, toFileUrl } from "@std/path";
import {
  bundledLibraryPath,
  bundledLibraryPathIn,
  DESKTOP_LIBRARY_TARGETS,
  desktopBundleLibrariesProblem,
  desktopBundleProblem,
  desktopLibrariesForTarget,
  desktopLibraryDir,
  type DesktopLibraryTarget,
  desktopLibraryTarget,
  registerBundledLibraries,
} from "../src/desktop/bundled-libraries.ts";
import {
  bundleDesktopLibraries,
  desktopBundledLibraryTable,
  desktopLibrariesDoctorFindings,
  desktopLibrariesFfiNote,
  staleLibrariesScriptProblem,
} from "../src/build/desktop-bundle-libraries.ts";
import { syncDesktopRuntimeConfig } from "../src/build/desktop-app-config.ts";
import { desktopPeFiles } from "../src/build/desktop-package-script.ts";
import {
  buildDesktopDeb,
  buildDesktopTarball,
  packageMetaFrom,
} from "../src/build/desktop-installers.ts";
import { runDesktopDoctor } from "../src/build/desktop-doctor.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";
import {
  LINUX_PACKAGE_SCRIPT,
  MACOS_PACKAGE_SCRIPT,
  WINDOWS_PACKAGE_SCRIPT,
} from "../src/build/desktop-package-scripts.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

const TARGETS = Object.keys(DESKTOP_LIBRARY_TARGETS) as DesktopLibraryTarget[];

/** A temp project with `files` (path → text or bytes) and a `scripts/` entry URL. */
async function project(
  files: Record<string, string | Uint8Array>,
): Promise<{ dir: string; entry: string }> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-libs-" }));
  for (const [path, body] of Object.entries(files)) {
    const file = join(dir, ...path.split("/"));
    await Deno.mkdir(dirname(file), { recursive: true });
    if (typeof body === "string") await Deno.writeTextFile(file, body);
    else await Deno.writeFile(file, body);
  }
  return { dir, entry: toFileUrl(join(dir, "scripts", "package.ts")).href };
}

/** `denext.config.ts` exporting `config`. */
const configFile = (config: unknown) => `export default ${JSON.stringify(config)};\n`;

// ---------------------------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------------------------

Deno.test("desktop.bundle.libraries: every accepted entry form validates", () => {
  assertEquals(desktopBundleLibrariesProblem(undefined), null);
  assertEquals(desktopBundleLibrariesProblem([]), null);
  assertEquals(
    desktopBundleLibrariesProblem([
      "native/{target}/librullama_audio_ffi.{ext}",
      "./native/{os}-{arch}/libvad.{ext}",
      { path: "native/{os}/libspeech.{ext}", optional: true },
      { path: "native/{arch}/libx-{arch}.{ext}", name: "x" },
      {
        name: "audio",
        files: {
          "darwin-arm64": "native/mac-arm64/libaudio.dylib",
          "linux-x64": "native/linux/libaudio.so.1",
        },
        optional: false,
      },
      { name: "win", files: { "windows-x64": "native/win/Win.DLL" } },
    ]),
    null,
  );
  assertEquals(desktopBundleProblem(undefined), null);
  assertEquals(desktopBundleProblem({}), null);
  assertEquals(desktopBundleProblem({ libraries: ["native/libz.{ext}"] }), null);
});

Deno.test("desktop.bundle.libraries: unsafe or malformed entries are refused, naming the field", () => {
  const cases: Array<[unknown, string, string]> = [
    ["native/libx.dylib", "desktop.bundle.libraries", "must be an array"],
    [[42], "desktop.bundle.libraries[0]", "must be a path pattern"],
    [["/abs/libx.{ext}"], "desktop.bundle.libraries[0].path", "relative to the project"],
    [["C:/x/libx.{ext}"], "desktop.bundle.libraries[0].path", "relative to the project"],
    [["\\\\server\\libx.{ext}"], "desktop.bundle.libraries[0].path", "relative to the project"],
    [["native\\libx.{ext}"], "desktop.bundle.libraries[0].path", "/ separators"],
    [["../outside/libx.{ext}"], "desktop.bundle.libraries[0].path", "inside the project"],
    [["native/../../libx.{ext}"], "desktop.bundle.libraries[0].path", "inside the project"],
    [["native//libx.{ext}"], "desktop.bundle.libraries[0].path", "inside the project"],
    [[""], "desktop.bundle.libraries[0].path", "non-empty path"],
    [
      ["native/{platform}/libx.{ext}"],
      "desktop.bundle.libraries[0].path",
      "unknown placeholder {platform}",
    ],
    [["native/{os/libx.{ext}"], "desktop.bundle.libraries[0].path", "unknown placeholder"],
    [["native/libx}.{ext}"], "desktop.bundle.libraries[0].path", "unbalanced brace"],
    [
      ["native/libx.a"],
      "desktop.bundle.libraries[0]",
      'must name a .dylib, .so (.so.N) or .dll file (got "libx.a"',
    ],
    [["native/libx.{os}"], "desktop.bundle.libraries[0]", "must name a .dylib"],
    [["native/libx-{arch}.{ext}"], "desktop.bundle.libraries[0]", "needs a name"],
    [["native/.{ext}"], "desktop.bundle.libraries[0]", "needs a name"],
    [
      [{ path: "native/libx.{ext}", files: {} }],
      "desktop.bundle.libraries[0]",
      "path or files, not both",
    ],
    [[{ optional: true }], "desktop.bundle.libraries[0]", "needs a path"],
    [
      [{ path: "native/libx.{ext}", optional: "yes" }],
      "desktop.bundle.libraries[0].optional",
      "boolean",
    ],
    [
      [{ path: "native/libx.{ext}", name: "a b" }],
      "desktop.bundle.libraries[0].name",
      "must be a name",
    ],
    [[{ path: "native/libx.{ext}", nam: "x" }], "desktop.bundle.libraries[0].nam", "not a key"],
    [[{ files: { "linux-x64": "a/liba.so" } }], "desktop.bundle.libraries[0].name", "required"],
    [[{ name: "a", files: {} }], "desktop.bundle.libraries[0].files", "must map targets"],
    [[{ name: "a", files: [] }], "desktop.bundle.libraries[0].files", "must map targets"],
    [
      [{ name: "a", files: { "darwin-x86_64": "a/liba.dylib" } }],
      "desktop.bundle.libraries[0].files.darwin-x86_64",
      "not a target",
    ],
    [
      [{ name: "a", files: { "linux-x64": "{os}/liba.so" } }],
      "desktop.bundle.libraries[0].files.linux-x64",
      "cannot use placeholders",
    ],
    [
      [{ name: "a", files: { "linux-x64": "../liba.so" } }],
      "desktop.bundle.libraries[0].files.linux-x64",
      "inside the project",
    ],
    [
      [{ name: "a", files: { "linux-x64": "liba.txt" } }],
      "desktop.bundle.libraries[0]",
      'got "liba.txt" for linux-x64',
    ],
    [["a/libx.{ext}", "b/libx.{ext}"], "desktop.bundle.libraries[1]", 'repeats the name "x"'],
    [
      ["a/libx.{ext}", { name: "y", files: { "darwin-arm64": "b/LIBX.dylib" } }],
      "desktop.bundle.libraries[1]",
      'bundles the file "LIBX.dylib" for darwin-arm64',
    ],
  ];
  for (const [value, field, message] of cases) {
    const problem = desktopBundleLibrariesProblem(value);
    assert(problem, `expected a problem for ${JSON.stringify(value)}`);
    assertEquals(problem[0], field, JSON.stringify(value));
    assertStringIncludes(problem[1], message, JSON.stringify(value));
  }
  assertEquals(desktopBundleProblem("x")?.[0], "desktop.bundle");
  assertEquals(desktopBundleProblem([])?.[0], "desktop.bundle");
  assertEquals(desktopBundleProblem({ libs: [] })?.[0], "desktop.bundle.libs");
});

Deno.test("config validation: desktop.bundle reports through validateDenextConfig", () => {
  const check = (bundle: unknown) => () =>
    validateDenextConfig({ desktop: { bundle } } as unknown as DenextConfig);
  check({ libraries: ["native/{target}/libaudio.{ext}"] })();
  assertThrows(check({ libraries: ["/abs/libx.so"] }), Error, "desktop.bundle.libraries[0].path");
  assertThrows(check({ libraries: ["native/libx.txt"] }), Error, "desktop.bundle.libraries[0]");
  assertThrows(check({ extra: true }), Error, "desktop.bundle.extra");
});

// ---------------------------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------------------------

Deno.test("desktopLibrariesForTarget: a pattern expands {os} {arch} {target} {ext} for every target", () => {
  const value = [
    "native/{target}/librullama_audio_ffi.{ext}",
    { path: "native/{os}-{arch}/libvad-{arch}.{ext}", name: "vad" },
  ];
  const expected: Record<DesktopLibraryTarget, [string, string]> = {
    "darwin-arm64": ["aarch64-apple-darwin", "darwin-arm64/libvad-arm64.dylib"],
    "darwin-x64": ["x86_64-apple-darwin", "darwin-x64/libvad-x64.dylib"],
    "linux-arm64": ["aarch64-unknown-linux-gnu", "linux-arm64/libvad-arm64.so"],
    "linux-x64": ["x86_64-unknown-linux-gnu", "linux-x64/libvad-x64.so"],
    "windows-arm64": ["aarch64-pc-windows-msvc", "windows-arm64/libvad-arm64.dll"],
    "windows-x64": ["x86_64-pc-windows-msvc", "windows-x64/libvad-x64.dll"],
  };
  for (const target of TARGETS) {
    const ext = DESKTOP_LIBRARY_TARGETS[target].ext;
    const [triple, vad] = expected[target];
    assertEquals(desktopLibrariesForTarget(value, target), [
      {
        name: "rullama_audio_ffi",
        path: `native/${triple}/librullama_audio_ffi.${ext}`,
        file: `librullama_audio_ffi.${ext}`,
        optional: false,
      },
      { name: "vad", path: `native/${vad}`, file: vad.split("/")[1], optional: false },
    ], target);
  }
});

Deno.test("desktopLibrariesForTarget: names, leading ./, versioned .so and per-target maps", () => {
  assertEquals(desktopLibrariesForTarget(["./native/libz.so.1.2"], "linux-x64"), [
    { name: "z", path: "native/libz.so.1.2", file: "libz.so.1.2", optional: false },
  ]);
  // No `lib` prefix: the file name without the extension.
  assertEquals(desktopLibrariesForTarget(["bin/Speech.{ext}"], "windows-arm64")[0].name, "Speech");
  const map = [{
    name: "audio",
    files: {
      "darwin-arm64": "native/mac/libaudio.dylib",
      "linux-x64": "./native/linux/libaudio.so",
    },
    optional: true,
  }];
  assertEquals(desktopLibrariesForTarget(map, "darwin-arm64"), [
    { name: "audio", path: "native/mac/libaudio.dylib", file: "libaudio.dylib", optional: true },
  ]);
  assertEquals(desktopLibrariesForTarget(map, "linux-x64")[0].path, "native/linux/libaudio.so");
  // A target with no entry ships without the library.
  for (const t of ["darwin-x64", "linux-arm64", "windows-arm64", "windows-x64"] as const) {
    assertEquals(desktopLibrariesForTarget(map, t), [], t);
  }
  assertThrows(() => desktopLibrariesForTarget(["/x/liba.so"], "linux-x64"), Error, "invalid");
});

Deno.test("desktopLibraryTarget / desktopLibraryDir", () => {
  assertEquals(desktopLibraryTarget("darwin", "aarch64"), "darwin-arm64");
  assertEquals(desktopLibraryTarget("darwin", "arm64"), "darwin-arm64");
  assertEquals(desktopLibraryTarget("linux", "x86_64"), "linux-x64");
  assertEquals(desktopLibraryTarget("windows", "x64"), "windows-x64");
  assertEquals(desktopLibraryTarget("freebsd", "x86_64"), null);
  assertEquals(desktopLibraryTarget("linux", "riscv64"), null);
  assertEquals(desktopLibraryDir("darwin"), "Contents/Frameworks");
  assertEquals(desktopLibraryDir("linux"), "lib");
  assertEquals(desktopLibraryDir("windows"), "");
});

// ---------------------------------------------------------------------------------------------
// Run-time lookup
// ---------------------------------------------------------------------------------------------

const TABLE = {
  targets: {
    "darwin-arm64": { audio: "native/mac/libaudio.dylib" },
    "linux-x64": { audio: "native/linux/libaudio.so.1" },
    "windows-x64": { audio: "native/win/audio.dll" },
  },
};

Deno.test("bundledLibraryPathIn: the packaged bundle's copy for each OS layout", () => {
  assertEquals(
    bundledLibraryPathIn("audio", TABLE, {
      os: "darwin",
      arch: "aarch64",
      execPath: "/Applications/My App.app/Contents/MacOS/laufey_webview",
    }),
    "/Applications/My App.app/Contents/Frameworks/libaudio.dylib",
  );
  assertEquals(
    bundledLibraryPathIn("audio", TABLE, {
      os: "linux",
      arch: "x86_64",
      execPath: "/usr/lib/my-app/My-App-x64",
    }),
    "/usr/lib/my-app/lib/libaudio.so.1",
  );
  assertEquals(
    bundledLibraryPathIn("audio", TABLE, {
      os: "windows",
      arch: "x86_64",
      execPath: "C:\\Users\\me\\AppData\\Local\\Programs\\My App\\My-App-x64.exe",
    }),
    "C:\\Users\\me\\AppData\\Local\\Programs\\My App\\audio.dll",
  );
});

Deno.test("bundledLibraryPathIn: null without a table, a library, a target or a bundle", () => {
  const mac = { os: "darwin", arch: "aarch64", execPath: "/A.app/Contents/MacOS/a" };
  assertEquals(bundledLibraryPathIn("audio", undefined, mac), null);
  assertEquals(bundledLibraryPathIn("nope", TABLE, mac), null);
  // darwin-x64 has no build of it.
  assertEquals(bundledLibraryPathIn("audio", TABLE, { ...mac, arch: "x86_64" }), null);
  assertEquals(bundledLibraryPathIn("audio", TABLE, { ...mac, os: "freebsd" }), null);
  // An executable outside an .app (the deno CLI) has no bundle.
  assertEquals(
    bundledLibraryPathIn("audio", TABLE, { ...mac, execPath: "/usr/local/bin/deno" }),
    null,
  );
  assertEquals(bundledLibraryPathIn("audio", TABLE, { ...mac, execPath: undefined }), null);
  assertEquals(
    bundledLibraryPathIn("audio", TABLE, { os: "linux", arch: "x86_64", execPath: "app" }),
    null,
  );
  // Inherited keys are not library names.
  assertEquals(bundledLibraryPathIn("toString", TABLE, mac), null);
});

Deno.test("bundledLibraryPathIn: a desktop run / dev table answers the project's own file", () => {
  const dev = { ...TABLE, projectDir: "/work/app/" };
  assertEquals(
    bundledLibraryPathIn("audio", dev, { os: "darwin", arch: "arm64", execPath: "/tmp/x" }),
    "/work/app/native/mac/libaudio.dylib",
  );
  assertEquals(
    bundledLibraryPathIn("audio", { ...TABLE, projectDir: "C:\\work\\app" }, {
      os: "windows",
      arch: "x86_64",
      execPath: undefined,
    }),
    "C:\\work\\app\\native\\win\\audio.dll",
  );
});

/** The host's target, or `null` off the desktop OSes. */
const HOST = desktopLibraryTarget(Deno.build.os, Deno.build.arch);

Deno.test({
  name: "bundledLibraryPath: a simulated packaged tree and the dev layout, on this host",
  ignore: HOST === null,
  fn: async () => {
    const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-libs-tree-" }));
    try {
      const os = Deno.build.os as "darwin" | "linux" | "windows";
      const ext = DESKTOP_LIBRARY_TARGETS[HOST!].ext;
      const file = `libaudio.${ext}`;
      // The packaged layout deno desktop writes, with the library where the packager puts it.
      const bundle = os === "darwin" ? join(root, "My App.app") : join(root, "My-App");
      const exe = os === "darwin"
        ? join(bundle, "Contents", "MacOS", "my-app")
        : join(bundle, os === "windows" ? "My-App.exe" : "My-App");
      const lib = join(bundle, ...desktopLibraryDir(os).split("/").filter(Boolean), file);
      await Deno.mkdir(dirname(exe), { recursive: true });
      await Deno.mkdir(dirname(lib), { recursive: true });
      await Deno.writeTextFile(exe, "");
      await Deno.writeTextFile(lib, "");
      const table = { targets: { [HOST!]: { audio: `native/${file}` } } };
      const packaged = bundledLibraryPathIn("audio", table, {
        os,
        arch: Deno.build.arch,
        execPath: exe,
      });
      assertEquals(packaged, lib);
      assert((await Deno.stat(packaged!)).isFile);

      // The dev layout: the table registered from the entry's config names the project.
      await Deno.mkdir(join(root, "proj", "native"), { recursive: true });
      await Deno.writeTextFile(join(root, "proj", "native", file), "");
      registerBundledLibraries({ bundledLibraries: { ...table, projectDir: join(root, "proj") } });
      try {
        const dev = bundledLibraryPath("audio");
        assertEquals(dev, join(root, "proj", "native", file));
        assert((await Deno.stat(dev!)).isFile);
        assertEquals(bundledLibraryPath("other"), null);
      } finally {
        registerBundledLibraries(undefined);
      }
      assertEquals(bundledLibraryPath("audio"), null, "no table registered: null");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("resolveDesktopCapabilities registers the config's bundledLibraries table", async () => {
  if (HOST === null) return;
  try {
    await resolveDesktopCapabilities({
      desktop: {},
      bundledLibraries: { targets: { [HOST]: { audio: "native/libaudio.x" } }, projectDir: "/p" },
    });
    assertStringIncludes(bundledLibraryPath("audio") ?? "", "libaudio.x");
    // A malformed table registers none.
    await resolveDesktopCapabilities({ desktop: {}, bundledLibraries: { targets: 3 } });
    assertEquals(bundledLibraryPath("audio"), null);
  } finally {
    registerBundledLibraries(undefined);
  }
});

// ---------------------------------------------------------------------------------------------
// The packager's copy
// ---------------------------------------------------------------------------------------------

/** A config with one library per form, the files present for every target but windows-arm64. */
async function libraryProject(extra: Record<string, unknown> = {}) {
  const files: Record<string, string> = {};
  for (const t of TARGETS) {
    if (t === "windows-arm64") continue;
    const { triple, ext } = DESKTOP_LIBRARY_TARGETS[t];
    files[`native/${triple}/librullama_audio_ffi.${ext}`] = `lib for ${t}`;
  }
  files["native/mac/libaudio.dylib"] = "audio";
  return await project({
    ...files,
    "denext.config.ts": configFile({
      desktop: {
        bundle: {
          libraries: [
            "native/{target}/librullama_audio_ffi.{ext}",
            { path: "native/{os}/libspeech.{ext}", optional: true },
            { name: "audio", files: { "darwin-arm64": "native/mac/libaudio.dylib" } },
          ],
        },
        ...extra,
      },
    }),
  });
}

Deno.test("bundleDesktopLibraries: each target's build lands in its OS's bundle layout", async () => {
  const { dir, entry } = await libraryProject();
  try {
    const cases: Array<[DesktopLibraryTarget, string, string]> = [
      ["darwin-arm64", "aarch64-apple-darwin", "My.app/Contents/Frameworks"],
      ["darwin-x64", "x86_64-apple-darwin", "My.app/Contents/Frameworks"],
      ["linux-arm64", "aarch64-unknown-linux-gnu", "My-arm64/lib"],
      ["linux-x64", "x86_64-unknown-linux-gnu", "My-x64/lib"],
      ["windows-x64", "x86_64-pc-windows-msvc", "My-x64"],
    ];
    for (const [target, triple, where] of cases) {
      const { os, ext } = DESKTOP_LIBRARY_TARGETS[target];
      const bundle = join(dir, "dist", target, where.split("/")[0]);
      const lines: string[] = [];
      const out = await bundleDesktopLibraries(entry, os, bundle, triple, (l) => lines.push(l));
      const lib = join(dir, "dist", target, ...where.split("/"), `librullama_audio_ffi.${ext}`);
      assertEquals(out.copied[0], lib, target);
      assertEquals(await Deno.readTextFile(lib), `lib for ${target}`);
      // The optional library has no file anywhere: skipped with a note, never a failure.
      assertEquals(out.skipped, [`speech: native/${os}/libspeech.${ext}`]);
      assert(lines.some((l) => l.includes('the optional library "speech" is skipped')), target);
      // The per-target map ships on darwin-arm64 only.
      assertEquals(out.copied.length, target === "darwin-arm64" ? 2 : 1, target);
      // No unscoped --allow-ffi: the note says what the app needs.
      assert(lines.some((l) => l.includes('ffi: ["*"]')), target);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleDesktopLibraries: a missing required file fails, naming the path it looked for", async () => {
  const { dir, entry } = await libraryProject();
  try {
    const err = await assertRejects(
      () =>
        bundleDesktopLibraries(
          entry,
          "windows",
          join(dir, "dist", "W"),
          "aarch64-pc-windows-msvc",
          () => {},
        ),
      Error,
    );
    assertStringIncludes(
      err.message,
      'the library "rullama_audio_ffi" needs native/aarch64-pc-windows-msvc/librullama_audio_ffi.dll for windows-arm64',
    );
    assertStringIncludes(err.message, "optional: true");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleDesktopLibraries: never overwrites a file the bundle already has", async () => {
  const { dir, entry } = await project({
    "native/laufey.dll": "mine",
    "denext.config.ts": configFile({ desktop: { bundle: { libraries: ["native/laufey.{ext}"] } } }),
  });
  try {
    const bundle = join(dir, "dist", "W");
    await Deno.mkdir(bundle, { recursive: true });
    await Deno.writeTextFile(join(bundle, "laufey.dll"), "runtime");
    await assertRejects(
      () => bundleDesktopLibraries(entry, "windows", bundle, "x86_64-pc-windows-msvc", () => {}),
      Error,
      "has the name of a file the bundle already has",
    );
    assertEquals(await Deno.readTextFile(join(bundle, "laufey.dll")), "runtime");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleDesktopLibraries: no libraries, nothing copied; an invalid config fails", async () => {
  const none = await project({ "denext.config.ts": configFile({ desktop: {} }) });
  const bad = await project({
    "denext.config.ts": configFile({ desktop: { bundle: { libraries: ["../x/liba.so"] } } }),
  });
  try {
    assertEquals(await bundleDesktopLibraries(none.entry, "linux", join(none.dir, "b")), {
      copied: [],
      skipped: [],
    });
    await assertRejects(
      () => bundleDesktopLibraries(bad.entry, "linux", join(bad.dir, "b"), "host", () => {}),
      Error,
      "desktop.bundle.libraries[0].path",
    );
  } finally {
    await Deno.remove(none.dir, { recursive: true });
    await Deno.remove(bad.dir, { recursive: true });
  }
});

Deno.test("desktopLibrariesFfiNote: silent with the unscoped grant or no libraries", () => {
  const libs = { bundle: { libraries: ["native/liba.{ext}"] } };
  assertStringIncludes(desktopLibrariesFfiNote({ desktop: libs }, "darwin") ?? "", "--allow-ffi");
  assertStringIncludes(
    desktopLibrariesFfiNote(
      { desktop: { ...libs, extraPermissions: { ffi: ["/opt/liba.so"] } } },
      "linux",
    ) ?? "",
    "/usr/lib/<package>/lib/",
  );
  assertEquals(
    desktopLibrariesFfiNote({ desktop: { ...libs, extraPermissions: { ffi: ["*"] } } }, "windows"),
    null,
  );
  assertEquals(desktopLibrariesFfiNote({ desktop: {} }, "linux"), null);
  assertEquals(desktopLibrariesFfiNote({ desktop: { bundle: { libraries: [7] } } }, "linux"), null);
});

Deno.test("bundleDesktopLibraries + desktopPeFiles: a bundled .dll is among the PE files the Windows script signs", async () => {
  // A minimal PE header: "MZ", e_lfanew at 0x3c pointing at "PE\0\0".
  const pe = new Uint8Array(0x48);
  pe.set([0x4d, 0x5a]);
  new DataView(pe.buffer).setUint32(0x3c, 0x40, true);
  pe.set([0x50, 0x45, 0, 0], 0x40);
  const { dir, entry } = await project({
    "native/win/audio.dll": pe,
    "denext.config.ts": configFile({
      desktop: {
        bundle: {
          libraries: [{ name: "audio", files: { "windows-x64": "native/win/audio.dll" } }],
        },
      },
    }),
  });
  try {
    const bundle = join(dir, "dist", "App-x64");
    await Deno.mkdir(bundle, { recursive: true });
    await bundleDesktopLibraries(entry, "windows", bundle, "x86_64-pc-windows-msvc", () => {});
    assertEquals(await desktopPeFiles(bundle), [join(bundle, "audio.dll")]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The member names of a gzipped ustar archive. */
async function tarNames(gz: Uint8Array): Promise<string[]> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  const dec = new TextDecoder();
  const cstr = (a: number, n: number) => dec.decode(tar.subarray(a, a + n)).replace(/\0.*$/s, "");
  const out: string[] = [];
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const prefix = cstr(at + 345, 155);
    out.push((prefix ? prefix + "/" : "") + cstr(at, 100));
    at += 512 + Math.ceil(parseInt(cstr(at + 124, 12), 8) / 512) * 512;
  }
  return out;
}

/** The `data.tar.gz` member of a `.deb` (an `ar` archive). */
function debData(bytes: Uint8Array): Uint8Array {
  const dec = new TextDecoder();
  for (let at = 8; at < bytes.length;) {
    const header = dec.decode(bytes.subarray(at, at + 60));
    const size = Number(header.slice(48, 58).trim());
    if (header.slice(0, 16).trim() === "data.tar.gz") {
      return bytes.subarray(at + 60, at + 60 + size);
    }
    at += 60 + size + (size % 2);
  }
  throw new Error("no data.tar.gz");
}

Deno.test("Linux: the .tar.gz and .deb built from the bundle carry lib/<file>", async () => {
  const { dir, entry } = await project({
    "native/x86_64-unknown-linux-gnu/libaudio.so": "elf",
    "denext.config.ts": configFile({
      desktop: { bundle: { libraries: ["native/{target}/libaudio.{ext}"] } },
    }),
  });
  try {
    const bundle = join(dir, "dist", "My-App-x64");
    await Deno.mkdir(bundle, { recursive: true });
    await Deno.writeTextFile(join(bundle, "My-App-x64"), "#!/bin/sh\n");
    await Deno.writeTextFile(join(bundle, "laufey-launch.json"), "{}\n");
    await bundleDesktopLibraries(entry, "linux", bundle, "x86_64-unknown-linux-gnu", () => {});
    const tgz = await buildDesktopTarball({ bundleDir: bundle, out: join(dir, "app.tar.gz") });
    assert((await tarNames(await Deno.readFile(tgz))).includes("./My-App-x64/lib/libaudio.so"));
    const meta = packageMetaFrom(
      { version: "1.0.0", desktop: { app: { name: "My App" } } },
      {},
      "x",
    );
    const deb = await buildDesktopDeb({
      meta,
      bundleDir: bundle,
      exe: "My-App-x64",
      arch: "x86_64",
      out: join(dir, "app.deb"),
    });
    const names = await tarNames(debData(await Deno.readFile(deb)));
    assert(names.includes("./usr/lib/my-app/lib/libaudio.so"), names.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The run-time table (`.deno-desktop/config.json`)
// ---------------------------------------------------------------------------------------------

Deno.test("desktopBundledLibraryTable: per target, only the files that exist; projectDir for dev", async () => {
  const { dir } = await libraryProject();
  try {
    const config = await import(toFileUrl(join(dir, "denext.config.ts")).href);
    const table = await desktopBundledLibraryTable(dir, config.default);
    assertEquals(table?.projectDir, undefined);
    assertEquals(table?.targets["darwin-arm64"], {
      rullama_audio_ffi: "native/aarch64-apple-darwin/librullama_audio_ffi.dylib",
      audio: "native/mac/libaudio.dylib",
    });
    assertEquals(table?.targets["linux-x64"], {
      rullama_audio_ffi: "native/x86_64-unknown-linux-gnu/librullama_audio_ffi.so",
    });
    assertEquals(table?.targets["windows-arm64"], undefined, "no file for it: no entry");
    assertEquals((await desktopBundledLibraryTable(dir, config.default, dir))?.projectDir, dir);
    assertEquals(await desktopBundledLibraryTable(dir, { desktop: {} }), undefined);
    await assertRejects(
      () => desktopBundledLibraryTable(dir, { desktop: { bundle: { libraries: [1] } } }),
      Error,
      "desktop.bundle.libraries[0]",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncDesktopRuntimeConfig: config.json carries bundledLibraries (projectDir only when asked)", async () => {
  const { dir } = await project({
    "desktop.ts": 'import config from "./.deno-desktop/config.json" with { type: "json" };\n',
    "native/libaudio.dylib": "x",
  });
  try {
    const config = {
      desktop: {
        bundle: {
          libraries: [{ name: "audio", files: { "darwin-arm64": "native/libaudio.dylib" } }],
        },
      },
    };
    const read = async () =>
      JSON.parse(await Deno.readTextFile(join(dir, ".deno-desktop", "config.json")));
    assertEquals(await syncDesktopRuntimeConfig(dir, config, { projectDir: dir }), "written");
    assertEquals((await read()).bundledLibraries, {
      targets: { "darwin-arm64": { audio: "native/libaudio.dylib" } },
      projectDir: dir,
    });
    // The rewrite after a desktop run / dev build drops the project directory again.
    assertEquals(await syncDesktopRuntimeConfig(dir, config), "written");
    assertEquals((await read()).bundledLibraries, {
      targets: { "darwin-arm64": { audio: "native/libaudio.dylib" } },
    });
    assertEquals(await syncDesktopRuntimeConfig(dir, config), "unchanged");
    assertEquals(await syncDesktopRuntimeConfig(dir, { desktop: {} }), "written");
    assertEquals((await read()).bundledLibraries, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------
// denext desktop doctor
// ---------------------------------------------------------------------------------------------

Deno.test("desktopLibrariesDoctorFindings: invalid config, missing host file, the ffi grant, a stale script", async () => {
  const { dir } = await project({
    "native/x86_64-unknown-linux-gnu/libaudio.so": "x",
    "scripts/package-macos.ts": "// an old script\n",
  });
  try {
    assertEquals(await desktopLibrariesDoctorFindings(dir, {}), null);
    assertEquals(await desktopLibrariesDoctorFindings(dir, { bundle: {} }), null);
    const invalid = await desktopLibrariesDoctorFindings(dir, { bundle: { libraries: ["/x.so"] } });
    assertEquals(invalid?.map((f) => f.level), ["error"]);
    const desktop = { bundle: { libraries: ["native/{target}/libaudio.{ext}"] } };
    const linux = await desktopLibrariesDoctorFindings(dir, desktop, {
      os: "linux",
      arch: "x86_64",
    });
    assertEquals(linux?.length, 2);
    assertStringIncludes(linux![0].message, "--allow-ffi");
    assertStringIncludes(linux![1].fix, "--regenerate-scripts");
    const mac = await desktopLibrariesDoctorFindings(
      dir,
      { ...desktop, extraPermissions: { ffi: ["*"] } },
      { os: "darwin", arch: "aarch64" },
    );
    assertEquals(mac?.length, 2);
    assertStringIncludes(mac![0].message, "has no native/aarch64-apple-darwin/libaudio.dylib");
    await Deno.writeTextFile(join(dir, "scripts", "package-macos.ts"), MACOS_PACKAGE_SCRIPT);
    assertEquals(
      await desktopLibrariesDoctorFindings(
        dir,
        { ...desktop, extraPermissions: { ffi: ["*"] } },
        { os: "linux", arch: "x86_64" },
      ),
      [],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDesktopDoctor: the libraries check runs when given and lists its findings", async () => {
  const finding = { check: "libraries", level: "warning" as const, message: "m", fix: "f" };
  const report = await runDesktopDoctor({
    os: "darwin",
    runtimeStatus: () =>
      Promise.resolve({ state: "ready", detail: "ok", backend: "webview" } as never),
    bundledLibraries: () => Promise.resolve([finding]),
  });
  assert(report.checks.includes("libraries"));
  assert(report.findings.some((f) => f.check === "libraries" && f.message === "m"));
  const none = await runDesktopDoctor({
    os: "darwin",
    runtimeStatus: () =>
      Promise.resolve({ state: "ready", detail: "ok", backend: "webview" } as never),
    bundledLibraries: () => Promise.resolve(null),
  });
  assert(!none.checks.includes("libraries"));
});

// ---------------------------------------------------------------------------------------------
// The package scripts
// ---------------------------------------------------------------------------------------------

Deno.test("package-macos.ts: copies each arch's libraries into the bundle before it is signed", () => {
  const s = MACOS_PACKAGE_SCRIPT;
  const copy = s.indexOf(
    'await bundleDesktopLibraries(\n    import.meta.url,\n    "darwin",\n    out,\n    target ?? "host",\n  );',
  );
  assert(copy > 0, "buildApp copies the target's libraries");
  // After the launch file, inside buildApp, and the bundle is then re-signed.
  assert(s.indexOf('writeLaufeyLaunchConfig(import.meta.url, "darwin", out)') < copy);
  assertStringIncludes(s, "if (libraries.copied.length > 0) resealNeeded = true;");
  assertStringIncludes(s, 'if (s.identity || opts.arch === "universal" || resealNeeded) {');
  // sign() signs every nested Mach-O (Contents/Frameworks included) before the bundle itself.
  const nested = s.indexOf("for (const file of await machOFiles(app)) {");
  const bundle = s.indexOf("await run(macosCodesignArgs(app, {");
  assert(nested > 0 && nested < bundle);
  assertStringIncludes(s, "for await (const e of walk(`${app}/Contents`)) {");
});

Deno.test("package-macos.ts: a universal merge keeps an already-universal library and carries a one-arch one", () => {
  const s = MACOS_PACKAGE_SCRIPT;
  assertStringIncludes(s, "if (!inX86 || await sameBytes(file, x86)) continue;");
  assertStringIncludes(s, "for (const file of await machOFiles(x86App)) {");
});

Deno.test("package-linux.ts / package-windows.ts: the copy is buildDesktopBundle's, before signing and the installers", async () => {
  assertStringIncludes(LINUX_PACKAGE_SCRIPT, "buildDesktopBundle(import.meta.url, OS, {");
  assertStringIncludes(WINDOWS_PACKAGE_SCRIPT, "buildDesktopBundle(import.meta.url, OS, {");
  // The Windows script signs every PE file of the bundle after it is built.
  assertStringIncludes(WINDOWS_PACKAGE_SCRIPT, "await sign(await desktopPeFiles(dir))");
  const src = await Deno.readTextFile(
    new URL("../src/build/desktop-package-script.ts", import.meta.url),
  );
  const body = src.slice(src.indexOf("export async function buildDesktopBundle("));
  const launch = body.indexOf("await writeLaufeyLaunchConfig(entryUrl, os, o.out);");
  const copy = body.indexOf("await bundleDesktopLibraries(entryUrl, os, o.out, o.target);");
  const stamp = body.indexOf("await stampWindowsBundleTreeUnlessDeferred(o, meta);");
  assert(
    launch > 0 && launch < copy && copy < stamp,
    "copied after the launch file, before the tree manifest",
  );
});

Deno.test("desktop package: a macOS script that never copies the configured libraries is refused", () => {
  const withLibs = { desktop: { bundle: { libraries: ["native/{target}/libaudio.{ext}"] } } };
  const old = 'await buildDesktopBundle({ os: "macos" });\n';
  const current = old + "await bundleDesktopLibraries(app, config);\n";
  assertStringIncludes(
    staleLibrariesScriptProblem(withLibs, old) ?? "",
    "predates desktop.bundle.libraries: its .app ships without them",
  );
  assertEquals(staleLibrariesScriptProblem(withLibs, current), null, "a current script");
  assertEquals(staleLibrariesScriptProblem({ desktop: {} }, old), null, "no libraries configured");
  assertEquals(staleLibrariesScriptProblem({}, old), null, "no desktop config");
});
