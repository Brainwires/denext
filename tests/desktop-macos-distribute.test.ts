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
  desktopStapleMacos,
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
  // Then Gatekeeper itself is asked, as a downloader's Mac would: `-t open` for the image (the
  // check that answered "no usable signature" for an unsigned one), `-t install` for the package.
  const assess = {
    "dist/App.dmg": [
      "spctl",
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "-v",
      "dist/App.dmg",
    ],
    "dist/App.pkg": ["spctl", "--assess", "--type", "install", "-v", "dist/App.pkg"],
  };
  for (const file of ["dist/App.dmg", "dist/App.pkg"] as const) {
    const mine = calls.filter((c) => c.includes(file));
    assertEquals(mine, [
      ["xcrun", "notarytool", "submit", file, "--keychain-profile", "notary", "--wait"],
      ["xcrun", "stapler", "staple", file],
      ["xcrun", "stapler", "validate", file],
      assess[file],
    ]);
  }
});

Deno.test("desktopNotarizeMacos: an installer Gatekeeper refuses fails the run", async () => {
  const { run } = recorder((cmd) => cmd[0] === "spctl");
  await assertRejects(
    () =>
      desktopNotarizeMacos(
        [desktopMacosArtifact("dist/App.dmg", "dmg", "developer-id")],
        PROFILE,
        { run },
      ),
    Error,
    "spctl",
  );
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

Deno.test("desktopStapleMacos: a staple that fails is tried again, the wait doubling up to 60 s", async () => {
  let failures = 2;
  const { calls, run } = recorder((cmd) => cmd[2] === "staple" && failures-- > 0);
  const waits: number[] = [];
  await desktopStapleMacos("dist/App.dmg", {
    run,
    stapleDelayMs: 40_000,
    sleep: (ms) => (waits.push(ms), Promise.resolve()),
  });
  assertEquals(calls.length, 3);
  assert(calls.every((c) => c.join(" ") === "xcrun stapler staple dist/App.dmg"));
  assertEquals(waits, [40_000, 60_000]);
});

Deno.test("desktopStapleMacos: every attempt failing rethrows the last failure", async () => {
  const { calls, run } = recorder(() => true);
  const waits: number[] = [];
  await assertRejects(
    () =>
      desktopStapleMacos("dist/App.app", {
        run,
        stapleAttempts: 3,
        stapleDelayMs: 10,
        sleep: (ms) => (waits.push(ms), Promise.resolve()),
      }),
    Error,
    "stapler staple",
  );
  assertEquals(calls.length, 3);
  assertEquals(waits, [10, 20]);
});

Deno.test("desktopStapleMacos: DENEXT_STAPLE_ATTEMPTS sets the attempts (1 to 20; else 5)", async () => {
  const tries = async (value: string | undefined) => {
    const { calls, run } = recorder(() => true);
    await desktopStapleMacos("x.dmg", {
      run,
      sleep: () => Promise.resolve(),
      env: (name) => name === "DENEXT_STAPLE_ATTEMPTS" ? value : undefined,
    }).catch(() => {});
    return calls.length;
  };
  assertEquals(await tries("2"), 2);
  assertEquals(await tries("0"), 5);
  assertEquals(await tries("99"), 5);
  assertEquals(await tries("x"), 5);
  assertEquals(await tries(undefined), 5);
});

Deno.test("desktopNotarizeMacos: a staple that fails once is retried before validating", async () => {
  let failed = false;
  const { calls, run } = recorder((cmd) => {
    if (cmd[2] !== "staple" || failed) return false;
    failed = true;
    return true;
  });
  const [dmg] = await desktopNotarizeMacos(
    [desktopMacosArtifact("dist/App.dmg", "dmg", "developer-id")],
    PROFILE,
    { run, sleep: () => Promise.resolve() },
  );
  assertEquals(dmg.stapled, true);
  const kinds = calls.map((c) => c.slice(0, 3).join(" "));
  assertEquals(kinds.filter((k) => k === "xcrun stapler staple").length, 2);
  assert(kinds.indexOf("xcrun stapler validate") > kinds.lastIndexOf("xcrun stapler staple"));
});

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
  // Wrapped as `deno fmt` lays it out in a scaffolded app (80 columns).
  assertStringIncludes(
    script,
    "await desktopNotarizeMacos(\n        await installersFor(app, formats, s),\n        s.notary,\n      )",
  );
  // The .app is notarized + stapled before its installers are built (they hold the stapled .app).
  const appNotarized = script.indexOf('[desktopMacosArtifact(app, "app", signed)]');
  assert(appNotarized > 0 && appNotarized < script.indexOf("await makeDmg(app)"));
  // The closing line comes from what was done, not from the signing settings.
  assertStringIncludes(script, "desktopMacosDistributionNote(done)");
  assert(!script.includes("signed + notarized + stapled — ready to distribute"));
  // Either notary credential (a keychain profile or an API key), as `build --compile --sign` takes.
  assertStringIncludes(script, "const notary = desktopNotaryCredentials();");
});
