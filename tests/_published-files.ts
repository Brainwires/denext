// The @denext/denext publish set, as tests/release-tools.test.ts and tests/release-pins.test.ts
// measure and scan it.

/**
 * What `deno publish` sends for @denext/denext, repo-relative with each file's size: tracked
 * files minus `publish.exclude` and the workspace members (published on their own). `null`
 * outside a git checkout.
 */
export async function publishedFiles(): Promise<Map<string, number> | null> {
  const root = new URL("../", import.meta.url);
  const deno = JSON.parse(await Deno.readTextFile(new URL("deno.json", root)));
  const excluded: string[] = [...deno.publish.exclude, "packages/"];
  const out = await new Deno.Command("git", {
    args: ["ls-files", "-z", "-co", "--exclude-standard"],
    cwd: root,
  }).output();
  if (!out.success) return null;
  const files = new Map<string, number>();
  for (const file of new TextDecoder().decode(out.stdout).split("\0")) {
    if (!file || excluded.some((e) => e.endsWith("/") ? file.startsWith(e) : file === e)) continue;
    files.set(file, (await Deno.stat(new URL(file, root)).catch(() => ({ size: 0 }))).size);
  }
  return files;
}
