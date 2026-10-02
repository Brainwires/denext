// The desktop installer formats (`desktop.installers`, `--format`) and the builders the package
// scripts call: the per-OS plan, the package metadata, the MSI's WiX source and UpgradeCode, the
// Linux tree / .desktop entry / control file, and a real .deb built and read back.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  arArchive,
  buildDesktopDeb,
  debControl,
  debianPackageName,
  DEFAULT_DESKTOP_INSTALLERS,
  desktopInstallerPlan,
  desktopPackageMeta,
  linuxDesktopEntry,
  linuxPackageVersion,
  msiProductVersion,
  msiUpgradeCode,
  packageMetaFrom,
  planDesktopInstallers,
  rpmSpec,
  splitFormatList,
  stageLinuxRoot,
  walkBundle,
  wixArch,
  wixSource,
} from "../src/build/desktop-installers.ts";
import {
  desktopAppName,
  desktopBundleCommand,
  desktopHasTool,
  desktopPackageArches,
  desktopRequireTool,
  desktopRun,
  desktopSlug,
  desktopToolGate,
  parseDesktopPackageArgs,
  prepareDesktopPackage,
} from "../src/build/desktop-package-script.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

const META = packageMetaFrom(
  {
    version: "2.3.4-rc.1",
    license: "MIT",
    desktop: {
      app: {
        name: "My App",
        identifier: "com.acme.myapp",
        deepLinks: ["myapp", "MyApp-Dev://"],
        singleInstance: true,
      },
    },
  },
  { desktop: { installers: { publisher: "Acme Inc." } } },
  "fallback",
);

Deno.test("plan: each OS has its defaults, and they are not explicit", () => {
  assertEquals(planDesktopInstallers("darwin", undefined), { formats: ["dmg"], explicit: false });
  assertEquals(planDesktopInstallers("linux", {}), { formats: ["tar.gz", "deb"], explicit: false });
  assertEquals(planDesktopInstallers("windows", { desktop: {} }), {
    formats: ["msi"],
    explicit: false,
  });
  assertEquals(DEFAULT_DESKTOP_INSTALLERS.windows, ["msi"]);
});

Deno.test("plan: --format beats desktop.installers, which beats the defaults", () => {
  const config = { desktop: { installers: { linux: ["rpm"], windows: ["zip"] } } };
  assertEquals(planDesktopInstallers("linux", config), { formats: ["rpm"], explicit: true });
  assertEquals(planDesktopInstallers("linux", config, ["deb,appimage", "deb"]), {
    formats: ["deb", "appimage"],
    explicit: true,
  });
  assertEquals(planDesktopInstallers("windows", config).formats, ["zip"]);
  // An empty config list builds only the bundle (macOS still makes the .app).
  assertEquals(planDesktopInstallers("darwin", { desktop: { installers: { macos: [] } } }), {
    formats: [],
    explicit: true,
  });
});

Deno.test("plan: a legacy --dmg / --appimage adds to the list without making it explicit", () => {
  assertEquals(planDesktopInstallers("darwin", undefined, [], ["dmg"]).formats, ["dmg"]);
  assertEquals(planDesktopInstallers("linux", undefined, [], ["appimage"]), {
    formats: ["tar.gz", "deb", "appimage"],
    explicit: false,
  });
  assertEquals(planDesktopInstallers("darwin", undefined, ["pkg"], ["dmg"]).formats, [
    "pkg",
    "dmg",
  ]);
});

Deno.test("plan: a format of another OS (or a typo) is refused with the valid list", () => {
  const msi = assertThrows(() => planDesktopInstallers("linux", undefined, ["msi"]), Error);
  assertStringIncludes(String(msi), "tar.gz, deb, rpm, appimage");
  assertThrows(() => planDesktopInstallers("darwin", undefined, ["DMG", "zip"]), Error, '"zip"');
  assertThrows(
    () => planDesktopInstallers("windows", { desktop: { installers: { windows: "msi" } } }),
    Error,
    "must be an array",
  );
  assertEquals(splitFormatList([" MSI , zip", ""]), ["msi", "zip"]);
});

