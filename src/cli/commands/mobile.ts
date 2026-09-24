// Over-the-air UI updates for Capacitor apps:
//
//   denext ota manifest <dir>     (re)write <dir>/_denext/ota.json for a static export
//                                 (--required / --notes <text> / --sequence <n> /
//                                 --min-native <n> add release metadata, --sign <keyfile> or
//                                 DENEXT_OTA_SIGNING_KEY signs it, stamping a sequence)
//   denext ota keygen <out>       write a P-256 signing key (<out>) and its public key (<out>.pub)
//   denext mobile add-ota [dir]   install the native DenextOta plugin into ios/ + android/
//                                 (--public-key <file> embeds the verifying key)
//   denext mobile add <cap...>    add the Capacitor plugins behind denext/mobile's capability
//                                 functions (haptics, share, secure-store, …), their native
//                                 config, and `cap sync` (--dry-run plans, --list lists)
//
// Both are flat verbs whose first positional selects the action (as `desktop` does). Neither
// loads the project's modules: `ota manifest` only hashes files, and `add-ota` only writes
// native sources and edits the Xcode project, storyboard, Info.plist, AndroidManifest and
// MainActivity as text.

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { writeOtaManifest } from "../../build/ota-manifest.ts";
import type { OtaManifest } from "../../mobile/ota-manifest.ts";
import {
  generateOtaKeyPair,
  loadOtaSigningKey,
  OTA_SIGNING_KEY_ENV,
  parseOtaPublicKey,
} from "../../build/ota-signing.ts";
import { type AddOtaReport, addOtaToProject } from "../../build/mobile-ota-install.ts";
import {
  type AddCapabilitiesReport,
  addMobileCapabilities,
  type CommandRunner,
  formatCapabilityPlan,
  formatCapabilityTable,
} from "../../build/mobile-capabilities.ts";

/** Print `message` to stderr and exit 1. */
function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

/** Print what `denext ota manifest` wrote, as JSON or as one line. */
function printManifest(ctx: CommandContext, dir: string, dirArg: string, m: OtaManifest): void {
  if (ctx.global.json) {
    console.log(
      JSON.stringify({
        path: `${dir}/_denext/ota.json`,
        version: m.version,
        files: m.files.length,
        required: m.required ?? false,
        notes: m.notes ?? null,
        sequence: m.sequence ?? null,
        minNative: m.minNative ?? null,
        signed: m.signature !== undefined,
      }),
    );
    return;
  }
  const extra = (m.required ? ", required" : "") +
    (m.sequence !== undefined ? `, sequence ${m.sequence}` : "") +
    (m.minNative !== undefined ? `, min native ${m.minNative}` : "") +
    (m.signature ? ", signed" : "");
  console.log(
    `  wrote ${dirArg}/_denext/ota.json — version ${m.version} (${m.files.length} files${extra})`,
  );
}

