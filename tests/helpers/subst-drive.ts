// A second Windows drive for a test: `subst` maps a free drive letter onto a directory, so a project
// (or a checkout) can sit on another drive than the working directory, the way a CI runner's temp
// dir (C:) and its checkout (D:) do. Windows only; the mapping lives for the logon session and is
// removed when the callback settles.

/** Whether `letter:` already names a drive. */
function driveExists(letter: string): boolean {
  try {
    Deno.statSync(`${letter}:\\`);
    return true;
  } catch {
    return false;
  }
}

/** Run `subst` with `args`, throwing with its output on failure. */
async function subst(args: string[]): Promise<void> {
  const out = await new Deno.Command("subst", { args, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) {
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    throw new Error(`subst ${args.join(" ")} failed: ${text}`);
  }
}

/**
 * Map a free drive letter onto `dir` for the duration of `fn`.
 *
 * @param dir The directory the drive's root shows.
 * @param fn Called with the drive's root (`X:\`).
 * @returns What `fn` returns.
 */
export async function withSubstDrive<T>(dir: string, fn: (root: string) => Promise<T>): Promise<T> {
  const letter = [..."QRSTUVWXYZ"].find((l) => !driveExists(l));
  if (!letter) throw new Error("no free drive letter for subst");
  await subst([`${letter}:`, dir]);
  try {
    return await fn(`${letter}:\\`);
  } finally {
    await subst([`${letter}:`, "/d"]);
  }
}
