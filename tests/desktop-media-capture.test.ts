// `denext desktop add microphone` / `camera`: the launch file's grant (the app origin alone, gated
// on the runtime), the macOS usage descriptions and Hardened Runtime entitlements, the config
// validation, the doctor and the `desktop add` catalog.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  defaultUsageDescription,
  desktopMediaCapture,
  mediaCaptureEntitlements,
  mediaCaptureLaunchGrant,
  mediaCaptureRuntimeProblem,
  withMediaUsageDescriptions,
} from "../src/build/desktop-media-capture.ts";
import { writeLaufeyLaunchConfig } from "../src/build/desktop-app-config.ts";
import { desktopMacosSigning } from "../src/build/desktop-macos-signing.ts";
import {
  desktopRuntimeLabel,
  mediaCaptureRuntime,
  strictLaunchRuntime,
} from "../src/build/desktop-launch-policy.ts";
import { FIRST_MEDIA_CAPTURE_RUNTIME, supportsMediaCapture } from "../src/build/deno-version.ts";
import { dictGet, parsePlist, type PlistDict, renderPlist } from "../src/build/plist-value.ts";
import { addDesktopCapabilities, DESKTOP_CAPABILITIES } from "../src/build/desktop-capabilities.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { desktopLaunchPolicyCheck } from "../src/cli/commands/doctor.ts";

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

Deno.test("media capture: gated on runtime 3.0.0-denext.9", () => {
  assertEquals(FIRST_MEDIA_CAPTURE_RUNTIME, "3.0.0-denext.9");
  assert(supportsMediaCapture("3.0.0-denext.9"));
  assert(supportsMediaCapture("3.0.0-denext.12"));
  assert(!supportsMediaCapture("3.0.0-denext.8"));
  assert(!supportsMediaCapture("3.0.0-rc.7"));
  assert(!supportsMediaCapture("garbage"));
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assert(mediaCaptureRuntime(env({}), "3.0.0-denext.9"));
  assert(!mediaCaptureRuntime(env({}), "3.0.0-denext.7"));
  assert(!mediaCaptureRuntime(env({ DENEXT_DESKTOP_RUNTIME: "stock" }), "3.0.0-denext.9"));
  assert(!mediaCaptureRuntime(env({ DENEXT_DESKTOP_RUNTIME_DIR: "/x" }), "3.0.0-denext.9"));
  assertEquals(desktopRuntimeLabel(env({}), "3.0.0-denext.7"), "runtime 3.0.0-denext.7");
  assertEquals(desktopRuntimeLabel(env({ DENEXT_DESKTOP_RUNTIME: "Stock" })), "the stock runtime");
  assertEquals(
    desktopRuntimeLabel(env({ DENEXT_DESKTOP_RUNTIME_DIR: "/x" })),
    "a local runtime build",
  );

  const problem = mediaCaptureRuntimeProblem(BOTH, false, "runtime 3.0.0-denext.7");
  assertStringIncludes(problem!, "desktop.capabilities.microphone / camera");
  assertStringIncludes(problem!, "3.0.0-denext.9");
  assertStringIncludes(problem!, "runtime 3.0.0-denext.7");
  assertEquals(mediaCaptureRuntimeProblem(BOTH, true, "runtime 3.0.0-denext.9"), null);
  assertEquals(mediaCaptureRuntimeProblem({}, false, "runtime 3.0.0-denext.7"), null);
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

    // A runtime without the grant: no key (an older laufey would only report it), a warning, and
    // the usage text anyway (it costs nothing).
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      await Deno.writeTextFile(join(app, "Contents", "Info.plist"), INFO_PLIST);
      await writeLaufeyLaunchConfig(entry, "darwin", app, { mediaCapture: false });
    } finally {
      console.warn = warn;
    }
    assertEquals(JSON.parse(await Deno.readTextFile(written!)).mediaCapture, undefined);
    assertStringIncludes(warnings.join("\n"), "NotAllowedError");
    assertEquals(
      plistValue(
        await Deno.readTextFile(join(app, "Contents", "Info.plist")),
        "NSMicrophoneUsageDescription",
      ),
      "Talk to the assistant.",
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

Deno.test("media capture: a signed build gets the device entitlements; the config's own win", async () => {
  const { dir, entry } = await project(BOTH);
  const off = await project({
    desktop: {
      capabilities: { microphone: true, camera: true },
      macos: { entitlements: { "com.apple.security.device.camera": false } },
    },
  });
  try {
    const out = await desktopMacosSigning(entry, {});
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

    const own = await desktopMacosSigning(off.entry, {});
    const ownSigned = parsePlist(await Deno.readTextFile(own.entitlements!)) as PlistDict;
    assertEquals(dictGet(ownSigned, "com.apple.security.device.camera"), {
      kind: "bool",
      value: false,
    });
    await Deno.remove(own.entitlements!);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(off.dir, { recursive: true });
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
});

Deno.test("media capture: `desktop add microphone camera` writes both keys", async () => {
  assertEquals(DESKTOP_CAPABILITIES.microphone.key, "microphone");
  assertEquals(DESKTOP_CAPABILITIES.camera.trust, "none");
  assertStringIncludes(DESKTOP_CAPABILITIES.microphone.manual!.join("\n"), "3.0.0-denext.9");
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

Deno.test("media capture: the doctor names a runtime without the grant", async () => {
  const { dir } = await project(BOTH);
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "// entry\n");
    const check = await desktopLaunchPolicyCheck(dir, BOTH);
    if (mediaCaptureRuntime()) {
      assert(!check!.detail.includes("getUserMedia"));
    } else {
      assert(!check!.ok);
      assertStringIncludes(check!.detail, "getUserMedia");
      assertStringIncludes(check!.detail, "denext upgrade");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
