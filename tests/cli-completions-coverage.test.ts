// Coverage for `src/cli/commands/completions.ts` and `src/cli/register.ts`: build the
// real first-party registry, then drive the completions command's emitters for each
// supported shell and assert the generated scripts.
//
// EVERY branch exits: the verb runs after eager project-verb discovery, so a plugin `setup`
// that leaked a timer or a watcher must not keep the shell's completion call alive. Each case
// therefore runs with Deno.exit stubbed to throw, and asserts the code it exited with.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildRegistry } from "../src/cli/register.ts";
import type { CommandContext } from "../src/cli/command.ts";

function ctx(positionals: string[]): CommandContext {
  return {
    positionals,
    flags: {},
    global: { json: false, verbose: false, quiet: false },
    rest: [],
  };
}

function capture(): { logs: string[]; errs: string[]; restore: () => void } {
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

/** Run the completions verb with `Deno.exit` stubbed; it always exits, never returns. */
function emit(shell: string): { logs: string[]; errs: string[]; codes: number[] } {
  const reg = buildRegistry();
  const cap = capture();
  const exit = stubExit();
  try {
    reg.get("completions")!.run(ctx([shell]));
  } catch (e) {
    assert(String(e).startsWith("Error: __exit__"), `unexpected throw: ${e}`);
  } finally {
    exit.restore();
    cap.restore();
  }
  return { logs: cap.logs, errs: cap.errs, codes: exit.calls };
}

function stubExit(): { calls: number[]; restore: () => void } {
  const orig = Deno.exit;
  const calls: number[] = [];
  Deno.exit = ((code?: number): never => {
    calls.push(code ?? 0);
    throw new Error(`__exit__${code ?? 0}`);
  }) as typeof Deno.exit;
  return { calls, restore: () => void (Deno.exit = orig) };
}

Deno.test("buildRegistry wires every first-party verb", () => {
  const reg = buildRegistry();
  const names = reg.names();
  for (const verb of ["dev", "build", "test", "migrate", "doctor", "audit", "completions"]) {
    assert(names.includes(verb), `registry missing ${verb}`);
  }
  // `completions` is registered bound to the real registry.
  assert(reg.get("completions"), "completions command registered");
  // Help renders without throwing and lists the verbs.
  const help = reg.formatHelp("9.9.9");
  assertStringIncludes(help, "denext dev");
});

Deno.test("completions emits a bash script for the real verb set, then exits", () => {
  const { logs, codes } = emit("bash");
  const out = logs.join("\n");
  assertStringIncludes(out, "_denext_complete()");
  assertStringIncludes(out, "complete -F _denext_complete denext");
  // Verb names appear in the compgen word list.
  assertStringIncludes(out, "doctor");
  assertStringIncludes(out, "migrate");
  // A plugin `setup` that leaked a handle cannot hold the process open past the script.
  assertEquals(codes, [0]);
});

Deno.test("completions emits a zsh compdef script, then exits", () => {
  const { logs, codes } = emit("zsh");
  const out = logs.join("\n");
  assertStringIncludes(out, "#compdef denext");
  assertStringIncludes(out, "_describe 'command' commands");
  // Each verb carries its summary as a 'name:desc' pair.
  assertStringIncludes(out, "'doctor:");
  assertEquals(codes, [0]);
});

Deno.test("completions emits a fish completion script, then exits", () => {
  const { logs, codes } = emit("fish");
  const out = logs.join("\n");
  assertStringIncludes(out, "complete -c denext -n __fish_use_subcommand -a");
  assertStringIncludes(out, "-a doctor");
  assertEquals(codes, [0]);
});

Deno.test("completions rejects an unknown shell with a non-zero exit", () => {
  const { errs, codes, logs } = emit("powershell");
  assertEquals(codes, [1]);
  assertEquals(logs, [], "no script is printed for a shell it does not know");
  assertStringIncludes(errs.join("\n"), "unknown shell");
});
