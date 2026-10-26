// Run a project's generated `build` and `start` tasks the way `deno task` would, against this
// checkout's CLI: the task's own permission flags (so a change to them is tested too), the app's
// own config, and a fetch of one page from the started server.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { spawnExclusive } from "../../src/build/serial-child.ts";
import { addrInUse, onFreePort } from "./port.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));

/** The deno.json part these helpers read: the tasks. */
export interface TaskConfig {
  tasks: Record<string, string>;
}

/** A denext CLI word in a task: the JSR one, or a checkout's `cli.ts` (`--denext-local-path`). */
const CLI_WORD = /^(?:jsr:@denext\/denext@[^/]+\/cli|file:\/\/\S+\/cli\.ts)$/;

/**
 * A `deno run <flags> jsr:@denext/denext@…/cli <args>` task (or one naming a checkout's
 * `cli.ts`) as `deno` arguments that run this checkout's CLI with the same permission flags and
 * verb arguments, under the app's own config.
 */
function taskArgs(task: string, dir: string): { flags: string[]; args: string[] } {
  const words = task.trim().split(/\s+/);
  assertEquals(words.slice(0, 2), ["deno", "run"], task);
  const cli = words.findIndex((w) => CLI_WORD.test(w));
  assert(cli > 1, `no denext CLI in the task: ${task}`);
  return {
    flags: words.slice(2, cli),
    args: ["--config", join(dir, "deno.json"), join(FW, "cli.ts"), ...words.slice(cli + 1)],
  };
}

/** The `deno` a task runs on, and its environment. */
export interface Runner {
  readonly deno: string;
  readonly env: Record<string, string>;
}

/** The Deno running this suite. */
export const STOCK: Runner = { deno: Deno.execPath(), env: { NO_COLOR: "1" } };

/** Run the app's `build` task's flags to completion; fail with its output. */
export async function buildTask(dir: string, cfg: TaskConfig, run: Runner = STOCK): Promise<void> {
  const { flags, args } = taskArgs(cfg.tasks.build, dir);
  const out = await new Deno.Command(run.deno, {
    args: ["run", ...flags, ...args],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
    env: run.env,
  }).output();
  const dec = new TextDecoder();
  assertEquals(out.code, 0, `build failed:\n${dec.decode(out.stdout)}${dec.decode(out.stderr)}`);
}

/** A start that lost its port to another process between the pick and the bind. */
class PortTaken extends Error {}

/**
 * Run the `start` task's exact flags, fetch `/`, and stop the server; the page and output. A port
 * taken between the pick and the bind is retried on another.
 */
export async function startTask(
  dir: string,
  cfg: TaskConfig,
  run: Runner = STOCK,
  path = "/",
): Promise<{ html: string; output: string }> {
  const { flags, args } = taskArgs(cfg.tasks.start, dir);
  assert(!flags.some((f) => f === "-A" || f.startsWith("--allow-run")), cfg.tasks.start);
  return await onFreePort(async (port) => {
    const served = await startTaskOn(port, dir, run, flags, args, path);
    if (!served.html && addrInUse(served.output)) throw new PortTaken(served.output);
    return served;
  }, { retryIf: (err) => err instanceof PortTaken });
}

/** {@linkcode startTask} on `port`. */
async function startTaskOn(
  port: number,
  dir: string,
  run: Runner,
  flags: string[],
  args: string[],
  path: string,
): Promise<{ html: string; output: string }> {
  // A long-lived child: on Windows it is never created while this process's `deno info` /
  // `deno bundle` children hold pipes it would inherit (src/build/serial-child.ts).
  const child = await spawnExclusive(() =>
    new Deno.Command(run.deno, {
      args: ["run", ...flags, ...args, "--port", String(port)],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
      env: run.env,
    }).spawn()
  );
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  let exited = false;
  child.status.then(() => exited = true);
  let html = "";
  try {
    // Generous: a loaded machine takes a while to load the app's modules.
    for (let i = 0; i < 1200 && !exited && !html; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        const text = await res.text();
        if (res.status === 200) html = text;
      } catch { /* not listening yet */ }
      if (!html) await new Promise((r) => setTimeout(r, 100));
    }
    // A second request once the first was delivered: Deno's legacy-abort notice prints on the
    // first response whose signal was read, so it is in the output by now if it is coming.
    if (html) await (await fetch(`http://127.0.0.1:${port}/`)).body?.cancel();
  } finally {
    if (!exited) child.kill("SIGTERM");
    await child.status;
    await drained;
  }
  return { html, output };
}
