// The kitchen sink's automated window test: package the app with the platform's packaging script
// (written from the current scaffold template; denext's pinned Deno Desktop runtime, least-privilege
// flags), launch the packaged app with a deep link and a file on its command line, start the second
// instances the page asks for, serve signed full-app update manifests on loopback, and wait for the
// page to report every check through the `kitchen` extension. A second launch clicks plain links
// between the export's pages (denext's client router: soft navigations, a link back, history.back())
// and loads `/second` in full, asserting each page renders its own content and keeps the desktop
// bridge, and that the desktop export took `PlatformBadge.desktop.tsx` (imported through an alias)
// in its server render and its client bundle. Then the full-app update itself: a
// copy of the app downloads, verifies and installs a second build (99.0.0, same throwaway key), the
// new version's trial launch deliberately does not confirm, and the next launch must roll it back.
//
// Windows adds Authenticode signing. The "sign" phase (any Windows host, no admin): two throwaway
// self-signed code-signing certificates (A, B) are created in CurrentUser\My, 1.0.0 and 99.0.0 are
// packaged with A through the package script, a copy of 99.0.0 is re-signed with B through
// `desktopSignWindows`, and every PE file of each bundle must carry the expected signer. The
// "trusted update" phases need the certificates trusted machine-wide, which only an elevated
// process can do without a dialog, so they run only elevated AND with
// KITCHEN_SINK_TRUST_TEST_ROOT=1 (the CI workflow's hosted runner); elsewhere they are skipped
// with the reason. There the A-signed 1.0.0 must refuse the B-signed build (`os_signature`), stage
// the A-signed one as `authenticode`, install it and confirm it, and the relaunch must stay on it.
// The certificates are removed from every store at the end. Timestamps come from
// DENEXT_SIGN_TIMESTAMP_URL (default DigiCert's); when that server is unreachable the builds are
// signed without one, and the output says so.
//
// Exits non-zero on any failed or missing check, a skip without a reason, a timeout, or an app that
// does not quit.
//
//   deno task test:window                 # from examples/desktop-kitchen-sink
//   deno task test:window --no-package    # reuse the last dist/ builds (and their update key)
//   deno task test:window --no-update     # skip the full-app update install / rollback phases
//   deno task test:window --no-signing    # Windows: skip the signing and trusted-update phases
//
// macOS: run it in a logged-in session (the window needs a screen). Linux: under a display, e.g.
// `xvfb-run -a deno task test:window`. Windows: in the interactive desktop session (over SSH, start
// it from an `/it` scheduled task). Env: KITCHEN_SINK_TIMEOUT_MS (default 240000).
//
// Results: `e2e/.run/results.json` (every check of every phase, per OS), and with
// GITHUB_STEP_SUMMARY set a Markdown table of them, skips listed with their reasons.

import { DELIMITER, dirname, fromFileUrl, join } from "@std/path";
import {
  generateOtaKeyPair,
  importOtaSigningKey,
  toBase64,
} from "../../../src/build/ota-signing.ts";
import {
  type AppUpdatePayload,
  appUpdatePlatformKey,
  signAppUpdatePayload,
  verifyAppUpdateEnvelope,
  writeAppUpdateArchive,
} from "../../../src/build/app-update.ts";
import { desktopAppDirs } from "../../../src/desktop/app-dirs.ts";
import {
  desktopPeFiles,
  desktopRun,
  desktopSignWindows,
} from "../../../src/build/desktop-package-script.ts";
import {
  createTestCert,
  ensureSigntool,
  fileSignatures,
  isElevated,
  removeTestCerts,
  type TestCert,
  timestampServerReachable,
  trustTestCerts,
  untrustTestCerts,
} from "./windows-signing.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const SCRATCH = join(ROOT, "e2e", ".run");
const APP_ID = "dev.denext.kitchen-sink";
const APP_NAME = "KitchenSink"; // DENEXT_APP_NAME: a predictable dist/ path without spaces
const LINK_SCHEME = "kitchensink-link";
const OS = Deno.build.os;
const ARCH_LABEL = Deno.build.arch === "aarch64" ? "arm64" : "x64";
const TIMEOUT_MS = Number(Deno.env.get("KITCHEN_SINK_TIMEOUT_MS") ?? 240_000);
/** The page's main-phase check count (app/checks.ts); fewer means it shipped without some. */
const MIN_CHECKS = 55;
/** The checks the navigation phase reports (app/navigation.tsx `NAVIGATION_CHECKS`). */
const NAVIGATION_CHECKS = 6;
/** The checks each full-app update phase reports (app/checks.ts `PHASE_CHECKS`). */
const UPDATE_PHASES = { "update-install": 2, "update-trial": 1, "update-rollback": 2 } as const;
/** The version the update build is packaged as (app/checks.ts `UPDATE_VERSION`). */
const UPDATE_VERSION = "99.0.0";
/**
 * The checks of each trusted-update phase (app/checks.ts `PHASE_CHECKS`), by name: where the
 * phases cannot run, the runner reports these as skipped, under the same names.
 */
const TRUSTED_PHASES: Readonly<Record<string, readonly string[]>> = {
  "trusted-install": [
    "trusted install: the A-signed 1.0.0, not on trial",
    `trusted install: ${UPDATE_VERSION} re-signed with another certificate (B) is refused (os_signature)`,
    `trusted install: ${UPDATE_VERSION} signed with the same certificate (A) stages as authenticode`,
  ],
  "trusted-trial": [
    `trusted trial: ${UPDATE_VERSION} runs on trial and confirmAppUpdate() confirms it`,
  ],
  "trusted-relaunch": [
    `trusted relaunch: still ${UPDATE_VERSION}, not on trial, nothing rolled back`,
  ],
};
const OPEN_FILE_NAME = "open me.txt";
const OPEN_FILE_TEXT = "opened by the kitchen sink window test";
const PACKAGE_SCRIPTS: Record<string, string> = {
  darwin: "package-macos.ts",
  linux: "package-linux.ts",
  windows: "package-windows.ts",
};
/** The opener the auth-session capability runs, replaced by a stand-in first on PATH. */
const BROWSER_OPENER: Record<string, string> = {
  darwin: "open",
  linux: "xdg-open",
  windows: "rundll32.exe",
};

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  ms: number;
}

interface Report {
  phase: string;
  pid: number;
  results: CheckResult[];
  expected: string[];
}

/** One check's outcome in the merged results (`results.json`). */
interface RunResult extends CheckResult {
  phase: string;
}

/** A launched app process, its output going to a log file. */
interface Launched {
  child: Deno.ChildProcess;
  done: Promise<void>;
  exit?: Deno.CommandStatus;
}

