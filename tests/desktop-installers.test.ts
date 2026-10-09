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
import { inChild } from "./helpers/isolated.ts";
import {
  arArchive,
  buildDesktopDeb,
  buildDesktopTarball,
  bundleFileMode,
  CEF_SANDBOX_HELPER,
  debControl,
  debianPackageName,
  debMaintainerScript,
  DEFAULT_DESKTOP_INSTALLERS,
  desktopAppVersion,
  desktopInstallerPlan,
  desktopPackageMeta,
  desktopPackageMetaWarnings,
  isDbusAppId,
  linuxDbusService,
  linuxDesktopEntry,
  linuxPackageVersion,
  linuxTimerAppPart,
  linuxTimerCleanup,
  linuxTimerGlob,
  msiProductVersion,
  msiUpgradeCode,
  packageMetaFrom,
  packageMetaWarnings,
  planDesktopInstallers,
  rpmFiles,
  rpmSpec,
  splitFormatList,
  stageLinuxRoot,
  stampDenoJsonVersion,
  walkBundle,
  wixArch,
  wixSource,
} from "../src/build/desktop-installers.ts";
import {
  desktopHasTool,
  desktopMsiProblem,
  desktopOptionalInstaller,
  desktopPackageArches,
  desktopRequireTool,
  desktopRun,
  desktopSlug,
  desktopToolGate,
  desktopVersionProblem,
  desktopWithAppVersion,
  parseDesktopPackageArgs,
  type prepareDesktopPackage,
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
  // The icon is installed under the app id, which the entry names.
  assertStringIncludes(entry, "Icon=com.acme.myapp\n");
  assert(!linuxDesktopEntry(META, false).includes("Icon="), "no icon installed: no Icon=");
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

Deno.test("linux: the .rpm scriptlets and .deb maintainer scripts refresh the databases", () => {
  const spec = rpmSpec(META, "/tmp/s", []);
  for (const section of ["%post", "%postun"]) {
    const body = spec.split(`\n${section}\n`)[1].split("\n\n")[0];
    assertStringIncludes(body, "update-desktop-database -q /usr/share/applications || :");
    assertStringIncludes(body, "gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || :");
  }
  assert(spec.indexOf("%postun") < spec.indexOf("%files"), "scriptlets before %files");
  const postinst = debMaintainerScript("postinst");
  assert(postinst.startsWith("#!/bin/sh\nset -e\n"));
  assertStringIncludes(postinst, "  configure)\n    command -v update-desktop-database");
  assertStringIncludes(postinst, "gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || :");
  assertStringIncludes(debMaintainerScript("postrm"), "  remove|purge)\n");
  assert(postinst.endsWith("esac\nexit 0\n"));
});

Deno.test("linux: the D-Bus service file and the removal's timer cleanup (runtime denext.11)", () => {
  assertEquals(
    linuxDbusService({ ...META, singleInstance: false }),
    "[D-BUS Service]\nName=com.acme.myapp\n" +
      "Exec=/usr/bin/env LAUFEY_APP_ID=com.acme.myapp /usr/bin/my-app --laufey-dbus-activated\n",
  );
  // The same environment as the .desktop entry's Exec line.
  assertStringIncludes(
    linuxDbusService({ ...META, singleInstance: true })!,
    "LAUFEY_APP_ID=com.acme.myapp LAUFEY_SINGLE_INSTANCE=1 /usr/bin/my-app",
  );
  // An app id D-Bus can't take as a name: no service file, no timers to clean.
  const digits = { ...META, identifier: "com.acme.3d-viewer" };
  assertEquals(linuxDbusService(digits), undefined);
  assert(!rpmSpec(digits, "/tmp/s", []).includes("systemctl"));
  for (
    const [id, ok] of [
      ["dev.denext.kitchen-sink", true],
      ["org.example.App_2", true],
      ["app", false],
      ["dev..app", false],
      ["dev.2app", false],
      ["dev.a b", false],
    ] as const
  ) {
    assertEquals(isDbusAppId(id), ok, id);
  }
  // .deb: the postrm stops the timers (remove / purge), the postinst doesn't.
  const glob = linuxTimerGlob("com.acme.myapp");
  assertEquals(glob, `laufey-com.acme.myapp-${"[0-9a-f]".repeat(16)}.timer`);
  const postrm = debMaintainerScript("postrm", "com.acme.myapp");
  assertStringIncludes(
    postrm,
    `      $laufey_timeout systemctl --user --machine="$user"@ --no-block stop '${glob}'` +
      " >/dev/null 2>&1 || :\n",
  );
  assertStringIncludes(
    postrm,
    '    if command -v timeout >/dev/null 2>&1; then laufey_timeout="timeout 10"; fi\n',
  );
  assertStringIncludes(postrm, "loginctl list-users --no-legend");
  assert(!debMaintainerScript("postinst", "com.acme.myapp").includes("systemctl"));
  assert(!debMaintainerScript("postrm").includes("systemctl"));
  // .rpm: an erase only ($1 = 0), not an upgrade's %postun.
  const postun = rpmSpec(META, "/tmp/s", []).split("\n%postun\n")[1].split("\n\n")[0];
  assertStringIncludes(postun, 'if [ "$1" = 0 ]; then\n');
  assertStringIncludes(postun, `'${glob}'`);
  assert(!rpmSpec(META, "/tmp/s", []).split("\n%post\n")[1].split("\n\n")[0].includes("systemctl"));
});

Deno.test("linux: the removal's timer glob matches the app's timers only", async () => {
  // The runtime's unit names: laufey-<app part>-<16 hex digits of the tag's FNV-1a 64>.
  const unit = (id: string, hex = "0123456789abcdef") =>
    `laufey-${linuxTimerAppPart(id)}-${hex}.timer`;
  const glob = linuxTimerGlob("com.acme.app");
  // systemd matches unit names with fnmatch(3): ask the shell's `case`, the same matcher.
  const matches = async (name: string) => {
    if (Deno.build.os === "windows") return globToRegExp(glob).test(name);
    const out = await new Deno.Command("/bin/sh", {
      args: ["-c", `case "$1" in ${glob}) echo yes;; *) echo no;; esac`, "sh", name],
    }).output();
    return new TextDecoder().decode(out.stdout).trim() === "yes";
  };
  assert(await matches(unit("com.acme.app")));
  assert(!(await matches(unit("com.acme.app-extra"))), "an app id this one prefixes");
  assert(!(await matches(unit("com.acme.app.extra"))));
  assert(!(await matches(unit("com.acme.app-0123456789abcdef"))));
  assert(!(await matches(unit("com.acme.app", "0123456789ABCDEF"))));
  assert(!(await matches(unit("com.acme.app").replace(".timer", ".service"))));
  // A long app id is cut as the runtime cuts it: 191 bytes, "_", 8 hex digits of its hash.
  const longId = `dev.${"x".repeat(240)}`;
  const part = linuxTimerAppPart(longId);
  assertEquals(part.length, 200);
  // 7154d850: FNV-1a 64 of the id, as the runtime's NotificationTagId hashes it.
  assertEquals(part, `dev.${"x".repeat(187)}_7154d850`);
  assertEquals(part, linuxTimerAppPart(longId));
  assert(part !== linuxTimerAppPart(`${longId}y`));
  assertEquals(linuxTimerAppPart(`dev.${"x".repeat(196)}`), `dev.${"x".repeat(196)}`);
  assertStringIncludes(linuxTimerCleanup(longId).join("\n"), `'laufey-${part}-[0-9a-f]`);
});

/** Bracket classes and literals, the only glob syntax the timer glob uses. */
function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/\[[^\]]*\]|[.*+?^${}()|\\]/g, (m) => m.startsWith("[") ? m : `\\${m}`);
  return new RegExp(`^${body}$`);
}

