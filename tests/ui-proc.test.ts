// `denext ui`'s subprocess runner: a child that never prints a newline (a `\r` progress bar,
// one huge blob) is streamed in bounded pieces instead of being held whole until it exits.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cliInvocation, runDeno } from "../src/ui/proc.ts";

Deno.test("runDeno: output with no newline arrives in bounded pieces", async () => {
  const lines: string[] = [];
  const cwd = await Deno.makeTempDir({ prefix: "denext-proc-" });
  try {
    const program = "await new Blob(['x'.repeat(300000)]).stream().pipeTo(Deno.stdout.writable)";
    const result = await runDeno(["eval", program], {
      cwd,
      onLine: (line) => void lines.push(line),
    });
    assertEquals(result.code, 0);
    assertEquals(lines.join("").length, 300_000, "every byte arrives");
    assert(lines.length > 1, "split into several pieces");
    assert(lines.every((line) => line.length <= 128 * 1024), "each piece is bounded");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ── --offline and the grandchild gap ─────────────────────────────────────────

/**
 * A project whose `denext.config.ts` shells out while it is being EVALUATED — the way a config
 * that wanted the network under `--offline` would, since `--deny-net` does not reach a process
 * the child spawns. It reports on stderr whether the spawn went through, and contributes a
 * verb, so the listing itself can be checked too.
 */
const SPAWNING_CONFIG = `let spawned = "not tried";
try {
  const out = new Deno.Command("sh", { args: ["-c", "echo grandchild"] }).outputSync();
  spawned = new TextDecoder().decode(out.stdout).trim();
} catch (e) {
  spawned = "refused: " + (e as Error).name;
}
console.error("CONFIG-SPAWN " + spawned);
export default {
  commands: [{ name: "seed", summary: "Load fixtures", run: () => console.log("seeded") }],
};
`;

Deno.test("cliInvocation: --deny-run rides with --offline only when asked, after the net flags", () => {
  const online = cliInvocation({ denyRun: true });
  assertEquals(online.slice(0, 2), ["run", "-A"]);
  assertEquals(online.length, 3, "online, denyRun changes nothing");
  assertEquals(cliInvocation({ offline: true, denyRun: true }), [
    "run",
    "-A",
    "--deny-net",
    "--cached-only",
    "--deny-run",
    online[2],
  ]);
  assert(!cliInvocation({ offline: true }).includes("--deny-run"), "a verb run keeps --allow-run");
});

Deno.test("--offline discovery: a config that spawns is refused, and its verbs are still listed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-proc-offline-" });
  try {
    await Deno.writeTextFile(join(dir, "denext.config.ts"), SPAWNING_CONFIG);
    const discovery = [
      ...cliInvocation({ offline: true, dir, denyRun: true }),
      "commands",
      "--json",
      "--cwd",
      dir,
    ];
    const result = await runDeno(discovery, { cwd: dir });
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stderr, "CONFIG-SPAWN refused: NotCapable");
    const listing = result.json() as { project?: Array<{ name: string }> };
    assert(listing.project?.some((verb) => verb.name === "seed"), "the verb is still discovered");

    // The control: the same child without --deny-run (the verb-run path) lets the config spawn,
    // which is exactly the gap the discovery flag closes.
    const run = [...cliInvocation({ offline: true, dir }), "commands", "--json", "--cwd", dir];
    const control = await runDeno(run, { cwd: dir });
    assertEquals(control.code, 0, control.stderr);
    assertStringIncludes(control.stderr, "CONFIG-SPAWN grandchild");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