Deno.test("plan + meta: read from the project beside a scripts/ entry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { desktop: { installers: { windows: ["zip", "msi"], description: "Hi" } } };\n',
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ version: "1.2.3", desktop: { app: { name: "Beside" } } }),
    );
    const entry = toFileUrl(join(dir, "scripts", "package-windows.ts")).href;
    assertEquals((await desktopInstallerPlan(entry, "windows")).formats, ["zip", "msi"]);
    const meta = await desktopPackageMeta(entry, "x");
    assertEquals([meta.name, meta.version, meta.description], ["Beside", "1.2.3", "Hi"]);
    assertEquals(meta.identifier, "com.deno.desktop.beside");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("meta: deno.json wins for the app, the config fills installers, defaults fill the rest", () => {
  assertEquals(META.name, "My App");
  assertEquals(META.publisher, "Acme Inc.");
  assertEquals(META.deepLinks, ["myapp", "myapp-dev"]);
  assertEquals(META.singleInstance, true);
  assertEquals(META.backend, "webview");
  const bare = packageMetaFrom({}, { desktop: { app: { identifier: "com.x.y" } } }, "Thing");
  assertEquals(
    [bare.name, bare.version, bare.publisher, bare.identifier],
    ["Thing", "1.0.0", "Thing", "com.x.y"],
  );
  assertEquals(bare.description, "Thing desktop application");
});

Deno.test("versions: MSI keeps numeric major.minor.build; deb/rpm map a prerelease to ~", () => {
  assertEquals(msiProductVersion(undefined), "1.0.0");
  assertEquals(msiProductVersion("2.3.4-rc.1+b5"), "2.3.4");
  assertEquals(msiProductVersion("7"), "7.0.0");
  assertThrows(() => msiProductVersion("2026.10.2"), Error, "exceeds 255");
  assertThrows(() => msiProductVersion("v1"), Error);
  assertEquals(linuxPackageVersion("2.3.4-rc.1"), "2.3.4~rc.1");
  assertEquals(linuxPackageVersion(undefined), "1.0.0");
  assertThrows(() => linuxPackageVersion("v1.0"), Error, "start with a digit");
  assertThrows(() => linuxPackageVersion("1.0_beta"), Error);
  assertEquals(debianPackageName("My App!"), "my-app");
  assertEquals(debianPackageName("--x"), "app");
});

Deno.test("msi: the UpgradeCode is the one deno desktop's MSI derives (UUIDv5, stable)", async () => {
  // uuid.uuid5(UUID("6f1d3c8a-4b2e-4f5a-9c7d-8e0f1a2b3c4d"), "com.acme.myapp\0upgrade")
  assertEquals(await msiUpgradeCode("com.acme.myapp"), "{6793091E-3930-53B0-8465-3E0524F492E7}");
  assertEquals(await msiUpgradeCode("com.acme.myapp"), await msiUpgradeCode("com.acme.myapp"));
  assert((await msiUpgradeCode("com.acme.other")) !== (await msiUpgradeCode("com.acme.myapp")));
  assertEquals([wixArch("x86_64"), wixArch("arm64")], ["x64", "arm64"]);
});

