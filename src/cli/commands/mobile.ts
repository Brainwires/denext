// Over-the-air UI updates for Capacitor apps:
//
//   denext ota manifest <dir>     (re)write <dir>/_denext/ota.json for a static export
//                                 (--required / --notes <text> / --sequence <n> /
//                                 --min-native <n> / --native-fingerprint <fp|auto> add release
//                                 metadata, --sign <keyfile> or DENEXT_OTA_SIGNING_KEY signs it,
//                                 stamping a sequence)
//   denext ota keygen <out>       write a P-256 signing key (<out>) and its public key (<out>.pub)
//   denext mobile add-ota [dir]   install the native DenextOta plugin into ios/ + android/
//                                 (--public-key <file> embeds the verifying key,
//                                 --dry-run lists the changes and makes none)
//   denext mobile add <cap...>    add the Capacitor plugins behind denext/mobile's capability
//                                 functions (haptics, share, secure-store, deep-links, push,
//                                 …), their native config, and `cap sync` (--dry-run plans,
//                                 --list lists, --scheme / --domain configure deep-links);
//                                 auth-session installs denext's own DenextAuthSession plugin;
//                                 share-extension / widget / live-activity add app extension
//                                 targets (--app-group, --name, --configurable)
//   denext mobile dev [project]   live reload: start (or attach to) `denext dev`, point the
//                                 Capacitor config's server.url at it for the session and
//                                 `cap copy`; restored on exit (--lan for a physical device)
//   denext mobile fingerprint     hash the native layer (ios/, android/, config, plugins) so CI
//                                 can tell OTA-able changes from binary ones (--json, --diff
//                                 <old.json> explains a change, --write embeds it in the app)
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
  computeNativeFingerprint,
  diffNativeFingerprints,
  type FingerprintInput,
  formatFingerprintDiff,
  isFingerprintDocument,
  writeNativeFingerprint,
} from "../../build/mobile-fingerprint.ts";
import {
  type AddCapabilitiesReport,
  addMobileCapabilities,
  type CommandRunner,
  formatCapabilityPlan,
  formatCapabilityTable,
} from "../../build/mobile-capabilities.ts";
import {
  type MobileDevServer,
  restoreMobileDevSession,
  runMobileDev,
} from "../../build/mobile-dev.ts";
import { pickLanAddress } from "../../build/dev-server/lan.ts";
import { denoExecutable } from "../../build/bundle.ts";
import { cliInvocation } from "../../ui/proc.ts";
import { SHUTDOWN_SIGNALS } from "../shared.ts";

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
        nativeFingerprint: m.nativeFingerprint ?? null,
        signed: m.signature !== undefined,
      }),
    );
    return;
  }
  const extra = (m.required ? ", required" : "") +
    (m.sequence !== undefined ? `, sequence ${m.sequence}` : "") +
    (m.minNative !== undefined ? `, min native ${m.minNative}` : "") +
    (m.nativeFingerprint !== undefined ? `, native ${m.nativeFingerprint.slice(0, 12)}` : "") +
    (m.signature ? ", signed" : "");
  console.log(
    `  wrote ${dirArg}/_denext/ota.json — version ${m.version} (${m.files.length} files${extra})`,
  );
}

/**
 * The `--native-fingerprint` value: the fingerprint as given (64 hex digits), or with `auto` the
 * one computed for the Capacitor project at `--dir` (default: the current directory); undefined
 * without the flag.
 */
