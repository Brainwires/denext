// `denext desktop add microphone` / `camera`: the launch file's grant (the app origin alone, gated
// on the runtime), the macOS usage descriptions and Hardened Runtime entitlements, the config
// validation, the doctor and the `desktop add` catalog.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  assertMediaCaptureRuntime,
  defaultUsageDescription,
  denoJsonMediaCaptureProblem,
  desktopMediaCapture,
  LINUX_WEBRTC_FIX,
  linuxWebRtcProblem,
  mediaCaptureEntitlements,
  mediaCaptureLaunchGrant,
  mediaCaptureRuntimeProblem,
  withMediaUsageDescriptions,
} from "../src/build/desktop-media-capture.ts";
import { laufeyLaunchPath, writeLaufeyLaunchConfig } from "../src/build/desktop-app-config.ts";
import { desktopMacosSigning } from "../src/build/desktop-macos-signing.ts";
import {
  desktopRuntimeLabel,
  mediaCaptureRuntime,
  strictLaunchRuntime,
} from "../src/build/desktop-launch-policy.ts";
import {
  FIRST_MEDIA_CAPTURE_RUNTIME,
  MEDIA_CAPTURE_LAUFEY_API,
  mediaCapturePinProblem,
  supportsMediaCapture,
} from "../src/build/deno-version.ts";
import pinJson from "../src/build/desktop-runtime-pin.json" with { type: "json" };
import { dictGet, parsePlist, type PlistDict, renderPlist } from "../src/build/plist-value.ts";
import { addDesktopCapabilities, DESKTOP_CAPABILITIES } from "../src/build/desktop-capabilities.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { desktopLaunchPolicyCheck, desktopLinuxWebRtcCheck } from "../src/cli/commands/doctor.ts";
import { projectLinuxWebRtc } from "../src/cli/commands/desktop-doctor.ts";
import type { prepareDesktopPackage } from "../src/build/desktop-package-script.ts";
import { inChild } from "./helpers/isolated.ts";

const STRICT = strictLaunchRuntime() ? { strictPolicy: true } : {};

const BOTH = {
  desktop: {
    app: { origin: "myapp://app", identifier: "com.example.voice" },
    capabilities: { microphone: { usageDescription: "Talk to the assistant." }, camera: true },
  },
};

/** A minimal macOS bundle's Info.plist. */
const INFO_PLIST = renderPlist({
  kind: "dict",
  entries: [
    ["CFBundleName", { kind: "string", text: "Voice" }],
    ["CFBundleIdentifier", { kind: "string", text: "com.example.voice" }],
  ],
});

