// The esbuild loader's own `deno info` children, run like denext's: one at a time, read until they
// exit, killed at a deadline and retried once.
//
// `@luca/esbuild-deno-loader`'s native loader learns each module's graph from
// `new Deno.Command(Deno.execPath(), { args: ["info", "--json", …] }).output()` (its `src/deno.ts`:
// `info()` for a batch of specifiers, `rootInfo()` for the cache directories). That call has no
// deadline, runs outside denext's serialized-child queue (serial-child.ts), and `output()` waits
// for the child's pipes to reach EOF. On Windows a `deno info` beside other Deno children (the
// esbuild service, a `deno info` or `deno bundle` of another build) sometimes never exits, and a
// long-lived process created meanwhile can inherit its pipe and hold it open (exited-output.ts):
// either way the build waits forever. The loader takes no hook for its child, so while one of its
// plugin callbacks runs (an async scope that follows its awaits and timers), `Deno.Command#output`
// for a `deno info` of this executable goes through {@linkcode retryOnStall} +
// {@linkcode boundedOutput} instead: the module-graph crawl's deadline
// ({@linkcode DENO_INFO_DEADLINE_MS}, or `DENEXT_CHILD_DEADLINE_MS`), one retry, then a
// `ChildStallError` naming the pids. Every other command, and every call outside such a scope, is
// the stock `Deno.Command`.

import { AsyncLocalStorage } from "node:async_hooks";
import type * as esbuild from "./esbuild/mod.ts";
import {
  boundedOutput,
  childDeadlineMs,
  DENO_INFO_DEADLINE_MS,
  retryOnStall,
} from "./serial-child.ts";

/** What a scope knows: its deadline (`undefined`: the default, read when the child starts). */
interface InfoScope {
  readonly deadlineMs: number | undefined;
}

const scopes = new AsyncLocalStorage<InfoScope>();

/** Whether `Deno.Command` has been replaced in this isolate. */
let installed = false;

/** Whether `cmd` is this executable running `deno info`. */
function isDenoInfo(cmd: string | URL, options: Deno.CommandOptions): boolean {
  let exec: string;
  try {
    exec = Deno.execPath();
  } catch {
    return false; // no permission to ask: never ours
  }
  return String(cmd) === exec && options.args?.[0] === "info";
}

/**
 * Run one `deno info` the way `Deno.Command#output` would, but read until it exits, killed at
 * `deadlineMs` and retried once (one child at a time per process).
 */
function boundedInfo(
  Command: typeof Deno.Command,
  cmd: string | URL,
  options: Deno.CommandOptions,
  deadlineMs: number,
): Promise<Deno.CommandOutput> {
  const stdout = options.stdout ?? "piped";
  const stderr = options.stderr ?? "piped";
  const args = (options.args ?? []).map(String);
  return retryOnStall(
    "deno info",
    args.slice(1),
    (deadline) =>
      boundedOutput(
        // stdin: nothing to read, and no handle of ours for it to hold.
        new Command(cmd, { ...options, stdin: "null", stdout, stderr }).spawn(),
        { stdout: stdout === "piped", stderr: stderr === "piped" },
        deadline,
        "deno info",
      ),
    deadlineMs,
  );
}

/** Replace `Deno.Command` (once per isolate) with a subclass whose `output()` honours a scope. */
function install(): void {
  if (installed) return;
  installed = true;
  const Original = Deno.Command;
  class ScopedCommand extends Original {
    readonly #cmd: string | URL;
    readonly #options: Deno.CommandOptions;
    constructor(cmd: string | URL, options: Deno.CommandOptions = {}) {
      super(cmd, options);
      this.#cmd = cmd;
      this.#options = options;
    }
    override output(): Promise<Deno.CommandOutput> {
      const scope = scopes.getStore();
      if (!scope || !isDenoInfo(this.#cmd, this.#options)) return super.output();
      const deadlineMs = scope.deadlineMs ?? childDeadlineMs(DENO_INFO_DEADLINE_MS);
      return boundedInfo(Original, this.#cmd, this.#options, deadlineMs);
    }
  }
  (Deno as unknown as { Command: typeof Deno.Command }).Command = ScopedCommand;
}

/**
 * `plugin` (the esbuild loader) with every `deno info` it starts — from `setup` or from any
 * onStart / onResolve / onLoad / onEnd callback, across their awaits — run through
 * {@linkcode retryOnStall} and {@linkcode boundedOutput}: serialized with denext's other
 * `deno info` / `deno bundle` children, read until it exits, killed at the deadline and retried
 * once; a second stall rejects with a `ChildStallError`.
 *
 * @param plugin The loader plugin.
 * @param deadlineMs Each attempt's deadline; by default `DENEXT_CHILD_DEADLINE_MS`, else 2 minutes.
 * @returns The same plugin, its `deno info` children bounded.
 */
export function withBoundedDenoInfo(
  plugin: esbuild.Plugin,
  deadlineMs?: number,
): esbuild.Plugin {
  install();
  const scope: InfoScope = { deadlineMs };
  // deno-lint-ignore no-explicit-any
  const scoped = <F extends (...args: any[]) => any>(cb: F) =>
    ((...args: Parameters<F>) => scopes.run(scope, () => cb(...args))) as F;
  return {
    name: plugin.name,
    setup(build) {
      return scopes.run(scope, () =>
        plugin.setup({
          ...build,
          onStart: (cb) => build.onStart(scoped(cb)),
          onEnd: (cb) => build.onEnd(scoped(cb)),
          onResolve: (opts, cb) => build.onResolve(opts, scoped(cb)),
          onLoad: (opts, cb) => build.onLoad(opts, scoped(cb)),
        }));
    },
  };
}
