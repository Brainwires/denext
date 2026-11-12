// scripts/package-macos.ts notarizes and staples the .app AND each installer beside it: a .dmg
// holding a stapled .app is still "no usable signature" to Gatekeeper (`spctl -t open`) until the
// image itself is code-signed, notarized and stapled. The closing line names exactly what was
// done to each artifact kind, never more.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type DesktopMacosArtifact,
  desktopMacosArtifact,
  desktopMacosDistributionNote,
  desktopNotarizeMacos,
  desktopSignMacosDmg,
} from "../src/build/desktop.ts";
import { MACOS_PACKAGE_SCRIPT } from "../src/build/desktop-package-scripts.ts";

const ID = "Developer ID Application: Example (TEAM123456)";
const PROFILE = { kind: "keychain-profile", profile: "notary" } as const;

/** A command runner that records every command. */
function recorder(fail?: (cmd: string[]) => boolean) {
  const calls: string[][] = [];
  const run = (cmd: string[]) => {
    calls.push(cmd);
    return fail?.(cmd) ? Promise.reject(new Error(`failed: ${cmd.join(" ")}`)) : Promise.resolve();
  };
  return { calls, run };
}

Deno.test("desktopSignMacosDmg: a Developer ID identity signs the image with a timestamp, then verifies", async () => {
  const { calls, run } = recorder();
  const dmg = await desktopSignMacosDmg("dist/App.dmg", ID, { run });
  assertEquals(calls, [
    ["codesign", "--force", "--timestamp", "-s", ID, "dist/App.dmg"],
    ["codesign", "--verify", "--strict", "dist/App.dmg"],
  ]);
  assertEquals(dmg, {
    path: "dist/App.dmg",
    kind: "dmg",
    signature: "developer-id",
    notarized: false,
    stapled: false,
  });
});

Deno.test("desktopSignMacosDmg: no identity or the ad-hoc one leaves the image unsigned", async () => {
  for (const identity of [undefined, "-", ""]) {
    const { calls, run } = recorder();
    const dmg = await desktopSignMacosDmg("dist/App.dmg", identity, { run });
    assertEquals(calls, []);
    assertEquals(dmg.signature, "unsigned");
  }
});

Deno.test("desktopNotarizeMacos: a .dmg and a .pkg are submitted directly, stapled and validated", async () => {
  const { calls, run } = recorder();
  const done = await desktopNotarizeMacos(
    [
      desktopMacosArtifact("dist/App.dmg", "dmg", "developer-id"),
      desktopMacosArtifact("dist/App.pkg", "pkg", "developer-id"),
    ],
    PROFILE,
    { run },
  );
  assertEquals(done.map((a) => [a.path, a.notarized, a.stapled]), [
    ["dist/App.dmg", true, true],
    ["dist/App.pkg", true, true],
  ]);
  for (const file of ["dist/App.dmg", "dist/App.pkg"]) {
    const mine = calls.filter((c) => c.includes(file));
    assertEquals(mine, [
      ["xcrun", "notarytool", "submit", file, "--keychain-profile", "notary", "--wait"],
      ["xcrun", "stapler", "staple", file],
      ["xcrun", "stapler", "validate", file],
    ]);
  }
});

Deno.test("desktopNotarizeMacos: an .app goes up as a zip with the API key, which is removed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const app = join(dir, "App.app");
    const zip = `${app}.zip`;
    const { calls, run } = recorder();
    const writeZip = async (cmd: string[]) => {
      if (cmd[0] === "ditto") await Deno.writeTextFile(zip, "zip");
      await run(cmd);
    };
    const key = { kind: "api-key", key: "/k/AuthKey.p8", keyId: "KID", issuer: "ISS" } as const;
    const [done] = await desktopNotarizeMacos(
      [desktopMacosArtifact(app, "app", "developer-id")],
      key,
      { run: writeZip },
    );
    assertEquals(calls, [
      ["ditto", "-c", "-k", "--keepParent", app, zip],
      [
        "xcrun",
        "notarytool",
        "submit",
        zip,
        "--key",
        "/k/AuthKey.p8",
        "--key-id",
        "KID",
        "--issuer",
        "ISS",
        "--wait",
      ],
      ["xcrun", "stapler", "staple", app],
      ["xcrun", "stapler", "validate", app],
    ]);
    assert(done.notarized && done.stapled);
    await assertRejects(() => Deno.stat(zip), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopNotarizeMacos: nothing without credentials, nor for an unsigned or ad-hoc artifact", async () => {
  const { calls, run } = recorder();
  const items = [
    desktopMacosArtifact("dist/App.app", "app", "ad-hoc"),
    desktopMacosArtifact("dist/App.dmg", "dmg", "unsigned"),
    desktopMacosArtifact("dist/App.pkg", "pkg", "unsigned"),
  ];
  assertEquals(await desktopNotarizeMacos(items, PROFILE, { run }), items);
  const signed = [desktopMacosArtifact("dist/App.dmg", "dmg", "developer-id")];
  assertEquals(await desktopNotarizeMacos(signed, undefined, { run }), signed);
  assertEquals(calls, []);
});