async function project(config: unknown): Promise<{ dir: string; entry: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext-media-capture-" });
  await Deno.mkdir(join(dir, "scripts"));
  await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default ${JSON.stringify(config)};\n`,
  );
  return { dir, entry: toFileUrl(join(dir, "scripts", "package-macos.ts")).href };
}

function plistValue(text: string, key: string): string | undefined {
  const node = dictGet(parsePlist(text) as PlistDict, key);
  return node?.kind === "string" ? node.text : undefined;
}

Deno.test("media capture: the enabled kinds and their usage text", () => {
  assertEquals(desktopMediaCapture(BOTH), {
    microphone: { usageDescription: "Talk to the assistant." },
    camera: {},
  });
  assertEquals(desktopMediaCapture({}), {});
  assertEquals(desktopMediaCapture(undefined), {});
  assertEquals(
    desktopMediaCapture({
      desktop: { capabilities: { microphone: false, camera: { usageDescription: "  " } } },
    }),
    { camera: {} },
  );
  assertEquals(desktopMediaCapture({ desktop: { capabilities: { microphone: ["x"] } } }), {});
  // A package script reads the config unvalidated: an object with any other key is off, never on.
  assertEquals(
    desktopMediaCapture({
      desktop: {
        capabilities: {
          microphone: { enabled: false },
          camera: { origins: ["https://x.example"], usageDescription: "Video." },
        },
      },
    }),
    {},
  );
  assertEquals(
    mediaCaptureLaunchGrant(
      { desktop: { capabilities: { microphone: { enabled: false } } } },
      "app://localhost",
    ),
    undefined,
  );
});

Deno.test("media capture: the launch grant names the app origin alone, per kind", () => {
  assertEquals(mediaCaptureLaunchGrant(BOTH, "myapp://app"), {
    microphone: ["myapp://app"],
    camera: ["myapp://app"],
  });
  assertEquals(
    mediaCaptureLaunchGrant({ desktop: { capabilities: { microphone: true } } }, "app://localhost"),
    { microphone: ["app://localhost"] },
  );
  assertEquals(
    mediaCaptureLaunchGrant({ desktop: { capabilities: {} } }, "app://localhost"),
    undefined,
  );
  assertEquals(mediaCaptureLaunchGrant({}, "app://localhost"), undefined);
});

Deno.test("media capture: the Hardened Runtime entitlements", () => {
  assertEquals(mediaCaptureEntitlements(BOTH), {
    "com.apple.security.device.audio-input": true,
    "com.apple.security.device.camera": true,
  });
  assertEquals(
    mediaCaptureEntitlements({ desktop: { capabilities: { microphone: true } } }),
    { "com.apple.security.device.audio-input": true },
  );
  assertEquals(mediaCaptureEntitlements({}), {});
});

Deno.test("media capture: Info.plist usage descriptions, the config's text or the bundle's name", () => {
  const out = withMediaUsageDescriptions(INFO_PLIST, BOTH);
  assertEquals(plistValue(out, "NSMicrophoneUsageDescription"), "Talk to the assistant.");
  assertEquals(plistValue(out, "NSCameraUsageDescription"), "Voice uses your camera.");
  assertEquals(plistValue(out, "CFBundleIdentifier"), "com.example.voice");
  // An existing description is replaced, not duplicated; a kind that is off is left alone.
  const again = withMediaUsageDescriptions(
    out,
    { desktop: { capabilities: { microphone: { usageDescription: "New text." } } } },
  );
  assertEquals(plistValue(again, "NSMicrophoneUsageDescription"), "New text.");
  assertEquals(plistValue(again, "NSCameraUsageDescription"), "Voice uses your camera.");
  assertEquals(
    (parsePlist(again) as PlistDict).entries.filter(([k]) => k === "NSMicrophoneUsageDescription")
      .length,
    1,
  );
  assertEquals(withMediaUsageDescriptions(INFO_PLIST, {}), INFO_PLIST);
  assertEquals(defaultUsageDescription("microphone", undefined), "This app uses your microphone.");
  assertEquals(defaultUsageDescription("camera", " "), "This app uses your camera.");
});

Deno.test("media capture: a usage description with markup round-trips through Info.plist", () => {
  const text = `Say "hi" & <b>talk</b> — it's ]]> fine.\tTab\nnext line`;
  const out = withMediaUsageDescriptions(
    INFO_PLIST,
    { desktop: { capabilities: { microphone: { usageDescription: text } } } },
  );
  assertEquals(plistValue(out, "NSMicrophoneUsageDescription"), text);
  assert(!out.includes("<b>"));
  assertStringIncludes(out, "&lt;b&gt;");
  assertStringIncludes(out, "&amp;");
  // Nothing else entered the dict: the text could not open a key of its own.
  assertEquals(
    (parsePlist(out) as PlistDict).entries.map(([k]) => k),
    ["CFBundleName", "CFBundleIdentifier", "NSMicrophoneUsageDescription"],
  );
});

