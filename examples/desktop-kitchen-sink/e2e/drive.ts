// The kitchen sink's drive mode from the command line: launch the packaged app in drive mode and
// run its manual checks (dialogs, a notification click, the secure store, the tray, the title bar,
// the window states, deep links) as commands, with no one at the screen and no input injection
// (xdotool). Each command waits for the page's answer and prints it as JSON; the protocol and the
// folder layout are in `app/drive/protocol.ts`.
//
//   deno task drive start [--exe <app>]   # launch dist/'s build in drive mode
//   deno task drive <command> ['<json args>'] [--timeout <ms>]
//   deno task drive commands              # what the page runs
//   deno task drive events [--wait <EVENT> [--since <ISO time>]] [--timeout <ms>]
//   deno task drive click-notification    # the newest one (dunstctl / makoctl), then its TAPPED
//   deno task drive stop                  # quit the app, leave drive mode
//
// `--dir <dir>` picks the drive folder (default `e2e/.drive`). The app is the build
// `deno task test:window` leaves in dist/ (`--exe` for another). A command exits 0 with its result,
// 1 when the page answered an error, 2 on a timeout (default 30 s; a dialog a person must answer
// needs more). Anything else that writes a command file into `<dir>/queue/` drives it too.

import { join, resolve } from "@std/path";
import { desktopAppDirs } from "../../../src/desktop/app-dirs.ts";
import {
  DRIVE_COMMANDS,
  DRIVE_FILE,
  type DriveEvent,
  type DriveResult,
  queueFileName,
} from "../app/drive/protocol.ts";
import { parseFlags } from "./cli-args.ts";
import { APP_ID, bundleIn, executableOf, ROOT } from "./window-test.ts";

/** The runner's file: while it is in the data folder, the app ignores drive mode. */
const RUNNER_FILE = "kitchen-sink-runner.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string, code = 1): never {
  console.error(`drive: ${message}`);
  Deno.exit(code);
}

async function readJson<T>(file: string): Promise<T | null> {
  const text = await Deno.readTextFile(file).catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null; // being written: read it again
  }
}

/** Whether a process is still running. */
async function alive(pid: number): Promise<boolean> {
  if (Deno.build.os === "windows") {
    const out = await new Deno.Command("tasklist", {
      args: ["/FI", `PID eq ${pid}`, "/NH"],
      stdout: "piped",
      stderr: "null",
    }).output().catch(() => null);
    return out !== null && new TextDecoder().decode(out.stdout).includes(` ${pid} `);
  }
  const out = await new Deno.Command("kill", { args: ["-0", String(pid)], stderr: "null" })
    .output().catch(() => null);
  return out?.success === true;
}

let seq = 0;

/** Queue `cmd` and wait for its answer. */
async function send(
  dir: string,
  cmd: string,
  args: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<DriveResult | null> {
  const id = `c${Date.now().toString(36)}-${(seq++).toString(36)}-${
    crypto.randomUUID().slice(0, 8)
  }`;
  const queue = join(dir, "queue");
  await Deno.mkdir(queue, { recursive: true });
  const file = join(queue, queueFileName(Date.now(), seq, id));
  await Deno.writeTextFile(`${file}.tmp`, JSON.stringify({ id, cmd, ...(args ? { args } : {}) }));
  await Deno.rename(`${file}.tmp`, file);
  const result = join(dir, "results", `${id}.json`);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const answer = await readJson<DriveResult>(result);
    if (answer) return answer;
    await sleep(100);
  }
  return null;
}

/** Launch the app in drive mode and wait until its page takes commands. */
async function start(dir: string, exe: string | undefined, timeoutMs: number): Promise<void> {
  const app = exe ?? await executableOf(bundleIn(join(ROOT, "dist"))).catch(() => null);
  if (!app) {
    fail("no build in dist/: run `deno task test:window` (or --no-update) once, or pass --exe");
  }
  for (const sub of ["queue", "results"]) {
    await Deno.remove(join(dir, sub), { recursive: true }).catch(() => {});
    await Deno.mkdir(join(dir, sub), { recursive: true });
  }
  for (const f of ["events.jsonl", "ready.json"]) await Deno.remove(join(dir, f)).catch(() => {});
  const data = desktopAppDirs(APP_ID).data;
  await Deno.mkdir(data, { recursive: true });
  if (await Deno.remove(join(data, RUNNER_FILE)).then(() => true, () => false)) {
    console.error("drive: removed the runner file an interrupted window test left");
  }
  await Deno.writeTextFile(join(data, DRIVE_FILE), JSON.stringify({ dir }));
  const log = join(dir, "app.log");
  // Detached: the app outlives this command, its output appended to app.log.
  const child = Deno.build.os === "windows"
    ? new Deno.Command(app, { stdin: "null", stdout: "null", stderr: "null" }).spawn()
    : new Deno.Command("sh", {
      args: ["-c", 'exec "$0" >>"$1" 2>&1', app, log],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
  child.unref();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ready = await readJson<{ pid: number; href: string }>(join(dir, "ready.json"));
    if (ready) {
      console.log(JSON.stringify({ started: true, dir, log, ...ready }, null, 2));
      return;
    }
    const exited = await Promise.race([child.status, sleep(250).then(() => null)]);
    if (exited) fail(`the app exited with ${exited.code} before taking commands (log: ${log})`);
  }
  fail(`the page took no command within ${timeoutMs} ms (log: ${log})`, 2);
}

/** Quit the app and leave drive mode. */
async function stop(dir: string, timeoutMs: number): Promise<void> {
  const ready = await readJson<{ pid: number }>(join(dir, "ready.json"));
  const answer = ready && await alive(ready.pid)
    ? await send(dir, "quit", undefined, timeoutMs)
    : null;
  if (ready) {
    const until = Date.now() + 20_000;
    while (await alive(ready.pid) && Date.now() < until) await sleep(250);
    if (await alive(ready.pid)) {
      Deno.kill(ready.pid, "SIGTERM");
      console.error(`drive: the app (pid ${ready.pid}) did not quit; sent SIGTERM`);
    }
  }
  await Deno.remove(join(desktopAppDirs(APP_ID).data, DRIVE_FILE)).catch(() => {});
  await Deno.remove(join(dir, "ready.json")).catch(() => {});
  console.log(JSON.stringify({ stopped: true, quit: answer?.ok ?? false }));
}

/** Every event so far. */
async function readEvents(dir: string): Promise<DriveEvent[]> {
  const text = await Deno.readTextFile(join(dir, "events.jsonl")).catch(() => "");
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as DriveEvent);
}

