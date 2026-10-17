// Format generated TypeScript with `deno fmt` (the repo's settings), for the generators whose
// output is committed and checked by `deno fmt --check`.

/**
 * `source` as `deno fmt` writes it.
 *
 * @param source TypeScript source.
 * @param cwd The directory whose `deno.json` settings apply.
 * @returns The formatted source.
 */
export async function denoFmt(source: string, cwd: string): Promise<string> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--ext", "ts", "-"],
    cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(source));
  await writer.close();
  const out = await child.output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}