function log(line: string): void {
  console.log(`[window-test] ${line}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

/** Run a command in the example dir, streaming its output; throw on a non-zero exit. */
async function run(cmd: string[], env: Record<string, string> = {}): Promise<void> {
  log(`$ ${cmd.join(" ")}`);
  const { code } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: ROOT,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) throw new Error(`exit ${code}: ${cmd.join(" ")}`);
}

const quiet = (cmd: string, args: string[]) =>
  new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).output().catch(() => null);

// --- packaging ---------------------------------------------------------------------------------

/** Where a build keeps the update key pair it was packaged with (the public half is baked in). */
const KEY_FILE = join(ROOT, "dist", "kitchen-sink-update-key.json");
/** Where the update build (99.0.0) is kept, beside the app build in dist/. */
const UPDATE_DIST = join(ROOT, "dist", "update");

/** The update key pair of the last build in dist/ (`--no-package`). */
async function buildKey(): Promise<{ publicKey: string; privateKeyPem: string }> {
  return JSON.parse(await Deno.readTextFile(KEY_FILE));
}

/** The packaged app's bundle in `dist`: the `.app` (macOS) or the app directory. */
function bundleIn(dist: string): string {
  return OS === "darwin" ? join(dist, `${APP_NAME}.app`) : join(dist, `${APP_NAME}-${ARCH_LABEL}`);
}

/**
 * Run this OS's packaging script with the update key baked in. Windows signs only with `signWith`
 * (its certificate overrides any DENEXT_WINDOWS_CERT of the environment), else `--no-sign`.
 */
async function runPackageScript(publicKey: string, signWith?: TestCert): Promise<void> {
  const script = PACKAGE_SCRIPTS[OS];
  if (!script) throw new Error(`unsupported OS ${OS}`);
  await run(
    [
      "deno",
      "run",
      "-A",
      `scripts/${script}`,
      ...(OS === "windows" && !signWith ? ["--no-sign"] : []),
    ],
    {
      DENEXT_APP_NAME: APP_NAME,
      KITCHEN_SINK_UPDATE_PUBLIC_KEY: publicKey,
      ...(signWith ? signingEnv(signWith) : {}),
    },
  );
}

/** Run `build` with deno.json's `version` set to `version` (restored afterwards). */
async function withVersion(version: string, build: () => Promise<void>): Promise<void> {
  const denoJson = join(ROOT, "deno.json");
  const original = await Deno.readTextFile(denoJson);
  const versioned = original.replace(/"version": "1\.0\.0"/, `"version": "${version}"`);
  if (versioned === original) throw new Error('deno.json has no "version": "1.0.0"');
  await Deno.writeTextFile(denoJson, versioned);
  try {
    await build();
  } finally {
    await Deno.writeTextFile(denoJson, original);
  }
}

/** Move the bundle just packaged into dist/ to `dist` (replacing what was there). */
async function moveBundle(dist: string): Promise<string> {
  await Deno.remove(dist, { recursive: true }).catch(() => {});
  await Deno.mkdir(dist, { recursive: true });
  await Deno.rename(bundleIn(join(ROOT, "dist")), bundleIn(dist));
  return bundleIn(dist);
}

/** Package the update build: the same app as version 99.0.0 (deno.json's `version`, restored). */
async function packageUpdateBuild(publicKey: string): Promise<void> {
  await withVersion(UPDATE_VERSION, () => runPackageScript(publicKey));
  await moveBundle(UPDATE_DIST);
}

/** Write the packaging scripts from the current scaffold, then package the update build, the
 * Windows signed builds (`signing`) and the app (as `denext desktop package` does) with one fresh
 * throwaway update key baked into all of them. Returns that key pair and the sign phase. */
async function packageApp(withUpdate: boolean, signing: boolean): Promise<
  { keys: { publicKey: string; privateKeyPem: string }; signed: Signing | null }
> {
  const keys = await generateOtaKeyPair();
  await run([
    "deno",
    "run",
    "-A",
    "../../cli.ts",
    "desktop",
    "package",
    "--regenerate-scripts",
    ".",
  ]);
  if (withUpdate) await packageUpdateBuild(keys.publicKey);
  // Before the app's own build: the sign phase packages into dist/ too and moves its bundles out.
  const signed = signing ? await signPhase(keys.publicKey) : null;
  await runPackageScript(keys.publicKey);
  await Deno.writeTextFile(KEY_FILE, JSON.stringify(keys));
  return { keys, signed };
}

// --- Windows Authenticode signing --------------------------------------------------------------

/** Where the sign phase keeps its builds: `v1` and `v2a` signed with A, `v2b` re-signed with B. */
const SIGNED_DIST = join(ROOT, "dist", "signed");
/** The timestamp server the package script and `desktopSignWindows` use. */
const TIMESTAMP_URL = Deno.env.get("DENEXT_SIGN_TIMESTAMP_URL") ?? "http://timestamp.digicert.com";

/** The sign phase's checks. */
const SIGN_CHECKS = {
  setup: "sign: signtool and two throwaway code-signing certificates (A, B)",
  v1: "sign: 1.0.0 packaged with A by the package script, every PE file signed by A",
  v2a: `sign: ${UPDATE_VERSION} packaged with A by the package script, every PE file signed by A`,
  v2b: `sign: a copy of ${UPDATE_VERSION} re-signed with B by desktopSignWindows, every PE file ` +
    "signed by B",
} as const;
/** The runner's own check in the trusted-update phase (the app's follow in `TRUSTED_PHASES`). */
const TRUST_CHECK = "trusted update: the throwaway certificates are trusted machine-wide";

/** The sign phase's outcome. */
interface Signing {
  report: Report;
  /** The signed bundles, when every sign check passed. */
  builds: { v1: string; v2a: string; v2b: string } | null;
  /** Why there are no builds (a skip), when the phase did not run. */
  skipped: string | null;
  /** The certificates created (removed again by {@link cleanupSigning}). */
  certs: TestCert[];
  /** The private temporary folder holding the .pfx / .cer files and PowerShell scripts. */
  tmp: string | null;
}

/** The sign phase in progress or done, for {@link cleanupSigning} even when packaging fails. */
let currentSigning: Signing | null = null;

/** The environment that makes the package script sign with `cert`. */
function signingEnv(cert: TestCert): Record<string, string> {
  return { DENEXT_WINDOWS_CERT: cert.pfx, DENEXT_WINDOWS_CERT_PASSWORD: cert.password };
}

/** A sign phase that did not run, every check skipped with `reason`. */
function skippedSigning(reason: string): Signing {
  const names = Object.values(SIGN_CHECKS);
  return {
    report: {
      phase: "sign",
      pid: Deno.pid,
      expected: names,
      results: names.map((name) => ({ name, status: "skip", detail: reason, ms: 0 })),
    },
    builds: null,
    skipped: reason,
    certs: [],
    tmp: null,
  };
}

/** signtool's arguments without the timestamp (`/tr <url> /td <alg>`): an offline signing. */
function withoutTimestamp(cmd: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === "/tr" || cmd[i] === "/td") i++;
    else out.push(cmd[i]);
  }
  return out;
}

/** Sign every PE file of `bundle` with `cert` through `desktopSignWindows` (no timestamp when
 * the server is unreachable). */
async function signBundle(bundle: string, cert: TestCert, timestamp: boolean): Promise<void> {
  const env = { ...signingEnv(cert), DENEXT_SIGN_TIMESTAMP_URL: TIMESTAMP_URL };
  const signed = await desktopSignWindows(await desktopPeFiles(bundle), {
    env: (name) => env[name as keyof typeof env],
    run: timestamp ? desktopRun : (cmd, e, o) => desktopRun(withoutTimestamp(cmd), e, o),
  });
  if (!signed) throw new Error(`desktopSignWindows signed nothing in ${bundle}`);
}

/** Every PE file of `bundle` must carry `cert`'s signature (timestamped, when `timestamp`). */
async function assertSignedBy(
  tmp: string,
  bundle: string,
  cert: TestCert,
  timestamp: boolean,
): Promise<string> {
  const files = await desktopPeFiles(bundle);
  const exe = await executableOf(bundle);
  if (!files.includes(exe)) throw new Error(`${exe} is not among the bundle's PE files`);
  const sigs = await fileSignatures(tmp, files);
  const wrong = sigs.filter((s) =>
    s.thumbprint !== cert.thumbprint || (timestamp && !s.timestamped)
  );
  if (wrong.length) {
    const say = (s: (typeof sigs)[number]) =>
      `${s.path.slice(bundle.length + 1)}: ${s.thumbprint ?? "unsigned"}` +
      `${s.timestamped ? "" : ", no timestamp"} (${s.status})`;
    throw new Error(
      `${wrong.length} of ${files.length} PE files not signed by ${cert.label} ` +
        `(${cert.thumbprint}): ${wrong.map(say).join("; ")}`,
    );
  }
  const statuses = [...new Set(sigs.map((s) => s.status))].join("/");
  return `${files.length} PE files signed by ${cert.label}` +
    `${timestamp ? ", timestamped" : ", NOT timestamped (server unreachable)"} (${statuses})`;
}

/**
 * The sign phase (Windows): throwaway certificates A and B, 1.0.0 and 99.0.0 packaged with A by
 * the package script, a copy of 99.0.0 re-signed with B by `desktopSignWindows`, and every PE file
 * of each checked for its signer. A failed step fails the steps after it.
 */
async function signPhase(publicKey: string): Promise<Signing> {
  const signtool = await ensureSigntool();
  if (!signtool) {
    const reason = "signtool not found (install the Windows SDK)";
    // A CI runner has the SDK: a missing signtool there is a broken run, not a skip.
    if (Deno.env.get("GITHUB_ACTIONS") !== "true") return skippedSigning(reason);
  }
  const tmp = await Deno.makeTempDir({ prefix: "kitchen-sink-sign-" });
  const signing: Signing = {
    report: { phase: "sign", pid: Deno.pid, expected: Object.values(SIGN_CHECKS), results: [] },
    builds: null,
    skipped: null,
    certs: [],
    tmp,
  };
  currentSigning = signing;
  let failed = false;
  const step = async (name: string, body: () => Promise<string>) => {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    if (failed) {
      signing.report.results.push({
        name,
        status: "fail",
        detail: "not run: an earlier signing step failed",
        ms: 0,
      });
      return;
    }
    try {
      signing.report.results.push({ name, status: "pass", detail: await body(), ms: ms() });
    } catch (err) {
      failed = true;
      const detail = err instanceof Error ? err.message : String(err);
      signing.report.results.push({ name, status: "fail", detail, ms: ms() });
    }
  };
  let timestamp = false;
  let a!: TestCert;
  let b!: TestCert;
  await step(SIGN_CHECKS.setup, async () => {
    if (!signtool) throw new Error("signtool not found (install the Windows SDK)");
    a = await createTestCert(tmp, "A");
    signing.certs.push(a);
    b = await createTestCert(tmp, "B");
    signing.certs.push(b);
    timestamp = await timestampServerReachable(TIMESTAMP_URL);
    if (!timestamp) {
      log(
        `WARNING: the timestamp server ${TIMESTAMP_URL} is unreachable: signing WITHOUT timestamps`,
      );
    }
    return `${signtool}; A ${a.thumbprint}, B ${b.thumbprint}; ` +
      (timestamp
        ? `timestamps from ${TIMESTAMP_URL}`
        : `${TIMESTAMP_URL} unreachable: no timestamps`);
  });
  /** Package with A: through the package script, or (offline) unsigned, then signed here. */
  const packageWithA = async () => {
    if (timestamp) return await runPackageScript(publicKey, a);
    await runPackageScript(publicKey);
    await signBundle(bundleIn(join(ROOT, "dist")), a, false);
  };
  const v1 = bundleIn(join(SIGNED_DIST, "v1"));
  const v2a = bundleIn(join(SIGNED_DIST, "v2a"));
  const v2b = bundleIn(join(SIGNED_DIST, "v2b"));
  await step(SIGN_CHECKS.v1, async () => {
    await packageWithA();
    await moveBundle(join(SIGNED_DIST, "v1"));
    return await assertSignedBy(tmp, v1, a, timestamp);
  });
  await step(SIGN_CHECKS.v2a, async () => {
    await withVersion(UPDATE_VERSION, packageWithA);
    await moveBundle(join(SIGNED_DIST, "v2a"));
    return await assertSignedBy(tmp, v2a, a, timestamp);
  });
  await step(SIGN_CHECKS.v2b, async () => {
    await Deno.remove(join(SIGNED_DIST, "v2b"), { recursive: true }).catch(() => {});
    await copyTree(v2a, v2b);
    await signBundle(v2b, b, timestamp);
    return await assertSignedBy(tmp, v2b, b, timestamp);
  });
  if (!failed) signing.builds = { v1, v2a, v2b };
  return signing;
}

/** Remove the sign phase's certificates (CurrentUser stores) and its temporary folder. */
async function cleanupSigning(signing: Signing | null): Promise<void> {
  if (!signing?.tmp) return;
  try {
    await removeTestCerts(signing.tmp, signing.certs);
  } catch (err) {
    log(`WARNING: removing the throwaway certificates failed: ${err}`);
  }
  await Deno.remove(signing.tmp, { recursive: true }).catch(() => {});
}

/** macOS: the executable inside a `.app`. */
async function macExecutable(app: string): Promise<string> {
  const plist = await Deno.readTextFile(join(app, "Contents", "Info.plist"));
  const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!exe) throw new Error(`no CFBundleExecutable in ${app}`);
  return join(app, "Contents", "MacOS", exe);
}

