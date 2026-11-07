// Which package managers a migration bed's install needs and this machine lacks. A bed whose
// install program is not installed (yarn on a machine with only npm and pnpm) is skipped with
// the reason in its name, as the other toolchain-dependent tests are, instead of failing on the
// spawn: a missing tool is the environment, not denext.

/**
 * Why `program` can't run here (`undefined`: it can).
 *
 * @param program The program the bed's install runs (`"yarn"`).
 * @param args The arguments that make it print its version and exit.
 * @returns `"needs <program>"` when it is not installed or does not run.
 */
export async function missingProgram(
  program: string,
  args: string[] = ["--version"],
): Promise<string | undefined> {
  try {
    const out = await new Deno.Command(program, { args, stdout: "null", stderr: "null" }).output();
    return out.success ? undefined : `needs ${program} (\`${program} ${args.join(" ")}\` failed)`;
  } catch {
    return `needs ${program} (not installed)`;
  }
}
