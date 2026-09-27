// The iOS privacy manifest (src/build/mobile-privacy.ts, src/build/plist-value.ts): every
// `denext mobile add` capability declares its required-reason APIs with a code Apple approves for
// the category, `mobile add` / `add-ota` / `mobile privacy --write` merge them into
// PrivacyInfo.xcprivacy without dropping an entry the app has, the file is added to the Xcode
// project's Copy Bundle Resources, and `checkPrivacyManifest` finds what App Store Connect would
// refuse. No test spawns a process.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  CAPABILITY_PRIVACY,
  checkPrivacyManifest,
  detectInstalledCapabilities,
  mergePrivacyManifest,
  OTA_PRIVACY,
  privacyEntriesFor,
  privacyLabels,
  REQUIRED_REASON_CODES,
  writePrivacyManifests,
} from "../src/build/mobile-privacy.ts";
import { dictGet, parsePlist, renderPlist } from "../src/build/plist-value.ts";
import {
  addMobileCapabilities,
  type CommandRunner,
  MOBILE_CAPABILITIES,
  planMobileCapabilities,
} from "../src/build/mobile-capabilities.ts";
import { addSourceFiles } from "../src/build/pbxproj.ts";

const PBXPROJ = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);
const MANIFEST_PATH = "ios/App/App/PrivacyInfo.xcprivacy";
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>App</string>
</dict>
</plist>
`;

/** A Capacitor 8 project in a temp dir: config, package.json, Info.plist, the Xcode project. */
async function project(files: Record<string, string> = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_privacy_" });
  const all: Record<string, string> = {
    "capacitor.config.json": JSON.stringify({ appId: "dev.example", webDir: "out" }),
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    "ios/App/App/Info.plist": INFO_PLIST,
    "ios/App/App.xcodeproj/project.pbxproj": PBXPROJ,
    ".git/HEAD": "ref: refs/heads/main\n",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

const read = (dir: string, path: string) => Deno.readTextFile(join(dir, path));
const noRun: CommandRunner = () => Promise.resolve({ code: 0 });

Deno.test("every mobile add capability has a checked privacy entry", () => {
  const missing = Object.keys(MOBILE_CAPABILITIES).filter((n) =>
    !Object.hasOwn(CAPABILITY_PRIVACY, n)
  );
  assertEquals(missing, [], "add each to CAPABILITY_PRIVACY ([] when its iOS code uses none)");
  const stale = Object.keys(CAPABILITY_PRIVACY).filter((n) =>
    !Object.hasOwn(MOBILE_CAPABILITIES, n)
  );
  assertEquals(stale, []);
});

Deno.test("every declared reason is approved for its category, and none is SDK-only", () => {
  for (const [name, entries] of Object.entries({ ...CAPABILITY_PRIVACY, ota: OTA_PRIVACY })) {
    for (const entry of entries) {
      assert(entry.source.length > 20, `${name}: say which code uses the API`);
      for (const api of entry.apis ?? []) {
        for (const reason of api.reasons) {
          assert(Object.hasOwn(REQUIRED_REASON_CODES[api.category], reason), `${name}: ${reason}`);
          assert(!["0A2A.1", "C56D.1"].includes(reason), `${name}: ${reason} is SDK-only`);
        }
      }
    }
  }
});

Deno.test("the mapping: filesystem C617.1, document-picker 3B52.1, social-login and OTA CA92.1", () => {
  assertEquals(privacyLabels(privacyEntriesFor(["filesystem"])), ["FileTimestamp C617.1"]);
  assertEquals(privacyLabels(privacyEntriesFor(["document-picker"])), ["FileTimestamp 3B52.1"]);
  assertEquals(privacyLabels(privacyEntriesFor(["social-login"])), ["UserDefaults CA92.1"]);
  assertEquals(privacyLabels(OTA_PRIVACY), ["UserDefaults CA92.1"]);
  assertEquals(privacyLabels(privacyEntriesFor(["widget"])), [
    "UserDefaults 1C8F.1",
    "UserDefaults 1C8F.1 (DenextWidgets)",
  ]);
  assertEquals(privacyLabels(privacyEntriesFor(["sentry"])), [
    "collected CrashData",
    "collected PerformanceData",
    "collected OtherDiagnosticData",
  ]);
  assertEquals(privacyEntriesFor(["haptics", "camera", "nope"]), []);
});

Deno.test("plist-value: parse and render round-trip every element kind", () => {
  const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- a comment -->
<dict>
	<key>s</key>
	<string>a &amp; b &lt;c&gt;</string>
	<key>i</key>
	<integer>42</integer>
	<key>r</key>
	<real>1.5</real>
	<key>d</key>
	<date>2024-05-01T00:00:00Z</date>
	<key>b</key>
	<data>AAE=</data>
	<key>t</key>
	<true/>
	<key>f</key>
	<false/>
	<key>empty</key>
	<array/>
	<key>nested</key>
	<array>
		<dict>
			<key>x</key>
			<string/>
		</dict>
	</array>
</dict>
</plist>
`;
  const node = parsePlist(text);
  assert(node.kind === "dict");
  assertEquals(dictGet(node, "s"), { kind: "string", text: "a & b <c>" });
  assertEquals(dictGet(node, "i"), { kind: "integer", text: "42" });
  assertEquals(dictGet(node, "t"), { kind: "bool", value: true });
  assertEquals(parsePlist(renderPlist(node)), node);
  assertStringIncludes(renderPlist(node), "<string>a &amp; b &lt;c&gt;</string>");
  assertThrows(() => parsePlist("bplist00"), Error);
  assertThrows(() => parsePlist("<dict></dict>"), Error, "not an XML plist");
});