/** Linux: the bundle directory's executable (a regular file with an exec bit, not a library). */
async function linuxExecutable(dir: string): Promise<string> {
  // The bundle's own launcher is named after its directory; a CEF bundle also holds
  // `chrome-sandbox` (executable, but not the app).
  const named = join(dir, dir.split("/").pop()!);
  if (await exists(named)) return named;
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || /\.so(\.|$)/.test(e.name) || e.name === "chrome-sandbox") continue;
    const mode = (await Deno.stat(join(dir, e.name))).mode ?? 0;
    if ((mode & 0o111) !== 0) return join(dir, e.name);
  }
  throw new Error(`no executable in ${dir}`);
}

/** The packaged executable of a bundle (see {@link bundleIn}). */
function executableOf(bundle: string): Promise<string> {
  if (OS === "darwin") return macExecutable(bundle);
  if (OS === "windows") return Promise.resolve(join(bundle, `${APP_NAME}-${ARCH_LABEL}.exe`));
  return linuxExecutable(bundle);
}

/** Copy a packaged bundle (macOS: `ditto`, which keeps the code signature intact). */
async function copyBundle(from: string, to: string): Promise<void> {
  await Deno.mkdir(dirname(to), { recursive: true });
  if (OS === "darwin") return await run(["ditto", from, to]);
  if (OS === "linux") return await run(["cp", "-a", from, to]);
  await copyTree(from, to);
}

