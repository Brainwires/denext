// Coverage for `src/cli/commands/completions.ts` and `src/cli/register.ts`: build the
// real first-party registry, then drive the completions command's emitters for each
// supported shell and assert the generated scripts. The unknown-shell branch exits, so
// it is exercised with Deno.exit stubbed to throw.

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

Deno.test("completions emits a bash script for the real verb set", () => {
  const reg = buildRegistry();
  const cap = capture();
  try {
    reg.get("completions")!.run(ctx(["bash"]));
  } finally {
    cap.restore();
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "_denext_complete()");
  assertStringIncludes(out, "complete -F _denext_complete denext");
  // Verb names appear in the compgen word list.
  assertStringIncludes(out, "doctor");
  assertStringIncludes(out, "migrate");
});

Deno.test("completions emits a zsh compdef script", () => {
  const reg = buildRegistry();
  const cap = capture();
  try {
    reg.get("completions")!.run(ctx(["zsh"]));
  } finally {
    cap.restore();
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "#compdef denext");
  assertStringIncludes(out, "_describe 'command' commands");
  // Each verb carries its summary as a 'name:desc' pair.
  assertStringIncludes(out, "'doctor:");
});

Deno.test("completions emits a fish completion script", () => {
  const reg = buildRegistry();
  const cap = capture();
  try {
    reg.get("completions")!.run(ctx(["fish"]));
  } finally {
    cap.restore();
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "complete -c denext -n __fish_use_subcommand -a");
  assertStringIncludes(out, "-a doctor");
});

Deno.test("completions rejects an unknown shell with a non-zero exit", () => {
  const reg = buildRegistry();
  const cap = capture();
  const exit = stubExit();
  try {
    reg.get("completions")!.run(ctx(["powershell"]));
  } catch (e) {
    assert(String(e).includes("__exit__1"));
  } finally {
    exit.restore();
    cap.restore();
  }
  assertEquals(exit.calls, [1]);
  assertStringIncludes(cap.errs.join("\n"), "unknown shell");
});