Deno.test("desktopNotarizeMacos: a rejected submission fails the run before stapling", async () => {
  const { calls, run } = recorder((cmd) => cmd[1] === "notarytool");
  await assertRejects(
    () =>
      desktopNotarizeMacos(
        [desktopMacosArtifact("dist/App.dmg", "dmg", "developer-id")],
        PROFILE,
        { run },
      ),
    Error,
    "notarytool",
  );
  assert(!calls.some((c) => c[1] === "stapler"));
});

/** A record with the given state. */
function art(
  kind: DesktopMacosArtifact["kind"],
  signature: DesktopMacosArtifact["signature"],
  notarized = false,
): DesktopMacosArtifact {
  return { path: `dist/App.${kind}`, kind, signature, notarized, stapled: notarized };
}

Deno.test("desktopMacosDistributionNote: names what each artifact kind is, never more", () => {
  assertEquals(
    desktopMacosDistributionNote([
      art("app", "developer-id", true),
      art("dmg", "developer-id", true),
    ]),
    "  (.app signed + notarized + stapled; .dmg signed + notarized + stapled — ready to distribute)",
  );
  assertEquals(
    desktopMacosDistributionNote([art("app", "developer-id"), art("dmg", "developer-id")]),
    "  (.app signed, NOT notarized; .dmg signed, NOT notarized — set DENEXT_NOTARY_PROFILE " +
      "(or DENEXT_NOTARY_KEY + DENEXT_NOTARY_KEY_ID) to notarize)",
  );
  assertEquals(
    desktopMacosDistributionNote([art("app", "ad-hoc"), art("dmg", "unsigned")]),
    "  (.app ad-hoc signed; .dmg unsigned — not distributable; see the macOS distribution doc)",
  );
  // An unsigned .pkg beside a notarized .app and .dmg: no "ready to distribute".
  assertEquals(
    desktopMacosDistributionNote([
      art("app", "developer-id", true),
      art("dmg", "developer-id", true),
      art("pkg", "unsigned"),
    ]),
    "  (.app signed + notarized + stapled; .dmg signed + notarized + stapled; .pkg unsigned)",
  );
  // Two arches with the same state: named once.
  assertEquals(
    desktopMacosDistributionNote([
      art("app", "developer-id", true),
      art("app", "developer-id", true),
    ]),
    "  (.app signed + notarized + stapled — ready to distribute)",
  );
});

Deno.test("scaffold: the macOS script signs, notarizes and staples each .dmg, and claims only what it did", () => {
  const script = MACOS_PACKAGE_SCRIPT;
  // The .dmg is signed with the app's identity, then notarized with the installers.
  assertStringIncludes(script, "desktopSignMacosDmg(await makeDmg(app), s.identity)");
  assertStringIncludes(
    script,
    "await desktopNotarizeMacos(await installersFor(app, formats, s), s.notary)",
  );
  // The .app is notarized + stapled before its installers are built (they hold the stapled .app).
  const appNotarized = script.indexOf('[desktopMacosArtifact(app, "app", signed)]');
  assert(appNotarized > 0 && appNotarized < script.indexOf("await makeDmg(app)"));
  // The closing line comes from what was done, not from the signing settings.
  assertStringIncludes(script, "desktopMacosDistributionNote(done)");
  assert(!script.includes("signed + notarized + stapled — ready to distribute"));
  // Either notary credential (a keychain profile or an API key), as `build --compile --sign` takes.
  assertStringIncludes(script, "const notary = notaryCredentials();");
});
