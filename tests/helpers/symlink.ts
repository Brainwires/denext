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
