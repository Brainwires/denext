// A bundled Node backend sidecar per architecture (src/build/desktop-sidecar-bundle.ts): each
// `--arch` of a package script is its own bundle, which keeps only that arch's prebuilt addons
// (`prebuilds/<platform>-<arch>/`, node-gyp-build's `darwin-x64+arm64` for either) and the
// per-platform packages whose npm `os` / `cpu` allow it; `run.archDirs` points a target at a
// `node_modules` built for it, and a copied addon built for another arch is warned about. The
// fixtures' `.node` files are fake: a Mach-O / ELF header and nothing else.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  bundleDesktopSidecar,
  type DesktopArch,
  nativeArchesOf,
} from "../src/build/desktop-sidecar-bundle.ts";
import { desktopTargetArch } from "../src/build/desktop-capabilities.ts";
import { desktopBundleCommand } from "../src/build/desktop-package-script.ts";
import { MACOS_PACKAGE_SCRIPT } from "../src/build/desktop-package-scripts.ts";
import type { SidecarSigningDeps } from "../src/build/desktop-sidecar-sign.ts";
import { prepareSidecarModules } from "../src/desktop/sidecar-modules.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { SidecarDefinition } from "../src/desktop/sidecar.ts";

/** A thin 64-bit Mach-O header for `arch` (little-endian, as Apple's toolchains write it). */
function macho(arch: DesktopArch): Uint8Array {
  const b = new Uint8Array(32);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0xfeedfacf, true);
  v.setUint32(4, arch === "arm64" ? 0x0100000c : 0x01000007, true);
  return b;
}

/** A universal (fat) Mach-O header with one slice per arch. */
function fat(...arches: DesktopArch[]): Uint8Array {
  const b = new Uint8Array(8 + 20 * arches.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0xcafebabe, false);
  v.setUint32(4, arches.length, false);
  arches.forEach((a, i) => v.setUint32(8 + i * 20, a === "arm64" ? 0x0100000c : 0x01000007));
  return b;
}

/** A 64-bit little-endian ELF header for `arch`. */
function elf(arch: DesktopArch): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  new DataView(b.buffer).setUint16(18, arch === "arm64" ? 0xb7 : 0x3e, true);
  return b;
}

/** A PE header (MZ stub pointing at `PE\0\0` + Machine) for `arch`. */
function pe(arch: DesktopArch): Uint8Array {
  const b = new Uint8Array(0x100);
  const v = new DataView(b.buffer);
  b.set([0x4d, 0x5a]);
  v.setUint32(0x3c, 0x80, true);
  v.setUint32(0x80, 0x50450000, false);
  v.setUint16(0x84, arch === "arm64" ? 0xaa64 : 0x8664, true);
  return b;
}

/** Write `files` (path → bytes or text) under `root`. */
async function writeTree(root: string, files: Record<string, Uint8Array | string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    if (typeof body === "string") await Deno.writeTextFile(path, body);
    else await Deno.writeFile(path, body);
  }
}

const NM = "server/node_modules";

/**
 * A Qutty-like backend: `ptylib` ships prebuilds for four targets and a universal macOS one, and
 * a per-platform optional package per target (two of them installed, as `npm install` with both
 * `--cpu`s would leave them); `hostpty` is compiled on the host (`build/Release`, arm64 only).
 */
