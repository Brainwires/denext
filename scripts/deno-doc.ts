/**
 * Shared `deno doc --json` runner for the doc-driven generators (`gen-api-reference.ts`,
 * `gen-config-schema.ts`). Spawns the current `deno` binary so the output matches the
 * toolchain that runs the generator.
 *
 * @module
 */

/** Run `deno doc --json` over `file` and return the parsed document. */
export async function denoDocJson(file: string): Promise<unknown> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", file],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(`deno doc failed for ${file}: ${new TextDecoder().decode(stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(stdout));
}
