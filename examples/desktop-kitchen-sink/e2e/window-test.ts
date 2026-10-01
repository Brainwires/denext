// The kitchen sink's automated window test: package the app with the platform's packaging script
// (written from the current scaffold template; denext's pinned Deno Desktop runtime, least-privilege
// flags), launch the packaged app with a deep link and a file on its command line, start a second
// instance once the page asks for it, serve signed full-app update manifests on loopback, and wait
// for the page to report every check through the `kitchen` extension. Exits non-zero on any failed
// or missing check, a timeout, a second instance that does not hand over, or an app that does not
// quit.
//
//   deno task test:window                 # from examples/desktop-kitchen-sink
//   deno task test:window --no-package    # reuse the last dist/ build (and its update key)
//
// macOS: run it in a logged-in session (the window needs a screen). Linux: under a display, e.g.
// `xvfb-run -a deno task test:window`. Windows: in the interactive desktop session (over SSH, start
// it from an `/it` scheduled task). Env: KITCHEN_SINK_TIMEOUT_MS (default 240000).

import { fromFileUrl, join } from "@std/path";
import { generateOtaKeyPair, importOtaSigningKey } from "../../../src/build/ota-signing.ts";
import { type AppUpdatePayload, signAppUpdatePayload } from "../../../src/build/app-update.ts";
import { desktopAppDirs } from "../../../src/desktop/app-dirs.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const APP_ID = "dev.denext.kitchen-sink";
const APP_NAME = "KitchenSink"; // DENEXT_APP_NAME: a predictable dist/ path without spaces
const LINK_SCHEME = "kitchensink-link";
const OS = Deno.build.os;
const ARCH_LABEL = Deno.build.arch === "aarch64" ? "arm64" : "x64";
const TIMEOUT_MS = Number(Deno.env.get("KITCHEN_SINK_TIMEOUT_MS") ?? 240_000);
/** The page's check count (app/checks.ts); fewer means it shipped without some. */
const MIN_CHECKS = 32;
const OPEN_FILE_NAME = "open me.txt";
const OPEN_FILE_TEXT = "opened by the kitchen sink window test";
const PACKAGE_SCRIPTS: Record<string, string> = {
  darwin: "package-macos.ts",
  linux: "package-linux.ts",
  windows: "package-windows.ts",
};

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  ms: number;
}

