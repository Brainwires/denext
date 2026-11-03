// Over-the-air UI updates for Capacitor apps:
//
//   denext ota manifest <dir>     (re)write <dir>/_denext/ota.json for a static export
//                                 (--required / --notes <text> / --sequence <n> /
//                                 --min-native <n> / --native-fingerprint <fp|auto> /
//                                 --expires-in <days> / --expires-at <rfc3339> add release
//                                 metadata, --sign <keyfile> or DENEXT_OTA_SIGNING_KEY signs it,
//                                 stamping a sequence and a 30-day expiry)
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
//                                 targets (--app-group, --name, --configurable); fastlane
//                                 writes fastlane/ lanes over `mobile build` (--ci: a workflow)
//   denext mobile dev [project]   live reload: start (or attach to) `denext dev`, point the
//                                 Capacitor config's server.url at it for the session and
//                                 `cap copy`; restored on exit (--lan for a physical device)
//   denext mobile fingerprint     hash the native layer (ios/, android/, config, plugins) so CI
//                                 can tell OTA-able changes from binary ones (--json, --diff
//                                 <old.json> explains a change, --write embeds it in the app)
//   denext mobile privacy | doctor --store|--release | inspect
//                                 privacy manifest, App Review / release checks, device inspector
//                                 (./mobile-store.ts)
//   denext mobile assets | build ios|android | submit ios|android
//                                 icons + splash, store builds, store uploads (./mobile-build.ts)
//
// Both are flat verbs whose first positional selects the action (as `desktop` does). Neither
// loads the project's modules: `ota manifest` only hashes files, and `add-ota` only writes
// native sources and edits the Xcode project, storyboard, Info.plist, AndroidManifest and
// MainActivity as text.

import { parsePlatform, scanPlatformGroups } from "../../build/platform-extensions.ts";
import { relative, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { defaultOtaExpiry, readPlatformStamp, writeOtaManifest } from "../../build/ota-manifest.ts";
import { otaAppIdFor } from "../../build/ota-app-id.ts";
import { parseRfc3339 } from "../../build/app-update.ts";
import { isOtaAppId, type OtaManifest } from "../../mobile/ota-manifest.ts";
import {
  generateOtaKeyPair,
  loadOtaSigningKey,
  parseOtaPublicKey,
} from "../../build/ota-signing.ts";
import {
  type AddOtaReport,
  addOtaToProject,
  parseOtaOrigins,
} from "../../build/mobile-ota-install.ts";
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
  findProject,
  formatCapabilityPlan,
  formatCapabilityTable,
} from "../../build/mobile-capabilities.ts";
import { logStabilized } from "../../build/mobile-build.ts";
import { assertCapacitorCli, capCommand } from "../../build/capacitor-cli.ts";
import { type NpmPublishTimes, npmRegistryPublishTimes } from "../../build/npm-pin-age.ts";
import { nativeText } from "../../build/capacitor-native-dirs.ts";
import { stabilizeSpmPluginPaths } from "../../build/spm-plugin-paths.ts";
import {
  type MobileDevServer,
  restoreMobileDevSession,
  runMobileDev,
} from "../../build/mobile-dev.ts";
import { pickLanAddress } from "../../build/dev-server/lan.ts";
import { startOrAttachDevServer, waitForShutdownSignal } from "../dev-attach.ts";
import { otaChannel, otaPromote } from "./ota-channels.ts";
import { mobileDoctor, mobileInspect, mobilePrivacy } from "./mobile-store.ts";
import {
  mobileAssets,
  mobileBuild,
  mobileBuildLocks,
  mobileSubmit,
  runInheritedCommand,
} from "./mobile-build.ts";
import { commandMeta } from "../command-meta.ts";

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
        expiresAt: m.expiresAt ?? null,
        platform: m.platform ?? null,
        appId: m.appId ?? null,
        signed: m.signature !== undefined,
      }),
    );
    return;
  }
  const extra = manifestDetails(m).map((d) => `, ${d}`).join("");
  console.log(
    `  wrote ${dirArg}/_denext/ota.json — version ${m.version} (${m.files.length} files${extra})`,
  );
}