/** A plain recursive copy (Windows app directories hold no links). */
async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const e of Deno.readDir(from)) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory) await copyTree(src, dst);
    else await Deno.copyFile(src, dst);
  }
}

// --- the stand-in browser ----------------------------------------------------------------------

/** Put a stand-in for the system browser opener in `<scratch>/bin` (first on the app's PATH): it
 * records the URL it is asked to open in `bin/browser.log` and opens nothing. */
async function installBrowserStub(): Promise<string> {
  const bin = join(SCRATCH, "bin");
  await Deno.mkdir(bin, { recursive: true });
  const opener = join(bin, BROWSER_OPENER[OS]);
  if (OS === "windows") {
    await run([
      "deno",
      "compile",
      "--no-check",
      "--allow-read",
      "--allow-write",
      "--output",
      opener,
      "e2e/browser-stub.ts",
    ]);
  } else {
    await Deno.writeTextFile(
      opener,
      '#!/bin/sh\nfor a; do last="$a"; done\nprintf \'%s\\n\' "$last" >> "$(dirname "$0")/browser.log"\n',
    );
    await Deno.chmod(opener, 0o755);
  }
  return bin;
}

// --- signed update manifests on loopback -------------------------------------------------------

/**
 * The release counter every manifest of this run carries (the runtime refuses a lower one than an
 * install accepted, `replayed`): the run's start in Unix seconds, so a later run never goes below.
 */
const SEQUENCE = Math.floor(Date.now() / 1000);
/** A manifest's expiry, `days` from now (negative: already expired). */
const expiresIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

/**
 * One signed manifest payload offering `version` of `app` for `platform` (never downloaded): the
 * packaged app's own key, so a CEF build is offered a `-cef` build, not `no_platform`.
 */
function manifest(
  platform: string,
  version: string,
  app = APP_ID,
  fresh: { expiresAt?: string; sequence?: number } = {},
): AppUpdatePayload {
  return {
    schema: 1,
    app,
    version,
    platforms: {
      [platform]: {
        url: `https://updates.invalid/kitchen-sink/${version}/${platform}.tar.gz`,
        sha256: "0".repeat(64),
        size: 1024,
        kind: "bundle",
      },
    },
    releaseNotes: "kitchen sink window test",
    publishedAt: new Date().toISOString(),
    expiresAt: fresh.expiresAt ?? expiresIn(30),
    sequence: fresh.sequence ?? SEQUENCE,
  };
}

/**
 * Sign a payload whose archive is on the loopback server. denext's publisher refuses to sign a
 * non-https archive URL; the runtime accepts loopback http behind the dev-only
 * `allowInsecureLoopback`, so the harness signs this one itself in the same envelope format (and
 * verifies it with denext's verifier, so a format change fails here, not in the app).
 */
async function signLoopbackPayload(
  payload: AppUpdatePayload,
  key: CryptoKey,
  publicKey: string,
): Promise<string> {
  const signed = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(`denext-app-update-v1\n${signed}`);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes);
  const envelope = { signed, signature: toBase64(new Uint8Array(sig)) };
  await verifyAppUpdateEnvelope(envelope, publicKey);
  return JSON.stringify(envelope);
}

interface UpdateServer {
  base: string;
  close(): void;
}

/**
 * Signed manifests on loopback: a newer version, another key's signature, an older version,
 * another app, (with the update build) a real update whose archive is served here too, and
 * (Windows, `signed`) the update build signed with certificate A and re-signed with B.
 */
async function startUpdateServer(
  keys: { privateKeyPem: string; publicKey: string },
  bundle: string,
  update: string | null,
  signed: { v2a: string; v2b: string } | null,
) {
  // The installed app's platform key, backend included (`<target>-webview` / `<target>-cef`).
  const platform = await appUpdatePlatformKey(bundle);
  const key = await importOtaSigningKey(keys.privateKeyPem);
  const other = await importOtaSigningKey((await generateOtaKeyPair()).privateKeyPem);
  const docs: Record<string, string> = {};
  /** The archives served, by path. */
  const archives: Record<string, string> = {};
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const path = new URL(req.url).pathname;
    const archive = archives[path];
    if (archive) {
      return new Response((await Deno.open(archive)).readable, {
        headers: { "content-type": "application/gzip" },
      });
    }
    const body = docs[path];
    return body
      ? new Response(body, { headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
  });
  const base = `http://127.0.0.1:${server.addr.port}/`;
  const sign = async (payload: AppUpdatePayload, k: CryptoKey) =>
    JSON.stringify(await signAppUpdatePayload(payload, k));
  docs["/good.json"] = await sign(manifest(platform, "99.0.0"), key);
  docs["/bad-signature.json"] = await sign(manifest(platform, "99.0.0"), other);
  docs["/downgrade.json"] = await sign(manifest(platform, "0.0.1"), key);
  docs["/wrong-app.json"] = await sign(manifest(platform, "99.0.0", "dev.denext.another-app"), key);
  // signAppUpdatePayload validates the shape only, not the clock: an expired manifest still signs.
  docs["/expired.json"] = await sign(
    manifest(platform, "99.0.0", APP_ID, { expiresAt: expiresIn(-1) }),
    key,
  );
  docs["/replayed.json"] = await sign(
    manifest(platform, "99.0.0", APP_ID, { sequence: SEQUENCE - 1 }),
    key,
  );
  /** Pack `bundle` as `<name>.tar.gz` and serve its signed manifest as `<name>.json`. */
  const offer = async (bundle: string, name: string) => {
    log(`packing the update build ${bundle}`);
    const file = join(SCRATCH, `${name}.tar.gz`);
    const { sha256, size } = await writeAppUpdateArchive(bundle, file);
    archives[`/${name}.tar.gz`] = file;
    const platform = await appUpdatePlatformKey(bundle);
    docs[`/${name}.json`] = await signLoopbackPayload(
      {
        schema: 1,
        app: APP_ID,
        version: UPDATE_VERSION,
        platforms: { [platform]: { url: `${base}${name}.tar.gz`, sha256, size, kind: "bundle" } },
        releaseNotes: `kitchen sink window test: the update build (${name})`,
        publishedAt: new Date().toISOString(),
        expiresAt: expiresIn(30),
        sequence: SEQUENCE,
      },
      key,
      keys.publicKey,
    );
  };
  if (update) {
    await offer(update, "update");
    docs["/real.json"] = docs["/update.json"];
  }
  if (signed) {
    await offer(signed.v2a, "trusted-a");
    await offer(signed.v2b, "trusted-b");
  }
  return { base, close: () => void server.shutdown() } satisfies UpdateServer;
}

