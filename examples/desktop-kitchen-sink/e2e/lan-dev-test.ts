// The kitchen sink's `denext desktop dev --lan` test: start the live-reload window against a
// `denext dev` bound to this machine's LAN address and assert that the proxied page still holds
// the desktop bridge — the per-launch token is injected, and `secureStore` round-trips through the
// OS store (the `lan-dev` phase in `app/checks.ts`). While the session runs it also proves the dev
// server's own gate is intact: a request from the LAN address without the per-run session token is
// refused (403).
//
// The page reports through the `kitchen` extension and quits; the window's exit ends `desktop dev`,
// which stops the dev server it started. Exits non-zero on a failed or missing check, an ungated
// dev server, a timeout, or a session that does not end.
//
//   deno task test:lan-dev                                   # from examples/desktop-kitchen-sink
//   e2e/wm-session.sh --wayland sway -- deno task test:lan-dev  # headless Linux (Wayland)
//   e2e/linux-session.sh deno task test:lan-dev                 # headless Linux (Xvfb)
//
// It needs a LAN IPv4 address (`desktop dev --lan` refuses without one) and a Secret Service on
// Linux. Env: KITCHEN_SINK_TIMEOUT_MS (default 240000), KITCHEN_SINK_LAN_PORT (default 3217).

import { join } from "@std/path";
import { desktopAppDirs } from "../../../src/desktop/app-dirs.ts";
import { APP_ID, ROOT } from "./window-test.ts";

const SCRATCH = join(ROOT, "e2e", ".run");
const PHASE = "lan-dev";
const TIMEOUT_MS = Number(Deno.env.get("KITCHEN_SINK_TIMEOUT_MS") ?? 240_000);
const PORT = Number(Deno.env.get("KITCHEN_SINK_LAN_PORT") ?? 3217);
const CLI = join(ROOT, "..", "..", "cli.ts");

interface CheckResult {
  readonly name: string;
  readonly status: "pass" | "fail" | "skip";
  readonly detail: string;
}

interface Report {
  readonly results: CheckResult[];
  readonly expected: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(line: string): void {
  console.error(`lan-dev-test: ${line}`);
}

/** The Linux session type the page falls back to (see `desktop/kitchen.ts`). */
function sessionType(): "wayland" | "x11" | "tty" | null {
  if (Deno.build.os !== "linux") return null;
  const type = Deno.env.get("XDG_SESSION_TYPE");
  if (type === "wayland" || type === "x11" || type === "tty") return type;
  if (Deno.env.get("WAYLAND_DISPLAY")) return "wayland";
  return Deno.env.get("DISPLAY") ? "x11" : null;
}

/** Tell the app the runner started it, in the `lan-dev` phase. */
async function writeRunnerState(): Promise<void> {
  const dir = desktopAppDirs(APP_ID).data;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "kitchen-sink-runner.json"),
    JSON.stringify({ out: SCRATCH, phase: PHASE, updateBase: null, sessionType: sessionType() }),
  );
}

/** The dev server URL `desktop dev` printed (`the window loads http://…`), once it appears. */
function bannerUrl(output: string): URL | null {
  const m = /the window loads (http:\/\/\S+)/.exec(output);
  return m ? new URL(m[1]) : null;
}

/**
 * The dev server's gate, from the LAN address it is bound to: a request without the session token
 * is refused (403), one with it is not.
 */
async function checkDevGate(devUrl: URL): Promise<string[]> {
  const problems: string[] = [];
  const bare = new URL(devUrl.pathname, devUrl.origin);
  const refused = await fetch(bare, { redirect: "manual" });
  await refused.body?.cancel();
  if (refused.status !== 403) {
    problems.push(`the LAN dev server answered ${refused.status} without its session token`);
  }
  const token = devUrl.searchParams.get("__denext_dev");
  if (!token) problems.push("the dev URL desktop dev handed the window carries no session token");
  else {
    const ok = await fetch(bare, { headers: { "x-denext-dev-token": token }, redirect: "manual" });
    await ok.body?.cancel();
    if (ok.status === 403) problems.push("the LAN dev server refused its own session token");
  }
  return problems;
}

async function main(): Promise<void> {
  await Deno.mkdir(SCRATCH, { recursive: true });
  const reportFile = join(SCRATCH, `kitchen-sink-report-${PHASE}.json`);
  await Deno.remove(reportFile).catch(() => {});
  await writeRunnerState();
  const logFile = join(SCRATCH, "lan-dev.log");
  const out = await Deno.open(logFile, { create: true, write: true, truncate: true });
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", CLI, "desktop", "dev", "--lan", "--port", String(PORT), "."],
    cwd: ROOT,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  log(`desktop dev --lan started (pid ${child.pid}); log: ${logFile}`);
  let output = "";
  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      await out.write(chunk);
    }
  };
  const pumped = Promise.all([pump(child.stdout), pump(child.stderr)]);
  let exited = false;
  const status = child.status.then((s) => {
    exited = true;
    return s;
  });

  const problems: string[] = [];
  let report: Report | null = null;
  let gateChecked = false;
  const until = Date.now() + TIMEOUT_MS;
  try {
    while (Date.now() < until && !exited) {
      const devUrl = bannerUrl(output);
      if (devUrl && !gateChecked) {
        gateChecked = true;
        if (devUrl.hostname === "localhost" || devUrl.hostname.startsWith("127.")) {
          problems.push(`desktop dev --lan targets a loopback dev server (${devUrl.host})`);
        }
        problems.push(...await checkDevGate(devUrl));
        log(`the window loads ${devUrl.host}; the dev server's gate was checked`);
      }
      if (await Deno.stat(reportFile).then(() => true, () => false)) {
        report = JSON.parse(await Deno.readTextFile(reportFile)) as Report;
        break;
      }
      await sleep(250);
    }
    if (!report) {
      problems.push(
        exited
          ? "desktop dev exited before the page reported"
          : `no report within ${TIMEOUT_MS} ms`,
      );
    }
    if (!gateChecked) problems.push("desktop dev never printed the dev server it loads");
    // The page quits after reporting; the window's exit ends `desktop dev`.
    if (report) {
      const ended = await Promise.race([status.then(() => true), sleep(30_000).then(() => false)]);
      if (!ended) problems.push("desktop dev did not exit within 30 s of the page quitting");
    }
  } finally {
    if (!exited) {
      try {
        child.kill("SIGTERM"); // this exact child: `desktop dev` stops its window and dev server
      } catch { /* already gone */ }
      await status;
    }
    await Promise.race([pumped, sleep(2000)]);
    out.close();
  }

  for (const r of report?.results ?? []) {
    log(`${r.status.padEnd(4)} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.status !== "pass") problems.push(`${r.name}: ${r.status} (${r.detail})`);
  }
  const ran = new Set(report?.results.map((r) => r.name));
  for (const name of report?.expected ?? []) {
    if (!ran.has(name)) problems.push(`${name}: did not run`);
  }
  if (report && report.expected.length === 0) problems.push("the lan-dev phase defines no checks");
  await Deno.remove(join(desktopAppDirs(APP_ID).data, "kitchen-sink-runner.json")).catch(() => {});
  if (problems.length > 0) {
    const errors = output.split("\n").filter((l) => /error|denext:/i.test(l)).slice(-20);
    if (errors.length > 0) log(`desktop dev errors (last 20):\n${errors.join("\n")}`);
    log(`the whole output: ${logFile}`);
    for (const p of problems) log(`FAIL ${p}`);
    Deno.exit(1);
  }
  log(`ok: ${report!.results.length} checks passed under desktop dev --lan`);
}

if (import.meta.main) await main();