/** The first `event` at or after `since` (ISO time), waiting up to `timeoutMs` for it. */
async function waitForEvent(
  dir: string,
  event: string,
  since: string,
  timeoutMs: number,
): Promise<DriveEvent | null> {
  const until = Date.now() + timeoutMs;
  do {
    const hit = (await readEvents(dir)).find((e) => e.event === event && e.at >= since);
    if (hit) return hit;
    await sleep(200);
  } while (Date.now() < until);
  return null;
}

/** Print the events, or wait for the first `wait` one at or after `since`. */
async function events(
  dir: string,
  wait: string | undefined,
  since: string,
  timeoutMs: number,
): Promise<void> {
  if (!wait) {
    for (const e of await readEvents(dir)) console.log(JSON.stringify(e));
    return;
  }
  const hit = await waitForEvent(dir, wait, since, timeoutMs);
  if (!hit) fail(`no ${wait} event${since ? ` since ${since}` : ""} within ${timeoutMs} ms`, 2);
  console.log(JSON.stringify(hit, null, 2));
}

/**
 * Click the newest notification through the notification server's own command-line tool, then
 * wait for the page's TAPPED event of that click.
 */
async function clickNotification(dir: string, timeoutMs: number): Promise<void> {
  // A second of slack: the server's clock and the page's are the same, but not its rounding.
  const since = new Date(Date.now() - 1000).toISOString();
  for (const [tool, args] of [["dunstctl", ["action", "0"]], ["makoctl", ["invoke"]]] as const) {
    const out = await new Deno.Command(tool, { args: [...args], stdout: "piped", stderr: "piped" })
      .output().catch(() => null);
    if (out === null) continue; // not installed
    if (!out.success) fail(`${tool} ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
    const tapped = await waitForEvent(dir, "TAPPED", since, timeoutMs);
    console.log(
      JSON.stringify({ clicked: true, via: `${tool} ${args.join(" ")}`, tapped }, null, 2),
    );
    if (!tapped) fail(`clicked, but the page saw no TAPPED event within ${timeoutMs} ms`, 2);
    return;
  }
  fail(
    "no notification server with a command-line click here (dunst: dunstctl, mako: makoctl); " +
      "click the notification on the screen",
  );
}

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(Deno.args);
  const dir = resolve(flags.dir || join(ROOT, "e2e", ".drive"));
  const timeoutMs = flags.timeout ? Number(flags.timeout) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout must be a number of ms");
  const [verb, json] = positional;
  switch (verb) {
    case undefined:
    case "commands":
      for (const [name, help] of Object.entries(DRIVE_COMMANDS)) console.log(`${name}  ${help}`);
      return;
    case "start":
      return await start(dir, flags.exe || undefined, Math.max(timeoutMs, 60_000));
    case "stop":
      return await stop(dir, timeoutMs);
    case "events":
      return await events(dir, flags.wait || undefined, flags.since ?? "", timeoutMs);
    case "click-notification":
      return await clickNotification(dir, timeoutMs);
  }
  let args: Record<string, unknown> | undefined;
  if (json !== undefined) {
    try {
      args = JSON.parse(json);
    } catch {
      fail(`the arguments are not JSON: ${json}`);
    }
  }
  if (!(await readJson(join(dir, "ready.json")))) {
    fail(`no app in drive mode on ${dir} (deno task drive start)`);
  }
  const answer = await send(dir, verb, args, timeoutMs);
  if (!answer) fail(`no answer to ${verb} within ${timeoutMs} ms`, 2);
  console.log(JSON.stringify(answer, null, 2));
  if (!answer.ok) Deno.exit(1);
}

if (import.meta.main) await main();
