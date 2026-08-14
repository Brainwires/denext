// Regression test for the CLI/package-entry exit hang.
//
// The package entry (`mod.ts`) re-exports the SSR renderers, which pull in the
// class-component runtime. That runtime used to statically import the client
// reconciler, which constructs a `MessageChannel` with a live `onmessage`
// listener at module scope — a ref'd handle that keeps Deno's event loop alive
// forever. Merely importing `mod.ts` (or running `denext init`, which does) then
// never exits: the process hangs and has to be killed.
//
// The fix is twofold: the reconciler lazily creates its yield channel only on
// first real (browser) use, and the class runtime injects `scheduleUpdate` rather
// than statically importing the client reconciler. This test guards both by
// running the real subprocess and asserting a clean, timely exit — an in-process
// op-sanitizer test is insufficient here because it would itself hang on the
// leaked handle rather than report a failure.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const TIMEOUT_MS = 60_000;

/** Run a subprocess with a hard timeout; returns its exit code (or -1 on timeout). */
async function runWithTimeout(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ code: number; timedOut: boolean; stderr: string }> {
  const command = new Deno.Command(Deno.execPath(), {
    args,
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, TIMEOUT_MS);
  const started = performance.now();
  const out = await child.output();
  clearTimeout(timer);
  const timedOut = performance.now() - started >= TIMEOUT_MS;
  return { code: out.code, timedOut, stderr: new TextDecoder().decode(out.stderr) };
}

Deno.test("importing the package entry (mod.ts) exits cleanly", async () => {
  // A trivial script whose only job is to import the entry and return. If the
  // event loop is kept alive by a leaked handle, this never exits and the timeout
  // fires (killed → non-zero / timedOut).
  const script = `import ${JSON.stringify(new URL("../../mod.ts", import.meta.url).href)};`;
  const tmp = await Deno.makeTempFile({ prefix: "denext_exit_", suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmp, script);
    const { code, timedOut, stderr } = await runWithTimeout(["run", "-A", tmp]);
    assert(!timedOut, "importing mod.ts hung (event loop kept alive by a leaked handle)");
    assertEquals(code, 0, `importing mod.ts exited non-zero:\n${stderr}`);
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});

Deno.test("`denext init --yes` exits cleanly", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_init_exit_" });
  try {
    const cli = fromFileUrl(new URL("../../cli.ts", import.meta.url));
    const { code, timedOut, stderr } = await runWithTimeout(
      ["run", "-A", cli, "init", "--yes"],
      { cwd: dir },
    );
    assert(!timedOut, "`denext init` hung after finishing its work (leaked handle)");
    assertEquals(code, 0, `denext init exited non-zero:\n${stderr}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
