// One `deno compile`d denext per test process, built exactly as the release builds it
// (scripts/compile-cli.ts), shared by the compiled-binary tests so the CLI compiles once.
//
// `DENEXT_SMOKE_BINARY=<path>` tests a binary built elsewhere instead (the release workflow's
// own artifact, before it is uploaded) and skips the compile.

import { fromFileUrl, join } from "@std/path";
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
    globalThis.addEventListener("unload", () => {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* already gone */ }
    });
    const bin = join(dir, Deno.build.os === "windows" ? "denext.exe" : "denext");
    const { success } = await new Deno.Command(Deno.execPath(), {
      args: compileCliArgs({ output: bin }),
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!success) throw new Error("deno compile of the CLI failed");
    return bin;
  })();
  return compiled;
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
