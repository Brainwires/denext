// The kitchen sink's automated window test: package the app with the platform's packaging script
// (written from the current scaffold template; denext's pinned Deno Desktop runtime, least-privilege
// flags), launch the packaged app with a deep link and a file on its command line, start the second
// instances the page asks for, serve signed full-app update manifests on loopback, and wait for the
// page to report every check through the `kitchen` extension. Then the full-app update itself: a
// copy of the app downloads, verifies and installs a second build (99.0.0, same throwaway key), the
// new version's trial launch deliberately does not confirm, and the next launch must roll it back.
// Exits non-zero on any failed or missing check, a skip without a reason, a timeout, or an app that
// does not quit.
//
//   deno task test:window                 # from examples/desktop-kitchen-sink
//   deno task test:window --no-package    # reuse the last dist/ builds (and their update key)
//   deno task test:window --no-update     # skip the full-app update install / rollback phases
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

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const SCRATCH = join(ROOT, "e2e", ".run");
const APP_ID = "dev.denext.kitchen-sink";
const APP_NAME = "KitchenSink"; // DENEXT_APP_NAME: a predictable dist/ path without spaces
const LINK_SCHEME = "kitchensink-link";
const OS = Deno.build.os;
const ARCH_LABEL = Deno.build.arch === "aarch64" ? "arm64" : "x64";
const TIMEOUT_MS = Number(Deno.env.get("KITCHEN_SINK_TIMEOUT_MS") ?? 240_000);
/** The page's main-phase check count (app/checks.ts); fewer means it shipped without some. */
const MIN_CHECKS = 54;
/** The checks each full-app update phase reports (app/checks.ts `PHASE_CHECKS`). */
const UPDATE_PHASES = { "update-install": 2, "update-trial": 1, "update-rollback": 2 } as const;
/** The version the update build is packaged as (app/checks.ts `UPDATE_VERSION`). */
const UPDATE_VERSION = "99.0.0";
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

/** Run this OS's packaging script with the update key baked in. */
async function runPackageScript(publicKey: string): Promise<void> {
  const script = PACKAGE_SCRIPTS[OS];
  if (!script) throw new Error(`unsupported OS ${OS}`);
  await run(
    ["deno", "run", "-A", `scripts/${script}`, ...(OS === "windows" ? ["--no-sign"] : [])],
    { DENEXT_APP_NAME: APP_NAME, KITCHEN_SINK_UPDATE_PUBLIC_KEY: publicKey },
  );
}

/** Package the update build: the same app as version 99.0.0 (deno.json's `version`, restored). */
async function packageUpdateBuild(publicKey: string): Promise<void> {
  const denoJson = join(ROOT, "deno.json");
  const original = await Deno.readTextFile(denoJson);
  const versioned = original.replace(/"version": "1\.0\.0"/, `"version": "${UPDATE_VERSION}"`);
  if (versioned === original) throw new Error('deno.json has no "version": "1.0.0"');
  await Deno.writeTextFile(denoJson, versioned);
  try {
    await runPackageScript(publicKey);
  } finally {
    await Deno.writeTextFile(denoJson, original);
  }
  await Deno.remove(UPDATE_DIST, { recursive: true }).catch(() => {});
  await Deno.mkdir(UPDATE_DIST, { recursive: true });
  await Deno.rename(bundleIn(join(ROOT, "dist")), bundleIn(UPDATE_DIST));
}

/** Write the packaging scripts from the current scaffold, then package the update build and the
 * app (as `denext desktop package` does) with one fresh throwaway update key baked into both.
 * Returns that key pair. */
async function packageApp(withUpdate: boolean): Promise<
  { publicKey: string; privateKeyPem: string }
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
  await runPackageScript(keys.publicKey);
  await Deno.writeTextFile(KEY_FILE, JSON.stringify(keys));
  return keys;
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
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || /\.so(\.|$)/.test(e.name)) continue;
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

/** One signed manifest payload offering `version` of `app` for this platform (never downloaded). */
function manifest(version: string, app = APP_ID): AppUpdatePayload {
  const platform = `${Deno.build.target}-webview`;
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
 * another app, and (with the update build) a real update whose archive is served here too.
 */
async function startUpdateServer(
  keys: { privateKeyPem: string; publicKey: string },
  update: string | null,
) {
  const key = await importOtaSigningKey(keys.privateKeyPem);
  const other = await importOtaSigningKey((await generateOtaKeyPair()).privateKeyPem);
  const docs: Record<string, string> = {};
  const archiveFile = join(SCRATCH, "update.tar.gz");
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/update.tar.gz" && update) {
      return new Response((await Deno.open(archiveFile)).readable, {
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
  docs["/good.json"] = await sign(manifest("99.0.0"), key);
  docs["/bad-signature.json"] = await sign(manifest("99.0.0"), other);
  docs["/downgrade.json"] = await sign(manifest("0.0.1"), key);
  docs["/wrong-app.json"] = await sign(manifest("99.0.0", "dev.denext.another-app"), key);
  if (update) {
    log(`packing the update build ${update}`);
    const { sha256, size } = await writeAppUpdateArchive(update, archiveFile);
    const platform = await appUpdatePlatformKey(update);
    docs["/real.json"] = await signLoopbackPayload(
      {
        schema: 1,
        app: APP_ID,
        version: UPDATE_VERSION,
        platforms: { [platform]: { url: `${base}update.tar.gz`, sha256, size, kind: "bundle" } },
        releaseNotes: "kitchen sink window test: the update build",
        publishedAt: new Date().toISOString(),
      },
      key,
      keys.publicKey,
    );
  }
  return { base, close: () => void server.shutdown() } satisfies UpdateServer;
}

// --- launching ---------------------------------------------------------------------------------

/** What the app reads at launch to know the runner started it (see `desktop/kitchen.ts`). */
async function writeRunnerState(phase: "main" | "update", updateBase: string): Promise<void> {
  const dir = desktopAppDirs(APP_ID).data;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "kitchen-sink-runner.json"),
    JSON.stringify({ out: SCRATCH, phase, updateBase }),
  );
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
    throw new Error(`no report within ${TIMEOUT_MS} ms (app log: ${join(SCRATCH, "app.log")})`);
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
    const want = UPDATE_PHASES[report.phase as keyof typeof UPDATE_PHASES];
    if (want !== undefined && report.expected.length !== want) {
      problems.push(`${report.phase}: ${report.expected.length} checks (expected ${want})`);
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
  const keys = Deno.args.includes("--no-package") ? await buildKey() : await packageApp(withUpdate);
  const bundle = bundleIn(join(ROOT, "dist"));
  const exe = await executableOf(bundle);
  log(`app: ${exe}`);
  const update = withUpdate ? bundleIn(UPDATE_DIST) : null;
  if (update && !(await exists(update))) {
    throw new Error(`no update build at ${update} (package without --no-package)`);
  }
  const bin = await installBrowserStub();
  const updates = await startUpdateServer(keys, update);
  const reports: Report[] = [];
  const extra: string[] = [];
  try {
    const main = await mainPhase(exe, bin, updates.base);
    reports.push(main.report);
    extra.push(...main.problems);
    if (update) {
      const up = await updatePhases(exe, bin, updates.base);
      reports.push(...up.reports);
      extra.push(...up.problems);
    }
  } catch (err) {
    extra.push(err instanceof Error ? err.message : String(err));
  } finally {
    updates.close();
    await cleanupAfterRun([bundle, bundleIn(join(SCRATCH, "install"))]).catch(() => {});
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
