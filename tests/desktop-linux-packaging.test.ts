// The Linux packaging settings: `desktop.linux.desktopEntry` in every `.desktop` denext writes,
// the bundle's own entry rewritten after `deno desktop` (name, icon id, categories), AppStream
// metainfo, the pinned AppImage type2 runtime, `desktop.installers.email` in the Maintainer,
// the libnode check of Node-API addons, and the regenerated package-linux.ts calling the
// config-driven builders.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  debControl,
  linuxDesktopEntry,
  packageMetaFrom,
  rpmSpec,
  stageLinuxRoot,
} from "../src/build/desktop-installers.ts";
import {
  desktopEntryList,
  desktopEntryString,
  finishLinuxBundleEntry,
  linuxMetainfo,
  rewriteDesktopEntry,
} from "../src/build/desktop-linux-entry.ts";
import {
  APPIMAGE_RUNTIME_PIN,
  appImageRequires,
  buildDesktopAppImage,
  ensureAppImageRuntime,
} from "../src/build/desktop-appimage.ts";
import {
  assertLinuxNativeAddons,
  findElfAddons,
  libnodeNeeded,
  linuxNativeAddonProblems,
  neededLibraries,
} from "../src/build/desktop-native-addons.ts";
import { desktopHasTool, desktopRequireTool } from "../src/build/desktop-package-script.ts";
import { LINUX_PACKAGE_SCRIPT } from "../src/build/desktop-package-scripts.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { runDesktopDoctor } from "../src/build/desktop-doctor.ts";
import type { DesktopRuntimeStatus } from "../src/build/desktop-runtime.ts";

const DENO_JSON = {
  version: "1.4.0",
  license: "MIT",
  desktop: { app: { name: "Shell Box", identifier: "com.acme.shellbox", deepLinks: ["shellbox"] } },
};
const CONFIG = {
  desktop: {
    installers: { publisher: "Acme Inc.", email: "apps@acme.example", description: "A terminal" },
    linux: {
      desktopEntry: {
        categories: ["System", "TerminalEmulator"],
        keywords: ["shell", "prompt;cli"],
        genericName: "Terminal",
        mimeTypes: ["text/plain"],
      },
      appImage: { requires: ["libvte-2.91.so.0"] },
    },
  },
};
const META = packageMetaFrom(DENO_JSON, CONFIG, "fallback", undefined, "linux");
const PLAIN = packageMetaFrom(DENO_JSON, {}, "fallback", undefined, "linux");

// ---------------------------------------------------------------------------------------------
// B1: desktop.linux.desktopEntry
// ---------------------------------------------------------------------------------------------

Deno.test("linux entry: desktopEntry sets Categories, Keywords, GenericName and MimeType", () => {
  const entry = linuxDesktopEntry(META);
  assertStringIncludes(entry, "Categories=System;TerminalEmulator;\n");
  assertStringIncludes(entry, "Keywords=shell;prompt\\;cli;\n");
  assertStringIncludes(entry, "GenericName=Terminal\n");
  assertStringIncludes(entry, "MimeType=x-scheme-handler/shellbox;text/plain;\n");
  assert(!entry.includes("Categories=Utility;"), "the configured categories replace the default");
});

Deno.test("linux entry: the default stays Categories=Utility; with no extra keys", () => {
  const entry = linuxDesktopEntry(PLAIN);
  assertStringIncludes(entry, "Categories=Utility;\n");
  assert(!entry.includes("Keywords="));
  assert(!entry.includes("GenericName="));
});

Deno.test("linux entry: file types alone take %F; a deep link keeps %u", () => {
  const files = packageMetaFrom(
    { desktop: { app: { name: "Ed", identifier: "com.acme.ed" } } },
    { desktop: { linux: { desktopEntry: { mimeTypes: ["text/markdown"] } } } },
    "x",
    undefined,
    "linux",
  );
  assertStringIncludes(linuxDesktopEntry(files), "Exec=env LAUFEY_APP_ID=com.acme.ed ed %F\n");
  assert(linuxDesktopEntry(META).includes(" %u\n"));
});

