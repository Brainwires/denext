// Portable links for tests that exercise symlink containment.
//
// Windows lets an unprivileged process create a directory JUNCTION but not a symlink (that
// needs Developer Mode or elevation: "A required privilege is not held by the client"). A
// junction escapes a directory exactly as a directory symlink does, so the directory cases
// still run there; the FILE cases run only where file symlinks can be made.

/**
 * Link `path` to the directory `target`: a junction on Windows, a symlink elsewhere.
 *
 * @param target The absolute directory the link points at.
 * @param path Where the link is created.
 */
export function symlinkDir(target: string, path: string): Promise<void> {
  return Deno.symlink(target, path, {
    type: Deno.build.os === "windows" ? "junction" : "dir",
  });
}

/** Whether this process may create a file symlink (always on POSIX; probed on Windows). */
async function probeFileSymlinks(): Promise<boolean> {
  if (Deno.build.os !== "windows") return true;
  const dir = await Deno.makeTempDir({ prefix: "denext_symlink_probe_" });
  try {
    await Deno.writeTextFile(`${dir}\\target.txt`, "");
    await Deno.symlink(`${dir}\\target.txt`, `${dir}\\link.txt`, { type: "file" });
    return true;
  } catch {
    return false;
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * `true` when file symlinks can be created here. `false` only on a Windows account without
 * the symlink privilege, where a test that needs one is ignored (named in its `ignore`).
 */
export const FILE_SYMLINKS: boolean = await probeFileSymlinks();

/** Whether this process may create a directory link (a junction on Windows, a symlink elsewhere). */
async function probeDirLinks(): Promise<boolean> {
  const dir = await Deno.makeTempDir({ prefix: "denext_dirlink_probe_" });
  try {
    await Deno.mkdir(`${dir}/target`);
    await symlinkDir(`${dir}/target`, `${dir}/link`);
    return true;
  } catch {
    return false;
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** `true` when directory links can be created here (a junction needs no privilege on Windows). */
const DIR_LINKS: boolean = await probeDirLinks();

function inCi(): boolean {
  try {
    return (Deno.env.get("CI") ?? "") !== "";
  } catch {
    return false;
  }
}

/**
 * The `ignore` of a test that needs a directory link: set on a host that can't create one, so the
 * test is reported as ignored instead of passing without checking anything. Never under CI
 * (`CI` set): a runner that can't make a junction is broken, and the test fails there.
 */
export const IGNORE_WITHOUT_DIR_LINKS: boolean = !DIR_LINKS && !inCi();

/**
 * `name`, saying why the test is ignored when {@linkcode IGNORE_WITHOUT_DIR_LINKS} is set.
 *
 * @param name The test's name.
 */
export function dirLinkTestName(name: string): string {
  return IGNORE_WITHOUT_DIR_LINKS
    ? `${name} [ignored: this host can't create a directory link]`
    : name;
}

/**
 * A test's gate on a host capability probed at load: `ignore` is set only where the capability is
 * missing and never under CI (a runner without it is broken, and the test fails there), and
 * `name` says why the test was ignored, so a skipped check reads as one in the report.
 */
export interface HostGate {
  /** Pass as the test's `ignore`. */
  readonly ignore: boolean;
  /**
   * `name`, with the reason appended when the test is ignored.
   *
   * @param name The test's name.
   */
  name(name: string): string;
}

/**
 * The {@linkcode HostGate} for a capability.
 *
 * @param available Whether this host has it (a real probe, not an OS check).
 * @param missing What the host lacks, for the ignored test's name.
 * @returns The gate.
 */
export function hostGate(available: boolean, missing: string): HostGate {
  const ignore = !available && !inCi();
  return { ignore, name: (name) => ignore ? `${name} [ignored: ${missing}]` : name };
}

/**
 * Tests that create a symlink (a file one, or a directory one a junction can't stand in for):
 * ignored on a Windows account without the symlink privilege (no Developer Mode, not elevated).
 */
export const SYMLINK_GATE: HostGate = hostGate(
  FILE_SYMLINKS,
  "this Windows account may not create symlinks",
);

/**
 * Whether `cmd` can be started here (it exits, whatever its status).
 *
 * @param cmd The program, looked up on PATH.
 * @param args Arguments that make it exit at once (`--version`).
 * @returns Whether it spawned.
 */
export async function commandRuns(cmd: string, args: readonly string[]): Promise<boolean> {
  try {
    await new Deno.Command(cmd, { args: [...args], stdout: "null", stderr: "null", stdin: "null" })
      .output();
    return true;
  } catch {
    return false;
  }
}