const BACKEND: Record<string, Uint8Array | string> = {
  "server/main.mjs": 'import pty from "ptylib";\nimport host from "hostpty";\n' +
    "console.log(pty, host);\n",
  [`${NM}/ptylib/package.json`]: JSON.stringify({
    name: "ptylib",
    main: "index.js",
    optionalDependencies: {
      "@q/ptylib-darwin-arm64": "1",
      "@q/ptylib-darwin-x64": "1",
      "@q/ptylib-linux-arm64": "1",
    },
  }),
  [`${NM}/ptylib/index.js`]: "module.exports = 'pty';\n",
  [`${NM}/ptylib/prebuilds/darwin-arm64/pty.node`]: macho("arm64"),
  [`${NM}/ptylib/prebuilds/darwin-x64/pty.node`]: macho("x86_64"),
  [`${NM}/ptylib/prebuilds/darwin-x64+arm64/pty.node`]: fat("x86_64", "arm64"),
  [`${NM}/ptylib/prebuilds/linux-x64/pty.node`]: elf("x86_64"),
  [`${NM}/ptylib/prebuilds/linux-arm64/pty.node`]: elf("arm64"),
  [`${NM}/@q/ptylib-darwin-arm64/package.json`]: JSON.stringify({
    name: "@q/ptylib-darwin-arm64",
    os: ["darwin"],
    cpu: ["arm64"],
  }),
  [`${NM}/@q/ptylib-darwin-arm64/helper.node`]: macho("arm64"),
  [`${NM}/@q/ptylib-darwin-x64/package.json`]: JSON.stringify({
    name: "@q/ptylib-darwin-x64",
    os: ["darwin"],
    cpu: ["x64"],
  }),
  [`${NM}/@q/ptylib-darwin-x64/helper.node`]: macho("x86_64"),
  [`${NM}/hostpty/package.json`]: '{"name":"hostpty","main":"index.js","gypfile":true}',
  [`${NM}/hostpty/index.js`]: "module.exports = 'host';\n",
  [`${NM}/hostpty/build/Release/pty.node`]: macho("arm64"),
  // The same addon built for x64 (another machine, or a cross build), for run.archDirs.
  "vendor/x64/node_modules/hostpty/package.json":
    '{"name":"hostpty","main":"index.js","gypfile":true}',
  "vendor/x64/node_modules/hostpty/index.js": "module.exports = 'host-x64';\n",
  "vendor/x64/node_modules/hostpty/build/Release/pty.node": macho("x86_64"),
};

/** The sidecar (with `archDirs` when given). */
function sidecar(archDirs?: Record<string, string>): SidecarDefinition {
  return {
    name: "pty",
    run: {
      module: "server/main.mjs",
      nodeModules: NM,
      ...(archDirs ? { archDirs } : {}),
    },
    permissions: { ffi: ["*"] },
  };
}

/** Every file of the bundle's unpacked packages, relative to its `node_modules`. */
async function filesOf(root: string): Promise<string[]> {
  const out = join(root, ".deno-desktop/sidecars/pty");
  const mods = await prepareSidecarModules(out, "pty", join(root, ".test-cache"));
  assert(mods, "the bundle has an archive");
  const files: string[] = [];
  const walk = async (dir: string, rel: string) => {
    for await (const e of Deno.readDir(dir)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(join(dir, e.name), r);
      else files.push(r);
    }
  };
  await walk(join(mods, "node_modules"), "");
  return files.filter((f) => f.endsWith(".node")).sort();
}