Deno.test("merge: a new manifest has tracking off, empty lists, and the declarations", () => {
  const { text, added } = mergePrivacyManifest(
    undefined,
    privacyEntriesFor(["filesystem", "sentry"]),
  );
  assertEquals(added, [
    "FileTimestamp C617.1",
    "collected CrashData",
    "collected PerformanceData",
    "collected OtherDiagnosticData",
  ]);
  const root = parsePlist(text);
  assert(root.kind === "dict");
  assertEquals(dictGet(root, "NSPrivacyTracking"), { kind: "bool", value: false });
  assertEquals(dictGet(root, "NSPrivacyTrackingDomains"), { kind: "array", items: [] });
  assertStringIncludes(text, "<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>");
  assertStringIncludes(text, "<string>C617.1</string>");
  // Idempotent: merging again returns the same text and adds nothing.
  assertEquals(mergePrivacyManifest(text, privacyEntriesFor(["filesystem", "sentry"])), {
    text,
    added: [],
  });
});

Deno.test("merge: keeps every entry the app has and adds only what is missing", () => {
  const own = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<true/>
	<key>NSPrivacyTrackingDomains</key>
	<array>
		<string>ads.example.com</string>
	</array>
	<key>NSPrivacyCollectedDataTypes</key>
	<array>
		<dict>
			<key>NSPrivacyCollectedDataType</key>
			<string>NSPrivacyCollectedDataTypeCrashData</string>
			<key>NSPrivacyCollectedDataTypeLinked</key>
			<true/>
			<key>NSPrivacyCollectedDataTypeTracking</key>
			<false/>
			<key>NSPrivacyCollectedDataTypePurposes</key>
			<array>
				<string>NSPrivacyCollectedDataTypePurposeAnalytics</string>
			</array>
		</dict>
	</array>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array>
				<string>DDA9.1</string>
			</array>
		</dict>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryDiskSpace</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array>
				<string>E174.1</string>
			</array>
		</dict>
	</array>
	<key>MyOwnKey</key>
	<string>kept</string>
</dict>
</plist>
`;
  const { text, added } = mergePrivacyManifest(own, privacyEntriesFor(["filesystem", "sentry"]));
  assertEquals(added, [
    "FileTimestamp C617.1",
    "collected CrashData",
    "collected PerformanceData",
    "collected OtherDiagnosticData",
  ]);
  const root = parsePlist(text);
  assert(root.kind === "dict");
  assertEquals(dictGet(root, "NSPrivacyTracking"), { kind: "bool", value: true });
  assertStringIncludes(text, "<string>ads.example.com</string>");
  assertStringIncludes(text, "<string>kept</string>");
  assertStringIncludes(text, "<string>E174.1</string>");
  // The existing FileTimestamp dict gained C617.1 next to DDA9.1 (no second dict).
  assertEquals(text.match(/NSPrivacyAccessedAPICategoryFileTimestamp/g)?.length, 1);
  assert(text.indexOf("DDA9.1") < text.indexOf("C617.1"));
  // The app's own CrashData row keeps Linked = true and gains the AppFunctionality purpose.
  const crash = text.slice(text.indexOf("CrashData"), text.indexOf("PerformanceData"));
  assertStringIncludes(crash, "<true/>");
  assertStringIncludes(crash, "PurposeAnalytics");
  assertStringIncludes(crash, "PurposeAppFunctionality");
});

Deno.test("merge refuses a manifest whose list key is not an array", () => {
  const bad =
    `<plist version="1.0"><dict><key>NSPrivacyAccessedAPITypes</key><string>x</string></dict></plist>`;
  assertThrows(
    () => mergePrivacyManifest(bad, privacyEntriesFor(["filesystem"])),
    Error,
    "not an array",
  );
});

Deno.test("addSourceFiles phase resources: PrivacyInfo.xcprivacy joins Copy Bundle Resources once", () => {
  const first = addSourceFiles(PBXPROJ, ["PrivacyInfo.xcprivacy"], { phase: "resources" });
  assertEquals(first.added, ["PrivacyInfo.xcprivacy"]);
  assertStringIncludes(first.text, "/* PrivacyInfo.xcprivacy in Resources */");
  assertStringIncludes(first.text, "lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy;");
  assert(!first.text.includes("PrivacyInfo.xcprivacy in Sources"));
  assertEquals(
    addSourceFiles(first.text, ["PrivacyInfo.xcprivacy"], { phase: "resources" }).added,
    [],
  );
});

Deno.test("writePrivacyManifests writes the app manifest and adds it to Xcode; idempotent", async () => {
  const dir = await project();
  try {
    const report = await writePrivacyManifests(dir, privacyEntriesFor(["filesystem"]));
    assertEquals(report.written, [MANIFEST_PATH, "ios/App/App.xcodeproj/project.pbxproj"]);
    assertEquals(report.added[MANIFEST_PATH], ["FileTimestamp C617.1"]);
    assertStringIncludes(await read(dir, MANIFEST_PATH), "<string>C617.1</string>");
    assertStringIncludes(
      await read(dir, "ios/App/App.xcodeproj/project.pbxproj"),
      "PrivacyInfo.xcprivacy in Resources",
    );
    const again = await writePrivacyManifests(dir, privacyEntriesFor(["filesystem"]));
    assertEquals(again.written, []);
    assertEquals(again.unchanged, [MANIFEST_PATH]);
    // Nothing to declare: no manifest is created unless asked (`mobile privacy --write`).
    const empty = await project();
    assertEquals((await writePrivacyManifests(empty, [])).written, []);
    const ensured = await writePrivacyManifests(empty, [], { ensureApp: true });
    assertEquals(ensured.written, [MANIFEST_PATH, "ios/App/App.xcodeproj/project.pbxproj"]);
    await Deno.remove(empty, { recursive: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writePrivacyManifests: an extension bundle is written only when its folder exists", async () => {
  const dir = await project();
  try {
    const report = await writePrivacyManifests(dir, privacyEntriesFor(["widget"]));
    // The app gets its entry; DenextWidgets has no folder (no widget extension installed).
    assertEquals(report.written.includes("ios/App/DenextWidgets/PrivacyInfo.xcprivacy"), false);
    assertStringIncludes(await read(dir, MANIFEST_PATH), "<string>1C8F.1</string>");
    // No ios/ at all: nothing, no error.
    const android = await Deno.makeTempDir();
    assertEquals(await writePrivacyManifests(android, privacyEntriesFor(["filesystem"])), {
      written: [],
      unchanged: [],
      skipped: [],
      manual: [],
      added: {},
    });
    await Deno.remove(android, { recursive: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile add merges the capabilities' entries and lists them in the plan", async () => {
  const dir = await project();
  try {
    const plan = await planMobileCapabilities({
      capabilities: ["filesystem", "haptics"],
      cwd: dir,
    });
    assertEquals(plan.privacy, ["FileTimestamp C617.1"]);
    const report = await addMobileCapabilities({
      capabilities: ["filesystem", "document-picker"],
      cwd: dir,
      run: noRun,
    });
    assert(report.written.includes(MANIFEST_PATH), report.written.join());
    const text = await read(dir, MANIFEST_PATH);
    assertStringIncludes(text, "<string>C617.1</string>");
    assertStringIncludes(text, "<string>3B52.1</string>");
    const again = await addMobileCapabilities({
      capabilities: ["filesystem"],
      cwd: dir,
      run: noRun,
    });
    assert(!again.written.includes(MANIFEST_PATH));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("detectInstalledCapabilities reads package.json and denext's native templates", async () => {
  const dir = await project({
    "package.json": JSON.stringify({
      dependencies: { "@capacitor/core": "^8.0.0", "@capacitor/filesystem": "^8.1.3" },
      devDependencies: { "@sentry/capacitor": "4.4.0" },
    }),
    "ios/App/App/DenextOtaStore.swift": "// ota\n",
  });
  try {
    assertEquals(await detectInstalledCapabilities(dir, MOBILE_CAPABILITIES), [
      "filesystem",
      "sentry",
      "ota",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkPrivacyManifest: missing manifest, bad codes, SDK-only codes, not in Resources", async () => {
  const deps = { dependencies: { "@capacitor/core": "^8.0.0", "@capacitor/filesystem": "^8.1.3" } };
  const dir = await project({ "package.json": JSON.stringify(deps) });
  try {
    let check = await checkPrivacyManifest(dir, MOBILE_CAPABILITIES);
    assertEquals(check.findings.map((f) => f.level), ["error"]);
    assertStringIncludes(check.findings[0].message, "FileTimestamp C617.1");

    await writePrivacyManifests(dir, privacyEntriesFor(["filesystem"]));
    check = await checkPrivacyManifest(dir, MOBILE_CAPABILITIES);
    assertEquals(check.findings, []);

    const bad = (await read(dir, MANIFEST_PATH)).replace(
      "<string>C617.1</string>",
      "<string>C617.1</string><string>E174.1</string><string>0A2A.1</string>",
    );
    await Deno.writeTextFile(join(dir, MANIFEST_PATH), bad);
    check = await checkPrivacyManifest(dir, MOBILE_CAPABILITIES);
    const messages = check.findings.map((f) => f.message).join("\n");
    assertStringIncludes(messages, '"E174.1" is not an approved reason');
    assertStringIncludes(messages, "0A2A.1 may only be declared by a third-party SDK");

    // A manifest Xcode does not copy never ships.
    await Deno.writeTextFile(join(dir, "ios/App/App.xcodeproj/project.pbxproj"), PBXPROJ);
    check = await checkPrivacyManifest(dir, MOBILE_CAPABILITIES);
    assert(check.findings.some((f) => f.message.includes("Copy Bundle Resources")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkPrivacyManifest: tracking without domains and malformed data rows", async () => {
  const dir = await project({
    [MANIFEST_PATH]: `<plist version="1.0"><dict>
<key>NSPrivacyTracking</key><true/>
<key>NSPrivacyTrackingDomains</key><array/>
<key>NSPrivacyCollectedDataTypes</key><array><dict>
<key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeShoeSize</string>
<key>NSPrivacyCollectedDataTypePurposes</key><array><string>Fun</string></array>
</dict></array>
</dict></plist>`,
  });
  try {
    const check = await checkPrivacyManifest(dir, MOBILE_CAPABILITIES);
    const messages = check.findings.map((f) => `${f.level}: ${f.message}`).join("\n");
    assertStringIncludes(messages, "warning: NSPrivacyAccessedAPITypes is missing");
    assertStringIncludes(messages, "NSPrivacyTrackingDomains is empty");
    assertStringIncludes(
      messages,
      'unknown collected data type "NSPrivacyCollectedDataTypeShoeSize"',
    );
    assertStringIncludes(messages, "NSPrivacyCollectedDataTypeLinked is missing");
    assertStringIncludes(messages, 'unknown purpose "Fun"');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@capacitor/preferences needs CA92.1; tracking without NSPrivacyTracking is a warning", async () => {
  const dir = await project({
    "package.json": JSON.stringify({
      dependencies: {
        "@capacitor/core": "^8.0.0",
        "@capacitor/preferences": "^8.0.1",
        "capacitor-plugin-app-tracking-transparency": "^3.0.0",
      },
    }),
  });
  try {
    assertEquals(await detectInstalledCapabilities(dir, MOBILE_CAPABILITIES), [
      "tracking",
      "preferences",
    ]);
    await writePrivacyManifests(dir, [], { ensureApp: true });
    let check = await checkPrivacyManifest(dir, MOBILE_CAPABILITIES);
    const messages = check.findings.map((f) => `${f.level}: ${f.message}`);
    assert(
      messages.some((m) => m.startsWith("error: missing UserDefaults CA92.1")),
      messages.join(),
    );
    assert(messages.some((m) => m.startsWith("warning: the app asks for tracking permission")));
    const text = (await read(dir, MANIFEST_PATH)).replace(
      "<key>NSPrivacyTracking</key>\n\t<false/>",
      "<key>NSPrivacyTracking</key>\n\t<true/>",
    );
    await Deno.writeTextFile(join(dir, MANIFEST_PATH), text);
    check = await checkPrivacyManifest(dir, MOBILE_CAPABILITIES);
    assert(!check.findings.some((f) => f.message.includes("asks for tracking permission")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