// --- launching ---------------------------------------------------------------------------------

/** The packaged app's backend (set once the bundle is known), for the page's skip reasons. */
let appBackend: "webview" | "cef" | null = null;

/**
 * The Linux session the app runs in: `XDG_SESSION_TYPE`, else `WAYLAND_DISPLAY` / `DISPLAY`
 * (`null` off Linux). The page prefers the runtime's own probe and falls back to this.
 */
function linuxSessionType(): "wayland" | "x11" | "tty" | null {
  if (OS !== "linux") return null;
  const type = Deno.env.get("XDG_SESSION_TYPE");
  if (type === "wayland" || type === "x11" || type === "tty") return type;
  if (Deno.env.get("WAYLAND_DISPLAY")) return "wayland";
  return Deno.env.get("DISPLAY") ? "x11" : null;
}

/** What the app reads at launch to know the runner started it (see `desktop/kitchen.ts`). */
async function writeRunnerState(
  phase: "main" | "navigation" | "update" | "trusted",
  updateBase: string,
): Promise<void> {
  const dir = desktopAppDirs(APP_ID).data;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "kitchen-sink-runner.json"),
    JSON.stringify({
      out: SCRATCH,
      phase,
      updateBase,
      sessionType: linuxSessionType(),
      backend: appBackend,
    }),
  );
}

/** A command's trimmed stdout, or `null` when it cannot run or fails. */
async function stdoutOf(cmd: string[]): Promise<string | null> {
  try {
    const out = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    return null;
  }
}

/**
 * Linux: warn when one of this user's logind sessions is locked (a locked screen keeps the window
 * from the focus, so the clipboard and sizing checks fail). Never unlocks it.
 */
async function warnIfScreenLocked(): Promise<void> {
  if (OS !== "linux") return;
  const uid = String(Deno.uid());
  const sessions = await stdoutOf(["loginctl", "list-sessions", "--no-legend"]);
  for (const line of sessions?.split("\n") ?? []) {
    const [id, sessionUid] = line.trim().split(/\s+/);
    if (!id || sessionUid !== uid) continue;
    const locked = await stdoutOf(["loginctl", "show-session", id, "-p", "LockedHint", "--value"]);
    if (locked === "yes") {
      log(
        `WARNING: screen is locked (logind session ${id}): focus-dependent checks (clipboard, ` +
          "sizing) will fail",
      );
      return;
    }
  }
}

/** The app's environment: the stand-in browser first on PATH. */
function appEnv(bin: string): Record<string, string> {
  return { PATH: `${bin}${DELIMITER}${Deno.env.get("PATH") ?? ""}` };
}

/** Start the packaged app, its stdout + stderr appended to `logFile`. */
function launch(exe: string, args: string[], env: Record<string, string>, logFile: string) {
  const out = Deno.openSync(logFile, { create: true, append: true, write: true });
  const child = new Deno.Command(exe, {
    args,
    env,
    cwd: ROOT,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) out.writeSync(chunk);
  };
  const launched: Launched = {
    child,
    // A process the updater starts inherits these pipes, so they may outlive this child.
    done: Promise.all([pump(child.stdout), pump(child.stderr)]).then(() => out.close()),
  };
  child.status.then((s) => launched.exit = s);
  return launched;
}

function kill(app: Launched): void {
  try {
    app.child.kill();
  } catch { /* already gone */ }
}

/** Whether a process (one the updater started, not a child of ours) is still running. */
async function alive(pid: number): Promise<boolean> {
  if (OS === "windows") {
    const r = await new Deno.Command("tasklist", {
      args: ["/FI", `PID eq ${pid}`, "/NH"],
      stdout: "piped",
      stderr: "null",
    }).output().catch(() => null);
    return r !== null && new TextDecoder().decode(r.stdout).includes(` ${pid} `);
  }
  return (await quiet("kill", ["-0", String(pid)]))?.success === true;
}

/** Start the second instances the page asks for (`kitchen.secondInstance`): each hands its
 * arguments to the running app and must exit; its exit code goes back to the page. */
async function serveSecondInstances(exe: string, env: Record<string, string>): Promise<void> {
  for await (const e of Deno.readDir(SCRATCH)) {
    const m = /^second-([a-z0-9-]+)\.request\.json$/.exec(e.name);
    if (!m) continue;
    const request = join(SCRATCH, e.name);
    const { args } = JSON.parse(await Deno.readTextFile(request)) as { args: string[] };
    await Deno.remove(request);
    log(`the page asks for a second instance (${m[1]})`);
    const second = launch(exe, args, env, join(SCRATCH, `second-${m[1]}.log`));
    const timer = setTimeout(() => kill(second), 20_000);
    const { code } = await second.child.status;
    clearTimeout(timer);
    await Promise.race([second.done, sleep(2000)]);
    log(`the second instance (${m[1]}) exited with ${code}`);
    await Deno.writeTextFile(join(SCRATCH, `second-${m[1]}.done.json`), JSON.stringify({ code }));
  }
}

/** Wait for `phase`'s report, serving second instances meanwhile; `null` on a timeout. */
async function waitForReport(
  phase: string,
  exe: string,
  env: Record<string, string>,
  until: number,
): Promise<Report | null> {
  const file = join(SCRATCH, `kitchen-sink-report-${phase}.json`);
  while (Date.now() < until) {
    if (await exists(file)) return JSON.parse(await Deno.readTextFile(file)) as Report;
    await serveSecondInstances(exe, env);
    await sleep(250);
  }
  return null;
}

/** Wait (up to 20 s) for a child or a pid to be gone; `false` if it is still running. */
async function waitGone(target: Launched | number): Promise<boolean> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (typeof target === "number" ? !(await alive(target)) : target.exit) return true;
    await sleep(250);
  }
  return false;
}