interface Report {
  results: CheckResult[];
  expected: string[];
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

async function waitForFile(path: string, until: number): Promise<boolean> {
  while (Date.now() < until) {
    if (await exists(path)) return true;
    await sleep(250);
  }
  return false;
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

/** Where a build keeps the update key pair it was packaged with (the public half is baked in). */
const KEY_FILE = join(ROOT, "dist", "kitchen-sink-update-key.json");

/** The update key pair of the last build in dist/ (`--no-package`). */
async function buildKey(): Promise<{ publicKey: string; privateKeyPem: string }> {
  return JSON.parse(await Deno.readTextFile(KEY_FILE));
}

/** Write the packaging scripts from the current scaffold, then run this OS's (as `denext desktop
 * package` does) with a fresh throwaway update key baked in. Returns that key pair. */
async function packageApp(): Promise<{ publicKey: string; privateKeyPem: string }> {
  const script = PACKAGE_SCRIPTS[OS];
  if (!script) throw new Error(`unsupported OS ${OS}`);
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
  await run(
    ["deno", "run", "-A", `scripts/${script}`, ...(OS === "windows" ? ["--no-sign"] : [])],
    {
      DENEXT_APP_NAME: APP_NAME,
      KITCHEN_SINK_UPDATE_PUBLIC_KEY: keys.publicKey,
    },
  );
  await Deno.writeTextFile(KEY_FILE, JSON.stringify(keys));
  return keys;
}

/** macOS: the executable inside dist/<name>.app. */
async function macExecutable(dist: string): Promise<string> {
  const app = join(dist, `${APP_NAME}.app`);
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

/** The packaged executable dist/ holds for this OS. */
function packagedExecutable(): Promise<string> {
  const dist = join(ROOT, "dist");
  if (OS === "darwin") return macExecutable(dist);
  if (OS === "windows") {
    return Promise.resolve(
      join(dist, `${APP_NAME}-${ARCH_LABEL}`, `${APP_NAME}-${ARCH_LABEL}.exe`),
    );
  }
  return linuxExecutable(join(dist, `${APP_NAME}-${ARCH_LABEL}`));
}

/** One signed manifest payload offering `version` for this platform (never downloaded). */
function manifest(version: string): AppUpdatePayload {
  const platform = `${Deno.build.target}-webview`;
  return {
    schema: 1,
    app: APP_ID,
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

/** Signed manifests on loopback: a newer version, another key's signature, an older version. */
async function startUpdateServer(privateKeyPem: string): Promise<{ base: string; close(): void }> {
  const key = await importOtaSigningKey(privateKeyPem);
  const other = await importOtaSigningKey((await generateOtaKeyPair()).privateKeyPem);
  const sign = async (version: string, k: CryptoKey) =>
    JSON.stringify(await signAppUpdatePayload(manifest(version), k));
  const docs: Record<string, string> = {
    "/good.json": await sign("99.0.0", key),
    "/bad-signature.json": await sign("99.0.0", other),
    "/downgrade.json": await sign("0.0.1", key),
  };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const body = docs[new URL(req.url).pathname];
    return body
      ? new Response(body, { headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
  });
  return { base: `http://127.0.0.1:${server.addr.port}/`, close: () => void server.shutdown() };
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

/** Once the page asks (its link listener runs), start a second instance with a link; it must hand
 * the link to the running app and exit 0. Returns its exit code, or `null` when never asked. */
async function secondLaunch(
  exe: string,
  env: Record<string, string>,
  scratch: string,
  until: number,
): Promise<number | null> {
  if (!(await waitForFile(join(scratch, "ready-for-warm.marker"), until))) return null;
  log("the page is ready for a second launch; starting one with a link");
  const second = launch(exe, [`${LINK_SCHEME}://open/warm`], env, join(scratch, "second.log"));
  const timer = setTimeout(() => kill(second), 20_000);
  const { code } = await second.child.status;
  clearTimeout(timer);
  await second.done;
  log(`the second instance exited with ${code}`);
  return code;
}

const quiet = (cmd: string, args: string[]) =>
  new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).output().catch(() => {});

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

/** Remove what the app registered with the OS for its link scheme (it registers on launch), and
 * the data it left in its own folders (the keychain entry is deleted by the check itself). */
async function cleanupAfterRun(exe: string): Promise<void> {
  const dirs = desktopAppDirs(APP_ID);
  for (const dir of [dirs.data, dirs.cache]) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
  if (OS === "windows") {
    await quiet("reg", ["delete", `HKCU\\Software\\Classes\\${LINK_SCHEME}`, "/f"]);
  } else if (OS === "darwin") {
    const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/" +
      "LaunchServices.framework/Support/lsregister";
    await quiet(lsregister, ["-u", exe.slice(0, exe.indexOf(".app/") + 4)]);
  } else {
    await cleanupLinuxScheme();
  }
}

/** Everything wrong with a finished run (empty: it passed), printing each check. */
function problemsOf(report: Report, secondCode: number | null, app: Launched): string[] {
  const problems: string[] = [];
  for (const r of report.results) {
    const mark = { pass: "PASS", skip: "SKIP", fail: "FAIL" }[r.status];
    console.log(`${mark}  ${r.name}  (${r.ms} ms)  ${r.detail}`);
    if (r.status === "fail") problems.push(`${r.name}: ${r.detail}`);
  }
  const reported = new Set(report.results.map((r) => r.name));
  if (report.expected.length < MIN_CHECKS) {
    problems.push(`only ${report.expected.length} checks are defined (expected ${MIN_CHECKS})`);
  }
  for (const name of report.expected) {
    if (!reported.has(name)) problems.push(`missing check: ${name}`);
  }
  if (secondCode !== 0) problems.push(`the second instance exited with ${secondCode} (want 0)`);
  if (!app.exit) problems.push("the app did not quit within 20 s of reporting");
  else if (app.exit.code !== 0) problems.push(`the app exited with ${app.exit.code}`);
  return problems;
}

/** Launch, drive the second instance, and wait for the report and the quit. */
async function drive(exe: string, scratch: string, updateBase: string) {
  const fixture = join(scratch, OPEN_FILE_NAME);
  await Deno.writeTextFile(fixture, OPEN_FILE_TEXT);
  const env = {
    KITCHEN_SINK_AUTORUN: "1",
    KITCHEN_SINK_OUT: scratch,
    KITCHEN_SINK_UPDATE_BASE: updateBase,
  };
  const until = Date.now() + TIMEOUT_MS;
  const app = launch(
    exe,
    [`${LINK_SCHEME}://open/cold?x=1`, fixture],
    env,
    join(scratch, "app.log"),
  );
  log(`launched pid ${app.child.pid}; waiting for the page (timeout ${TIMEOUT_MS} ms)`);
  const secondCode = await secondLaunch(exe, env, scratch, until);
  const reportFile = join(scratch, "kitchen-sink-report.json");
  if (!(await waitForFile(reportFile, until))) {
    kill(app);
    throw new Error(`no report within ${TIMEOUT_MS} ms (app log: ${join(scratch, "app.log")})`);
  }
  // The page quits the app after reporting.
  const quitBy = Date.now() + 20_000;
  while (!app.exit && Date.now() < quitBy) await sleep(250);
  if (!app.exit) kill(app);
  await app.done.catch(() => {});
  const report = JSON.parse(await Deno.readTextFile(reportFile)) as Report;
  return { report, secondCode, app };
}

async function main(): Promise<void> {
  const scratch = join(ROOT, "e2e", ".run");
  await Deno.remove(scratch, { recursive: true }).catch(() => {});
  await Deno.mkdir(scratch, { recursive: true });
  log(`${OS} ${Deno.build.arch}, deno ${Deno.version.deno}`);
  const keys = Deno.args.includes("--no-package") ? await buildKey() : await packageApp();
  const exe = await packagedExecutable();
  log(`app: ${exe}`);
  const updates = await startUpdateServer(keys.privateKeyPem);
  let outcome;
  try {
    outcome = await drive(exe, scratch, updates.base);
  } finally {
    updates.close();
    await cleanupAfterRun(exe).catch(() => {});
  }
  const problems = problemsOf(outcome.report, outcome.secondCode, outcome.app);
  const count = (s: string) => outcome.report.results.filter((r) => r.status === s).length;
  log(`${count("pass")} passed, ${count("skip")} skipped, ${problems.length} problem(s)`);
  if (problems.length === 0) return;
  for (const p of problems) console.error(`[window-test]   - ${p}`);
  log(`app log: ${join(scratch, "app.log")}`);
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