Deno.test("linux: secure-store adds libsecret, which the runtime loads (libsecret-1-0 / libsecret)", () => {
  assertEquals(META.secureStore, false);
  assert(!debControl(META, "x86_64", 1).includes("libsecret"), "off: no dependency");
  assert(!rpmSpec(META, "/tmp/s", []).includes("libsecret"));
  for (const caps of [{ secureStore: true }, { "secure-store": true }]) {
    const meta = packageMetaFrom(
      {},
      { desktop: { app: { name: "My App" }, capabilities: caps } },
      "x",
    );
    assertEquals(meta.secureStore, true);
    assertStringIncludes(
      debControl(meta, "x86_64", 1),
      "Depends: libwebkit2gtk-4.1-0, libgtk-3-0, libsecret-1-0\n",
    );
    assert(!debControl(meta, "x86_64", 1).includes("libsecret-tools"), "no CLI package");
    assertStringIncludes(rpmSpec(meta, "/tmp/s", []), "Requires: libsecret\n");
  }
  const off = packageMetaFrom({}, { desktop: { capabilities: { secureStore: false } } }, "x");
  assertEquals(off.secureStore, false);
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
    for (const script of ["postinst", "postrm"] as const) {
      assertEquals(control.get(`./${script}`), [
        "0",
        0o755,
        debMaintainerScript(script, "com.acme.myapp"),
      ]);
    }
    const data = await readTarGz(members.get("data.tar.gz")!);
    // The D-Bus service file: a click on a notification starts the app (runtime denext.11).
    assertEquals(
      data.get("./usr/share/dbus-1/services/com.acme.myapp.service")?.[2],
      linuxDbusService(META),
    );
    assertEquals(data.get("./usr/bin/my-app"), ["2", 0o777, "../lib/my-app/My-App-x64"]);
    assertEquals(data.get("./usr/lib/my-app/My-App-x64")?.slice(0, 2), ["0", 0o755]);
    assertEquals(data.get("./usr/lib/my-app/laufey-launch.json")?.[2], '{"inspectable":false}\n');
    assertEquals(data.get("./usr/lib/my-app/sub/data.txt")?.[2].length, 700);
    assertEquals(data.get("./usr/lib/my-app/sub/")?.[0], "5");
    const entry = data.get("./usr/share/applications/com.acme.myapp.desktop")![2];
    assertStringIncludes(entry, "MimeType=x-scheme-handler/myapp;");
    assertStringIncludes(entry, "Icon=com.acme.myapp\n");
    assert(data.has("./usr/share/pixmaps/com.acme.myapp.png"));
    assert(data.has("./usr/share/icons/hicolor/64x64/apps/com.acme.myapp.png"));
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

Deno.test("deb + rpm: the CEF sandbox helper installs setuid root; nothing else is", {
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bundle = join(dir, "My-App-x64");
    await fakeLinuxBundle(bundle);
    await Deno.writeTextFile(join(bundle, CEF_SANDBOX_HELPER), "\x7fELFsandbox");
    await Deno.chmod(join(bundle, CEF_SANDBOX_HELPER), 0o755);
    // A stray setgid, world-writable file: shipped masked.
    await Deno.writeTextFile(join(bundle, "loose.bin"), "loose");
    await Deno.chmod(join(bundle, "loose.bin"), 0o2777);
    const out = join(dir, "my-app.deb");
    await buildDesktopDeb({
      meta: { ...META, backend: "cef" },
      bundleDir: bundle,
      exe: "My-App-x64",
      arch: "x86_64",
      out,
    });
    const data = await readTarGz(readAr(await Deno.readFile(out)).get("data.tar.gz")!);
    assertEquals(data.get(`./usr/lib/my-app/${CEF_SANDBOX_HELPER}`)?.slice(0, 2), ["0", 0o4755]);
    assertEquals(data.get("./usr/lib/my-app/loose.bin")?.[1], 0o755);
    for (const [path, [type, mode]] of data) {
      if (path.endsWith(`/${CEF_SANDBOX_HELPER}`)) continue;
      assertEquals(mode & 0o7000, 0, `${path} must not be setuid / setgid / sticky`);
      if (type !== "2") assertEquals(mode & 0o022, 0, `${path} must not be group/other-writable`);
    }

    // The .rpm: the app's directory listed entry by entry, the helper alone %attr(4755,root,root).
    const root = join(dir, "root");
    const owned = await stageLinuxRoot(bundle, "My-App-x64", META, root);
    const files = await rpmFiles(root, "my-app", owned);
    const spec = rpmSpec(META, root, files);
    const list = spec.split("%defattr(-,root,root,-)\n")[1];
    assertStringIncludes(list, "%dir /usr/lib/my-app\n");
    assertStringIncludes(list, `%attr(4755,root,root) /usr/lib/my-app/${CEF_SANDBOX_HELPER}\n`);
    assertStringIncludes(list, "\n/usr/lib/my-app/sub\n");
    assertStringIncludes(list, "\n/usr/bin/my-app\n");
    assertEquals(list.match(/%attr/g)?.length, 1);
    assert(!list.includes("\n/usr/lib/my-app\n"), "the directory is not owned whole as well");
    // Without the helper (the WebView backend) the directory is owned whole, as before.
    await Deno.remove(join(root, "usr/lib/my-app", CEF_SANDBOX_HELPER));
    assertEquals(await rpmFiles(root, "my-app", owned), owned.map((path) => ({ path })));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stage: owned paths; a non-theme-size icon goes to the theme size below it", {
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
      "/usr/share/pixmaps/com.acme.myapp.png",
      "/usr/share/icons/hicolor/512x512/apps/com.acme.myapp.png",
      "/usr/share/dbus-1/services/com.acme.myapp.service",
    ]);
    const paths = (await walkBundle(join(dir, "root"))).map((e) => e.path);
    assert(paths.includes("usr/lib/my-app/sub/data.txt"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stage: an SVG icon is scalable; a non-square PNG is pixmaps only", {
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bundle = join(dir, "b");
    await fakeLinuxBundle(bundle);
    const png = await Deno.readFile(join(bundle, "AppIcon.png"));
    new DataView(png.buffer).setUint32(20, 32); // 64x32
    await Deno.writeFile(join(bundle, "AppIcon.png"), png);
    await Deno.writeTextFile(join(bundle, "AppIcon.svg"), "<svg/>");
    const root = join(dir, "root");
    const owned = await stageLinuxRoot(bundle, "My-App-x64", META, root);
    assertEquals(owned.slice(3), [
      "/usr/share/pixmaps/com.acme.myapp.png",
      "/usr/share/icons/hicolor/scalable/apps/com.acme.myapp.svg",
      "/usr/share/dbus-1/services/com.acme.myapp.service",
    ]);
    assertEquals(
      await Deno.readTextFile(
        join(root, "usr/share/icons/hicolor/scalable/apps/com.acme.myapp.svg"),
      ),
      "<svg/>",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stage: a bundle with no icon installs none, and the entry names none", {
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bundle = join(dir, "b");
    await fakeLinuxBundle(bundle);
    await Deno.remove(join(bundle, "AppIcon.png"));
    const root = join(dir, "root");
    const owned = await stageLinuxRoot(bundle, "My-App-x64", META, root);
    assertEquals(owned.length, 4, "the bundle, the link, the entry, the D-Bus service file");
    const entry = await Deno.readTextFile(
      join(root, "usr/share/applications/com.acme.myapp.desktop"),
    );
    assert(!entry.includes("Icon="), entry);
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

/** Run `fn` with console.warn captured. */
async function warnings<T>(fn: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = warn;
  }
}

Deno.test("tool gate: a missing tool's warning says how to install it", async () => {
  const { value, lines } = await warnings(() => desktopRequireTool("rpmbuild", ".rpm", false));
  if (await desktopHasTool("rpmbuild")) return; // installed here: nothing to warn about
  assertEquals(value, false);
  assertStringIncludes(lines.join("\n"), "rpmbuild not found on PATH (install rpm-build");
  const err = await assertRejects(() => desktopRequireTool("rpmbuild", ".rpm", true), Error);
  assertStringIncludes(err.message, "dnf install rpm-build");
  if (await desktopHasTool("appimagetool")) return;
  const appimage = await assertRejects(
    () => desktopRequireTool("appimagetool", "AppImage", true),
    Error,
  );
  assertStringIncludes(appimage.message, "github.com/AppImage/appimagetool/releases");
});

Deno.test("version gate: a version MSI / Debian can't express is a reason, not a crash", () => {
  assertEquals(desktopVersionProblem("msi", "1.2.3"), undefined);
  assertEquals(desktopVersionProblem("deb", "1.2.3-rc.1"), undefined);
  assertEquals(desktopVersionProblem("msi", undefined), undefined);
  assertStringIncludes(desktopVersionProblem("msi", "2026.10.2")!, "exceeds 255");
  assertStringIncludes(desktopVersionProblem("msi", "2026.10.2")!, "the MSI can express");
  assertStringIncludes(desktopVersionProblem("deb", "v1.0")!, "start with a digit");
  assertStringIncludes(desktopVersionProblem("rpm", "1.0_beta")!, "the package can express");
});

Deno.test("msi gate: Windows only, an expressible version, and WiX 5 — not just any wix", async () => {
  const wix = (v: string | null) => () => Promise.resolve(v);
  assertEquals(
    await desktopMsiProblem("1.0.0", { os: "linux", wixVersion: wix("5.0.2") }),
    "WiX builds an .msi on Windows only",
  );
  assertStringIncludes(
    (await desktopMsiProblem("2026.10.2", { os: "windows", wixVersion: wix("5.0.2") }))!,
    "exceeds 255",
  );
  assertStringIncludes(
    (await desktopMsiProblem("1.0.0", { os: "windows", wixVersion: wix(null) }))!,
    "dotnet tool install --global wix --version 5.0.2",
  );
  for (const v of ["6.0.1+abc", "4.0.5", "garbage"]) {
    const why = await desktopMsiProblem("1.0.0", { os: "windows", wixVersion: wix(v) });
    assertStringIncludes(why!, `wix ${v} is not WiX 5`);
  }
  for (const v of ["5.0.2+aa65968c", "v5.0.0"]) {
    assertEquals(
      await desktopMsiProblem("1.0.0", { os: "windows", wixVersion: wix(v) }),
      undefined,
    );
  }
  // The real probe: off Windows it never runs wix; on Windows it answers either way.
  const real = await desktopMsiProblem("1.0.0");
  if (Deno.build.os !== "windows") assertEquals(real, "WiX builds an .msi on Windows only");
  assertEquals(
    await desktopMsiProblem("1.0.0", { os: "windows" }).then((w) => w === undefined || !!w),
    true,
  );
});

Deno.test("optional installer: a default one's failure warns and yields null; an asked-for one throws", async () => {
  const boom = () => Promise.reject(new Error("wix build exited 1"));
  const { value, lines } = await warnings(() =>
    desktopOptionalInstaller(".msi for x86_64", false, boom)
  );
  assertEquals(value, null);
  assertStringIncludes(
    lines.join("\n"),
    "building the .msi for x86_64 failed (wix build exited 1)",
  );
  await assertRejects(() => desktopOptionalInstaller(".msi", true, boom), Error, "exited 1");
  assertEquals(await desktopOptionalInstaller(".msi", false, () => Promise.resolve("ok")), "ok");
  const odd = await warnings(() =>
    desktopOptionalInstaller(".msi", false, () => Promise.reject("str"))
  );
  assertStringIncludes(odd.lines.join("\n"), "failed (str)");
});

Deno.test("meta warnings: a made-up version or identifier is warned about, a set one is not", () => {
  const bare = packageMetaFrom({}, {}, "Thing");
  const lines = packageMetaWarnings({}, {}, bare);
  assertEquals(lines.length, 2);
  assertStringIncludes(
    lines[0],
    'no "version" in deno.json or package.json: the installers say 1.0.0',
  );
  assertStringIncludes(lines[1], "using com.deno.desktop.thing");
  assertStringIncludes(lines[1], "UpgradeCode");
  const deno = { version: "2.0.0", desktop: { app: { identifier: "com.acme.thing" } } };
  assertEquals(packageMetaWarnings(deno, {}, packageMetaFrom(deno, {}, "Thing")), []);
  const cfg = { desktop: { app: { identifier: "com.acme.cfg" } } };
  assertEquals(packageMetaWarnings({ version: "1.0.0" }, cfg, bare), []);
});

Deno.test("tool probe: an executable on PATH is found without a shell, a plain file is not", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "denext-fake-tool"), "#!/bin/sh\n");
    await Deno.chmod(join(dir, "denext-fake-tool"), 0o755);
    await Deno.writeTextFile(join(dir, "denext-not-exec"), "x");
    await Deno.mkdir(join(dir, "denext-a-dir"));
    // Its own PATH, in its own process: every other test's subprocesses read this one's.
    const { value } = await inChild<boolean[]>({
      imports: `import { desktopHasTool } from "@repo/src/build/desktop-package-script.ts";`,
      body: `return await Promise.all(["denext-fake-tool", "denext-not-exec", "denext-a-dir", ` +
        `"denext-missing"].map((t) => desktopHasTool(t)));`,
      env: { PATH: `:${dir}` },
    });
    assertEquals(value, [true, false, false, false]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prepare: the plan, the app.json sync and the metadata of a project", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ version: "4.5.6" }));
    const entry = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    // The name from the environment and `dist/` in the working directory: its own process.
    const run = await inChild<Awaited<ReturnType<typeof prepareDesktopPackage>>>({
      imports: `import { prepareDesktopPackage } from "@repo/src/build/desktop-package-script.ts";`,
      body: `return await prepareDesktopPackage(${JSON.stringify(entry)}, "linux", ` +
        `{ formats: ["rpm"], add: ["appimage"], export: false });`,
      env: { DENEXT_APP_NAME: "Prepared App" },
      cwd: dir,
    });
    // deno.json has a version but no identifier: only the identifier is warned about.
    const lines = run.stderr.split("\n").filter((l) => l.trim());
    assertEquals(lines.length, 1, run.stderr);
    assertStringIncludes(lines[0], "no desktop.app.identifier");
    const { name, plan, meta } = run.value;
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
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.mkdir(join(dir, "icons"));
    await Deno.writeTextFile(join(dir, "icons", "app.png"), "png");
    const entry = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    // The icons resolve against the working directory: its own process.
    const { value: cmd } = await inChild<string[]>({
      imports: `import { desktopBundleCommand } from "@repo/src/build/desktop-package-script.ts";`,
      body: `return await desktopBundleCommand(${JSON.stringify(entry)}, "linux", ` +
        `{ target: "x86_64-unknown-linux-gnu", out: "dist/a-x64", ` +
        `icons: ["icons/missing.png", "icons/app.png"] });`,
      cwd: dir,
    });
    assertEquals(cmd.slice(0, 3), ["deno", "desktop", "--no-prompt"]);
    assert(!cmd.includes("-A"));
    assertStringIncludes(cmd.join(" "), "--include out");
    assertStringIncludes(cmd.join(" "), "--target x86_64-unknown-linux-gnu");
    assertStringIncludes(cmd.join(" "), "--icon icons/app.png --output dist/a-x64 desktop.ts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("script helpers: the app name, its slug, and a failing command", async () => {
  assertEquals(desktopSlug("  My App! "), "My-App");
  assertEquals(desktopSlug("!!!"), "app");
  const { value: fromEnv } = await inChild<string>({
    imports: `import { desktopAppName } from "@repo/src/build/desktop-package-script.ts";`,
    body: `return await desktopAppName();`,
    env: { DENEXT_APP_NAME: "From Env" },
  });
  assertEquals(fromEnv, "From Env");
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
  // The name with no DENEXT_APP_NAME, read from the working directory: its own process.
  const name = async () =>
    (await inChild<string>({
      imports: `import { desktopAppName } from "@repo/src/build/desktop-package-script.ts";`,
      body: `return await desktopAppName();`,
      env: { DENEXT_APP_NAME: undefined },
      cwd: dir,
    })).value;
  try {
    assertEquals(await name(), "app"); // no deno.json
    await Deno.writeTextFile(join(dir, "deno.json"), "{ not json");
    assertEquals(await name(), "app"); // an unreadable one
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ desktop: { app: { name: "   " } } }),
    );
    assertEquals(await name(), "app"); // a blank name
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ desktop: { app: { name: "  Named App " } } }),
    );
    assertEquals(await name(), "Named App");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleFileMode: POSIX executable bits decide; on Windows, the content", () => {
  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
  const script = new TextEncoder().encode("#!/b");
  const data = new TextEncoder().encode("{}");
  assertEquals(bundleFileMode(0o100755, data, "linux"), 0o755);
  assertEquals(bundleFileMode(0o100644, elf, "darwin"), 0o644);
  assertEquals(bundleFileMode(0o100700, data, "linux"), 0o755);
  // Windows (a Linux bundle packaged cross-OS): Deno's 0o666 means nothing; an ELF image or a
  // script is executable, anything else is not.
  assertEquals(bundleFileMode(0o100666, elf, "windows"), 0o755);
  assertEquals(bundleFileMode(0o100666, script, "windows"), 0o755);
  assertEquals(bundleFileMode(0o100666, data, "windows"), 0o644);
  assertEquals(bundleFileMode(null, elf, "linux"), 0o755);
  assertEquals(bundleFileMode(null, new Uint8Array(), "windows"), 0o644);
});