async function nativeFingerprintFlag(ctx: CommandContext): Promise<string | undefined> {
  const value = ctx.flags["native-fingerprint"];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail("denext ota manifest: --native-fingerprint needs a value");
  if (value !== "auto") {
    const fp = value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fp)) {
      fail(
        "denext ota manifest: --native-fingerprint takes 64 hex digits (`denext mobile fingerprint`) or `auto`",
      );
    }
    return fp;
  }
  const cwd = ctx.global.cwd ?? ".";
  const dir = resolve(cwd, typeof ctx.flags.dir === "string" ? ctx.flags.dir : ".");
  try {
    return (await computeNativeFingerprint(dir)).fingerprint;
  } catch (err) {
    fail(
      `denext ota manifest --native-fingerprint auto: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
  const nativeFingerprint = await nativeFingerprintFlag(ctx);
  const sign = ctx.flags.sign;
  try {
    // --sign wins; without it DENEXT_OTA_SIGNING_KEY (the PEM contents, for CI) signs.
    const signingKey = await loadOtaSigningKey(
      typeof sign === "string" ? resolve(cwd, sign) : undefined,
    );
    printManifest(
      ctx,
      dir,
      dirArg,
      await writeOtaManifest(
        dir,
        nativeFingerprint === undefined ? meta : { ...meta, nativeFingerprint },
        signingKey,
      ),
    );
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
    "  denext ota manifest out --native-fingerprint auto --dir .\n" +
    "                              Also stamp the native fingerprint of the Capacitor project at\n" +
    "                              --dir; a binary embedding another one (`denext mobile\n" +
    "                              fingerprint --write`) refuses it (code native_mismatch)\n" +
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
      name: "native-fingerprint",
      type: "string",
      valueName: "<fp|auto>",
      help:
        "Stamp the native fingerprint this UI was built for (auto: compute it for --dir); binaries embedding another refuse it",
    },
    {
      name: "dir",
      type: "string",
      valueName: "<dir>",
      help:
        "manifest --native-fingerprint auto: the Capacitor project (default: the current directory)",
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

/** Print an add-ota report; a dry run's lists say what a real run would do, and stop there. */
function printReport(report: AddOtaReport, dryRun: boolean): void {
  const upgraded = new Set(report.upgraded);
  const [upgrade, write] = dryRun ? ["would upgrade", "would write  "] : ["upgraded", "wrote   "];
  for (const path of report.written) {
    console.log(`  ${upgraded.has(path) ? upgrade : write}   ${path}`);
  }
  for (const path of report.unchanged) console.log(`  unchanged  ${path}`);
  for (const note of report.skipped) console.log(`  skipped    ${note}`);
  if (report.manual.length > 0) {
    console.log(dryRun ? "\n  By hand:" : "\n  Still to do by hand:");
    for (const note of report.manual) console.log(`    - ${note}`);
  }
  if (dryRun) return;
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
  const dryRun = ctx.flags["dry-run"] === true;
  let report: AddOtaReport;
  try {
    report = await addOtaToProject({ dir, force: ctx.flags.force === true, publicKey, dryRun });
  } catch (err) {
    fail(`denext mobile add-ota: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ctx.global.json) console.log(JSON.stringify(dryRun ? { ...report, dryRun } : report));
  else {
    console.log(
      dryRun
        ? `\n  denext mobile add-ota --dry-run (nothing changed)  ▸  ${dir}\n`
        : `\n  denext mobile add-ota  ▸  ${dir}\n`,
    );
    printReport(report, dryRun);
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
  for (const warning of report.plan.warnings) console.log(`\n  WARNING: ${warning}`);
  const manual = [...report.plan.manual, ...report.manual];
  if (manual.length > 0) {
    console.log("\n  Still to do by hand:");
    for (const step of manual) console.log(`    - ${step}`);
  }
  if (report.plan.notes.length > 0) {
    console.log("\n  Now call from denext/mobile:");
    for (const note of report.plan.notes) console.log(`    - ${note}`);
  }
  console.log("\n  Native plugins changed: ship a new app binary (OTA only updates the web UI).");
}

/** A comma-separated list flag (`--scheme a,b`) as its trimmed, non-empty items. */
function listFlag(value: string | number | boolean | undefined): string[] {
  return typeof value === "string" ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
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
      schemes: listFlag(ctx.flags.scheme),
      domains: listFlag(ctx.flags.domain),
      appGroups: listFlag(ctx.flags["app-group"]),
      names: listFlag(ctx.flags.name),
      configurable: listFlag(ctx.flags.configurable),
      force: ctx.flags.force === true,
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

/** Whether anything answers HTTP at `url` within a second. */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: "manual" });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/**
 * The host `mobile dev` binds and the URL the device loads. `--lan` binds the LAN IPv4; else
 * `--host` (a wildcard bind is advertised by the LAN IPv4); else loopback, which only the iOS
 * simulator (or Android behind `adb reverse`) can reach.
 */
function mobileDevTarget(ctx: CommandContext): { host: string; url: string } {
  const port = typeof ctx.flags.port === "number" ? ctx.flags.port : 3000;
  const flagHost = typeof ctx.flags.host === "string" ? ctx.flags.host : undefined;
  if (ctx.flags.lan === true && flagHost !== undefined) {
    fail("denext mobile dev: --lan picks the address itself; drop --host.");
  }
  const lan = ctx.flags.lan === true || flagHost === "0.0.0.0" ? pickLanAddress() : null;
  if (ctx.flags.lan === true && !lan) {
    fail("denext mobile dev --lan: this machine has no LAN IPv4 address (is Wi-Fi on?).");
  }
  const host = ctx.flags.lan === true ? lan! : flagHost ?? "localhost";
  const shown = host === "0.0.0.0" ? lan ?? "127.0.0.1" : host;
  return { host, url: `http://${shown.includes(":") ? `[${shown}]` : shown}:${port}` };
}

/**
 * Start `denext dev` for the project on the target host and port (strict, so the URL is
 * known), or attach to a server already answering there. Polls until it answers.
 */
async function startOrAttachDev(ctx: CommandContext): Promise<MobileDevServer> {
  const { host, url } = mobileDevTarget(ctx);
  const port = new URL(url).port;
  if (await answers(url)) {
    return { url, attached: true, finished: new Promise(() => {}), stop: () => Promise.resolve() };
  }
  const project = resolve(ctx.global.cwd ?? ".", ctx.positionals[1] ?? ".");
  const child = new Deno.Command(denoExecutable(), {
    args: [...cliInvocation({ dir: project }), "dev", project, "--host", host, "--port", port],
    cwd: project,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  let exited = false;
  const finished = child.status.then(() => void (exited = true));
  const stop = async () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
    await child.status;
  };
  for (const deadline = Date.now() + 120_000; !(await answers(url));) {
    if (exited || Date.now() > deadline) {
      await stop();
      throw new Error(`the dev server did not come up at ${url}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { url, attached: false, finished, stop };
}

/** Resolves on the first Ctrl-C / SIGTERM (and stops listening). */
function waitForShutdownSignal(): Promise<void> {
  return new Promise((done) => {
    const handler = () => {
      for (const signal of SHUTDOWN_SIGNALS) Deno.removeSignalListener(signal, handler);
      done();
    };
    for (const signal of SHUTDOWN_SIGNALS) Deno.addSignalListener(signal, handler);
  });
}

/** `denext mobile dev [project]` (and `--restore`). */
async function mobileDev(ctx: CommandContext, run: CommandRunner): Promise<void> {
  const cwd = resolve(ctx.global.cwd ?? ".");
  const dir = typeof ctx.flags.dir === "string" ? ctx.flags.dir : undefined;
  try {
    if (ctx.flags.restore === true) {
      await restoreMobileDevSession(resolve(cwd, dir ?? "."), {
        run,
        log: (line) => console.log(line),
      });
      return;
    }
    await runMobileDev({ cwd, dir }, {
      run,
      startServer: () => startOrAttachDev(ctx),
      waitForStop: waitForShutdownSignal,
      log: (line) => console.log(line),
    });
  } catch (err) {
    fail(`denext mobile dev: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The Capacitor project `mobile fingerprint` reads: `--dir`, else the positional, else `.`. */
function fingerprintRoot(ctx: CommandContext): string {
  const dir = typeof ctx.flags.dir === "string" ? ctx.flags.dir : ctx.positionals[1] ?? ".";
  return resolve(ctx.global.cwd ?? ".", dir);
}

/** The `--diff` file's earlier `--json` document. */
async function previousFingerprint(
  ctx: CommandContext,
  file: string,
): Promise<{ fingerprint: string; inputs: FingerprintInput[] }> {
  const path = resolve(ctx.global.cwd ?? ".", file);
  let doc: unknown;
  try {
    doc = JSON.parse(await Deno.readTextFile(path));
  } catch (err) {
    fail(`denext mobile fingerprint --diff: ${path}: ${err instanceof Error ? err.message : err}`);
  }
  if (!isFingerprintDocument(doc)) {
    fail(
      `denext mobile fingerprint --diff: ${path} is not a \`denext mobile fingerprint --json\` document`,
    );
  }
  return doc;
}

/** Print each dependency warning to stderr. */
function printWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) console.error(`  warning: ${warning}`);
}

/** `denext mobile fingerprint --write`: embed it, then report what changed. */
async function writeFingerprint(ctx: CommandContext, root: string): Promise<void> {
  const report = await writeNativeFingerprint(root);
  printWarnings(report.warnings);
  if (ctx.global.json) return console.log(JSON.stringify(report));
  for (const path of report.written) console.log(`  wrote      ${path}`);
  for (const path of report.unchanged) console.log(`  unchanged  ${path}`);
  for (const note of report.skipped) console.log(`  skipped    ${note}`);
  console.log(`\n  native fingerprint ${report.fingerprint}`);
}

/** `denext mobile fingerprint [--diff <old.json>]`: the fingerprint, its inputs, or a diff. */
async function printFingerprint(ctx: CommandContext, root: string): Promise<void> {
  const current = await computeNativeFingerprint(root);
  printWarnings(current.warnings);
  const doc = { fingerprint: current.fingerprint, inputs: current.inputs };
  const diffFile = ctx.flags.diff;
  if (typeof diffFile !== "string") {
    return console.log(ctx.global.json ? JSON.stringify(doc) : current.fingerprint);
  }
  const diff = diffNativeFingerprints(await previousFingerprint(ctx, diffFile), doc);
  console.log(ctx.global.json ? JSON.stringify(diff) : formatFingerprintDiff(diff));
}

/** `denext mobile fingerprint [--dir] [--json] [--diff <old.json>] [--write]`. */
async function mobileFingerprint(ctx: CommandContext): Promise<void> {
  const root = fingerprintRoot(ctx);
  try {
    if (ctx.flags.write === true) await writeFingerprint(ctx, root);
    else await printFingerprint(ctx, root);
  } catch (err) {
    fail(`denext mobile fingerprint: ${err instanceof Error ? err.message : String(err)}`);
  }
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
      if (action === "dev") return await mobileDev(ctx, run);
      if (action === "fingerprint") return await mobileFingerprint(ctx);
      fail(
        `denext mobile: unknown action "${
          action ?? ""
        }" (expected: add, add-ota, dev, fingerprint).`,
      );
    },
  };
}

const mobileCommandSpec: Omit<CommandSpec, "run"> = {
  name: "mobile",
  summary:
    "Capacitor helpers (add: native capabilities; add-ota: over-the-air UI updates; dev: live reload; fingerprint: native-layer hash)",
  usage: "  denext mobile add <capability...>\n" +
    "                                Add the Capacitor plugins behind denext/mobile's\n" +
    "                                capability functions, then `npx cap sync`\n" +
    "  denext mobile add deep-links --scheme myapp --domain app.example.com\n" +
    "                                Register a URL scheme and universal / app link domains\n" +
    "  denext mobile add push        Push notifications (entitlement, AppDelegate, permission)\n" +
    "  denext mobile add auth-session --scheme myapp\n" +
    "                                OAuth in a system browser sheet (openAuthSession)\n" +
    "  denext mobile add share-extension --app-group group.com.example.app\n" +
    "                                Receive shared links, text and images (onShareReceived)\n" +
    "  denext mobile add widget --name Status\n" +
    "                                A home-screen widget fed by setWidgetData\n" +
    "  denext mobile add widget --name Usage --configurable period:enum=session|weekly\n" +
    "                                An iOS 17+ configurable widget (App Intents enum)\n" +
    "  denext mobile add live-activity --name Delivery\n" +
    "                                An iOS Live Activity (startLiveActivity)\n" +
    "  denext mobile add --list      List the capabilities and the plugins they install\n" +
    "  denext mobile add-ota [dir]   Install the DenextOta plugin into ios/ and android/\n" +
    "  denext mobile dev [project] --lan\n" +
    "                                Live reload on a device: point the app at `denext dev`\n" +
    "  denext mobile fingerprint --json > native.json\n" +
    "                                Hash the native layer (OTA-able vs needs a binary)\n" +
    "  denext mobile fingerprint --diff native.json\n" +
    "                                Explain which native inputs changed since native.json\n" +
    "  denext mobile fingerprint --write\n" +
    "                                Embed it in Info.plist + AndroidManifest (OTA gate)\n" +
    "\n" +
    "  fingerprint: SHA-256 over the ios/ and android/ sources (minus build output, Pods,\n" +
    "  .gradle, xcuserdata, local.properties and what `cap sync` copies in; text with CRLF\n" +
    "  normalised), capacitor.config.* without its server block, and the installed versions of\n" +
    "  @capacitor/* and every Capacitor / Cordova plugin package.json declares. The same\n" +
    "  fingerprint means the change can ship over the air; a different one needs a new binary.\n" +
    "  --write stores it as Info.plist DenextNativeFingerprint and the\n" +
    "  dev.denext.native.FINGERPRINT meta-data (never changing the value itself); a manifest\n" +
    "  stamped with `denext ota manifest --native-fingerprint` is then refused by a binary with\n" +
    "  another one (code native_mismatch).\n" +
    "\n" +
    "  dev: starts `denext dev` for [project] (default: .) on --port (default 3000), or attaches\n" +
    "  to a server already answering there; writes server: { url, cleartext: true } into the\n" +
    "  Capacitor project's capacitor.config.* (--dir, else the current directory) and runs\n" +
    "  `npx cap copy`, so the app loads the dev server and reloads on every edit. --lan binds\n" +
    "  the LAN IPv4 (a physical device on the same network); without it the URL is\n" +
    "  localhost (the iOS simulator, or Android behind `adb reverse`). On iOS it also adds\n" +
    "  NSAppTransportSecurity > NSAllowsLocalNetworking and (when absent) an\n" +
    "  NSLocalNetworkUsageDescription to ios/App/App/Info.plist, without which the WebView\n" +
    "  never reaches a LAN server; a changed Info.plist needs a rebuild from Xcode. The edits\n" +
    "  are temporary: Ctrl-C, SIGTERM or an error puts the original bytes back and runs\n" +
    "  `cap copy` again. A killed run leaves a backup in .denext/; the next `mobile dev`, or\n" +
    "  `mobile dev --restore`, restores it first. The restore also takes the dev URL out of\n" +
    "  the native config copies itself, so they are clean even when `cap copy` fails because\n" +
    "  the webDir was never built (export and `npx cap copy` before a release build).\n" +
    "\n" +
    "  add: finds the Capacitor project (the folder with capacitor.config.*: --dir when given,\n" +
    "  with no fallback, else the current directory), refuses when its @capacitor/core major\n" +
    "  is not the one the pinned plugins target, adds the packages with the package manager\n" +
    "  the nearest lockfile names (pnpm, npm, bun or yarn, looking up to the repository root\n" +
    "  for a workspace's; else a packageManager field; else npm) as caret ranges, or as exact\n" +
    "  versions (the range's minimum) when package.json pins every @capacitor/* package\n" +
    "  exactly, adds any Info.plist keys (never replacing yours) and Android permissions the\n" +
    "  capability needs, and runs `npx cap sync`. --dry-run prints the plan and changes\n" +
    "  nothing. Ship a new app binary afterwards.\n" +
    "\n" +
    "  deep-links takes --scheme (CFBundleURLTypes + a VIEW intent filter) and --domain\n" +
    "  (applinks: in the entitlements + an autoVerify https intent filter); give several as\n" +
    "  a comma-separated list. The domains must also serve apple-app-site-association and\n" +
    "  assetlinks.json. push writes aps-environment (development) into the entitlements, the\n" +
    "  token forwarding into AppDelegate.swift and POST_NOTIFICATIONS into the manifest, and\n" +
    "  warns when android/app/google-services.json (FCM) is missing. A new entitlements file\n" +
    "  (ios/App/App/App.entitlements) must be selected in Xcode (Code Signing Entitlements);\n" +
    "  the steps left to do by hand are printed.\n" +
    "\n" +
    "  auth-session has no npm package: it writes denext's DenextAuthSession plugin\n" +
    "  (ios/App/App/DenextAuthSessionPlugin.swift, an ASWebAuthenticationSession sheet, added to\n" +
    "  the App target; android dev/denext/authsession/*.java, a Custom Tab) and registers it\n" +
    "  through DenextBridgeViewController and MainActivity, which it shares with add-ota (either\n" +
    "  order works). --scheme registers the OAuth callback scheme as deep-links does; Android\n" +
    "  needs it to receive the redirect. No install or `cap sync` runs for it alone.\n" +
    "\n" +
    "  share-extension, widget and live-activity add app extensions (no npm package either).\n" +
    "  share-extension: an iOS Share Extension target (ios/App/DenextShareExtension, embedded in\n" +
    "  the app) that queues shares in the App Group container and opens the app with its URL\n" +
    "  scheme (--scheme, else the app's first CFBundleURLSchemes entry), and Android SEND /\n" +
    "  SEND_MULTIPLE intent filters. widget --name <Name>: a WidgetKit extension target\n" +
    "  (ios/App/DenextWidgets) with <Name>Widget.swift, and an Android AppWidgetProvider with its\n" +
    "  layout and manifest receiver. --configurable <param:enum=a|b,...> makes it configurable on\n" +
    "  iOS 17+ (an App Intents enum per parameter; static on 14-16 and on Android), and\n" +
    "  setWidgetData(kind, data, { params }) stores the snapshot for the chosen values.\n" +
    "  live-activity --name <Name> (iOS 16.1+, the app keeps its\n" +
    "  deployment target): an ActivityKit UI in the same extension and NSSupportsLiveActivities.\n" +
    "  Each writes a denext plugin into the app, and the App Group (--app-group, default\n" +
    "  group.<bundle id>) into the app's and the extension's entitlements; the group must exist\n" +
    "  in the Apple Developer portal (automatic signing usually registers it). Several names are\n" +
    "  comma-separated. The widget and Live Activity views are yours to edit: an edited file is\n" +
    "  kept on the next run.\n" +
    "\n" +
    "  iOS: writes DenextOtaPlugin.swift, DenextOtaStore.swift and DenextBridgeViewController.swift\n" +
    "  into ios/App/App/, adds them to the App target in project.pbxproj, and switches\n" +
    "  Main.storyboard and SceneDelegate to DenextBridgeViewController when they still use\n" +
    "  CAPBridgeViewController. Android: writes dev/denext/ota/*.java and calls\n" +
    "  DenextOta.prepare(this, bridgeBuilder) from MainActivity, when it is the stock one or one\n" +
    "  denext generated (recognised by its marker line, or as a shape an earlier denext shipped).\n" +
    "  Customised files are left alone and listed as one-line manual steps, as are a MainActivity\n" +
    "  or bridge view controller a newer denext wrote (never downgraded). Safe to run again, and\n" +
    "  run it after every denext upgrade: unedited templates from an earlier denext are upgraded\n" +
    "  in place (ship a new app binary afterwards).\n" +
    "\n" +
    "  --public-key ota.key.pub (from `denext ota keygen`) embeds the verifying key as Info.plist\n" +
    "  DenextOtaPublicKey and the dev.denext.ota.PUBLIC_KEY meta-data in AndroidManifest.xml\n" +
    "  (replacing an earlier one); the app then refuses any manifest not signed with its key.\n" +
    "  It exits non-zero when the key cannot be embedded on an installed platform, or an edited\n" +
    "  template was kept. --dry-run lists what it would write, upgrade or keep and changes\n" +
    "  nothing.",
  positionals: [
    { name: "action", help: "add | add-ota | dev | fingerprint", required: true },
    {
      name: "args",
      help:
        "add: capability names (see --list); add-ota, fingerprint: the Capacitor project (default: .); dev: the denext project (default: .)",
      variadic: true,
    },
  ],
  flags: [
    {
      name: "force",
      type: "boolean",
      help:
        "Replace native template files that differ from denext's (loses local edits; add-ota, add auth-session / share-extension / widget / live-activity)",
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
      help:
        "add, dev, fingerprint: the Capacitor project, with no fallback (default: the current directory)",
    },
    {
      name: "diff",
      type: "string",
      valueName: "<old.json>",
      help: "fingerprint: explain which inputs changed since an earlier `fingerprint --json`",
    },
    {
      name: "write",
      type: "boolean",
      help:
        "fingerprint: embed it in Info.plist (DenextNativeFingerprint) and AndroidManifest (dev.denext.native.FINGERPRINT)",
    },
    {
      name: "lan",
      type: "boolean",
      help: "dev: serve on the LAN IPv4 so a physical device on the network can load it",
    },
    {
      name: "port",
      alias: "p",
      type: "number",
      valueName: "<port>",
      help: "dev: the dev server port (default: 3000)",
    },
    {
      name: "host",
      type: "string",
      valueName: "<host>",
      help: "dev: the host to bind and load (default: localhost; --lan picks the LAN IPv4)",
    },
    {
      name: "restore",
      type: "boolean",
      help:
        "dev: only put back what an interrupted session left (capacitor.config, Info.plist, the " +
        "dev URL in the native config copies), then run `cap copy`",
    },
    {
      name: "dry-run",
      type: "boolean",
      help:
        "add, add-ota: print the plan (packages, native files, config, commands) and change nothing",
    },
    {
      name: "list",
      type: "boolean",
      help: "add: list the capabilities and the plugins they install",
    },
    {
      name: "scheme",
      type: "string",
      valueName: "<scheme[,scheme]>",
      help:
        "add deep-links / auth-session / share-extension: custom URL schemes to register (comma-separated)",
    },
    {
      name: "domain",
      type: "string",
      valueName: "<host[,host]>",
      help: "add deep-links: universal link / app link domains (comma-separated)",
    },
    {
      name: "app-group",
      type: "string",
      valueName: "<group>",
      help:
        "add share-extension / widget / live-activity: the App Group shared with the extension (default: group.<bundle id>)",
    },
    {
      name: "name",
      type: "string",
      valueName: "<Name[,Name]>",
      help: "add widget / live-activity: PascalCase names (comma-separated)",
    },
    {
      name: "configurable",
      type: "string",
      valueName: "<param:enum=a|b[,…]>",
      help:
        "add widget: iOS 17+ configurable widget with these enum parameters (the first value is the default; re-runs keep them)",
    },
  ],
};

/** The `mobile` verb. */
export const mobileCommand: CommandSpec = createMobileCommand();