/** The main phase: every check, launched with a link and a file. */
async function mainPhase(exe: string, bin: string, updateBase: string) {
  const fixture = join(SCRATCH, OPEN_FILE_NAME);
  await Deno.writeTextFile(fixture, OPEN_FILE_TEXT);
  await writeRunnerState("main", updateBase);
  await Deno.remove(join(SCRATCH, "progress.marker")).catch(() => {});
  const env = appEnv(bin);
  const app = launch(
    exe,
    [`${LINK_SCHEME}://open/cold?x=1`, fixture],
    env,
    join(SCRATCH, "app.log"),
  );
  log(`launched pid ${app.child.pid}; waiting for the page (timeout ${TIMEOUT_MS} ms)`);
  const report = await waitForReport("main", exe, env, Date.now() + TIMEOUT_MS);
  if (!report) {
    kill(app);
    // Where the page got to (the check it was running), and the end of the app's own log.
    const at = await Deno.readTextFile(join(SCRATCH, "progress.marker")).catch(() => "");
    const tail = (await Deno.readTextFile(join(SCRATCH, "app.log")).catch(() => ""))
      .split("\n").slice(-40).join("\n");
    if (tail.trim()) log(`app.log (last 40 lines):\n${tail}`);
    throw new Error(
      `no report within ${TIMEOUT_MS} ms; ` +
        (at ? `the page was running check ${at}` : "the page started no check") +
        ` (app log: ${join(SCRATCH, "app.log")})`,
    );
  }
  const problems: string[] = [];
  // The page quits the app after reporting.
  if (!(await waitGone(app))) {
    kill(app);
    problems.push("the app did not quit within 20 s of reporting");
  } else if (app.exit!.code !== 0) problems.push(`the app exited with ${app.exit!.code}`);
  await Promise.race([app.done, sleep(2000)]);
  if (report.expected.length < MIN_CHECKS) {
    problems.push(`only ${report.expected.length} checks are defined (expected ${MIN_CHECKS})`);
  }
  return { report, problems };
}

/**
 * The navigation phase: the page clicks plain links between `/` and `/second` (soft navigations),
 * goes back, then loads `/second` in full; that second document checks the export rendered and
 * hydrated the desktop variant of a platform-specific file, reports every check and quits.
 */
async function navigationPhase(exe: string, bin: string, updateBase: string) {
  await writeRunnerState("navigation", updateBase);
  await Deno.remove(join(SCRATCH, "progress.marker")).catch(() => {});
  const env = appEnv(bin);
  const logFile = join(SCRATCH, "navigation.log");
  const app = launch(exe, [], env, logFile);
  log(`navigation: launched pid ${app.child.pid}`);
  const report = await waitForReport("navigation", exe, env, Date.now() + TIMEOUT_MS);
  if (!report) {
    kill(app);
    const at = await Deno.readTextFile(join(SCRATCH, "progress.marker")).catch(() => "");
    return {
      report: null,
      problems: [
        `navigation: no report within ${TIMEOUT_MS} ms` +
        (at ? `; the page was at ${at}` : "; the page started no check") + ` (app log: ${logFile})`,
      ],
    };
  }
  const problems: string[] = [];
  if (!(await waitGone(app))) {
    kill(app);
    problems.push("navigation: the app did not quit within 20 s of reporting");
  } else if (app.exit!.code !== 0) {
    problems.push(`navigation: the app exited with ${app.exit!.code}`);
  }
  await Promise.race([app.done, sleep(2000)]);
  return { report, problems };
}

/**
 * The full-app update: a copy of the app installs the update build, its trial launch is left
 * unconfirmed and quits, and the next launch must roll it back. Each launch reports its phase.
 */
async function updatePhases(exe: string, bin: string, updateBase: string) {
  const reports: Report[] = [];
  const problems: string[] = [];
  const install = bundleIn(join(SCRATCH, "install"));
  await copyBundle(bundleIn(join(ROOT, "dist")), install);
  const installExe = await executableOf(install);
  const env = appEnv(bin);
  await writeRunnerState("update", updateBase);
  const until = Date.now() + TIMEOUT_MS;

  log(`update: launching the installed copy ${installExe}`);
  const first = launch(installExe, [], env, join(SCRATCH, "update.log"));
  const installReport = await waitForReport("update-install", exe, env, until);
  if (!installReport) {
    kill(first);
    return { reports, problems: [...problems, "update-install: no report"] };
  }
  reports.push(installReport);
  if (!installReport.results.every((r) => r.status === "pass")) {
    await waitGone(first) || kill(first);
    return { reports, problems }; // the failed checks say why; nothing was installed
  }
  if (!(await waitGone(first))) {
    kill(first);
    problems.push("update-install: the app did not quit for the install");
  }
  const installed = await Deno.readTextFile(join(SCRATCH, "update-install.marker")).catch(() => "");
  log(`update: install answered ${installed || "(nothing)"}; waiting for the trial launch`);

  const trial = await waitForReport("update-trial", exe, env, until);
  if (!trial) {
    return {
      reports,
      problems: [...problems, `update-trial: no report (install answered ${installed || "-"})`],
    };
  }
  reports.push(trial);
  if (!(await waitGone(trial.pid))) problems.push("update-trial: the app did not quit");

  log("update: relaunching the unconfirmed version; it must roll back");
  const third = launch(installExe, [], env, join(SCRATCH, "rollback.log"));
  const rollback = await waitForReport("update-rollback", exe, env, until);
  if (!(await waitGone(third))) {
    kill(third);
    problems.push("update-rollback: the unconfirmed version kept running instead of rolling back");
  } else if (third.exit!.code !== 0) {
    problems.push(`update-rollback: the unconfirmed launch exited with ${third.exit!.code}`);
  }
  if (!rollback) return { reports, problems: [...problems, "update-rollback: no report"] };
  reports.push(rollback);
  if (!(await waitGone(rollback.pid))) problems.push("update-rollback: the app did not quit");
  return { reports, problems };
}

/** The trusted-update phases reported as skipped with `reason` (the runner's check included). */
function skippedTrusted(reason: string): Report[] {
  const skip = (name: string) => ({ name, status: "skip" as const, detail: reason, ms: 0 });
  return [
    {
      phase: "trusted-update",
      pid: Deno.pid,
      expected: [TRUST_CHECK],
      results: [skip(TRUST_CHECK)],
    },
    ...Object.entries(TRUSTED_PHASES).map(([phase, names]) => ({
      phase,
      pid: Deno.pid,
      expected: [...names],
      results: names.map(skip),
    })),
  ];
}

/**
 * The trusted update (Windows, elevated, opted in): trust the sign phase's certificates
 * machine-wide, then a copy of the A-signed 1.0.0 refuses the B-signed update, installs the
 * A-signed one, its trial launch confirms it, and the relaunch must still run it. The
 * certificates leave the machine stores whatever happens.
 */
