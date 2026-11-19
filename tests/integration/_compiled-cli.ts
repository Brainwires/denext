// One `deno compile`d denext per test process, built exactly as the release builds it
// (scripts/compile-cli.ts), shared by the compiled-binary tests so the CLI compiles once.
//
// `deno test --parallel` runs each test file on its own thread of ONE process, so module state
// is per file: without coordination every file that asks for the binary compiles the CLI, all at
// once. One compile peaks at ~2.7 GB, so two together outgrow a 3.5 GB CI container and the
// kernel's OOM killer ends one ("deno compile of the CLI failed"). The files of a process
// therefore take one lock file (named by the process id) around the compile: the first one in
// compiles into a directory every file of the process shares, and each file hard-links (else
// copies) that binary into its own temporary directory. Never two compiles at a time.
//
// `DENEXT_SMOKE_BINARY=<path>` tests a binary built elsewhere instead (the release workflow's
// own artifact, before it is uploaded) and skips the compile.

import { dirname, fromFileUrl, join } from "@std/path";
import { compileCliArgs } from "../../scripts/compile-cli.ts";
import { boundedOutput } from "../helpers/bounded-command.ts";

/** The repository root. */
const ROOT: string = fromFileUrl(new URL("../..", import.meta.url));

let compiled: Promise<string> | undefined;

/**
 * The path of a compiled denext: `DENEXT_SMOKE_BINARY` when set, else this checkout compiled
 * once into a temporary directory (removed when the process exits).
 *
 * @returns The executable's path.
 */
export function compiledCli(): Promise<string> {
  const given = Deno.env.get("DENEXT_SMOKE_BINARY");
  if (given) return Promise.resolve(given);
  compiled ??= (async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_compiled_cli_bin_" });
    const shared = sharedCompileDir(dirname(dir));
    globalThis.addEventListener("unload", () => {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* already gone */ }
      // The shared copy goes too (under the lock, so no file is linking it right then); a file
      // that asks later compiles again, alone.
      withLockSync(shared.lock, () => {
        try {
          Deno.removeSync(shared.dir, { recursive: true });
        } catch { /* already gone */ }
      });
    });
    const name = Deno.build.os === "windows" ? "denext.exe" : "denext";
    const bin = join(dir, name);
    await withLock(shared.lock, async () => {
      const source = join(shared.dir, name);
      if (!await exists(source)) {
        await Deno.mkdir(shared.dir, { recursive: true });
        const { success } = await new Deno.Command(Deno.execPath(), {
          args: compileCliArgs({ output: source }),
          cwd: ROOT,
          stdout: "inherit",
          stderr: "inherit",
        }).output();
        if (!success) {
          await Deno.remove(source).catch(() => {});
          throw new Error("deno compile of the CLI failed");
        }
      }
      try {
        await Deno.link(source, bin);
      } catch {
        await Deno.copyFile(source, bin); // another filesystem, or no hard links
      }
    });
    return bin;
  })();
  return compiled;
}

/**
 * The directory the files of this process share for the compiled CLI, and the lock file that
 * guards it, both in `tmp` (the run's temp root under scripts/test-run.ts, removed with it).
 *
 * @param tmp The temp directory.
 * @returns The shared directory and the lock file's path.
 */
export function sharedCompileDir(tmp: string): { dir: string; lock: string } {
  return {
    dir: join(tmp, `denext_compiled_cli_shared_${Deno.pid}`),
    lock: join(tmp, `denext_compiled_cli_shared_${Deno.pid}.lock`),
  };
}

/**
 * Run `fn` holding an exclusive lock on the file at `path` (created when missing). Locks are
 * per open file, so two files of one process exclude each other like two processes would.
 *
 * @param path The lock file.
 * @param fn The work to do under the lock.
 * @returns What `fn` returned.
 */
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  using file = await Deno.open(path, { create: true, write: true });
  await file.lock(true);
  try {
    return await fn();
  } finally {
    await file.unlock();
  }
}

/** {@linkcode withLock}, synchronously (for an `unload` listener). */
function withLockSync(path: string, fn: () => void): void {
  try {
    using file = Deno.openSync(path, { create: true, write: true });
    file.lockSync(true);
    try {
      fn();
    } finally {
      file.unlockSync();
    }
  } catch { /* the temp root is gone already */ }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** What a run of the binary printed. */
export interface CliRun {
  /** The exit code. */
  code: number;
  /** stdout. */
  out: string;
  /** stderr. */
  err: string;
}

/**
 * Run the binary with `args` in `cwd`, stdin closed.
 *
 * @param bin The executable.
 * @param args Its arguments.
 * @param cwd The working directory.
 * @param env Extra environment.
 * @returns Its exit code and output.
 */
export async function runCli(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<CliRun> {
  const { code, stdout, stderr } = await boundedOutput(bin, {
    args,
    cwd,
    // A pinned child resolves denext from JSR: a release younger than Deno's minimum dependency
    // age would otherwise be refused there.
    env: { DENEXT_MIN_DEP_AGE: "0", NO_COLOR: "1", ...env },
  });
  const decoder = new TextDecoder();
  return { code, out: decoder.decode(stdout), err: decoder.decode(stderr) };
}
