// runToExit / exitedOutput: a child's output read until it EXITS, not until every copy of its
// pipes closes. The stand-ins are shell scripts that leave a background process holding their
// stdout and stderr, which is what a process another thread spawned at the same moment does on
// Windows (it inherits the pipes); `Deno.Command#output()` waits on that holder for its whole life.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { exitedOutput, runToExit, runToExitText } from "../src/build/exited-output.ts";
import { inChild } from "./helpers/isolated.ts";

const POSIX_ONLY = Deno.build.os === "windows";

/** A temp dir with an executable `sh` script `name` holding `body`. */
async function script(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}`);
  await Deno.chmod(path, 0o755);
  return path;
}

/** Kill the background holder whose pid the stand-in wrote to `pidFile`. */
async function killHolder(pidFile: string): Promise<void> {
  try {
    Deno.kill(Number((await Deno.readTextFile(pidFile)).trim()), "SIGKILL");
  } catch { /* gone, or never started */ }
}

Deno.test({
  name: "runToExit: returns once the child exits while a process it left holds its pipes",
  ignore: POSIX_ONLY,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_run_to_exit_" });
    const pidFile = join(dir, "pid");
    const fake = await script(
      dir,
      "held",
      `sleep 120 &\necho $! > '${pidFile}'\nprintf 'out'\nprintf 'err' >&2\nexit 3\n`,
    );
    try {
      const t0 = Date.now();
      const out = await runToExit(fake, {}, 200);
      assert(Date.now() - t0 < 30_000, `took ${Date.now() - t0} ms`);
      assertEquals(out.code, 3);
      assertEquals(out.success, false);
      assertEquals(new TextDecoder().decode(out.stdout), "out");
      assertEquals(new TextDecoder().decode(out.stderr), "err");
    } finally {
      await killHolder(pidFile);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("runToExit: the same status and bytes as output(), stdin null by default", async () => {
  const program = "const b = new Uint8Array(8); const n = await Deno.stdin.read(b);" +
    "await Deno.stdout.write(new TextEncoder().encode(`stdin:${n}`));" +
    "await Deno.stderr.write(new Uint8Array([0, 255, 10])); Deno.exit(7);";
  const options = { args: ["eval", program], stdin: "null" as const };
  const ours = await runToExit(Deno.execPath(), options);
  const theirs = await new Deno.Command(Deno.execPath(), options).output();
  assertEquals(ours.code, theirs.code);
  assertEquals(ours.success, theirs.success);
  assertEquals(ours.signal, theirs.signal);
  assertEquals(ours.stdout, theirs.stdout);
  assertEquals(ours.stderr, theirs.stderr);
  // No stdin given: the child reads EOF at once rather than this process's stdin.
  const defaulted = await runToExit(Deno.execPath(), { args: ["eval", program] });
  assertEquals(new TextDecoder().decode(defaulted.stdout), "stdin:null");
  assertEquals(defaulted.code, 7);
});

Deno.test("runToExit: a stream that was not piped throws when read, as output()'s does", async () => {
  const out = await runToExit(Deno.execPath(), {
    args: ["eval", "console.log('x')"],
    stdout: "null",
  });
  assertEquals(out.success, true);
  assertThrows(() => out.stdout, TypeError, "stdout is not piped");
  assertEquals(out.stderr.length, 0);
});

Deno.test("runToExit: input is written to stdin, which is then closed", async () => {
  const program = "const t = await new Response(Deno.stdin.readable).text();" +
    "console.log(JSON.stringify(t)); Deno.exit(t.length === 0 ? 1 : 0);";
  const text = await runToExit(Deno.execPath(), { args: ["eval", program], input: "héllo\n" });
  assertEquals(text.code, 0);
  assertEquals(new TextDecoder().decode(text.stdout).trim(), JSON.stringify("héllo\n"));
  const bytes = await runToExit(Deno.execPath(), {
    args: ["eval", program],
    input: new Uint8Array([97, 98]),
  });
  assertEquals(new TextDecoder().decode(bytes.stdout).trim(), '"ab"');
  // `input` wins over a `stdin` mode.
  const both = await runToExit(Deno.execPath(), {
    args: ["eval", program],
    stdin: "inherit",
    input: "x",
  });
  assertEquals(new TextDecoder().decode(both.stdout).trim(), '"x"');
});

Deno.test("runToExit: a child that exits without reading its input is not an error", async () => {
  // Far more than a pipe buffer, so the write is still pending when the child exits.
  const input = new Uint8Array(4 * 1024 * 1024).fill(120);
  const out = await runToExit(Deno.execPath(), {
    args: ["eval", "console.log('done'); Deno.exit(4)"],
    input,
  });
  assertEquals(out.code, 4);
  assertEquals(new TextDecoder().decode(out.stdout).trim(), "done");
});

Deno.test("runToExit: an aborted child ends with the status output() reports", async () => {
  const args = ["eval", "setTimeout(() => {}, 30_000)"];
  const ours = await runToExit(Deno.execPath(), { args, signal: AbortSignal.timeout(200) });
  const theirs = await new Deno.Command(Deno.execPath(), {
    args,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(200),
  }).output();
  assertEquals([ours.success, ours.code, ours.signal], [
    theirs.success,
    theirs.code,
    theirs.signal,
  ]);
  assertEquals(ours.success, false);
});

Deno.test("runToExitText: the status and output as text; an unpiped stream reads as empty", async () => {
  const program = "console.log('é'); console.error('warn'); Deno.exit(2);";
  const out = await runToExitText(Deno.execPath(), { args: ["eval", program] });
  assertEquals(out, { success: false, code: 2, stdout: "é\n", stderr: "warn\n" });
  const quiet = await runToExitText(Deno.execPath(), {
    args: ["eval", program],
    stderr: "null",
  });
  assertEquals([quiet.stdout, quiet.stderr], ["é\n", ""]);
});

Deno.test("runToExit: a missing program rejects with NotFound", async () => {
  await assertRejects(
    () => runToExit(join(Deno.cwd(), "no-such-program-denext")),
    Deno.errors.NotFound,
  );
});

Deno.test({
  name: "exitedOutput: a spawned child's output, read until exit past a held pipe",
  ignore: POSIX_ONLY,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_exited_output_" });
    const pidFile = join(dir, "pid");
    const fake = await script(dir, "held", `sleep 120 &\necho $! > '${pidFile}'\necho done\n`);
    try {
      const child = new Deno.Command(fake, { stdin: "null", stdout: "piped", stderr: "null" })
        .spawn();
      const out = await exitedOutput(child, { stdout: true, stderr: false }, 200);
      assertEquals(new TextDecoder().decode(out.stdout), "done\n");
      assertThrows(() => out.stderr, TypeError, "stderr is not piped");
    } finally {
      await killHolder(pidFile);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "bundleSourceFiles: returns once `deno bundle` exits while a process it left holds its output",
  ignore: POSIX_ONLY,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_bundle_held_" });
    const pidFile = join(dir, "pid");
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    // A stand-in `deno`: answers the version probe and `bundle --help`, and for a bundle writes
    // the entry into --outdir, then exits leaving a background process on its stdout and stderr.
    const fake = await script(
      dir,
      "fake-deno",
      `case "$1" in\n` +
        `  --version) echo 'deno 2.9.7'; exit 0 ;;\n` +
        `  bundle) [ "$2" = --help ] && exit 0 ;;\n` +
        `  *) exit 1 ;;\n` +
        `esac\n` +
        `while [ $# -gt 0 ]; do [ "$1" = --outdir ] && out="$2"; shift; done\n` +
        `mkdir -p "$out" && printf 'export const ok = 1;\\n' > "$out/entry.js"\n` +
        `sleep 120 &\necho $! > '${pidFile}'\nexit 0\n`,
    );
    try {
      const t0 = Date.now();
      const { value } = await inChild<{ entry: string; files: string[] }>({
        imports: `import { bundleSourceFiles } from "@repo/src/build/bundle.ts";`,
        body: `const out = await bundleSourceFiles("export {};\\n", ` +
          `{ configPath: ${JSON.stringify(join(dir, "deno.json"))} });\n` +
          `return { entry: out.entry, files: [...out.files.keys()] };`,
        env: { DENO_BIN: fake },
        timeoutMs: 60_000,
      });
      assertEquals(value, { entry: "entry.js", files: ["entry.js"] });
      assert(Date.now() - t0 < 60_000, `took ${Date.now() - t0} ms`);
    } finally {
      await killHolder(pidFile);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("quietThenExplain: runs once with stderr discarded; a failure runs again piped", async () => {
  const { quietThenExplain } = await import("../src/build/exited-output.ts");
  const output = (code: number) => ({ code, success: code === 0 } as Deno.CommandOutput);
  const modes: string[] = [];
  const ok = await quietThenExplain((mode) => (modes.push(mode), Promise.resolve(output(0))));
  assertEquals([ok.code, modes], [0, ["null"]]);
  modes.length = 0;
  let n = 0;
  const failed = await quietThenExplain((mode) => (modes.push(mode), Promise.resolve(output(++n))));
  assertEquals([failed.code, modes], [2, ["null", "piped"]], "the re-run's output is returned");
});

// Pipes that reach EOF before the exit is reported (the usual order for a quick child) ended the
// read with no grace timer yet; the exit then started one nothing cleared, so every such read left
// a timer running for the grace period (5 s by default), which held a test's ops open.
Deno.test({
  name: "exitedOutput: pipes that end before the exit leave no grace timer behind",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const exit = Promise.withResolvers<Deno.CommandStatus>();
    const ended = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("x"));
          c.close();
        },
      });
    const child = { status: exit.promise, stdout: ended(), stderr: ended() };
    const reading = exitedOutput(child as unknown as Deno.ChildProcess, {
      stdout: true,
      stderr: true,
    }, 60_000);
    await new Promise((r) => setTimeout(r, 0)); // both pipes are at EOF; then the exit
    exit.resolve({ success: true, code: 0, signal: null });
    const out = await reading;
    assertEquals(new TextDecoder().decode(out.stdout), "x");
    assertEquals(new TextDecoder().decode(out.stderr), "x");
    await new Promise((r) => setTimeout(r, 0)); // a timer the exit started is pending by now
  },
});