/** `denext ota manifest <dir>`. */
async function otaManifest(ctx: CommandContext): Promise<void> {
  const dirArg = ctx.positionals[1];
  if (!dirArg) {
    fail("denext ota manifest: pass the export directory, e.g. `denext ota manifest out`.");
  }
  const cwd = ctx.global.cwd ?? ".";
  const dir = resolve(cwd, dirArg);
  // Each key is written only when its flag is given, so a plain run stamps what it always did.
  // A signed manifest gets a sequence (the Unix time) unless --sequence sets one.
  const meta = {
    ...(ctx.flags.required === true ? { required: true } : {}),
    ...(typeof ctx.flags.notes === "string" ? { notes: ctx.flags.notes } : {}),
    ...(typeof ctx.flags.sequence === "number" ? { sequence: ctx.flags.sequence } : {}),
    ...(typeof ctx.flags["min-native"] === "number" ? { minNative: ctx.flags["min-native"] } : {}),
  };
  const sign = ctx.flags.sign;
  try {
    // --sign wins; without it DENEXT_OTA_SIGNING_KEY (the PEM contents, for CI) signs.
    const signingKey = await loadOtaSigningKey(
      typeof sign === "string" ? resolve(cwd, sign) : undefined,
    );
    printManifest(ctx, dir, dirArg, await writeOtaManifest(dir, meta, signingKey));
  } catch (err) {
    fail(`denext ota manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write `content` to `path` through a fresh temporary file in the same directory (created with
 * `mode`, never an existing, maybe wider file) renamed over it, so an existing key is replaced
 * only once its successor is complete.
 */
async function replaceFile(path: string, content: string, mode: number): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temp, content, { createNew: true, mode });
  try {
    await Deno.rename(temp, path);
  } catch (err) {
    await Deno.remove(temp).catch(() => {});
    throw err;
  }
}

/** Whether something exists at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** `denext ota keygen <out>`. */
async function otaKeygen(ctx: CommandContext): Promise<void> {
  const outArg = ctx.positionals[1];
  if (!outArg) {
    fail(
      "denext ota keygen: pass the private key file to write, e.g. `denext ota keygen ota.key`.",
    );
  }
  const out = resolve(ctx.global.cwd ?? ".", outArg);
  const pub = `${out}.pub`;
  const force = ctx.flags.force === true;
  let replacing = false;
  for (const path of [out, pub]) {
    if (!(await exists(path))) continue;
    if (!force) fail(`denext ota keygen: ${path} already exists (pass --force to replace it).`);
    replacing = true;
  }
  try {
    const { privateKeyPem, publicKey } = await generateOtaKeyPair();
    // Each file is written complete (the key with 0600) before it replaces the old one.
    await replaceFile(out, privateKeyPem, 0o600);
    await replaceFile(pub, publicKey + "\n", 0o644);
    if (replacing) {
      console.error(
        "  warning: the old key pair is replaced. Every installed app binary that embeds the old\n" +
          "  public key now refuses manifests signed with the new key (code `signature`) until you\n" +
          "  ship a binary built with `denext mobile add-ota --public-key` and the new .pub.",
      );
    }
    if (ctx.global.json) {
      console.log(
        JSON.stringify({ privateKey: out, publicKeyFile: pub, publicKey, replaced: replacing }),
      );
      return;
    }
    console.log(`  wrote ${outArg} (private key, mode 0600: keep it secret, e.g. a CI secret)`);
    console.log(
      `  wrote ${outArg}.pub (public key; embed it with \`denext mobile add-ota --public-key ${outArg}.pub\`)`,
    );
    console.log(`\n  ${publicKey}`);
  } catch (err) {
    fail(`denext ota keygen: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const otaCommand: CommandSpec = {
  name: "ota",
  summary: "Over-the-air UI manifest for Capacitor apps",
  usage:
    "  denext ota manifest out     Write out/_denext/ota.json (paths, SHA-256s, sizes, version)\n" +
    '  denext ota manifest out --required --notes "Fixes sign-in"\n' +
    "                              Also mark the UI required and attach release notes\n" +
    "  denext ota manifest out --sign ota.key\n" +
    "                              Also sign it (or set " + OTA_SIGNING_KEY_ENV +
    " to the PEM);\n" +
    "                              signing stamps --sequence (default: the Unix time) so apps\n" +
    "                              refuse an older release, and --min-native <build> refuses\n" +
    "                              app binaries older than that build number\n" +
    "  denext ota keygen ota.key   Write a P-256 signing key (0600) and ota.key.pub\n" +
    "\n" +
    "  Run it after anything that changes the export (e.g. swapping brand icons in), and before\n" +
    "  `cap sync`, so the bundled UI and the served UI carry the right version. `spa.ota: true`\n" +
    "  makes `denext export` write it for you. `*.gz` files are never listed. `--required` and\n" +
    "  `--notes` feed the app's own update prompt (prepareUiUpdate in denext/mobile); they are\n" +
    "  not part of the version, but the signature covers them. An app whose binary embeds the\n" +
    "  public key (`denext mobile add-ota --public-key ota.key.pub`) refuses an unsigned or\n" +
    "  wrongly signed manifest; one without a key refuses plain http beyond loopback. Signing\n" +
    "  protects integrity only: over plain http the headers (bearer tokens) are visible on the\n" +
    "  network. `keygen --force` rotates the key, which breaks OTA for every installed binary\n" +
    "  that embeds the old public key.",
  positionals: [
    { name: "action", help: "manifest | keygen", required: true },
    {
      name: "path",
      help: "manifest: the static export directory (e.g. out); keygen: the private key file",
    },
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
    {
      name: "sign",
      type: "string",
      valueName: "<keyfile>",
      help: `Sign the manifest with this PKCS#8 PEM key (default: $${OTA_SIGNING_KEY_ENV}, if set)`,
    },
    {
      name: "sequence",
      type: "number",
      valueName: "<n>",
      help:
        "Release sequence (a non-negative integer that only grows; default when signing: the Unix time in seconds)",
    },
    {
      name: "min-native",
      type: "number",
      valueName: "<build>",
      help:
        "Refuse this UI on app binaries whose build number (CFBundleVersion / versionCode) is lower",
    },
    {
      name: "force",
      type: "boolean",
      help:
        "keygen: replace existing key files (breaks OTA for binaries that embed the old public key)",
    },
  ],
  run: async (ctx) => {
    const action = ctx.positionals[0];
    if (action === "manifest") return await otaManifest(ctx);
    if (action === "keygen") return await otaKeygen(ctx);
    fail(`denext ota: unknown action "${action ?? ""}" (expected: manifest, keygen).`);
  },
};

/** Print an add-ota report. */
function printReport(report: AddOtaReport): void {
  const upgraded = new Set(report.upgraded);
  for (const path of report.written) {
    console.log(`  ${upgraded.has(path) ? "upgraded" : "wrote   "}   ${path}`);
  }
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
  if (report.written.some((p) => /\.(swift|java)$/.test(p))) {
    console.log(
      "\n  The native plugin changed: ship a new app binary (the OTA channel only updates the web\n" +
        "  UI). Re-run `denext mobile add-ota` after every denext upgrade.",
    );
  }
  if (report.unsignedPlatforms.length > 0) {
    console.log(
      `\n  Note: no public key embedded (${
        report.unsignedPlatforms.join(", ")
      }), so unsigned OTA only works over https or loopback.`,
    );
  }
}

/**
 * Why `add-ota --public-key` must exit non-zero, or undefined: the key could not be embedded
 * somewhere, or an edited template was kept (it may not verify signatures the way the key
 * implies).
 */
function publicKeyFailure(report: AddOtaReport): string | undefined {
  const reasons = [
    ...report.keyNotEmbedded.map((p) => `the public key could not be embedded in ${p}`),
    ...report.kept.map((p) => `${p} is an edited template that was kept (--force replaces it)`),
  ];
  return reasons.length === 0
    ? undefined
    : `denext mobile add-ota --public-key: not every installed platform will verify signatures:\n    - ${
      reasons.join("\n    - ")
    }`;
}

/** The `--public-key` file's key as base64 SPKI, or undefined without the flag. */
async function publicKeyFlag(ctx: CommandContext): Promise<string | undefined> {
  const file = ctx.flags["public-key"];
  if (typeof file !== "string") return undefined;
  const path = resolve(ctx.global.cwd ?? ".", file);
  try {
    return await parseOtaPublicKey(await Deno.readTextFile(path));
  } catch (err) {
    fail(`denext mobile add-ota: ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `denext mobile add-ota [dir]`. */
async function addOta(ctx: CommandContext): Promise<void> {
  const dir = resolve(ctx.global.cwd ?? ".", ctx.positionals[1] ?? ".");
  const publicKey = await publicKeyFlag(ctx);
  let report: AddOtaReport;
  try {
    report = await addOtaToProject({ dir, force: ctx.flags.force === true, publicKey });
  } catch (err) {
    fail(`denext mobile add-ota: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ctx.global.json) console.log(JSON.stringify(report));
  else {
    console.log(`\n  denext mobile add-ota  ▸  ${dir}\n`);
    printReport(report);
  }
  if (report.skipped.length === 2) {
    fail("\n  denext mobile add-ota: no ios/ or android/ project found.");
  }
  const failure = publicKey === undefined ? undefined : publicKeyFailure(report);
  if (failure !== undefined) fail(`\n  ${failure}`);
}

/** Run a planned command with the terminal attached, resolving its exit code. */
const runInherit: CommandRunner = async ({ cmd, args, cwd }) => {
  const { code } = await new Deno.Command(cmd, {
    args: [...args],
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return { code };
};

/** Print an `add` report (after the commands ran). */
function printAddReport(report: AddCapabilitiesReport): void {
  for (const path of report.written) console.log(`  wrote      ${path}`);
  for (const path of report.unchanged) console.log(`  unchanged  ${path}`);
  for (const note of report.skipped) console.log(`  skipped    ${note}`);
  if (report.plan.notes.length > 0) {
    console.log("\n  Now call from denext/mobile:");
    for (const note of report.plan.notes) console.log(`    - ${note}`);
  }
  console.log("\n  Native plugins changed: ship a new app binary (OTA only updates the web UI).");
}

/** `denext mobile add <capability...>`. */
async function addCapabilities(ctx: CommandContext, run: CommandRunner): Promise<void> {
  if (ctx.flags.list === true) {
    console.log(formatCapabilityTable());
    return;
  }
  const dryRun = ctx.flags["dry-run"] === true;
  const dir = ctx.flags.dir;
  let report: AddCapabilitiesReport;
  try {
    report = await addMobileCapabilities({
      capabilities: ctx.positionals.slice(1),
      cwd: resolve(ctx.global.cwd ?? "."),
      dir: typeof dir === "string" ? dir : undefined,
      dryRun,
      run,
    });
  } catch (err) {
    fail(`denext mobile add: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ctx.global.json) return console.log(JSON.stringify(report));
  if (dryRun) {
    console.log(`\n  denext mobile add --dry-run (nothing changed)\n`);
    console.log(formatCapabilityPlan(report.plan));
    return;
  }
  console.log(`\n  denext mobile add  ▸  ${report.plan.root}\n`);
  printAddReport(report);
}

/**
 * Build the `mobile` verb with `run` as the subprocess runner for `add` (tests pass a fake).
 *
 * @param run Runs `add`'s package install and `cap sync`.
 * @returns The command spec.
 */
export function createMobileCommand(run: CommandRunner = runInherit): CommandSpec {
  return {
    ...mobileCommandSpec,
    run: async (ctx) => {
      const action = ctx.positionals[0];
      if (action === "add-ota") return await addOta(ctx);
      if (action === "add") return await addCapabilities(ctx, run);
      fail(`denext mobile: unknown action "${action ?? ""}" (expected: add, add-ota).`);
    },
  };
}

const mobileCommandSpec: Omit<CommandSpec, "run"> = {
  name: "mobile",
  summary: "Capacitor helpers (add: native capabilities; add-ota: over-the-air UI updates)",
  usage: "  denext mobile add <capability...>\n" +
    "                                Add the Capacitor plugins behind denext/mobile's\n" +
    "                                capability functions, then `npx cap sync`\n" +
    "  denext mobile add --list      List the capabilities and the plugins they install\n" +
    "  denext mobile add-ota [dir]   Install the DenextOta plugin into ios/ and android/\n" +
    "\n" +
    "  add: finds the Capacitor project (the folder with capacitor.config.*: --dir when given,\n" +
    "  with no fallback, else the current directory), refuses when its @capacitor/core major\n" +
    "  is not the one the pinned plugins target, adds the packages with the package manager\n" +
    "  its lockfile names (pnpm, npm, bun or yarn; npm without one), adds any Info.plist keys\n" +
    "  (never replacing yours) and Android permissions the capability needs, and runs\n" +
    "  `npx cap sync`. --dry-run prints the plan and changes nothing. Ship a new app binary\n" +
    "  afterwards.\n" +
    "\n" +
    "  iOS: writes DenextOtaPlugin.swift, DenextOtaStore.swift and DenextBridgeViewController.swift\n" +
    "  into ios/App/App/, adds them to the App target in project.pbxproj, and switches\n" +
    "  Main.storyboard and SceneDelegate to DenextBridgeViewController when they still use\n" +
    "  CAPBridgeViewController. Android: writes dev/denext/ota/*.java and calls\n" +
    "  DenextOta.prepare(this, bridgeBuilder) from a stock MainActivity. Customised files are\n" +
    "  left alone and listed as one-line manual steps. Safe to run again, and run it after every\n" +
    "  denext upgrade: unedited templates from an earlier denext are upgraded in place (ship a\n" +
    "  new app binary afterwards).\n" +
    "\n" +
    "  --public-key ota.key.pub (from `denext ota keygen`) embeds the verifying key as Info.plist\n" +
    "  DenextOtaPublicKey and the dev.denext.ota.PUBLIC_KEY meta-data in AndroidManifest.xml\n" +
    "  (replacing an earlier one); the app then refuses any manifest not signed with its key.\n" +
    "  It exits non-zero when the key cannot be embedded on an installed platform, or an edited\n" +
    "  template was kept.",
  positionals: [
    { name: "action", help: "add | add-ota", required: true },
    {
      name: "args",
      help: "add: capability names (see --list); add-ota: the Capacitor project (default: .)",
      variadic: true,
    },
  ],
  flags: [
    {
      name: "force",
      type: "boolean",
      help: "Replace native template files that differ from denext's (loses local edits)",
    },
    {
      name: "public-key",
      type: "string",
      valueName: "<file>",
      help:
        "Embed this OTA public key (base64 SPKI or PUBLIC KEY PEM) so the app verifies signatures",
    },
    {
      name: "dir",
      type: "string",
      valueName: "<dir>",
      help: "add: the Capacitor project, with no fallback (default: the current directory)",
    },
    {
      name: "dry-run",
      type: "boolean",
      help: "add: print the plan (packages, native config, commands) and change nothing",
    },
    {
      name: "list",
      type: "boolean",
      help: "add: list the capabilities and the plugins they install",
    },
  ],
};

/** The `mobile` verb. */
export const mobileCommand: CommandSpec = createMobileCommand();