Deno.test("msi: the WiX source is dual-scope, upgrades in place, and registers the app", () => {
  const wxs = wixSource({
    meta: META,
    bundleDir: "C:\\build\\My App-x64",
    exe: "My-App-x64.exe",
    upgradeCode: "{6793091E-3930-53B0-8465-3E0524F492E7}",
    entries: [
      { path: "AppIcon.ico", kind: "file", mode: 0o644, size: 1 },
      { path: "My-App-x64.dll", kind: "file", mode: 0o644, size: 1 },
      { path: "My-App-x64.exe", kind: "file", mode: 0o755, size: 1 },
      { path: "locales", kind: "dir", mode: 0o755, size: 0 },
      { path: "locales/en & us.pak", kind: "file", mode: 0o644, size: 1 },
    ],
  });
  assertStringIncludes(wxs, 'Scope="perUserOrMachine"');
  assertStringIncludes(wxs, 'Version="2.3.4"');
  assertStringIncludes(wxs, 'Manufacturer="Acme Inc."');
  assertStringIncludes(wxs, 'UpgradeCode="{6793091E-3930-53B0-8465-3E0524F492E7}"');
  assertStringIncludes(wxs, '<MajorUpgrade AllowSameVersionUpgrades="yes"');
  assertStringIncludes(wxs, '<StandardDirectory Id="ProgramFiles64Folder">');
  assertStringIncludes(wxs, '<Directory Id="INSTALLFOLDER" Name="My App">');
  assertStringIncludes(wxs, '<File Id="MainExe" Name="My-App-x64.exe"');
  assertStringIncludes(wxs, 'Name="en &amp; us.pak"');
  assertStringIncludes(wxs, '<Directory Id="d2" Name="locales">');
  assertStringIncludes(wxs, 'Target="[#MainExe]"');
  assertStringIncludes(wxs, '<Property Id="ARPPRODUCTICON" Value="AppIcon.ico" />');
  // Deep links in the install's own hive, marked as this app's like the runtime marks them.
  assertStringIncludes(wxs, 'Root="HKMU" Key="Software\\Classes\\myapp"');
  assertStringIncludes(wxs, 'Key="Software\\Classes\\myapp-dev"');
  assertStringIncludes(wxs, 'Name="DenoDesktopAppId" Type="string" Value="com.acme.myapp"');
  // The URL is a positional after `--`: a `"` in it cannot turn the rest into switches.
  assertStringIncludes(wxs, 'Value="&quot;[#MainExe]&quot; -- &quot;%1&quot;"');
  assert(!wxs.includes("&quot;[#MainExe]&quot; &quot;%1&quot;"));
  // Every file component is in the feature.
  for (const id of ["f0", "f1", "MainExe", "f3"]) {
    assertStringIncludes(wxs, `<ComponentRef Id="c_${id}" />`);
  }
  assertThrows(
    () =>
      wixSource({ meta: META, bundleDir: "x", exe: "nope.exe", upgradeCode: "{}", entries: [] }),
    Error,
    "no launcher",
  );
});

Deno.test("linux: the .desktop entry launches with the app id and claims the schemes", () => {
  const entry = linuxDesktopEntry(META);
  assertStringIncludes(
    entry,
    "Exec=env LAUFEY_APP_ID=com.acme.myapp LAUFEY_SINGLE_INSTANCE=1 my-app %u\n",
  );
  // `%u` is one argv element and the last token on the line (no shell, no re-splitting).
  const exec = entry.split("\n").find((l) => l.startsWith("Exec="))!;
  assert(exec.endsWith(" %u") && exec.indexOf("%") === exec.length - 2);
  assertStringIncludes(entry, "StartupWMClass=com.acme.myapp\n");
  assertStringIncludes(entry, "MimeType=x-scheme-handler/myapp;x-scheme-handler/myapp-dev;\n");
  assertStringIncludes(entry, "Icon=my-app\n");
  const plain = linuxDesktopEntry({ ...META, deepLinks: [], singleInstance: false, name: "A\nB" });
  assertStringIncludes(plain, "Exec=env LAUFEY_APP_ID=com.acme.myapp a-b\n");
  assert(!plain.includes("MimeType"));
  assertStringIncludes(plain, "Name=A B\n");
});