async function trustedUpdate(signing: Signing | null, bin: string, updateBase: string) {
  if (!signing?.builds || !signing.tmp) {
    const why = signing?.skipped ?? "the sign phase failed (see its checks)";
    return { reports: skippedTrusted(`no signed builds: ${why}`), problems: [] };
  }
  if (!(await isElevated(signing.tmp))) {
    return {
      reports: skippedTrusted("needs an elevated runner to trust a test root"),
      problems: [],
    };
  }
  if (Deno.env.get("KITCHEN_SINK_TRUST_TEST_ROOT") !== "1") {
    return {
      reports: skippedTrusted(
        "elevated, but KITCHEN_SINK_TRUST_TEST_ROOT=1 is not set: the test trusts a throwaway " +
          "root machine-wide only when asked (the CI workflow sets it)",
      ),
      problems: [],
    };
  }
  const reports: Report[] = [];
  const problems: string[] = [];
  const started = performance.now();
  let trustedOk = false;
  try {
    try {
      await trustTestCerts(signing.tmp, signing.certs);
      const [sig] = await fileSignatures(signing.tmp, [await executableOf(signing.builds.v1)]);
      if (sig.status !== "Valid") throw new Error(`the A-signed 1.0.0 still reads ${sig.status}`);
      trustedOk = true;
      reports.push({
        phase: "trusted-update",
        pid: Deno.pid,
        expected: [TRUST_CHECK],
        results: [{
          name: TRUST_CHECK,
          status: "pass",
          detail:
            "A and B in LocalMachine\\Root + TrustedPublisher; the A-signed 1.0.0 reads Valid",
          ms: Math.round(performance.now() - started),
        }],
      });
    } catch (err) {
      reports.push({
        phase: "trusted-update",
        pid: Deno.pid,
        expected: [TRUST_CHECK],
        results: [{
          name: TRUST_CHECK,
          status: "fail",
          detail: err instanceof Error ? err.message : String(err),
          ms: Math.round(performance.now() - started),
        }],
      });
    }
    if (trustedOk) {
      const up = await trustedLaunches(signing.builds.v1, bin, updateBase);
      reports.push(...up.reports);
      problems.push(...up.problems);
    }
  } finally {
    await untrustTestCerts(signing.tmp, signing.certs).catch((err) => {
      problems.push(`removing the trusted test certificates failed: ${err}`);
    });
  }
  return { reports, problems };
}

/** The trusted update's launches: install (refuse B, stage A, install), trial (confirm), relaunch. */
async function trustedLaunches(v1: string, bin: string, updateBase: string) {
  const reports: Report[] = [];
  const problems: string[] = [];
  // Its own parent folder: the updater's state file sits next to the install.
  const install = bundleIn(join(SCRATCH, "trusted-install"));
  await copyBundle(v1, install);
  const exe = await executableOf(install);
  const env = appEnv(bin);
  await writeRunnerState("trusted", updateBase);
  await Deno.remove(join(SCRATCH, "update-install.marker")).catch(() => {});
  const until = Date.now() + TIMEOUT_MS;

  log(`trusted update: launching the A-signed copy ${exe}`);
  const first = launch(exe, [], env, join(SCRATCH, "trusted.log"));
  const installReport = await waitForReport("trusted-install", exe, env, until);
  if (!installReport) {
    kill(first);
    return { reports, problems: ["trusted-install: no report"] };
  }
  reports.push(installReport);
  if (!installReport.results.every((r) => r.status === "pass")) {
    await waitGone(first) || kill(first);
    return { reports, problems };
  }
  if (!(await waitGone(first))) {
    kill(first);
    problems.push("trusted-install: the app did not quit for the install");
  }
  const installed = await Deno.readTextFile(join(SCRATCH, "update-install.marker")).catch(() => "");
  log(`trusted update: install answered ${installed || "(nothing)"}; waiting for the trial launch`);

  const trial = await waitForReport("trusted-trial", exe, env, until);
  if (!trial) {
    return {
      reports,
      problems: [...problems, `trusted-trial: no report (install answered ${installed || "-"})`],
    };
  }
  reports.push(trial);
  if (!(await waitGone(trial.pid))) problems.push("trusted-trial: the app did not quit");

  log("trusted update: relaunching the confirmed version; it must stay");
  const third = launch(exe, [], env, join(SCRATCH, "trusted-relaunch.log"));
  const relaunch = await waitForReport("trusted-relaunch", exe, env, until);
  if (!(await waitGone(third))) {
    kill(third);
    problems.push("trusted-relaunch: the app did not quit");
  } else if (third.exit!.code !== 0) {
    problems.push(`trusted-relaunch: the app exited with ${third.exit!.code}`);
  }
  if (!relaunch) return { reports, problems: [...problems, "trusted-relaunch: no report"] };
  reports.push(relaunch);
  return { reports, problems };
}

// --- cleanup -----------------------------------------------------------------------------------

/** Linux: the hidden XDG launcher the runtime wrote for the scheme, and its `xdg-mime` default. */
async function cleanupLinuxScheme(): Promise<void> {
  const home = Deno.env.get("HOME") ?? "";
  const apps = join(Deno.env.get("XDG_DATA_HOME") || join(home, ".local", "share"), "applications");
  for (const e of await Array.fromAsync(Deno.readDir(apps)).catch(() => [])) {
    const file = join(apps, e.name);
    const text = e.name.endsWith(".desktop") ? await Deno.readTextFile(file).catch(() => "") : "";
    if (text.includes(`x-scheme-handler/${LINK_SCHEME}`)) await Deno.remove(file);
  }
  const list = join(Deno.env.get("XDG_CONFIG_HOME") || join(home, ".config"), "mimeapps.list");
  const mime = await Deno.readTextFile(list).catch(() => null);
  const kept = mime?.split("\n").filter((l) => !l.startsWith(`x-scheme-handler/${LINK_SCHEME}=`));
  if (mime !== null && kept && kept.join("\n") !== mime) {
    await Deno.writeTextFile(list, kept.join("\n"));
  }
  await quiet("update-desktop-database", [apps]);
}

/** Windows: the link scheme and the notification activator (an AUMID key naming a COM CLSID
 * whose LocalServer32 starts the app) the runtime registered under HKCU. */
