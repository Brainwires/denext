// Over-the-air UI updates for Capacitor apps:
//
//   denext ota manifest <dir>     (re)write <dir>/_denext/ota.json for a static export
//                                 (--required / --notes <text> add release metadata,
//                                 --sign <keyfile> or DENEXT_OTA_SIGNING_KEY signs it)
//   denext ota keygen <out>       write a P-256 signing key (<out>) and its public key (<out>.pub)
//   denext mobile add-ota [dir]   install the native DenextOta plugin into ios/ + android/
//                                 (--public-key <file> embeds the verifying key)
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
        signed: m.signature !== undefined,
      }),
    );
    return;
  }
  const extra = (m.required ? ", required" : "") + (m.signature ? ", signed" : "");
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
  const meta = {
    ...(ctx.flags.required === true ? { required: true } : {}),
    ...(typeof ctx.flags.notes === "string" ? { notes: ctx.flags.notes } : {}),
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

/** Remove `path` if it exists. */
async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
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
  for (const path of [out, pub]) {
    if (!force && await exists(path)) {
      fail(`denext ota keygen: ${path} already exists (pass --force to replace it).`);
    }
  }
  try {
    const { privateKeyPem, publicKey } = await generateOtaKeyPair();
    // Created fresh with 0600, never written into an existing (maybe wider) file.
    await removeIfPresent(out);
    await Deno.writeTextFile(out, privateKeyPem, { createNew: true, mode: 0o600 });
    await removeIfPresent(pub);
    await Deno.writeTextFile(pub, publicKey + "\n", { createNew: true });
    if (ctx.global.json) {
      console.log(JSON.stringify({ privateKey: out, publicKeyFile: pub, publicKey }));
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
    "                              Also sign it (or set " + OTA_SIGNING_KEY_ENV + " to the PEM)\n" +
    "  denext ota keygen ota.key   Write a P-256 signing key (0600) and ota.key.pub\n" +
    "\n" +
    "  Run it after anything that changes the export (e.g. swapping brand icons in), and before\n" +
    "  `cap sync`, so the bundled UI and the served UI carry the right version. `spa.ota: true`\n" +
    "  makes `denext export` write it for you. `*.gz` files are never listed. `--required` and\n" +
    "  `--notes` feed the app's own update prompt (prepareUiUpdate in denext/mobile); they are\n" +
    "  not part of the version, but the signature covers them. An app whose binary embeds the\n" +
    "  public key (`denext mobile add-ota --public-key ota.key.pub`) refuses an unsigned or\n" +
    "  wrongly signed manifest; one without a key refuses plain http beyond loopback.",
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
      name: "force",
      type: "boolean",
      help: "keygen: replace existing key files",
    },
  ],
  run: async (ctx) => {
    const action = ctx.positionals[0];
    if (action === "manifest") return await otaManifest(ctx);
    if (action === "keygen") return await otaKeygen(ctx);
    fail(`denext ota: unknown action "${action ?? ""}" (expected: manifest, keygen).`);
  },
};

/** Print an add-ota report (`signed`: a public key was embedded). */
function printReport(report: AddOtaReport, signed: boolean): void {
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
  if (!signed) {
    console.log(
      "\n  Note: no --public-key, so unsigned OTA only works over https or loopback.",
    );
  }
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
  if (ctx.global.json) return console.log(JSON.stringify(report));
  console.log(`\n  denext mobile add-ota  ▸  ${dir}\n`);
  printReport(report, publicKey !== undefined);
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
    "  left alone and listed as one-line manual steps. Safe to run again.\n" +
    "\n" +
    "  --public-key ota.key.pub (from `denext ota keygen`) embeds the verifying key as Info.plist\n" +
    "  DenextOtaPublicKey and the dev.denext.ota.PUBLIC_KEY meta-data in AndroidManifest.xml\n" +
    "  (replacing an earlier one); the app then refuses any manifest not signed with its key.",
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
    {
      name: "public-key",
      type: "string",
      valueName: "<file>",
      help:
        "Embed this OTA public key (base64 SPKI or PUBLIC KEY PEM) so the app verifies signatures",
    },
  ],
  run: async (ctx) => {
    const action = ctx.positionals[0];
    if (action === "add-ota") return await addOta(ctx);
    fail(`denext mobile: unknown action "${action ?? ""}" (expected: add-ota).`);
  },
};