Deno.test("msi: project text reaches the .wxs literal (no $(…) / !(…) / [Property] expansion)", () => {
  const wxs = wixSource({
    meta: {
      ...META,
      name: "A $(env.PATH) !(loc.X)",
      publisher: "P [ProductName]",
      description: "d $(var.Y)",
    },
    bundleDir: "C:\\b$(sys.X)",
    exe: "a.exe",
    upgradeCode: "{}",
    entries: [{ path: "a.exe", kind: "file", mode: 0o755, size: 1 }],
  });
  // No unescaped preprocessor / binder reference survives anywhere in the source.
  assert(!/(?<![$])\$\((env|var|sys)\./.test(wxs));
  assert(!/(?<![!])!\(loc\./.test(wxs));
  assertStringIncludes(wxs, 'Name="A $$(env.PATH) !!(loc.X)"');
  assertStringIncludes(wxs, 'Description="d $$(var.Y)"');
  // The Formatted registry key keeps the brackets literal; the launcher reference still expands.
  assertStringIncludes(wxs, 'Key="Software\\P [\\[]ProductName[\\]]\\');
  assertStringIncludes(wxs, 'Target="[#MainExe]"');
});

Deno.test("linux: project text reaches the rpm spec literal (no %macro expansion)", () => {
  const spec = rpmSpec(
    { ...META, description: "d %(id)", publisher: "p %{lua:x}", license: "L%" },
    "/tmp/%s",
    ["/usr/lib/%x"],
  );
  assertStringIncludes(spec, "Summary: d %%(id)\n");
  assertStringIncludes(spec, "Vendor: p %%{lua:x}\n");
  assertStringIncludes(spec, "License: L%%\n");
  assertStringIncludes(spec, "cp -a '/tmp/%%s'/. %{buildroot}/\n");
  assertStringIncludes(spec, "\n/usr/lib/%%x\n");
});

Deno.test("linux: control and spec carry the version, arch, deps and owned paths", () => {
  const control = debControl(META, "arm64", 42);
  assertStringIncludes(control, "Package: my-app\nVersion: 2.3.4~rc.1\nArchitecture: arm64\n");
  assertStringIncludes(control, "Depends: libwebkit2gtk-4.1-0, libgtk-3-0\n");
  assertStringIncludes(control, "Installed-Size: 42\n");
  assertStringIncludes(debControl({ ...META, backend: "cef" }, "x86_64", 1), "libnss3");
  const spec = rpmSpec(META, "/tmp/it's", ["/usr/lib/my-app", "/usr/bin/my-app"]);
  assertStringIncludes(spec, "Name: my-app\nVersion: 2.3.4~rc.1\nRelease: 1\n");
  assertStringIncludes(spec, "License: MIT\n");
  assertStringIncludes(spec, "Requires: libwebkit2gtk-4.1.so.0()(64bit)\n");
  assertStringIncludes(spec, "cp -a '/tmp/it'\\''s'/. %{buildroot}/\n");
  assertStringIncludes(spec, "%files\n%defattr(-,root,root,-)\n/usr/lib/my-app\n/usr/bin/my-app\n");
});

/** A fake finished Linux bundle: launcher, runtime library, launch config, a 64×64 icon. */
async function fakeLinuxBundle(dir: string): Promise<void> {
  await Deno.mkdir(join(dir, "sub"), { recursive: true });
  await Deno.writeTextFile(join(dir, "My-App-x64"), "#!/bin/sh\necho hi\n");
  if (Deno.build.os !== "windows") await Deno.chmod(join(dir, "My-App-x64"), 0o755);
  await Deno.writeTextFile(join(dir, "My-App-x64.so"), "lib");
  await Deno.writeTextFile(join(dir, "laufey-launch.json"), '{"inspectable":false}\n');
  await Deno.writeTextFile(join(dir, "sub", "data.txt"), "x".repeat(700));
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 64);
  new DataView(png.buffer).setUint32(20, 64);
  await Deno.writeFile(join(dir, "AppIcon.png"), png);
}

/** The members of an `ar` archive. */
function readAr(bytes: Uint8Array): Map<string, Uint8Array> {
  const dec = new TextDecoder();
  assertEquals(dec.decode(bytes.subarray(0, 8)), "!<arch>\n");
  const out = new Map<string, Uint8Array>();
  let at = 8;
  while (at < bytes.length) {
    const header = dec.decode(bytes.subarray(at, at + 60));
    const size = Number(header.slice(48, 58).trim());
    out.set(header.slice(0, 16).trim(), bytes.subarray(at + 60, at + 60 + size));
    at += 60 + size + (size % 2);
  }
  return out;
}

/** The entries of a gzipped ustar archive: path → [type, mode, body or link target]. */
async function readTarGz(gz: Uint8Array): Promise<Map<string, [string, number, string]>> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  const dec = new TextDecoder();
  const cstr = (a: number, n: number) => dec.decode(tar.subarray(a, a + n)).replace(/\0.*$/s, "");
  const out = new Map<string, [string, number, string]>();
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const prefix = cstr(at + 345, 155);
    const path = (prefix ? prefix + "/" : "") + cstr(at, 100);
    const size = parseInt(cstr(at + 124, 12), 8);
    const type = cstr(at + 156, 1);
    const mode = parseInt(cstr(at + 100, 8), 8);
    // The checksum covers the header with its own field as spaces.
    const header = tar.slice(at, at + 512);
    header.fill(32, 148, 156);
    assertEquals(header.reduce((a, b) => a + b, 0), parseInt(cstr(at + 148, 8), 8), path);
    const body = type === "2"
      ? cstr(at + 157, 100)
      : dec.decode(tar.subarray(at + 512, at + 512 + size));
    out.set(path, [type, mode, body]);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

Deno.test("deb: a real .deb of a bundle, read back member by member", {
  ignore: Deno.build.os === "windows", // symlinks in the staging tree need privileges there
}, async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bundle = join(dir, "My-App-x64");
    await fakeLinuxBundle(bundle);
    const out = join(dir, "my-app.deb");
    await buildDesktopDeb({
      meta: META,
      bundleDir: bundle,
      exe: "My-App-x64",
      arch: "x86_64",
      out,
    });
    const members = readAr(await Deno.readFile(out));
    assertEquals([...members.keys()], ["debian-binary", "control.tar.gz", "data.tar.gz"]);
    assertEquals(new TextDecoder().decode(members.get("debian-binary")), "2.0\n");
    const control = await readTarGz(members.get("control.tar.gz")!);
    assertStringIncludes(control.get("./control")![2], "Architecture: amd64\n");
    const data = await readTarGz(members.get("data.tar.gz")!);
    assertEquals(data.get("./usr/bin/my-app"), ["2", 0o777, "../lib/my-app/My-App-x64"]);
    assertEquals(data.get("./usr/lib/my-app/My-App-x64")?.slice(0, 2), ["0", 0o755]);
    assertEquals(data.get("./usr/lib/my-app/laufey-launch.json")?.[2], '{"inspectable":false}\n');
    assertEquals(data.get("./usr/lib/my-app/sub/data.txt")?.[2].length, 700);
    assertEquals(data.get("./usr/lib/my-app/sub/")?.[0], "5");
    assertStringIncludes(
      data.get("./usr/share/applications/com.acme.myapp.desktop")![2],
      "MimeType=x-scheme-handler/myapp;",
    );
    assert(data.has("./usr/share/pixmaps/my-app.png"));
    assert(data.has("./usr/share/icons/hicolor/64x64/apps/my-app.png"));
    // dpkg itself agrees, where it is installed (the Linux CI legs).
    let dpkg: Deno.CommandOutput | null = null;
    try {
      dpkg = await new Deno.Command("dpkg-deb", { args: ["--info", out], stdout: "piped" })
        .output();
    } catch { /* no dpkg here */ }
    if (dpkg) {
      assert(dpkg.success);
      assertStringIncludes(new TextDecoder().decode(dpkg.stdout), "Package: my-app");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stage: owned paths, and a non-theme-size icon goes to pixmaps only", {
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bundle = join(dir, "b");
    await fakeLinuxBundle(bundle);
    const png = await Deno.readFile(join(bundle, "AppIcon.png"));
    new DataView(png.buffer).setUint32(16, 1000);
    new DataView(png.buffer).setUint32(20, 1000);
    await Deno.writeFile(join(bundle, "AppIcon.png"), png);
    const owned = await stageLinuxRoot(bundle, "My-App-x64", META, join(dir, "root"));
    assertEquals(owned, [
      "/usr/lib/my-app",
      "/usr/bin/my-app",
      "/usr/share/applications/com.acme.myapp.desktop",
      "/usr/share/pixmaps/my-app.png",
    ]);
    const paths = (await walkBundle(join(dir, "root"))).map((e) => e.path);
    assert(paths.includes("usr/lib/my-app/sub/data.txt"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ar: members are padded to an even offset", () => {
  const ar = arArchive([["a", new Uint8Array([1])], ["b", new Uint8Array([2, 3])]], 0);
  assertEquals(ar.length, 8 + 60 + 2 + 60 + 2);
  assertEquals(readAr(ar).get("b"), new Uint8Array([2, 3]));
});

Deno.test("config: desktop.installers is validated", () => {
  validateDenextConfig({
    desktop: {
      installers: {
        macos: ["dmg", "pkg"],
        linux: ["tar.gz", "deb", "rpm", "appimage"],
        windows: ["msi", "zip"],
        publisher: "Acme",
        description: "An app",
      },
    },
  } as DenextConfig);
  const cases: Array<[unknown, string]> = [
    [[], "desktop.installers"],
    [{ windows: ["exe"] }, "desktop.installers.windows"],
    [{ linux: "deb" }, "desktop.installers.linux"],
    [{ macos: ["msi"] }, "desktop.installers.macos"],
    [{ publisher: "" }, "desktop.installers.publisher"],
    [{ description: 3 }, "desktop.installers.description"],
  ];
  for (const [installers, field] of cases) {
    const err = assertThrows(
      () => validateDenextConfig({ desktop: { installers } } as DenextConfig),
      Error,
      undefined,
      field,
    );
    assertStringIncludes(String(err), `\`${field}`, field);
  }
});

Deno.test("script args: --arch / --format (both spellings), legacy flags, validation", () => {
  const spec = {
    arches: ["host", "x86_64", "arm64", "both"],
    legacy: { "--appimage": "appimage" },
  };
  assertEquals(parseDesktopPackageArgs([], spec), {
    arch: "host",
    export: true,
    sign: true,
    formats: [],
    add: [],
  });
  assertEquals(
    parseDesktopPackageArgs(
      [
        "--arch",
        "both",
        "--format=deb",
        "--format",
        "rpm,tar.gz",
        "--no-export",
        "--no-sign",
        "--appimage",
      ],
      spec,
    ),
    { arch: "both", export: false, sign: false, formats: ["deb", "rpm,tar.gz"], add: ["appimage"] },
  );
  assertEquals(parseDesktopPackageArgs(["--arch=arm64"], spec).arch, "arm64");
  assertThrows(
    () => parseDesktopPackageArgs(["--arch", "universal"], spec),
    Error,
    "--arch must be",
  );
  assertThrows(() => parseDesktopPackageArgs(["--dmg"], spec), Error, "unknown argument: --dmg");
  // A trailing `--arch` with no value is an empty arch, refused like any other.
  assertThrows(() => parseDesktopPackageArgs(["--arch"], spec), Error, "--arch must be");
});

Deno.test("script arches: both, host, or the one asked for", () => {
  assertEquals(desktopPackageArches("both"), ["x86_64", "arm64"]);
  assertEquals(desktopPackageArches("arm64"), ["arm64"]);
  assertEquals(desktopPackageArches("host"), [Deno.build.arch === "aarch64" ? "arm64" : "x86_64"]);
});

Deno.test("tool gate: a default format is skipped, an asked-for one fails", async () => {
  assertEquals(desktopToolGate(undefined, ".rpm", true), true);
  assertThrows(
    () => desktopToolGate("rpmbuild missing", ".rpm", true),
    Error,
    "cannot build the .rpm",
  );
  const warn = console.warn;
  console.warn = () => {};
  try {
    assertEquals(desktopToolGate("rpmbuild missing", ".rpm", false), false);
    assertEquals(await desktopRequireTool("denext-no-such-tool-xyz", ".rpm", false), false);
  } finally {
    console.warn = warn;
  }
  assertEquals(await desktopHasTool(Deno.build.os === "windows" ? "cmd" : "sh"), true);
  // A tool that is there passes the gate without a warning, asked for or not.
  assertEquals(
    await desktopRequireTool(Deno.build.os === "windows" ? "cmd" : "sh", ".x", true),
    true,
  );
  // The name is never shell text: anything but a plain command name is not found.
  for (
    const name of ["sh; true", "sh && true", "$(true)", "`true`", "./sh", "/bin/sh", "a b", ""]
  ) {
    assertEquals(await desktopHasTool(name), false, name);
  }
});

Deno.test("tool probe: an executable on PATH is found without a shell, a plain file is not", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await Deno.makeTempDir();
  const prev = Deno.env.get("PATH");
  try {
    await Deno.writeTextFile(join(dir, "denext-fake-tool"), "#!/bin/sh\n");
    await Deno.chmod(join(dir, "denext-fake-tool"), 0o755);
    await Deno.writeTextFile(join(dir, "denext-not-exec"), "x");
    await Deno.mkdir(join(dir, "denext-a-dir"));
    Deno.env.set("PATH", `:${dir}`);
    assertEquals(await desktopHasTool("denext-fake-tool"), true);
    assertEquals(await desktopHasTool("denext-not-exec"), false);
    assertEquals(await desktopHasTool("denext-a-dir"), false);
    assertEquals(await desktopHasTool("denext-missing"), false);
  } finally {
    if (prev === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", prev);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prepare: the plan, the app.json sync and the metadata of a project", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ version: "4.5.6" }));
    const entry = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    const prev = Deno.env.get("DENEXT_APP_NAME");
    Deno.env.set("DENEXT_APP_NAME", "Prepared App");
    const cwd = Deno.cwd();
    Deno.chdir(dir);
    let prepared;
    try {
      prepared = await prepareDesktopPackage(entry, "linux", {
        formats: ["rpm"],
        add: ["appimage"],
        export: false,
      });
    } finally {
      Deno.chdir(cwd);
      if (prev === undefined) Deno.env.delete("DENEXT_APP_NAME");
      else Deno.env.set("DENEXT_APP_NAME", prev);
    }
    const { name, plan, meta } = prepared;
    assertEquals(name, "Prepared-App");
    assertEquals(plan, { formats: ["rpm", "appimage"], explicit: true });
    assert((await Deno.stat(join(dir, "dist"))).isDirectory);
    assertEquals([meta.name, meta.version], ["Prepared App", "4.5.6"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundle command: least-privilege deno desktop with the target and the first icon", async () => {
  const dir = await Deno.makeTempDir();
  const cwd = Deno.cwd();
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.mkdir(join(dir, "icons"));
    await Deno.writeTextFile(join(dir, "icons", "app.png"), "png");
    Deno.chdir(dir);
    const entry = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    const cmd = await desktopBundleCommand(entry, "linux", {
      target: "x86_64-unknown-linux-gnu",
      out: "dist/a-x64",
      icons: ["icons/missing.png", "icons/app.png"],
    });
    assertEquals(cmd.slice(0, 3), ["deno", "desktop", "--no-prompt"]);
    assert(!cmd.includes("-A"));
    assertStringIncludes(cmd.join(" "), "--include out");
    assertStringIncludes(cmd.join(" "), "--target x86_64-unknown-linux-gnu");
    assertStringIncludes(cmd.join(" "), "--icon icons/app.png --output dist/a-x64 desktop.ts");
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("script helpers: the app name, its slug, and a failing command", async () => {
  assertEquals(desktopSlug("  My App! "), "My-App");
  assertEquals(desktopSlug("!!!"), "app");
  const prev = Deno.env.get("DENEXT_APP_NAME");
  Deno.env.set("DENEXT_APP_NAME", "From Env");
  try {
    assertEquals(await desktopAppName(), "From Env");
  } finally {
    if (prev === undefined) Deno.env.delete("DENEXT_APP_NAME");
    else Deno.env.set("DENEXT_APP_NAME", prev);
  }
  await assertRejects(() => desktopRun([Deno.execPath(), "eval", "Deno.exit(3)"]), Error, "(3)");
  // A secret on the command line never reaches the failure message.
  const err = await assertRejects(
    () =>
      desktopRun([Deno.execPath(), "eval", "Deno.exit(4)", "/p", "hunter2-pfx"], undefined, {
        secrets: ["hunter2-pfx", ""],
      }),
    Error,
    "(4)",
  );
  assert(!err.message.includes("hunter2-pfx"));
  assertStringIncludes(err.message, "/p ***");
});

Deno.test('script app name: DENEXT_APP_NAME, else deno.json desktop.app.name, else "app"', async () => {
  const dir = await Deno.makeTempDir();
  const cwd = Deno.cwd();
  const prev = Deno.env.get("DENEXT_APP_NAME");
  Deno.env.delete("DENEXT_APP_NAME");
  try {
    Deno.chdir(dir);
    assertEquals(await desktopAppName(), "app"); // no deno.json
    await Deno.writeTextFile("deno.json", "{ not json");
    assertEquals(await desktopAppName(), "app"); // an unreadable one
    await Deno.writeTextFile("deno.json", JSON.stringify({ desktop: { app: { name: "   " } } }));
    assertEquals(await desktopAppName(), "app"); // a blank name
    await Deno.writeTextFile(
      "deno.json",
      JSON.stringify({ desktop: { app: { name: "  Named App " } } }),
    );
    assertEquals(await desktopAppName(), "Named App");
  } finally {
    Deno.chdir(cwd);
    if (prev !== undefined) Deno.env.set("DENEXT_APP_NAME", prev);
    await Deno.remove(dir, { recursive: true });
  }
});