Deno.test("linux entry: startupWMClass overrides the window class", () => {
  const meta = packageMetaFrom(
    DENO_JSON,
    { desktop: { linux: { desktopEntry: { startupWMClass: "shellbox-main" } } } },
    "x",
    undefined,
    "linux",
  );
  assertStringIncludes(linuxDesktopEntry(meta), "StartupWMClass=shellbox-main\n");
});

Deno.test("linux entry: values are escaped per the Desktop Entry spec", () => {
  assertEquals(desktopEntryString(" a\\b\nc\td"), "\\sa\\\\b\\nc\\td");
  assertEquals(desktopEntryList(["a;b", "c"]), "a\\;b;c;");
  // A bad value reaching the builder (an unvalidated config) still cannot add a line or a key.
  const meta = {
    ...PLAIN,
    desktopEntry: { categories: ["Ok", "Bad;X-Evil", "Bad\nExec=x"], genericName: "G\nExec=evil" },
  };
  const entry = linuxDesktopEntry(meta);
  assertStringIncludes(entry, "Categories=Ok;\n");
  assertStringIncludes(entry, "GenericName=G\\nExec=evil\n");
  assertEquals(entry.split("\n").filter((l) => l.startsWith("Exec=")).length, 1);
});

Deno.test("linux entry: the config is validated", () => {
  validateDenextConfig(CONFIG as DenextConfig);
  const bad: Array<[unknown, string]> = [
    [{ categories: ["Bad;Cat"] }, "desktop.linux.desktopEntry.categories"],
    [{ categories: "System" }, "desktop.linux.desktopEntry.categories"],
    [{ keywords: ["a\nb"] }, "desktop.linux.desktopEntry.keywords"],
    [{ genericName: "" }, "desktop.linux.desktopEntry.genericName"],
    [{ genericName: "x\ny" }, "desktop.linux.desktopEntry.genericName"],
    [{ startupWMClass: "a b;" }, "desktop.linux.desktopEntry.startupWMClass"],
    [{ mimeTypes: ["text"] }, "desktop.linux.desktopEntry.mimeTypes"],
    [{ nope: true }, "desktop.linux.desktopEntry"],
    ["x", "desktop.linux.desktopEntry"],
  ];
  for (const [desktopEntry, field] of bad) {
    const err = assertThrows(() =>
      validateDenextConfig({ desktop: { linux: { desktopEntry } } } as unknown as DenextConfig)
    );
    assertStringIncludes(String(err), `\`${field}`, JSON.stringify(desktopEntry));
  }
  for (
    const appImage of [{ requires: "x" }, { requires: ["a b"] }, { nope: 1 }, 3] as unknown[]
  ) {
    assertThrows(() =>
      validateDenextConfig({ desktop: { linux: { appImage } } } as unknown as DenextConfig)
    );
  }
});

// ---------------------------------------------------------------------------------------------
// B2: the bundle's own .desktop
// ---------------------------------------------------------------------------------------------

/** A bundle as `deno desktop` writes it: the app-dir entry named after the app id, AppIcon.png. */
async function fakeBundle(icon = true): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-linux-bundle-" });
  await Deno.writeTextFile(
    join(dir, "com.acme.shellbox.desktop"),
    "[Desktop Entry]\nType=Application\nName=shell-box-x64\n" +
      'Exec=env LAUFEY_APP_ID=com.acme.shellbox "shell-box-x64" %u\nIcon=AppIcon\n' +
      "StartupWMClass=com.acme.shellbox\nCategories=Utility;\n" +
      "MimeType=x-scheme-handler/shellbox;\n\n[Desktop Action new]\nName=New\nExec=x\n",
  );
  await Deno.writeTextFile(join(dir, "shell-box-x64"), "#!/bin/sh\n");
  if (icon) await Deno.writeFile(join(dir, "AppIcon.png"), new Uint8Array([0x89, 0x50, 1, 2]));
  return dir;
}