/** Bundle the backend in a fresh project and return the report and the copied `.node` files. */
async function bundle(
  opts: { os: "darwin" | "linux"; arch?: DesktopArch; archDirs?: Record<string, string> },
  sign?: SidecarSigningDeps,
) {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-arch-" });
  try {
    await writeTree(root, BACKEND);
    const report = await bundleDesktopSidecar({
      projectDir: root,
      definition: sidecar(opts.archDirs),
      os: opts.os,
      ...(opts.arch ? { arch: opts.arch } : {}),
      ffiGranted: true,
      ...(sign ? { sign } : {}),
    });
    return { report, files: await filesOf(root) };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("nativeArchesOf: Mach-O thin and universal, ELF, PE; anything else says nothing", () => {
  assertEquals(nativeArchesOf(macho("arm64")), ["arm64"]);
  assertEquals(nativeArchesOf(macho("x86_64")), ["x86_64"]);
  assertEquals(nativeArchesOf(fat("x86_64", "arm64")), ["x86_64", "arm64"]);
  assertEquals(nativeArchesOf(elf("arm64")), ["arm64"]);
  assertEquals(nativeArchesOf(elf("x86_64")), ["x86_64"]);
  assertEquals(nativeArchesOf(pe("arm64")), ["arm64"]);
  assertEquals(nativeArchesOf(pe("x86_64")), ["x86_64"]);
  assertEquals(nativeArchesOf(new TextEncoder().encode("not a binary at all")), undefined);
  assertEquals(nativeArchesOf(new Uint8Array(3)), undefined);
});

Deno.test("desktopTargetArch: a Rust triple's arch, or the host's", () => {
  assertEquals(desktopTargetArch("aarch64-apple-darwin"), "arm64");
  assertEquals(desktopTargetArch("x86_64-apple-darwin"), "x86_64");
  assertEquals(desktopTargetArch("aarch64-unknown-linux-gnu"), "arm64");
  assertEquals(desktopTargetArch("x86_64-pc-windows-msvc"), "x86_64");
  assertEquals(desktopTargetArch("host"), Deno.build.arch === "aarch64" ? "arm64" : "x86_64");
});

Deno.test("bundleDesktopSidecar: macOS arm64 and x86_64 each keep their own prebuilds and per-platform packages", async () => {
  const arm = await bundle({ os: "darwin", arch: "arm64" });
  assertEquals(arm.files, [
    "@q/ptylib-darwin-arm64/helper.node",
    "hostpty/build/Release/pty.node",
    "ptylib/prebuilds/darwin-arm64/pty.node",
    "ptylib/prebuilds/darwin-x64+arm64/pty.node",
  ]);
  assertEquals(arm.report.arch, "arm64");
  assertEquals(arm.report.warnings, []);

  const x64 = await bundle({ os: "darwin", arch: "x86_64" });
  assertEquals(x64.files, [
    "@q/ptylib-darwin-x64/helper.node",
    "hostpty/build/Release/pty.node",
    "ptylib/prebuilds/darwin-x64+arm64/pty.node",
    "ptylib/prebuilds/darwin-x64/pty.node",
  ]);
  // The host-compiled addon is arm64: the x86_64 app could not load it.
  assertEquals(x64.report.warnings.length, 1);
  assertMatch(
    x64.report.warnings[0],
    /^hostpty\/build\/Release\/pty\.node is built for arm64, not x86_64: .*run\.archDirs/,
  );
});

Deno.test("bundleDesktopSidecar: run.archDirs supplies the target's own build of a package", async () => {
  const x64 = await bundle({
    os: "darwin",
    arch: "x86_64",
    archDirs: { "darwin-x86_64": "vendor/x64/node_modules" },
  });
  assertEquals(x64.report.warnings, [], "the x64 build replaced the host's");
  assert(x64.files.includes("hostpty/build/Release/pty.node"));
  // The plain `"<arch>"` key works too, and an arm64 bundle leaves the x64 folder alone.
  const plain = await bundle({
    os: "darwin",
    arch: "x86_64",
    archDirs: { x86_64: "vendor/x64/node_modules" },
  });
  assertEquals(plain.report.warnings, []);
  const arm = await bundle({
    os: "darwin",
    arch: "arm64",
    archDirs: { "darwin-x86_64": "vendor/x64/node_modules" },
  });
  assertEquals(arm.report.warnings, []);
});

Deno.test("bundleDesktopSidecar: Linux x64 and arm64; a per-platform package npm did not install is named", async () => {
  const x64 = await bundle({ os: "linux", arch: "x86_64" });
  assert(x64.files.includes("ptylib/prebuilds/linux-x64/pty.node"));
  assert(!x64.files.some((f) => f.includes("linux-arm64") || f.includes("darwin")));
  const arm = await bundle({ os: "linux", arch: "arm64" });
  assert(arm.files.includes("ptylib/prebuilds/linux-arm64/pty.node"));
  assert(!arm.files.some((f) => f.includes("linux-x64")));
  // @q/ptylib-linux-arm64 is an optional dependency that is not installed: said, with the fix.
  assert(
    arm.report.warnings.some((w) =>
      /ptylib's @q\/ptylib-linux-arm64 \(for linux-arm64\) is not installed.*run\.archDirs/.test(w)
    ),
    arm.report.warnings.join("\n"),
  );
});

Deno.test("bundleDesktopSidecar: without an arch every arch's prebuilds are kept (desktop run / dev)", async () => {
  const any = await bundle({ os: "darwin" });
  assertEquals(any.files, [
    "@q/ptylib-darwin-arm64/helper.node",
    "@q/ptylib-darwin-x64/helper.node",
    "hostpty/build/Release/pty.node",
    "ptylib/prebuilds/darwin-arm64/pty.node",
    "ptylib/prebuilds/darwin-x64+arm64/pty.node",
    "ptylib/prebuilds/darwin-x64/pty.node",
  ]);
  assertEquals(any.report.warnings, []);
  assertEquals(any.report.arch, undefined);
});

Deno.test("bundleDesktopSidecar: signing per arch signs only that arch's copies", async () => {
  const signedFor = async (arch: DesktopArch) => {
    const deps: SidecarSigningDeps = {
      has: () => Promise.resolve(true),
      env: () => undefined,
      run: (argv) =>
        Promise.resolve({
          code: 0,
          text: argv[1] === "-dv" ? `${argv.at(-1)}: code object is not signed at all` : "",
        }),
    };
    const { report } = await bundle({ os: "darwin", arch }, deps);
    assertEquals(report.signing.how, "ad-hoc");
    return report.signing.signed.map((p) => p.slice(p.indexOf("node_modules/") + 13)).sort();
  };
  assertEquals(await signedFor("x86_64"), [
    "@q/ptylib-darwin-x64/helper.node",
    "hostpty/build/Release/pty.node",
    "ptylib/prebuilds/darwin-x64+arm64/pty.node",
    "ptylib/prebuilds/darwin-x64/pty.node",
  ]);
  assertEquals((await signedFor("arm64")).filter((p) => p.includes("x64/")), []);
});

Deno.test("config validation: run.archDirs takes <arch> / <os>-<arch> keys and needs nodeModules", () => {
  /** The validation error for a sidecar with `run`, or `""`. */
  const check = (run: Record<string, unknown>) => {
    try {
      validateDenextConfig(
        { desktop: { sidecars: [{ name: "pty", run }] } } as unknown as DenextConfig,
      );
      return "";
    } catch (err) {
      return String((err as Error).message);
    }
  };
  assertEquals(
    check({
      module: "server/main.mjs",
      nodeModules: NM,
      archDirs: { "darwin-x86_64": "vendor/x64", arm64: "vendor/arm64" },
    }),
    "",
  );
  assertMatch(check({ module: "m.mjs", nodeModules: NM, archDirs: { x64: "v" } }), /"x64"/);
  assertMatch(check({ module: "m.mjs", nodeModules: NM, archDirs: { arm64: "" } }), /arm64/);
  assertMatch(check({ module: "m.mjs", nodeModules: NM, archDirs: ["v"] }), /archDirs/);
  assertMatch(check({ module: "m.mjs", archDirs: { arm64: "v" } }), /need run\.nodeModules/);
});

Deno.test("package scripts: each target's bundle is for its arch (Linux / Windows command, macOS template)", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-arch-cmd-" });
  try {
    await writeTree(root, {
      ...BACKEND,
      "denext.config.ts": `export default ${
        JSON.stringify({ desktop: { sidecars: [sidecar()] } })
      };\n`,
      "scripts/package-linux.ts": "",
    });
    const entryUrl = toFileUrl(join(root, "scripts/package-linux.ts")).href;
    const cmd = await desktopBundleCommand(entryUrl, "linux", {
      target: "aarch64-unknown-linux-gnu",
      out: "dist/app-linux-arm64",
      icons: [],
    });
    assert(cmd.includes(".deno-desktop/sidecars/pty"));
    const files = await filesOf(root);
    assert(files.includes("ptylib/prebuilds/linux-arm64/pty.node"), files.join("\n"));
    assert(!files.some((f) => f.includes("linux-x64")), "the x64 prebuild stays out");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
  // The macOS script builds one bundle per --target (lipo joins them for universal).
  assertMatch(
    MACOS_PACKAGE_SCRIPT,
    /desktopIncludeArgs\(import\.meta\.url, "darwin", undefined, \{\s+target: target \?\? "host",/,
  );
});
