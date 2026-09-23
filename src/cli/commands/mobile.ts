// Over-the-air UI updates for Capacitor apps:
//
//   denext ota manifest <dir>     (re)write <dir>/_denext/ota.json for a static export
//                                 (--required / --notes <text> add release metadata)
//   denext mobile add-ota [dir]   install the native DenextOta plugin into ios/ + android/
//
// Both are flat verbs whose first positional selects the action (as `desktop` does). Neither
// loads the project's modules: `ota manifest` only hashes files, and `add-ota` only writes
// native sources and edits the Xcode project, storyboard and MainActivity as text.

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { writeOtaManifest } from "../../build/ota-manifest.ts";
import { type AddOtaReport, addOtaToProject } from "../../build/mobile-ota-install.ts";

/** Print `message` to stderr and exit 1. */
function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

/** `denext ota manifest <dir>`. */
async function otaManifest(ctx: CommandContext): Promise<void> {
  const dirArg = ctx.positionals[1];
  if (!dirArg) {
    fail("denext ota manifest: pass the export directory, e.g. `denext ota manifest out`.");
  }
  const dir = resolve(ctx.global.cwd ?? ".", dirArg);
  // Each key is written only when its flag is given, so a plain run stamps what it always did.
  const meta = {
    ...(ctx.flags.required === true ? { required: true } : {}),
    ...(typeof ctx.flags.notes === "string" ? { notes: ctx.flags.notes } : {}),
  };
  try {
    const { version, files, required, notes } = await writeOtaManifest(dir, meta);
    if (ctx.global.json) {
      console.log(
        JSON.stringify({
          path: `${dir}/_denext/ota.json`,
          version,
          files: files.length,
          required: required ?? false,
          notes: notes ?? null,
        }),
      );
    } else {
      const extra = required ? ", required" : "";
      console.log(
        `  wrote ${dirArg}/_denext/ota.json — version ${version} (${files.length} files${extra})`,
      );
    }
  } catch (err) {
    fail(`denext ota manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const otaCommand: CommandSpec = {
  name: "ota",
  summary: "Over-the-air UI manifest for Capacitor apps",
  usage:
    "  denext ota manifest out     Write out/_denext/ota.json (paths, SHA-256s, sizes, version)\n" +
    '  denext ota manifest out --required --notes "Fixes sign-in"\n' +
    "                              Also mark the UI required and attach release notes\n" +
    "\n" +
    "  Run it after anything that changes the export (e.g. swapping brand icons in), and before\n" +
    "  `cap sync`, so the bundled UI and the served UI carry the right version. `spa.ota: true`\n" +
    "  makes `denext export` write it for you. `*.gz` files are never listed. `--required` and\n" +
    "  `--notes` feed the app's own update prompt (prepareUiUpdate in denext/mobile); they are\n" +
    "  not part of the version.",
  positionals: [
    { name: "action", help: "manifest", required: true },
    { name: "dir", help: "The static export directory (e.g. out)" },
  ],
  flags: [
    {
      name: "required",
      type: "boolean",
      help: "Mark this UI as a required update (the app should not let users decline it)",
    },
    {
      name: "notes",
      type: "string",
      valueName: "<text>",
      help: "Release notes for the app's update prompt (at most 2000 characters)",
    },
  ],
  run: async (ctx) => {
    const action = ctx.positionals[0];
    if (action === "manifest") return await otaManifest(ctx);
    fail(`denext ota: unknown action "${action ?? ""}" (expected: manifest).`);
  },
};

/** Print an add-ota report. */
function printReport(report: AddOtaReport): void {
  for (const path of report.written) console.log(`  wrote      ${path}`);
  for (const path of report.unchanged) console.log(`  unchanged  ${path}`);
  for (const note of report.skipped) console.log(`  skipped    ${note}`);
  if (report.manual.length > 0) {
    console.log("\n  Still to do by hand:");
    for (const note of report.manual) console.log(`    - ${note}`);
  }
  console.log(
    "\n  Next: stamp the bundled UI (`spa.ota: true`, or `denext ota manifest out` before\n" +
      "  `cap sync`), serve the export (see createOtaHandler in denext/server), and call\n" +
      "  otaBooted() + checkForUiUpdate({ baseUrl }) from denext/mobile.",
  );
}

/** `denext mobile add-ota [dir]`. */
async function addOta(ctx: CommandContext): Promise<void> {
  const dir = resolve(ctx.global.cwd ?? ".", ctx.positionals[1] ?? ".");
  let report: AddOtaReport;
  try {
    report = await addOtaToProject({ dir, force: ctx.flags.force === true });
  } catch (err) {
    fail(`denext mobile add-ota: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ctx.global.json) return console.log(JSON.stringify(report));
  console.log(`\n  denext mobile add-ota  ▸  ${dir}\n`);
  printReport(report);
  if (report.skipped.length === 2) {
    fail("\n  denext mobile add-ota: no ios/ or android/ project found.");
  }
}

export const mobileCommand: CommandSpec = {
  name: "mobile",
  summary: "Capacitor helpers (add-ota: install over-the-air UI updates)",
  usage: "  denext mobile add-ota [dir]   Install the DenextOta plugin into ios/ and android/\n" +
    "\n" +
    "  iOS: writes DenextOtaPlugin.swift, DenextOtaStore.swift and DenextBridgeViewController.swift\n" +
    "  into ios/App/App/, adds them to the App target in project.pbxproj, and switches\n" +
    "  Main.storyboard and SceneDelegate to DenextBridgeViewController when they still use\n" +
    "  CAPBridgeViewController. Android: writes dev/denext/ota/*.java and calls\n" +
    "  DenextOta.prepare(this, bridgeBuilder) from a stock MainActivity. Customised files are\n" +
    "  left alone and listed as one-line manual steps. Safe to run again.",
  positionals: [
    { name: "action", help: "add-ota", required: true },
    { name: "dir", help: "The Capacitor project (default: .)" },
  ],
  flags: [
    {
      name: "force",
      type: "boolean",
      help: "Replace native template files that differ from denext's (loses local edits)",
    },
  ],
  run: async (ctx) => {
    const action = ctx.positionals[0];
    if (action === "add-ota") return await addOta(ctx);
    fail(`denext mobile: unknown action "${action ?? ""}" (expected: add-ota).`);
  },
};