Deno.test("media capture: gated on runtime 3.0.0-denext.10", () => {
  assertEquals(FIRST_MEDIA_CAPTURE_RUNTIME, "3.0.0-denext.10");
  assert(supportsMediaCapture("3.0.0-denext.10"));
  assert(supportsMediaCapture("3.0.0-denext.12"));
  // No 3.0.0-denext.9 release exists; the version still sorts below the gate.
  assert(!supportsMediaCapture("3.0.0-denext.9"));
  assert(!supportsMediaCapture("3.0.0-denext.8"));
  assert(!supportsMediaCapture("3.0.0-rc.7"));
  assert(!supportsMediaCapture("garbage"));
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assert(mediaCaptureRuntime(env({}), "3.0.0-denext.10"));
  assert(!mediaCaptureRuntime(env({}), "3.0.0-denext.7"));
  assert(!mediaCaptureRuntime(env({ DENEXT_DESKTOP_RUNTIME: "stock" }), "3.0.0-denext.10"));
  assert(!mediaCaptureRuntime(env({ DENEXT_DESKTOP_RUNTIME_DIR: "/x" }), "3.0.0-denext.10"));
  assertEquals(desktopRuntimeLabel(env({}), "3.0.0-denext.7"), "runtime 3.0.0-denext.7");
  assertEquals(desktopRuntimeLabel(env({ DENEXT_DESKTOP_RUNTIME: "Stock" })), "the stock runtime");
  assertEquals(
    desktopRuntimeLabel(env({ DENEXT_DESKTOP_RUNTIME_DIR: "/x" })),
    "a local runtime build",
  );

  const problem = mediaCaptureRuntimeProblem(BOTH, false, "runtime 3.0.0-denext.7");
  assertStringIncludes(problem!, "desktop.capabilities.microphone / camera");
  assertStringIncludes(problem!, "3.0.0-denext.10");
  assertStringIncludes(problem!, "runtime 3.0.0-denext.7");
  assertStringIncludes(problem!, "cannot restrict capture to the app's origin");
  assert(!problem!.includes("\n"));
  assertEquals(mediaCaptureRuntimeProblem(BOTH, true, "runtime 3.0.0-denext.10"), null);
  assertEquals(mediaCaptureRuntimeProblem({}, false, "runtime 3.0.0-denext.7"), null);

  // Packaging refuses it, with one plain line.
  let refused: Error | undefined;
  try {
    assertMediaCaptureRuntime(BOTH, false, "the stock runtime");
  } catch (e) {
    refused = e as Error;
  }
  assertStringIncludes(refused!.message, "needs Deno Desktop runtime 3.0.0-denext.10 or later");
  assertStringIncludes(refused!.message, "the stock runtime");
  assert(!refused!.message.includes("\n"));
  assertMediaCaptureRuntime(BOTH, true, "runtime 3.0.0-denext.10");
  assertMediaCaptureRuntime({}, false, "the stock runtime");
});

Deno.test("media capture: a pin past the gate must carry the laufey API that enforces it", () => {
  assertEquals(MEDIA_CAPTURE_LAUFEY_API, 53);
  assertEquals(mediaCapturePinProblem("3.0.0-denext.8", 50), null);
  assertEquals(mediaCapturePinProblem("3.0.0-denext.8", null), null);
  assertEquals(mediaCapturePinProblem("3.0.0-denext.9", 51), null);
  assertEquals(mediaCapturePinProblem("3.0.0-denext.10", 53), null);
  assertEquals(mediaCapturePinProblem("3.0.0-denext.11", 54), null);
  assertStringIncludes(mediaCapturePinProblem("3.0.0-denext.10", 51)!, "laufey API 51");
  assertStringIncludes(mediaCapturePinProblem("3.0.0-denext.10", null)!, "laufey API none");
  // The committed pin: bumping it to the gate without the API fails here.
  assertEquals(mediaCapturePinProblem(pinJson.version, pinJson.laufeyApiVersion ?? null), null);
});