/** The release metadata of `m` worth a mention on the summary line, each as a short phrase. */
function manifestDetails(m: OtaManifest): string[] {
  const expires = (at: number) => new Date(at * 1000).toISOString().replace(/\.000Z$/, "Z");
  const details: Array<string | false | undefined> = [
    m.required && "required",
    m.sequence !== undefined && `sequence ${m.sequence}`,
    m.minNative !== undefined && `min native ${m.minNative}`,
    m.nativeFingerprint !== undefined && `native ${m.nativeFingerprint.slice(0, 12)}`,
    m.expiresAt !== undefined && `expires ${expires(m.expiresAt)}`,
    m.platform !== undefined && `platform ${m.platform}`,
    m.appId !== undefined && `app ${m.appId}`,
    m.signature !== undefined && "signed",
  ];
  return details.filter((d): d is string => typeof d === "string");
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

/**
 * `--expires-in <days>` / `--expires-at <RFC 3339>` as the manifest's `expiresAt` (Unix seconds);
 * `{}` without either (a signed manifest then gets the 30-day default). Exits when both are given,
 * when the value does not parse, or when it is not in the future.
 */
export function expiryFlags(
  flags: Readonly<Record<string, unknown>>,
  now: number = Date.now(),
): { expiresAt?: number } | string {
  const days = flags["expires-in"];
  const at = flags["expires-at"];
  if (days !== undefined && at !== undefined) return "pass --expires-in or --expires-at, not both";
  let expiresAt: number | undefined;
  if (days !== undefined) {
    if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
      return "--expires-in takes a positive number of days";
    }
    expiresAt = defaultOtaExpiry(now, days);
  } else if (at !== undefined) {
    const ms = typeof at === "string" ? parseRfc3339(at) : null;
    if (ms === null) return "--expires-at takes an RFC 3339 time, e.g. 2026-12-31T00:00:00Z";
    expiresAt = Math.floor(ms / 1000);
  } else {
    return {};
  }
  if (expiresAt * 1000 <= now) return "the expiry must be in the future";
  return { expiresAt };
}