async function cleanupWindowsRegistry(): Promise<void> {
  await quiet("reg", ["delete", `HKCU\\Software\\Classes\\${LINK_SCHEME}`, "/f"]);
  const aumid = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`;
  const q = await new Deno.Command("reg", {
    args: ["query", aumid, "/v", "CustomActivator"],
    stdout: "piped",
    stderr: "null",
  }).output().catch(() => null);
  const clsid = q && /\{[0-9A-Fa-f-]{36}\}/.exec(new TextDecoder().decode(q.stdout))?.[0];
  if (clsid) await quiet("reg", ["delete", `HKCU\\Software\\Classes\\CLSID\\${clsid}`, "/f"]);
  await quiet("reg", ["delete", aumid, "/f"]);
}

/** Remove what the app registered with the OS for its link scheme (it registers on launch), and
 * the data it left in its own folders (the keychain entries are deleted by the checks). */
async function cleanupAfterRun(bundles: string[]): Promise<void> {
  const dirs = desktopAppDirs(APP_ID);
  for (const dir of [dirs.data, dirs.cache]) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
  if (OS === "windows") {
    await cleanupWindowsRegistry();
  } else if (OS === "darwin") {
    const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/" +
      "LaunchServices.framework/Support/lsregister";
    for (const app of bundles) await quiet(lsregister, ["-u", app]);
  } else {
    await cleanupLinuxScheme();
  }
}

// --- results -----------------------------------------------------------------------------------

/** Everything wrong with the reports (each check printed as it is judged). */
function judge(reports: Report[], extra: string[]): { results: RunResult[]; problems: string[] } {
  const problems = [...extra];
  const results: RunResult[] = [];
  for (const report of reports) {
    for (const r of report.results) {
      results.push({ phase: report.phase, ...r });
      const mark = { pass: "PASS", skip: "SKIP", fail: "FAIL" }[r.status];
      console.log(`${mark}  [${report.phase}] ${r.name}  (${r.ms} ms)  ${r.detail}`);
      if (r.status === "fail") problems.push(`${r.name}: ${r.detail}`);
      if (r.status === "skip" && !r.detail.trim()) {
        problems.push(`${r.name}: skipped with no reason`);
      }
    }
    const reported = new Set(report.results.map((r) => r.name));
    for (const name of report.expected) {
      if (!reported.has(name)) problems.push(`missing check: ${name}`);
    }
    const want = report.phase === "navigation"
      ? NAVIGATION_CHECKS
      : UPDATE_PHASES[report.phase as keyof typeof UPDATE_PHASES];
    if (want !== undefined && report.expected.length !== want) {
      problems.push(`${report.phase}: ${report.expected.length} checks (expected ${want})`);
    }
    const names = TRUSTED_PHASES[report.phase];
    if (names && report.expected.join("\n") !== names.join("\n")) {
      problems.push(`${report.phase}: the app's checks differ from TRUSTED_PHASES in the runner`);
    }
  }
  return { results, problems };
}

/** A Markdown table cell (no pipes or newlines). */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").slice(0, 300);

/** The job summary: counts, every check, and every skip with its reason. */
function markdownSummary(results: RunResult[], problems: string[]): string {
  const n = (s: string) => results.filter((r) => r.status === s).length;
  const lines = [
    `## Desktop window test: ${OS} ${Deno.build.arch}`,
    "",
    `${n("pass")} passed, ${n("skip")} skipped, ${n("fail")} failed; ` +
    `${problems.length} problem(s).`,
    "",
  ];
  const skips = results.filter((r) => r.status === "skip");
  if (skips.length) {
    lines.push("### Skipped (not possible here)", "");
    for (const r of skips) lines.push(`- **${cell(r.name)}**: ${cell(r.detail)}`);
    lines.push("");
  }
  if (problems.length) {
    lines.push("### Problems", "");
    for (const p of problems) lines.push(`- ${cell(p)}`);
    lines.push("");
  }
  lines.push(
    "<details><summary>Every check</summary>",
    "",
    "| Phase | Check | Result | Detail |",
    "| --- | --- | --- | --- |",
  );
  for (const r of results) {
    lines.push(
      `| ${r.phase} | ${cell(r.name)} | ${r.status.toUpperCase()} | ${cell(r.detail)} |`,
    );
  }
  lines.push("", "</details>", "");
  return lines.join("\n");
}

async function writeResults(results: RunResult[], problems: string[]): Promise<void> {
  await Deno.writeTextFile(
    join(SCRATCH, "results.json"),
    JSON.stringify(
      { os: OS, arch: Deno.build.arch, target: Deno.build.target, results, problems },
      null,
      2,
    ),
  );
  const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summary) {
    await Deno.writeTextFile(summary, markdownSummary(results, problems), { append: true });
  }
}

// --- main --------------------------------------------------------------------------------------

async function main(): Promise<void> {
  await Deno.remove(SCRATCH, { recursive: true }).catch(() => {});
  await Deno.mkdir(SCRATCH, { recursive: true });
  log(`${OS} ${Deno.build.arch}, deno ${Deno.version.deno}`);
  const withUpdate = !Deno.args.includes("--no-update");
  const noPackage = Deno.args.includes("--no-package");
  // Windows signing: why the phases cannot run here (`null`: they run while packaging).
  const signSkip = OS !== "windows"
    ? null
    : Deno.args.includes("--no-signing")
    ? "--no-signing"
    : noPackage
    ? "--no-package: the sign phase packages and signs its own builds"
    : null;
  let signing: Signing | null = OS === "windows" && signSkip ? skippedSigning(signSkip) : null;
  const reports: Report[] = [];
  const extra: string[] = [];
  try {
    let keys: { publicKey: string; privateKeyPem: string };
    if (noPackage) keys = await buildKey();
    else {
      const packaged = await packageApp(withUpdate, OS === "windows" && !signSkip);
      keys = packaged.keys;
      signing ??= packaged.signed;
    }
    if (signing) reports.push(signing.report);
    const bundle = bundleIn(join(ROOT, "dist"));
    const exe = await executableOf(bundle);
    log(`app: ${exe}`);
    appBackend = (await appUpdatePlatformKey(bundle)).includes("-cef") ? "cef" : "webview";
    await warnIfScreenLocked();
    const update = withUpdate ? bundleIn(UPDATE_DIST) : null;
    if (update && !(await exists(update))) {
      throw new Error(`no update build at ${update} (package without --no-package)`);
    }
    const bin = await installBrowserStub();
    const signed = withUpdate ? signing?.builds ?? null : null;
    const updates = await startUpdateServer(keys, bundle, update, signed);
    try {
      const main = await mainPhase(exe, bin, updates.base);
      reports.push(main.report);
      extra.push(...main.problems);
      const nav = await navigationPhase(exe, bin, updates.base);
      if (nav.report) reports.push(nav.report);
      extra.push(...nav.problems);
      if (update) {
        const up = await updatePhases(exe, bin, updates.base);
        reports.push(...up.reports);
        extra.push(...up.problems);
      }
      if (OS === "windows") {
        const trusted = withUpdate
          ? await trustedUpdate(signing, bin, updates.base)
          : { reports: skippedTrusted("--no-update"), problems: [] };
        reports.push(...trusted.reports);
        extra.push(...trusted.problems);
      }
    } catch (err) {
      extra.push(err instanceof Error ? err.message : String(err));
    } finally {
      updates.close();
      await cleanupAfterRun([
        bundle,
        bundleIn(join(SCRATCH, "install")),
        bundleIn(join(SCRATCH, "trusted-install")),
      ]).catch(() => {});
    }
  } finally {
    await cleanupSigning(currentSigning);
  }
  const { results, problems } = judge(reports, extra);
  await writeResults(results, problems);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  log(`${count("pass")} passed, ${count("skip")} skipped, ${problems.length} problem(s)`);
  if (problems.length === 0) return;
  for (const p of problems) console.error(`[window-test]   - ${p}`);
  log(`logs: ${SCRATCH}`);
  Deno.exit(1);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(`[window-test] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
