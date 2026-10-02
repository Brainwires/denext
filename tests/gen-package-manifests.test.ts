// scripts/gen-package-manifests.ts: the Homebrew formula, Scoop manifest and winget set the
// release job generates from SHA256SUMS. Their URLs and digests must be exactly the release's.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import {
  archiveName,
  homebrewFormula,
  MANIFEST_TARGETS,
  packageManifests,
  parseSums,
  scoopManifest,
  wingetManifests,
} from "../scripts/gen-package-manifests.ts";

const TARGETS = Object.values(MANIFEST_TARGETS);
const SUMS = TARGETS.map((t, i) => `${String(i + 1).repeat(64)}  ${archiveName(t)}`).join("\n");
const RELEASE = { tag: "v3.1.0", sums: parseSums(SUMS + "\n\ngarbage line\n") };
const DL = "https://github.com/Brainwires/denext/releases/download/v3.1.0";

Deno.test("manifests: SHA256SUMS lines parse (binary-mode * too); junk is ignored", () => {
  assertEquals(RELEASE.sums.size, 5);
  assertEquals(parseSums(`${"A".repeat(64)} *x.zip`).get("x.zip"), "a".repeat(64));
  assertEquals(archiveName("x86_64-pc-windows-msvc"), "denext-x86_64-pc-windows-msvc.zip");
});

Deno.test("manifests: the Homebrew formula pins every unix archive by digest", () => {
  const rb = homebrewFormula(RELEASE);
  assertStringIncludes(rb, "class Denext < Formula");
  assertStringIncludes(rb, 'version "3.1.0"');
  for (const [i, t] of TARGETS.entries()) {
    if (t.includes("windows")) continue;
    assertStringIncludes(
      rb,
      `url "${DL}/denext-${t}.tar.gz"\n      sha256 "${String(i + 1).repeat(64)}"`,
    );
  }
  assertStringIncludes(rb, 'bin.install "denext"');
  assertStringIncludes(rb, '"denext #{version} (binary)"');
});

Deno.test("manifests: Scoop and winget name the Windows zip and its digest", () => {
  const scoop = JSON.parse(scoopManifest(RELEASE));
  assertEquals(scoop.version, "3.1.0");
  assertEquals(scoop.architecture["64bit"], {
    url: `${DL}/denext-x86_64-pc-windows-msvc.zip`,
    hash: "5".repeat(64),
  });
  assertEquals(scoop.bin, "denext.exe");
  const winget = wingetManifests(RELEASE);
  const installer = parseYaml(winget["Brainwires.denext.installer.yaml"]) as {
    PackageVersion: string;
    NestedInstallerType: string;
    NestedInstallerFiles: Array<{ PortableCommandAlias: string }>;
    Installers: Array<{ InstallerSha256: string; InstallerUrl: string }>;
  };
  assertEquals(installer.PackageVersion, "3.1.0");
  assertEquals(installer.NestedInstallerType, "portable");
  assertEquals(installer.NestedInstallerFiles[0].PortableCommandAlias, "denext");
  assertEquals(installer.Installers[0].InstallerSha256, "5".repeat(64));
  assertEquals(installer.Installers[0].InstallerUrl, `${DL}/denext-x86_64-pc-windows-msvc.zip`);
  for (const yaml of Object.values(winget)) {
    const doc = parseYaml(yaml) as Record<string, string>;
    assertEquals([doc.PackageIdentifier, doc.ManifestVersion], ["Brainwires.denext", "1.6.0"]);
  }
  assertEquals(Object.keys(packageManifests(RELEASE)).length, 5);
});

Deno.test("manifests: a release missing an archive fails instead of shipping a bad manifest", () => {
  const partial = { tag: "v3.1.0", sums: parseSums(SUMS.split("\n").slice(0, 4).join("\n")) };
  assertThrows(() => scoopManifest(partial), Error, "denext-x86_64-pc-windows-msvc.zip");
});
