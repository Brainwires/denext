// The `denext mobile privacy | doctor | inspect` verbs (src/cli/commands/mobile-store.ts through
// the `mobile` command) and the privacy line `denext doctor` adds for a Capacitor project.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createMobileCommand } from "../src/cli/commands/mobile.ts";
import { collectDoctorReport } from "../src/cli/commands/doctor.ts";

const PBXPROJ = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mobile_cli_" });
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

const BASE = {
  "capacitor.config.json": JSON.stringify({
    appId: "dev.example",
    appName: "Receipts",
    webDir: "out",
  }),
  "package.json": JSON.stringify({
    dependencies: { "@capacitor/core": "^8.0.0", "@capacitor/filesystem": "^8.1.3" },
  }),
  "ios/App/App/Info.plist": `<plist version="1.0"><dict></dict></plist>\n`,
  "ios/App/App.xcodeproj/project.pbxproj": PBXPROJ,
};

/** Run the `mobile` verb, capturing console.log. */
async function runVerb(
  positionals: string[],
  flags: Record<string, string | boolean>,
  json = false,
): Promise<string> {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await createMobileCommand().run({
      positionals,
      flags,
      global: { json, verbose: false, quiet: false },
      rest: [],
    });
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

Deno.test("denext mobile privacy: prints findings; --write merges the installed entries", async () => {
  const dir = await project(BASE);
  try {
    const before = await runVerb(["privacy"], { dir });
    assertStringIncludes(before, "(no manifest)");
    assertStringIncludes(before, "capabilities: filesystem");
    assertStringIncludes(before, "1 error(s)");
    const written = await runVerb(["privacy"], { dir, write: true });
    assertStringIncludes(
      written,
      "wrote      ios/App/App/PrivacyInfo.xcprivacy (+ FileTimestamp C617.1)",
    );
    assertStringIncludes(written, "The privacy manifest is valid.");
    const json = JSON.parse(await runVerb(["privacy", dir], { check: true }, true));
    assertEquals(json.findings, []);
    assertEquals(json.installed, ["filesystem"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext mobile doctor --release on a clean export passes; --json has the report", async () => {
  const dir = await project({
    ...BASE,
    "out/index.html": `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`,
  });
  try {
    const text = await runVerb(["doctor"], { dir, release: true });
    assertStringIncludes(text, "denext mobile doctor --release");
    assertStringIncludes(text, "All checks passed.");
    const report = JSON.parse(await runVerb(["doctor", dir], { release: true }, true));
    assertEquals(report.profile, "release");
    assertEquals(report.findings, []);
    assert(report.checks.includes("mixed-content"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext mobile inspect --dry-run prints the steps with the app's name, opening nothing", async () => {
  const dir = await project(BASE);
  try {
    const text = await runVerb(["inspect"], { dir, "dry-run": true, platform: "ios" });
    assertStringIncludes(text, "Safari → Develop");
    assertStringIncludes(text, "open Receipts");
    assert(!text.includes("chrome://inspect/#devices"));
    const json = JSON.parse(await runVerb(["inspect", dir], { "dry-run": true }, true));
    assertEquals(json.platform, "all");
    assertEquals(json.actions, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext doctor adds an advisory privacy line for a Capacitor project", async () => {
  const dir = await project({
    ...BASE,
    "denext.config.ts": `export default { mode: "spa", spa: { entry: "./src/main.ts" } };\n`,
    "src/main.ts": "console.log(1);\n",
  });
  try {
    const { checks } = await collectDoctorReport(dir);
    const privacy = checks.find((c) => c.name === "iOS privacy manifest");
    assert(privacy, checks.map((c) => c.name).join());
    assertEquals(privacy.ok, false);
    assertEquals(privacy.critical, false);
    assertStringIncludes(privacy.detail, "FileTimestamp C617.1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