/** `--platform <target>` as manifest metadata; exits on an unknown target. */
function platformFlag(ctx: CommandContext): { platform?: string } {
  const value = ctx.flags.platform;
  if (value === undefined) return {};
  try {
    return { platform: parsePlatform(typeof value === "string" ? value : "", "--platform") };
  } catch (err) {
    fail(`denext ota manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Warn when a manifest names no target (a `web` export, which every shell accepts) for an app
 * whose platform files differ between targets: each shell then runs the web files instead of
 * its own. The project is `--dir`, else the current directory.
 */
async function warnUnstampedExport(ctx: CommandContext): Promise<void> {
  const cwd = ctx.global.cwd ?? ".";
  const project = resolve(cwd, typeof ctx.flags.dir === "string" ? ctx.flags.dir : ".");
  const groups = await scanPlatformGroups(project).catch(() => []);
  const specific = groups.filter((g) => g.variants.some((v) => v.suffix !== "web"));
  if (specific.length === 0) return;
  console.error(
    `  warning: this export names no target, so every shell accepts it, but ${specific.length} ` +
      `module(s) have platform files (${relative(project, specific[0].stem)}, …): a shell ` +
      "would run the web files. Serve each shell its own export (`denext export --platform " +
      "ios`, then `denext ota manifest`), e.g. with `createOtaHandler({ platforms })`.",
  );
}

/**
 * The manifest's `appId`: `--app-id` as given; without it, for a signed manifest only, the app id
 * of the export's target ({@linkcode otaAppIdFor}: `DENEXT_OTA_APP_ID`, else the Capacitor `appId`
 * of `--dir` for an `ios` / `android` export). Unsigned manifests get none unless asked for.
 */
async function appIdFlag(
  ctx: CommandContext,
  dir: string,
  platform: string | undefined,
  signing: boolean,
): Promise<{ appId?: string }> {
  const value = ctx.flags["app-id"];
  if (value !== undefined) {
    if (!isOtaAppId(value)) {
      fail(
        "denext ota manifest: --app-id takes the app's id (A-Z a-z 0-9 . _ -, e.g. com.example.app)",
      );
    }
    return { appId: value };
  }
  if (!signing) return {};
  const cwd = ctx.global.cwd ?? ".";
  const project = resolve(cwd, typeof ctx.flags.dir === "string" ? ctx.flags.dir : ".");
  const appId = await otaAppIdFor(project, platform ?? await readPlatformStamp(dir));
  return appId === undefined ? {} : { appId };
}

/**
 * The warnings a written manifest may call for: signed without naming its app, or naming no
 * target for an app with platform files.
 */
async function warnAboutManifest(ctx: CommandContext, manifest: OtaManifest): Promise<void> {
  if (manifest.signature !== undefined && manifest.appId === undefined) {
    console.error(
      "  warning: this signed manifest names no app: app binaries that embed the public key " +
        "(and Deno Desktop overlays with desktop.app.identifier) refuse it (code " +
        "app_mismatch). Pass --app-id <bundle id / application id / desktop.app.identifier>.",
    );
  }
  // `--platform web` asked for the unstamped export every shell takes.
  if (manifest.platform === undefined && ctx.flags.platform !== "web") {
    await warnUnstampedExport(ctx);
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
  // A signed manifest gets a sequence (the Unix time) unless --sequence sets one, and an expiry
  // (30 days) unless --expires-in / --expires-at sets one.
  const expiry = expiryFlags(ctx.flags);
  if (typeof expiry === "string") fail(`denext ota manifest: ${expiry}`);
  const meta = {
    ...expiry,
    ...(ctx.flags.required === true ? { required: true } : {}),
    ...(typeof ctx.flags.notes === "string" ? { notes: ctx.flags.notes } : {}),
    ...(typeof ctx.flags.sequence === "number" ? { sequence: ctx.flags.sequence } : {}),
    ...(typeof ctx.flags["min-native"] === "number" ? { minNative: ctx.flags["min-native"] } : {}),
    ...platformFlag(ctx),
  };
  const nativeFingerprint = await nativeFingerprintFlag(ctx);
  const sign = ctx.flags.sign;
  try {
    // --sign wins; without it DENEXT_OTA_SIGNING_KEY (the PEM contents, for CI) signs.
    const signingKey = await loadOtaSigningKey(
      typeof sign === "string" ? resolve(cwd, sign) : undefined,
    );
    const appId = await appIdFlag(ctx, dir, meta.platform, signingKey !== undefined);
    const manifest = await writeOtaManifest(
      dir,
      { ...meta, ...appId, ...(nativeFingerprint === undefined ? {} : { nativeFingerprint }) },
      signingKey,
    );
    printManifest(ctx, dir, dirArg, manifest);
    await warnAboutManifest(ctx, manifest);
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
  ...commandMeta("ota"),
  run: async (ctx) => {
    const action = ctx.positionals[0];
    if (action === "manifest") return await otaManifest(ctx);
    if (action === "keygen") return await otaKeygen(ctx);
    if (action === "channel") return await otaChannel(ctx);
    if (action === "promote") return await otaPromote(ctx);
    fail(
      `denext ota: unknown action "${
        action ?? ""
      }" (expected: manifest, keygen, channel, promote).`,
    );
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
  if (report.unpinnedPlatforms.length > 0) {
    console.log(
      `\n  Note: no public key embedded and no origin pinned (${
        report.unpinnedPlatforms.join(", ")
      }), so OTA accepts an update from loopback only, and only in a debug build: pass\n` +
        "  --public-key, or --ota-origin https://<your OTA server> to accept unsigned updates from it.",
    );
  } else if (report.unsignedPlatforms.length > 0) {
    console.log(
      `\n  Note: no public key embedded (${
        report.unsignedPlatforms.join(", ")
      }), so OTA accepts unsigned updates from the pinned origins (and loopback in a debug ` +
        "build) only.",
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
    const flag = ctx.flags["ota-origin"];
    const origins = typeof flag === "string" ? parseOtaOrigins([flag]) : undefined;
    report = await addOtaToProject({
      dir,
      force: ctx.flags.force === true,
      publicKey,
      origins,
      dryRun,
    });
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
    fail(nativeText(dir, "\n  denext mobile add-ota: no ios/ or android/ project found."));
  }
  const failure = publicKey === undefined ? undefined : publicKeyFailure(report);
  if (failure !== undefined) fail(`\n  ${failure}`);
}

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
  // fastlane is release tooling: it changes nothing in the app.
  if (report.plan.capabilities.every((c) => c === "fastlane")) return;
  console.log("\n  Native plugins changed: ship a new app binary (OTA only updates the web UI).");
}

/** A comma-separated list flag (`--scheme a,b`) as its trimmed, non-empty items. */
function listFlag(value: string | number | boolean | undefined): string[] {
  return typeof value === "string" ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

/** `denext mobile add <capability...>`. */
async function addCapabilities(
  ctx: CommandContext,
  run: CommandRunner,
  publishTimes: NpmPublishTimes,
): Promise<void> {
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
      publishTimes,
      schemes: listFlag(ctx.flags.scheme),
      domains: listFlag(ctx.flags.domain),
      appGroups: listFlag(ctx.flags["app-group"]),
      names: listFlag(ctx.flags.name),
      configurable: listFlag(ctx.flags.configurable),
      force: ctx.flags.force === true,
      ci: ctx.flags.ci === true,
      encrypted: ctx.flags.encrypted === true,
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
function startOrAttachDev(ctx: CommandContext): Promise<MobileDevServer> {
  const { host, url } = mobileDevTarget(ctx);
  const project = resolve(ctx.global.cwd ?? ".", ctx.positionals[1] ?? ".");
  return startOrAttachDevServer(project, host, url);
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
 * `denext mobile sync [ios|android]`: `npx --no cap sync` in the Capacitor project, then the iOS
 * shell's plugin paths rewritten from pnpm's store to `node_modules/<name>` (see
 * `stabilizeSpmPluginPaths`), so a committed `ios/` builds on another checkout.
 */
async function mobileSync(ctx: CommandContext, run: CommandRunner): Promise<void> {
  const args = ["sync", ...syncPlatform(ctx.positionals[1])];
  try {
    const root = await findProject(resolve(ctx.global.cwd ?? "."), stringFlag(ctx.flags.dir));
    // The project's own Capacitor CLI, or a clear error (never a registry `cap`).
    await assertCapacitorCli(root);
    const command = capCommand(args, root);
    const { code } = await run(command);
    if (code !== 0) {
      throw new Error(`\`npx ${command.args.join(" ")}\` exited with ${code}.`);
    }
    logStabilized(await stabilizeSpmPluginPaths(root), (line) => console.log(line));
  } catch (err) {
    fail(`denext mobile sync: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `mobile sync`'s platform argument as `cap sync` arguments (none: both). */
function syncPlatform(platform: string | undefined): string[] {
  if (platform === undefined) return [];
  if (platform === "ios" || platform === "android") return [platform];
  fail(`denext mobile sync: unknown platform "${platform}" (expected ios or android).`);
}

/** A string flag's value, or undefined. */
function stringFlag(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Build the `mobile` verb with `run` as the subprocess runner for `add` (tests pass a fake).
 *
 * @param run Runs `add`'s package install and `cap sync`.
 * @param publishTimes The npm publish times `add` checks its exact pins' age with (tests pass a
 *   fake; default: the npm registry).
 * @returns The command spec.
 */
export function createMobileCommand(
  run: CommandRunner = runInheritedCommand,
  publishTimes: NpmPublishTimes = npmRegistryPublishTimes(),
): CommandSpec {
  return {
    ...mobileCommandSpec,
    run: async (ctx) => {
      const action = ctx.positionals[0];
      if (action === "add-ota") return await addOta(ctx);
      if (action === "add") return await addCapabilities(ctx, run, publishTimes);
      if (action === "sync") return await mobileSync(ctx, run);
      if (action === "dev") return await mobileDev(ctx, run);
      if (action === "fingerprint") return await mobileFingerprint(ctx);
      if (action === "privacy") return await mobilePrivacy(ctx);
      if (action === "doctor") return await mobileDoctor(ctx);
      if (action === "inspect") return await mobileInspect(ctx);
      if (action === "assets") return await mobileAssets(ctx);
      if (action === "build") return await mobileBuild(ctx);
      if (action === "submit") return await mobileSubmit(ctx);
      fail(
        `denext mobile: unknown action "${
          action ?? ""
        }" (expected: add, add-ota, sync, dev, fingerprint, privacy, doctor, inspect, assets, build, submit).`,
      );
    },
  };
}

const mobileCommandSpec: Omit<CommandSpec, "run"> = {
  ...commandMeta("mobile"),
  locks: (ctx) => ctx.positionals[0] === "build" ? mobileBuildLocks(ctx) : undefined,
};

/** The `mobile` verb. */
export const mobileCommand: CommandSpec = createMobileCommand();