Deno.test("bundle entry: Name is the app name, Icon an icon id with its file, B1 keys added", async () => {
  const dir = await fakeBundle();
  try {
    const path = await finishLinuxBundleEntry(dir, META);
    assertEquals(path, join(dir, "com.acme.shellbox.desktop"));
    const text = await Deno.readTextFile(path!);
    assertStringIncludes(text, "Name=Shell Box\n");
    assertStringIncludes(text, "Icon=com.acme.shellbox\n");
    assertStringIncludes(text, "Comment=A terminal\n");
    assertStringIncludes(text, "Categories=System;TerminalEmulator;\n");
    assertStringIncludes(text, "GenericName=Terminal\n");
    assertStringIncludes(text, "Keywords=shell;prompt\\;cli;\n");
    assertStringIncludes(text, "MimeType=x-scheme-handler/shellbox;text/plain;\n");
    // The runtime's Exec (the app id in the environment, the quoted launcher) is kept.
    assertStringIncludes(text, 'Exec=env LAUFEY_APP_ID=com.acme.shellbox "shell-box-x64" %u\n');
    // Only the main group changes: an action's own Name stays.
    assertStringIncludes(text, "[Desktop Action new]\nName=New\n");
    // The icon the entry names is beside it.
    assertEquals(
      await Deno.readFile(join(dir, "com.acme.shellbox.png")),
      new Uint8Array([0x89, 0x50, 1, 2]),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundle entry: no icon drops Icon=; no entry is a no-op", async () => {
  const dir = await fakeBundle(false);
  try {
    const text = await Deno.readTextFile((await finishLinuxBundleEntry(dir, PLAIN))!);
    assert(!text.includes("Icon="), text);
    assertStringIncludes(text, "Categories=Utility;\n");
    await Deno.remove(join(dir, "com.acme.shellbox.desktop"));
    assertEquals(await finishLinuxBundleEntry(dir, PLAIN), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundle entry: rewriteDesktopEntry replaces, appends and removes keys in the main group", () => {
  const out = rewriteDesktopEntry(
    "# c\n[Desktop Entry]\nName=a\nIcon=b\n[Other]\nName=keep\n",
    { Name: "N", Icon: null, Keywords: "k;" },
  );
  assertEquals(out, "# c\n[Desktop Entry]\nName=N\nKeywords=k;\n[Other]\nName=keep\n");
});

// ---------------------------------------------------------------------------------------------
// B4: AppStream metainfo
// ---------------------------------------------------------------------------------------------

Deno.test("metainfo: id, name, summary, launchable, content rating and release", () => {
  const xml = linuxMetainfo(META, { date: "2026-11-08" });
  assertStringIncludes(xml, '<component type="desktop-application">');
  assertStringIncludes(xml, "<id>com.acme.shellbox</id>");
  assertStringIncludes(xml, "<name>Shell Box</name>");
  assertStringIncludes(xml, "<summary>A terminal</summary>");
  assertStringIncludes(xml, "<project_license>MIT</project_license>");
  assertStringIncludes(xml, '<launchable type="desktop-id">com.acme.shellbox.desktop</launchable>');
  assertStringIncludes(xml, '<content_rating type="oars-1.1"/>');
  assertStringIncludes(xml, '<release version="1.4.0" date="2026-11-08"/>');
  assertStringIncludes(xml, "<update_contact>apps@acme.example</update_contact>");
  assertStringIncludes(xml, "<developer><name>Acme Inc.</name></developer>");
  const req = linuxMetainfo(META, { date: "2026-11-08", requires: ["libvte-2.91.so.0"] });
  assertStringIncludes(req, "libvte-2.91.so.0");
  // XML-escaped.
  assertStringIncludes(
    linuxMetainfo({ ...PLAIN, name: "A <b> & c" }, { date: "2026-11-08" }),
    "<name>A &lt;b&gt; &amp; c</name>",
  );
});

Deno.test("metainfo: the .deb / .rpm root installs it under usr/share/metainfo", async () => {
  const bundle = await fakeBundle();
  const root = await Deno.makeTempDir({ prefix: "denext-linux-root-" });
  try {
    const owned = await stageLinuxRoot(bundle, "shell-box-x64", META, root);
    const rel = "usr/share/metainfo/com.acme.shellbox.metainfo.xml";
    assert(owned.includes(`/${rel}`), owned.join("\n"));
    assertStringIncludes(await Deno.readTextFile(join(root, rel)), "<id>com.acme.shellbox</id>");
  } finally {
    await Deno.remove(bundle, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("appimage: requires lists the backend's libraries plus the declared ones", () => {
  assertEquals(appImageRequires(META), [
    "libwebkit2gtk-4.1.so.0",
    "libgtk-3.so.0",
    "libvte-2.91.so.0",
  ]);
  assert(appImageRequires({ ...PLAIN, backend: "cef" }).includes("libnss3.so"));
});

// ---------------------------------------------------------------------------------------------
// B5: the pinned type2 runtime
// ---------------------------------------------------------------------------------------------

Deno.test("appimage runtime: pinned by tag and SHA-256 for both arches, never continuous", () => {
  assert(APPIMAGE_RUNTIME_PIN.version !== "continuous");
  for (
    const [target, file] of [["linux-x86_64", "runtime-x86_64"], [
      "linux-aarch64",
      "runtime-aarch64",
    ]]
  ) {
    const a = APPIMAGE_RUNTIME_PIN.targets[target];
    assert(a, target);
    assertEquals(a.file, file);
    assert(/^[0-9a-f]{64}$/.test(a.sha256), target);
    assertEquals(
      a.url,
      `https://github.com/AppImage/type2-runtime/releases/download/${APPIMAGE_RUNTIME_PIN.version}/${file}`,
    );
    assertEquals(a.format, "binary");
  }
});

/** A `fetch` that answers `body` for every URL. */
function fakeFetch(body: Uint8Array<ArrayBuffer>): typeof fetch {
  return (() => Promise.resolve(new Response(body.slice()))) as typeof fetch;
}

/** A pin of one `linux-x86_64` runtime with `body`'s real digest. */
async function pinFor(body: Uint8Array<ArrayBuffer>) {
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    ...APPIMAGE_RUNTIME_PIN,
    version: "20990101",
    targets: {
      "linux-x86_64": {
        file: "runtime-x86_64",
        url: "https://example.invalid/runtime-x86_64",
        sha256: sha,
        size: body.length,
        format: "binary" as const,
      },
    },
  };
}

Deno.test("appimage runtime: downloaded once, verified and cached", async () => {
  const cacheRoot = await Deno.makeTempDir({ prefix: "denext-t2rt-" });
  const body = new TextEncoder().encode("runtime bytes");
  try {
    const pin = await pinFor(body);
    const opts = { cacheRoot, pin, fetch: fakeFetch(body), log: () => {} };
    const path = await ensureAppImageRuntime("x86_64", opts);
    assertEquals(await Deno.readFile(path), body);
    assertStringIncludes(path, join("appimage-runtime", "20990101", "linux-x86_64"));
    // Cached: a second call does not download.
    const again = await ensureAppImageRuntime("x86_64", {
      ...opts,
      fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch,
    });
    assertEquals(again, path);
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
  }
});

Deno.test("appimage runtime: a digest mismatch fails closed", async () => {
  const cacheRoot = await Deno.makeTempDir({ prefix: "denext-t2rt-" });
  try {
    const pin = await pinFor(new TextEncoder().encode("expected"));
    await assertRejects(() =>
      ensureAppImageRuntime("x86_64", {
        cacheRoot,
        pin,
        fetch: fakeFetch(new TextEncoder().encode("tampered")),
        log: () => {},
      })
    );
    await assertRejects(() => ensureAppImageRuntime("arm64", { cacheRoot, pin, log: () => {} }));
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
  }
});

Deno.test("appimage: the AppDir carries the entry, icon, metainfo and AppRun; appimagetool gets --runtime-file", async () => {
  const dir = await fakeBundle();
  const out = join(await Deno.makeTempDir({ prefix: "denext-appimage-" }), "a.AppImage");
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  let appDirSeen: Record<string, string> = {};
  try {
    await finishLinuxBundleEntry(dir, META);
    await buildDesktopAppImage({
      meta: META,
      bundleDir: dir,
      exe: "shell-box-x64",
      arch: "arm64",
      out,
      runtimeFile: "/cache/runtime-aarch64",
      date: "2026-11-08",
      run: async (cmd, args, env) => {
        calls.push({ cmd, args, env });
        const appDir = args.at(-2)!;
        appDirSeen = {
          desktop: await Deno.readTextFile(join(appDir, "com.acme.shellbox.desktop")),
          shared: await Deno.readTextFile(
            join(appDir, "usr/share/applications/com.acme.shellbox.desktop"),
          ),
          metainfo: await Deno.readTextFile(
            join(appDir, "usr/share/metainfo/com.acme.shellbox.metainfo.xml"),
          ),
          appRun: await Deno.readTextFile(join(appDir, "AppRun")),
          dirIcon: String((await Deno.lstat(join(appDir, ".DirIcon"))).isFile),
          icon: String((await Deno.stat(join(appDir, "com.acme.shellbox.png"))).isFile),
        };
      },
    });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].cmd, "appimagetool");
    assertEquals(calls[0].args.slice(0, 2), ["--runtime-file", "/cache/runtime-aarch64"]);
    assertEquals(calls[0].args.at(-1), out);
    assertEquals(calls[0].env.ARCH, "aarch64");
    assertStringIncludes(appDirSeen.desktop, "Categories=System;TerminalEmulator;\n");
    assertEquals(appDirSeen.shared, appDirSeen.desktop);
    assertStringIncludes(appDirSeen.metainfo, "libvte-2.91.so.0");
    assertStringIncludes(appDirSeen.appRun, 'exec "$HERE/shell-box-x64" "$@"');
    assertStringIncludes(appDirSeen.appRun, "LAUFEY_APP_ID");
    assertEquals(appDirSeen.dirIcon, "true");
    assertEquals(appDirSeen.icon, "true");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("appimage: a bundle with no .desktop entry is refused", async () => {
  const dir = await fakeBundle();
  try {
    await Deno.remove(join(dir, "com.acme.shellbox.desktop"));
    await assertRejects(
      () =>
        buildDesktopAppImage({
          meta: META,
          bundleDir: dir,
          exe: "shell-box-x64",
          arch: "x86_64",
          out: join(dir, "x.AppImage"),
          runtimeFile: "/r",
          run: () => Promise.resolve(),
        }),
      Error,
      ".desktop",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------
// B3: the regenerated package-linux.ts is config-driven
// ---------------------------------------------------------------------------------------------

Deno.test("package-linux.ts: the AppImage comes from the config-driven builder, nothing hardcoded", () => {
  assertStringIncludes(LINUX_PACKAGE_SCRIPT, "buildDesktopAppImage");
  // No hand-written AppDir, raw appimagetool call or fixed category left in the script.
  assert(!LINUX_PACKAGE_SCRIPT.includes('run(["appimagetool"'));
  assert(!LINUX_PACKAGE_SCRIPT.includes("Categories="));
  assert(!LINUX_PACKAGE_SCRIPT.includes("AppRun"));
});

// ---------------------------------------------------------------------------------------------
// B6: Node-API addons linked against a distro's libnode
// ---------------------------------------------------------------------------------------------

const READELF = `
Dynamic section at offset 0x2d80 contains 27 entries:
  Tag        Type                         Name/Value
 0x0000000000000001 (NEEDED)             Shared library: [libnode.so.109]
 0x0000000000000001 (NEEDED)             Shared library: [libstdc++.so.6]
 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]
 0x000000000000000e (SONAME)             Library soname: [addon.node]
`;
const OBJDUMP = `
Dynamic Section:
  NEEDED               libnode.so.115
  NEEDED               libc.so.6
`;
const LDD = `\tlinux-vdso.so.1 (0x00007ffd)\n\tlibnode.so.72 => not found\n` +
  `\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)\n`;

Deno.test("addons: NEEDED entries parse from readelf, objdump and ldd output", () => {
  assertEquals(neededLibraries(READELF), ["libnode.so.109", "libstdc++.so.6", "libc.so.6"]);
  assertEquals(neededLibraries(OBJDUMP), ["libnode.so.115", "libc.so.6"]);
  assertEquals(neededLibraries(LDD), ["linux-vdso.so.1", "libnode.so.72", "libc.so.6"]);
  assertEquals(libnodeNeeded(neededLibraries(READELF)), "libnode.so.109");
  assertEquals(libnodeNeeded(["libnode.so"]), "libnode.so");
  assertEquals(libnodeNeeded(["libc.so.6", "libnodejs.so.1"]), undefined);
});

/** A directory with one ELF `.node` addon, one Mach-O and a non-addon ELF. */
async function addonTree(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-addons-" });
  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  await Deno.mkdir(join(dir, "node_modules/pty/build/Release"), { recursive: true });
  await Deno.writeFile(join(dir, "node_modules/pty/build/Release/pty.node"), elf);
  await Deno.writeFile(
    join(dir, "node_modules/pty/build/Release/mac.node"),
    new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]),
  );
  await Deno.writeFile(join(dir, "node_modules/pty/lib.so"), elf);
  return dir;
}

Deno.test("addons: only ELF .node files are found", async () => {
  const dir = await addonTree();
  try {
    assertEquals(await findElfAddons([dir, join(dir, "missing")]), [
      join(dir, "node_modules/pty/build/Release/pty.node"),
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("addons: a libnode link is a problem naming the addon; no readelf is a note", async () => {
  const dir = await addonTree();
  try {
    const seen: string[] = [];
    const scan = await linuxNativeAddonProblems([dir], {
      run: (cmd, args) => {
        seen.push(`${cmd} ${args.join(" ")}`);
        return Promise.resolve(READELF);
      },
    });
    assertEquals(scan.addons.length, 1);
    assertEquals(scan.problems.length, 1);
    assertEquals(scan.problems[0].library, "libnode.so.109");
    assertStringIncludes(scan.problems[0].addon, "pty.node");
    assertStringIncludes(seen[0], "readelf -d ");
    // objdump when readelf is missing.
    const viaObjdump = await linuxNativeAddonProblems([dir], {
      run: (cmd) => Promise.resolve(cmd === "objdump" ? OBJDUMP : null),
    });
    assertEquals(viaObjdump.problems[0].library, "libnode.so.115");
    const none = await linuxNativeAddonProblems([dir], { run: () => Promise.resolve(null) });
    assertEquals(none.problems, []);
    assertStringIncludes(none.note!, "readelf");
    const clean = await linuxNativeAddonProblems([dir], {
      run: () => Promise.resolve("NEEDED libc.so.6"),
    });
    assertEquals(clean.problems, []);
    assertEquals(clean.note, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor: the native-addons check reports a libnode addon", async () => {
  const status = {
    mode: "pinned",
    version: "3.0.0-denext.13",
    target: "x86_64-unknown-linux-gnu",
    backend: "webview",
    cache: "cached",
    deno: { found: "2.9.8", required: "2.9.8" },
    ok: true,
    detail: "",
  } as unknown as DesktopRuntimeStatus;
  const report = await runDesktopDoctor({
    os: "darwin",
    linux: false,
    runtimeStatus: () => Promise.resolve(status),
    linuxNativeAddons: () =>
      Promise.resolve({
        addons: ["/p/node_modules/pty/pty.node"],
        problems: [{ addon: "/p/node_modules/pty/pty.node", library: "libnode.so.109" }],
      }),
  });
  assert(report.checks.includes("native-addons"), report.checks.join(","));
  const finding = report.findings.find((f) => f.check === "native-addons")!;
  assertStringIncludes(finding.message, "pty.node");
  assertStringIncludes(finding.message, "libnode.so.109");
  assertStringIncludes(finding.fix, "prebuilt");
  // No desktop project (null): no check.
  const none = await runDesktopDoctor({
    os: "darwin",
    linux: false,
    runtimeStatus: () => Promise.resolve(status),
    linuxNativeAddons: () => Promise.resolve(null),
  });
  assert(!none.checks.includes("native-addons"));
  // No readelf: the note is a warning-free fact, not a finding.
  const noted = await runDesktopDoctor({
    os: "darwin",
    linux: false,
    runtimeStatus: () => Promise.resolve(status),
    linuxNativeAddons: () =>
      Promise.resolve({ addons: ["/a.node"], problems: [], note: "readelf not found" }),
  });
  assert(noted.checks.includes("native-addons"));
  assertEquals(noted.findings.filter((f) => f.check === "native-addons"), []);
});

// ---------------------------------------------------------------------------------------------
// B7: desktop.installers.email
// ---------------------------------------------------------------------------------------------

Deno.test("deb: Maintainer is Publisher <email> with an email, the publisher alone without", () => {
  assertStringIncludes(
    debControl(META, "x86_64", 1),
    "Maintainer: Acme Inc. <apps@acme.example>\n",
  );
  assertStringIncludes(rpmSpec(META, "/s", []), "Packager: Acme Inc. <apps@acme.example>\n");
  const without = packageMetaFrom(
    DENO_JSON,
    { desktop: { installers: { publisher: "Acme Inc." } } },
    "x",
    undefined,
    "linux",
  );
  assertStringIncludes(debControl(without, "x86_64", 1), "Maintainer: Acme Inc.\n");
  assert(!rpmSpec(without, "/s", []).includes("Packager:"));
});

Deno.test("deb: desktop.installers.email is validated", () => {
  for (const email of ["nope", "a@b", "a b@c.d", "<a@b.c>", ""]) {
    const err = assertThrows(() =>
      validateDenextConfig({ desktop: { installers: { email } } } as unknown as DenextConfig)
    );
    assertStringIncludes(String(err), "`desktop.installers.email", email);
  }
});

// ---------------------------------------------------------------------------------------------
// B8: dpkg-deb's install hint
// ---------------------------------------------------------------------------------------------

Deno.test("tools: a missing dpkg-deb says how to install it", async () => {
  if (await desktopHasTool("dpkg-deb")) return; // installed here: nothing to report
  const err = await assertRejects(() => desktopRequireTool("dpkg-deb", ".deb", true), Error);
  assertStringIncludes(err.message, "apt install dpkg");
  assertStringIncludes(err.message, "dnf install dpkg");
  assertStringIncludes(err.message, "brew install dpkg");
});

Deno.test("addons: the package check throws naming the addon, notes an unchecked one", async () => {
  const project = await addonTree();
  const bundle = await Deno.makeTempDir({ prefix: "denext-addon-bundle-" });
  try {
    await Deno.mkdir(join(project, ".deno-desktop/sidecars/api/node_modules"), { recursive: true });
    await Deno.rename(
      join(project, "node_modules/pty"),
      join(project, ".deno-desktop/sidecars/api/node_modules/pty"),
    );
    const err = await assertRejects(
      () => assertLinuxNativeAddons(project, bundle, { run: () => Promise.resolve(READELF) }),
      Error,
      "libnode.so.109",
    );
    assertStringIncludes(err.message, "pty.node");
    assertStringIncludes(err.message, "prebuilt");
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => warned.push(line);
    try {
      await assertLinuxNativeAddons(project, bundle, { run: () => Promise.resolve(null) });
      // The default runner: a host reader reads the stub as no dependency (or there is none:
      // the note); never a libnode.
      await assertLinuxNativeAddons(project, bundle);
    } finally {
      console.warn = warn;
    }
    assertStringIncludes(warned[0], "not checked");
    // Nothing under either root: no note.
    await assertLinuxNativeAddons(bundle, bundle, { run: () => Promise.resolve(null) });
  } finally {
    await Deno.remove(project, { recursive: true });
    await Deno.remove(bundle, { recursive: true });
  }
});

Deno.test("appimage: appimagetool's exit status decides; links and an SVG icon carry over", {
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await fakeBundle(false);
  const out = join(await Deno.makeTempDir({ prefix: "denext-appimage-" }), "a.AppImage");
  try {
    await Deno.writeTextFile(join(dir, "AppIcon.svg"), "<svg/>");
    await Deno.mkdir(join(dir, "lib"));
    await Deno.writeTextFile(join(dir, "lib", "libx.so.1"), "x");
    await Deno.symlink("libx.so.1", join(dir, "lib", "libx.so"));
    await finishLinuxBundleEntry(dir, PLAIN);
    const base = {
      meta: PLAIN,
      bundleDir: dir,
      exe: "shell-box-x64",
      arch: "x86_64" as const,
      out,
      runtimeFile: "/r",
    };
    assertEquals(await buildDesktopAppImage({ ...base, appimagetool: "true" }), out);
    await assertRejects(
      () => buildDesktopAppImage({ ...base, appimagetool: "false" }),
      Error,
      "command failed",
    );
    let seen = "";
    await buildDesktopAppImage({
      ...base,
      run: async (_cmd, args) => {
        const appDir = args.at(-2)!;
        seen = await Deno.readLink(join(appDir, "lib", "libx.so")) + "|" +
          await Deno.readTextFile(join(appDir, ".DirIcon"));
      },
    });
    assertEquals(seen, "libx.so.1|<svg/>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
