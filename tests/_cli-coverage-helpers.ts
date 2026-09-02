// Shared, non-test helpers for the cli-*-coverage.test.ts suites: build a
// CommandContext, capture console output, and stub Deno.exit so a command's
// exit-branch can be exercised without tearing down the test process. Not a test file
// (no `.test.ts` suffix), so the runner never executes it directly.

import type { CommandContext, GlobalFlags } from "../src/cli/command.ts";

/** Build a CommandContext for driving a command's `run` directly. */
export function makeCtx(opts: {
  positionals?: string[];
  flags?: Record<string, string | number | boolean>;
  global?: Partial<GlobalFlags>;
  rest?: string[];
} = {}): CommandContext {
  return {
    positionals: opts.positionals ?? [],
    flags: opts.flags ?? {},
    global: { json: false, verbose: false, quiet: false, ...opts.global },
    rest: opts.rest ?? [],
  };
}

/** Temporarily capture console.log/console.error into string arrays. */
export function capture(): { logs: string[]; errs: string[]; restore: () => void } {
  const logs: string[] = [];
  const errs: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  return {
    logs,
    errs,
    restore: () => {
      console.log = ol;
      console.error = oe;
    },
  };
}

/** Replace Deno.exit with a throwing stub so exit branches don't kill the process. */
export function stubExit(): { calls: number[]; restore: () => void } {
  const orig = Deno.exit;
  const calls: number[] = [];
  Deno.exit = ((code?: number): never => {
    calls.push(code ?? 0);
    throw new Error(`__exit__${code ?? 0}`);
  }) as typeof Deno.exit;
  return { calls, restore: () => void (Deno.exit = orig) };
}