Deno.test("buildDesktopTarball: the bundle as the top-level directory, modes kept", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bundle = join(dir, "My-App-x64");
    await fakeLinuxBundle(bundle);
    const out = await buildDesktopTarball({ bundleDir: bundle, out: join(dir, "app.tar.gz") });
    const entries = await readTarGz(await Deno.readFile(out));
    // The launcher is a `#!` script here: executable on every host, Windows included.
    assertEquals(entries.get("./My-App-x64/My-App-x64")?.slice(0, 2), ["0", 0o755]);
    assertEquals(entries.get("./My-App-x64/laufey-launch.json")?.slice(0, 2), ["0", 0o644]);
    assertEquals(entries.get("./My-App-x64/sub/data.txt")?.[2].length, 700);
    assertEquals(entries.get("./My-App-x64/")?.[0], "5");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("meta: the version falls back to package.json `version`, then 1.0.0; deno.json's wins", () => {
  assertEquals(packageMetaFrom({}, {}, "Thing", { version: "3.4.5" }).version, "3.4.5");
  assertEquals(
    packageMetaFrom({ version: "2.0.0" }, {}, "Thing", { version: "3.4.5" }).version,
    "2.0.0",
  );
  assertEquals(packageMetaFrom({}, {}, "Thing", { version: " " }).version, "1.0.0");
  assertEquals(packageMetaFrom({}, {}, "Thing", undefined).version, "1.0.0");
  // A package.json version is a real one: no made-up-version warning.
  const cfg = { desktop: { app: { identifier: "com.acme.cfg" } } };
  const pkg = { version: "3.4.5" };
  assertEquals(packageMetaWarnings({}, cfg, packageMetaFrom({}, cfg, "Thing", pkg), pkg), []);
  const none = packageMetaWarnings({}, cfg, packageMetaFrom({}, cfg, "Thing"));
  assertStringIncludes(none.join("\n"), 'no "version" in deno.json or package.json');
});

Deno.test("meta: desktopAppVersion — deno.json's version, else package.json's, else none", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await desktopAppVersion(dir), undefined);
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify({ version: "0.7.1" }));
    assertEquals(await desktopAppVersion(dir), "0.7.1");
    await Deno.writeTextFile(join(dir, "deno.jsonc"), '// app\n{ "version": "2.0.0" }\n');
    assertEquals(await desktopAppVersion(dir), "2.0.0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("meta: deno desktop builds with package.json's version stamped into deno.json, then restored", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "scripts"));
    const entry = toFileUrl(join(dir, "scripts", "package-windows.ts")).href;
    const original = '{\n  // the app\n  "desktop": { "app": {} }\n}\n';
    await Deno.writeTextFile(join(dir, "deno.json"), original);
    // No package.json version: nothing to stamp.
    assertEquals(await stampDenoJsonVersion(dir), null);
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify({ version: "0.7.1" }));
    // During the build deno.json carries the version (comments kept); after it, the bytes are back.
    const during = await desktopWithAppVersion(
      entry,
      () => Deno.readTextFile(join(dir, "deno.json")),
    );
    assertStringIncludes(during, "// the app");
    assertEquals(JSON.parse(during.replace("// the app", "")).version, "0.7.1");
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), original);
    // A failed build restores it too.
    await assertRejects(
      () => desktopWithAppVersion(entry, () => Promise.reject(new Error("build failed"))),
      Error,
      "build failed",
    );
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), original);
    // deno.json's own version wins: left as it is.
    const own = JSON.stringify({ version: "2.0.0" });
    await Deno.writeTextFile(join(dir, "deno.json"), own);
    assertEquals(await stampDenoJsonVersion(dir), null);
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), own);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("meta: desktopPackageMeta reads package.json `version` beside the scripts/ entry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ desktop: { app: {} } }));
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify({ version: "0.7.1" }));
    const entry = toFileUrl(join(dir, "scripts", "package-windows.ts")).href;
    const meta = await desktopPackageMeta(entry, "x");
    assertEquals(meta.version, "0.7.1");
    assertEquals(msiProductVersion(meta.version), "0.7.1");
    const warnings = await desktopPackageMetaWarnings(entry, meta);
    assert(!warnings.some((l) => l.includes('"version"')), warnings.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