Deno.test("media capture: the packaged launch file grants the app origin; Info.plist gets the text", async () => {
  const { dir, entry } = await project(BOTH);
  try {
    const app = join(dir, "dist", "Voice.app");
    await Deno.mkdir(join(app, "Contents"), { recursive: true });
    await Deno.writeTextFile(join(app, "Contents", "Info.plist"), INFO_PLIST);
    const written = await writeLaufeyLaunchConfig(entry, "darwin", app, { mediaCapture: true });
    const launch = JSON.parse(await Deno.readTextFile(written!));
    assertEquals(launch.mediaCapture, { microphone: ["myapp://app"], camera: ["myapp://app"] });
    assertEquals(launch.bridgeOrigins, ["myapp://app"]);
    const plist = await Deno.readTextFile(join(app, "Contents", "Info.plist"));
    assertEquals(plistValue(plist, "NSMicrophoneUsageDescription"), "Talk to the assistant.");
    assertEquals(plistValue(plist, "NSCameraUsageDescription"), "Voice uses your camera.");

    // A runtime without the grant: packaging is refused, and nothing is written (no launch file,
    // no usage text: without them the OS still refuses an origin the runtime would not).
    const old = join(dir, "dist", "Old.app");
    await Deno.mkdir(join(old, "Contents"), { recursive: true });
    await Deno.writeTextFile(join(old, "Contents", "Info.plist"), INFO_PLIST);
    const err = await assertRejects(
      () => writeLaufeyLaunchConfig(entry, "darwin", old, { mediaCapture: false }),
      Error,
      "needs Deno Desktop runtime 3.0.0-denext.10 or later to package",
    );
    assert(!err.message.includes("\n"));
    const oldPlist = await Deno.readTextFile(join(old, "Contents", "Info.plist"));
    assertEquals(oldPlist, INFO_PLIST);
    assertEquals(plistValue(oldPlist, "NSMicrophoneUsageDescription"), undefined);
    assertEquals(plistValue(oldPlist, "NSCameraUsageDescription"), undefined);
    assertEquals(
      await Deno.stat(laufeyLaunchPath("darwin", old)).then(
        () => true,
        () => false,
      ),
      false,
    );

    // Linux / Windows: the grant, the default origin when the config names none.
    const plain = await project({ desktop: { capabilities: { microphone: true } } });
    try {
      const out = join(plain.dir, "dist");
      const linux = await writeLaufeyLaunchConfig(plain.entry, "linux", out, {
        mediaCapture: true,
      });
      assertEquals(JSON.parse(await Deno.readTextFile(linux!)), {
        inspectable: false,
        bridgeOrigins: ["app://localhost"],
        mediaCapture: { microphone: ["app://localhost"] },
        ...STRICT,
      });
    } finally {
      await Deno.remove(plain.dir, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("media capture: the grant stays the app origin whatever bridge or navigation origins say", async () => {
  const cases: unknown[] = [
    {
      desktop: {
        app: { origin: "myapp://app", identifier: "com.example.voice", bridgeOrigins: ["*"] },
        capabilities: { microphone: true, camera: true },
      },
    },
    {
      desktop: {
        app: {
          origin: "myapp://app",
          identifier: "com.example.voice",
          bridgeOrigins: ["https://partner.example", "other://*"],
          allowedNavigationOrigins: ["https://idp.example"],
          deepLinks: ["myapp"],
        },
        capabilities: { microphone: true, camera: true },
      },
    },
    {
      desktop: {
        app: { bridgeOrigins: ["*"], allowedNavigationOrigins: ["https://idp.example"] },
        capabilities: { microphone: true },
      },
    },
  ];
  const expected = [
    { microphone: ["myapp://app"], camera: ["myapp://app"] },
    { microphone: ["myapp://app"], camera: ["myapp://app"] },
    { microphone: ["app://localhost"] },
  ];
  for (const [i, config] of cases.entries()) {
    const { dir, entry } = await project(config);
    try {
      for (const os of ["darwin", "linux", "windows"] as const) {
        const out = join(dir, "dist", os === "darwin" ? "Voice.app" : `voice-${os}`);
        if (os === "darwin") {
          await Deno.mkdir(join(out, "Contents"), { recursive: true });
          await Deno.writeTextFile(join(out, "Contents", "Info.plist"), INFO_PLIST);
        }
        const written = await writeLaufeyLaunchConfig(entry, os, out, { mediaCapture: true });
        const launch = JSON.parse(await Deno.readTextFile(written!));
        assertEquals(launch.mediaCapture, expected[i], `case ${i} on ${os}`);
        // The bridge did take the wider list: the grant is not derived from it.
        assert(launch.bridgeOrigins.length >= 1);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("media capture: Linux and Windows bundles get no Info.plist edit", async () => {
  const { dir, entry } = await project(BOTH);
  try {
    for (const os of ["linux", "windows"] as const) {
      const out = join(dir, "dist", os);
      // A stray Info.plist where a macOS bundle would have one stays as it is.
      await Deno.mkdir(join(out, "Contents"), { recursive: true });
      await Deno.writeTextFile(join(out, "Contents", "Info.plist"), INFO_PLIST);
      await writeLaufeyLaunchConfig(entry, os, out, { mediaCapture: true });
      assertEquals(await Deno.readTextFile(join(out, "Contents", "Info.plist")), INFO_PLIST);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("media capture: a signed build gets the device entitlements; the config's own win", async () => {
  const { dir, entry } = await project(BOTH);
  const off = await project({
    desktop: {
      capabilities: { microphone: true, camera: true },
      macos: { entitlements: { "com.apple.security.device.camera": false } },
    },
  });
  try {
    const out = await desktopMacosSigning(entry, { mediaCapture: true });
    const signed = parsePlist(await Deno.readTextFile(out.entitlements!)) as PlistDict;
    assertEquals(dictGet(signed, "com.apple.security.device.audio-input"), {
      kind: "bool",
      value: true,
    });
    assertEquals(dictGet(signed, "com.apple.security.device.camera"), {
      kind: "bool",
      value: true,
    });
    await Deno.remove(out.entitlements!);

    const own = await desktopMacosSigning(off.entry, { mediaCapture: true });
    const ownSigned = parsePlist(await Deno.readTextFile(own.entitlements!)) as PlistDict;
    assertEquals(dictGet(ownSigned, "com.apple.security.device.camera"), {
      kind: "bool",
      value: false,
    });
    await Deno.remove(own.entitlements!);

    // A runtime that does not enforce the grant: refused before any entitlement is written.
    const refused = await assertRejects(
      () => desktopMacosSigning(entry, { mediaCapture: false }),
      Error,
      "needs Deno Desktop runtime 3.0.0-denext.10 or later to package",
    );
    assert(!refused.message.includes("\n"));
    // Without either capability the runtime does not matter.
    const plain = await project({ desktop: { capabilities: { fs: true } } });
    try {
      assertEquals(await desktopMacosSigning(plain.entry, { mediaCapture: false }), {
        entitlements: undefined,
      });
    } finally {
      await Deno.remove(plain.dir, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(off.dir, { recursive: true });
  }
});

Deno.test("media capture: the device entitlements merge over DENEXT_ENTITLEMENTS", async () => {
  const { dir, entry } = await project({ desktop: { capabilities: { microphone: true } } });
  const base = join(dir, "base.plist");
  await Deno.writeTextFile(
    base,
    renderPlist({
      kind: "dict",
      entries: [
        ["com.apple.security.cs.allow-jit", { kind: "bool", value: true }],
        ["com.apple.security.network.client", { kind: "bool", value: true }],
        // A device key the config does not turn on: left as the env plist set it.
        ["com.apple.security.device.camera", { kind: "bool", value: false }],
      ],
    }),
  );
  try {
    const out = await desktopMacosSigning(entry, { entitlements: base, mediaCapture: true });
    assert(out.entitlements !== base, "a merged copy, not the env plist itself");
    const signed = parsePlist(await Deno.readTextFile(out.entitlements!)) as PlistDict;
    assertEquals(dictGet(signed, "com.apple.security.cs.allow-jit"), { kind: "bool", value: true });
    assertEquals(dictGet(signed, "com.apple.security.network.client"), {
      kind: "bool",
      value: true,
    });
    assertEquals(dictGet(signed, "com.apple.security.device.audio-input"), {
      kind: "bool",
      value: true,
    });
    // The camera is off in the config, so the base's key is left as it was.
    assertEquals(dictGet(signed, "com.apple.security.device.camera"), {
      kind: "bool",
      value: false,
    });
    await Deno.remove(out.entitlements!);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("media capture: config validation", () => {
  const errors = (capabilities: unknown) => {
    try {
      validateDenextConfig({ desktop: { capabilities } } as DenextConfig);
      return "";
    } catch (e) {
      return String(e);
    }
  };
  assertEquals(errors({ microphone: true, camera: false }), "");
  assertEquals(errors({ microphone: { usageDescription: "For voice input." } }), "");
  assertEquals(errors({ camera: {} }), "");
  assertStringIncludes(errors({ microphone: "yes" }), "desktop.capabilities.microphone");
  assertStringIncludes(errors({ camera: [] }), "desktop.capabilities.camera");
  assertStringIncludes(
    errors({ microphone: { usageDescription: "" } }),
    "desktop.capabilities.microphone.usageDescription",
  );
  assertStringIncludes(
    errors({ camera: { usageDescription: 3 } }),
    "desktop.capabilities.camera.usageDescription",
  );
  // Only usageDescription: `{ enabled: false }` would turn the device ON, `{ origins }` be ignored.
  assertStringIncludes(errors({ microphone: { enabled: false } }), "microphone.enabled");
  assertStringIncludes(
    errors({ camera: { origins: ["https://x.example"] } }),
    "desktop.capabilities.camera.origins",
  );
  assertStringIncludes(
    errors({ microphone: { usageDescription: "ok", extra: 1 } }),
    "desktop.capabilities.microphone.extra",
  );
  // XML 1.0 cannot hold C0 controls (but tab / newline / CR), U+FFFE / U+FFFF or a lone surrogate.
  for (const bad of ["Ring\u0001", "a\u0000b", "\u001Fx", "x\uFFFE", "x\uD800y"]) {
    assertStringIncludes(
      errors({ microphone: { usageDescription: bad } }),
      "must not contain control characters",
      JSON.stringify(bad),
    );
  }
  assertEquals(errors({ microphone: { usageDescription: "Line one\n\tLine two\r\n" } }), "");
  assertEquals(errors({ camera: { usageDescription: "Emoji 🎙 ok" } }), "");
});

Deno.test("media capture: the schema closes the options object", async () => {
  const schema = JSON.parse(
    await Deno.readTextFile(new URL("../denext.config.schema.json", import.meta.url)),
  );
  const caps = schema.properties.desktop.properties.capabilities.properties;
  for (const kind of ["microphone", "camera"]) {
    const options = caps[kind].anyOf.find((b: { type?: string }) => b.type === "object");
    assertEquals(options.additionalProperties, false, kind);
    assertEquals(Object.keys(options.properties), ["usageDescription"]);
  }
});

Deno.test("media capture: `desktop add microphone camera` writes both keys", async () => {
  assertEquals(DESKTOP_CAPABILITIES.microphone.key, "microphone");
  assertEquals(DESKTOP_CAPABILITIES.camera.trust, "none");
  assertStringIncludes(DESKTOP_CAPABILITIES.microphone.manual!.join("\n"), "3.0.0-denext.10");
  const { dir } = await project({ desktop: { capabilities: {} } });
  try {
    const report = await addDesktopCapabilities({
      capabilities: ["microphone", "camera"],
      dir,
      dryRun: false,
    });
    assertEquals([...report.added].sort(), ["camera", "microphone"]);
    const text = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(text, "microphone: true");
    assertStringIncludes(text, "camera: true");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("media capture: deno.json's own mediaCapture is named as replaced, never silently dropped", async () => {
  const grant = { microphone: ["myapp://app"] };
  // Nothing set, an empty grant, or the very grant denext writes: nothing is lost.
  assertEquals(denoJsonMediaCaptureProblem({}, grant), null);
  assertEquals(denoJsonMediaCaptureProblem(null, grant), null);
  assertEquals(
    denoJsonMediaCaptureProblem({ desktop: { app: { mediaCapture: {} } } }, undefined),
    null,
  );
  assertEquals(
    denoJsonMediaCaptureProblem(
      { desktop: { app: { mediaCapture: { microphone: ["myapp://app"], camera: [] } } } },
      grant,
    ),
    null,
  );
  // Another origin, or a grant with no capability on: replaced, and the message says with what.
  const other = {
    desktop: { app: { mediaCapture: { microphone: ["https://example.com"] } } },
  };
  const problem = denoJsonMediaCaptureProblem(other, grant)!;
  assertStringIncludes(problem, "deno.json sets desktop.app.mediaCapture");
  assertStringIncludes(problem, "microphone for myapp://app");
  assertStringIncludes(denoJsonMediaCaptureProblem(other, undefined)!, "no grant");

  // The package step warns, and still writes denext's grant.
  const { dir, entry } = await project({
    desktop: { app: BOTH.desktop.app, capabilities: { microphone: true } },
  });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(other));
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args.join(" "));
    let written: string | null;
    try {
      written = await writeLaufeyLaunchConfig(entry, "linux", join(dir, "dist"), {
        mediaCapture: true,
      });
    } finally {
      console.warn = warn;
    }
    assertEquals(JSON.parse(await Deno.readTextFile(written!)).mediaCapture, grant);
    assertEquals(warned.length, 1, warned.join("\n"));
    assertStringIncludes(warned[0], "deno.json sets desktop.app.mediaCapture");
    assertStringIncludes(warned[0], "denext desktop add microphone camera");

    // `denext doctor` names it too.
    await Deno.writeTextFile(join(dir, "desktop.ts"), "// entry\n");
    const config = { desktop: { app: BOTH.desktop.app, capabilities: { microphone: true } } };
    const check = await desktopLaunchPolicyCheck(dir, config, {
      env: () => undefined,
      runtimeVersion: "3.0.0-denext.10",
    });
    assert(!check!.ok);
    assertStringIncludes(check!.detail, "deno.json sets desktop.app.mediaCapture");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ desktop: { app: { mediaCapture: grant } } }),
    );
    const same = await desktopLaunchPolicyCheck(dir, config, {
      env: () => undefined,
      runtimeVersion: "3.0.0-denext.10",
    });
    assert(!same!.detail.includes("mediaCapture"), same!.detail);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("media capture: the doctor names a runtime without the grant", async () => {
  const { dir } = await project(BOTH);
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "// entry\n");
    const bad = await desktopLaunchPolicyCheck(dir, BOTH, {
      env: env({}),
      runtimeVersion: "3.0.0-denext.7",
    });
    assert(!bad!.ok);
    assertEquals(bad!.critical, false);
    assertStringIncludes(bad!.detail, "runtime 3.0.0-denext.7");
    assertStringIncludes(bad!.detail, "`denext desktop package` refuses it");
    assertStringIncludes(bad!.detail, "DENEXT_DESKTOP_RUNTIME");
    assertStringIncludes(bad!.detail, "denext upgrade");

    const stock = await desktopLaunchPolicyCheck(dir, BOTH, {
      env: env({ DENEXT_DESKTOP_RUNTIME: "stock" }),
      runtimeVersion: "3.0.0-denext.10",
    });
    assertStringIncludes(stock!.detail, "the stock runtime");

    const good = await desktopLaunchPolicyCheck(dir, BOTH, {
      env: env({}),
      runtimeVersion: "3.0.0-denext.10",
    });
    assert(!good!.detail.includes("needs Deno Desktop runtime"), good!.detail);
    assert(good!.ok, good!.detail);

    // Without either capability the runtime is no problem.
    const plain = { desktop: { app: BOTH.desktop.app } };
    const none = await desktopLaunchPolicyCheck(dir, plain, {
      env: env({}),
      runtimeVersion: "3.0.0-denext.7",
    });
    assert(!none!.detail.includes("needs Deno Desktop runtime"), none!.detail);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("media capture: Linux WebRTC needs the CEF backend", () => {
  const mic = { desktop: { capabilities: { microphone: true } } };
  const problem = linuxWebRtcProblem(mic, "webview");
  assertStringIncludes(problem!, "desktop.capabilities.microphone is on");
  assertStringIncludes(problem!, "RTCPeerConnection is undefined");
  assertStringIncludes(problem!, "getUserMedia works");
  assertStringIncludes(linuxWebRtcProblem(BOTH, "webview")!, "microphone / camera");
  assertEquals(linuxWebRtcProblem(mic, "cef"), null);
  assertEquals(linuxWebRtcProblem(mic, null), null);
  assertEquals(
    linuxWebRtcProblem({ desktop: { capabilities: { microphone: false } } }, "webview"),
    null,
  );
  assertStringIncludes(
    LINUX_WEBRTC_FIX,
    'desktop: { backend: { linux: "cef" } } in denext.config.ts',
  );
  assertStringIncludes(LINUX_WEBRTC_FIX, "macOS and Windows keep the system WebView");
  assert(!LINUX_WEBRTC_FIX.includes("deno.json"), LINUX_WEBRTC_FIX);
});

Deno.test("media capture: both doctors warn that the Linux webview build has no WebRTC", async () => {
  const { dir } = await project(BOTH);
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "// entry\n");
    // `denext doctor`: the loaded config, the default (webview) backend.
    const check = await desktopLinuxWebRtcCheck(dir, BOTH);
    assertEquals([check!.name, check!.ok, check!.critical], ["desktop Linux WebRTC", false, false]);
    assertStringIncludes(check!.detail, "RTCPeerConnection is undefined");
    assertStringIncludes(
      check!.detail,
      'desktop: { backend: { linux: "cef" } } in denext.config.ts',
    );
    assertEquals(await desktopLinuxWebRtcCheck(dir, { desktop: { app: BOTH.desktop.app } }), null);
    // `denext desktop doctor --linux`: the config read as data.
    assertStringIncludes((await projectLinuxWebRtc(dir))!, "microphone / camera is on");

    // The CEF backend has WebRTC: neither says anything.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ desktop: { backend: "cef" } }),
    );
    assertEquals(await desktopLinuxWebRtcCheck(dir, BOTH), null);
    assertEquals(await projectLinuxWebRtc(dir), null);
    // An unknown backend is the runtime check's to report.
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ desktop: { backend: "x" } }));
    assertEquals(await desktopLinuxWebRtcCheck(dir, BOTH), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  // Not a desktop project, or a config that can't be read as data.
  const plain = await Deno.makeTempDir({ prefix: "denext-media-capture-" });
  try {
    assertEquals(await desktopLinuxWebRtcCheck(plain, BOTH), null);
    assertEquals(await projectLinuxWebRtc(plain), null);
    await Deno.writeTextFile(join(plain, "desktop.ts"), "// entry\n");
    await Deno.writeTextFile(join(plain, "denext.config.ts"), "export default make();\n");
    assertEquals(await projectLinuxWebRtc(plain), null);
  } finally {
    await Deno.remove(plain, { recursive: true });
  }
});

Deno.test('media capture: a per-OS desktop.backend with linux: "cef" gives no WebRTC warning', async () => {
  const perOs = { desktop: { ...BOTH.desktop, backend: { linux: "cef" } } };
  const { dir } = await project(perOs);
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "// entry\n");
    // deno.json keeps the system WebView (macOS and Windows): the Linux engine is still CEF.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ desktop: { backend: "webview" } }),
    );
    // `denext doctor`: the loaded config.
    assertEquals(await desktopLinuxWebRtcCheck(dir, perOs), null);
    // `denext desktop doctor --linux`: the config read as data.
    assertEquals(await projectLinuxWebRtc(dir), null);
    // A per-OS value that leaves Linux on the webview still warns, with the per-OS fix.
    const macCef = { desktop: { ...BOTH.desktop, backend: { macos: "cef" } } };
    const check = await desktopLinuxWebRtcCheck(dir, macCef);
    assertStringIncludes(check!.detail, "RTCPeerConnection is undefined");
    assertStringIncludes(
      check!.detail,
      'desktop: { backend: { linux: "cef" } } in denext.config.ts',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Run `prepareDesktopPackage` for `os` in its own process; its stderr. */
async function prepareStderr(dir: string, os: "linux" | "windows"): Promise<string> {
  const entry = toFileUrl(join(dir, "scripts", `package-${os}.ts`)).href;
  const run = await inChild<Awaited<ReturnType<typeof prepareDesktopPackage>>>({
    imports: `import { prepareDesktopPackage } from "@repo/src/build/desktop-package-script.ts";`,
    body: `return await prepareDesktopPackage(${JSON.stringify(entry)}, ${JSON.stringify(os)}, ` +
      `{ formats: [${
        JSON.stringify(os === "linux" ? "tar.gz" : "zip")
      }], add: [], export: false });`,
    env: { DENEXT_APP_NAME: "Voice" },
    cwd: dir,
  });
  return run.stderr;
}

Deno.test("media capture: a Linux package run warns once that the webview build has no WebRTC", async () => {
  const { dir } = await project(BOTH);
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ version: "1.2.3" }));
    const linux = await prepareStderr(dir, "linux");
    assertEquals(linux.split("RTCPeerConnection is undefined").length - 1, 1, linux);
    assertStringIncludes(linux, 'desktop: { backend: { linux: "cef" } } in denext.config.ts');
    // A warning, not a refusal; and only for a Linux target.
    assert(!(await prepareStderr(dir, "windows")).includes("RTCPeerConnection"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ version: "1.2.3", desktop: { backend: "cef" } }),
    );
    assert(!(await prepareStderr(dir, "linux")).includes("RTCPeerConnection"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('media capture: a Linux package run with desktop.backend { linux: "cef" } does not warn', async () => {
  const { dir } = await project({ desktop: { ...BOTH.desktop, backend: { linux: "cef" } } });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ version: "1.2.3" }));
    assert(!(await prepareStderr(dir, "linux")).includes("RTCPeerConnection"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
