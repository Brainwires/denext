// The @denext/denext publish set, as tests/release-tools.test.ts and tests/release-pins.test.ts
// measure and scan it, and a workspace member's (tests/release-tools.test.ts's @denext/ui guard).

/** Whether `file` is one of `entries` (a directory entry ends in `/`). */
const listed = (entries: readonly string[], file: string) =>
  entries.some((e) => e.endsWith("/") ? file.startsWith(e) : file === e);

/**
 * The files git tracks (or would: untracked, not ignored) under `root`, relative to it, that
 * `keep` accepts, with each file's size. `null` outside a git checkout.
 */
async function gitFiles(
  root: URL,
  keep: (file: string) => boolean,
): Promise<Map<string, number> | null> {
  const out = await new Deno.Command("git", {
    args: ["ls-files", "-z", "-co", "--exclude-standard", "."],
    cwd: root,
  }).output();
  if (!out.success) return null;
  const files = new Map<string, number>();
  for (const file of new TextDecoder().decode(out.stdout).split("\0")) {
    if (!file || !keep(file)) continue;
    files.set(file, (await Deno.stat(new URL(file, root)).catch(() => ({ size: 0 }))).size);
  }
  return files;
}

/**
 * What `deno publish` sends for @denext/denext, repo-relative with each file's size: tracked
 * files minus `publish.exclude` and the workspace members (published on their own). `null`
 * outside a git checkout.
 */
export async function publishedFiles(): Promise<Map<string, number> | null> {
  const root = new URL("../", import.meta.url);
  const deno = JSON.parse(await Deno.readTextFile(new URL("deno.json", root)));
  const excluded: string[] = [...deno.publish.exclude, "packages/"];
  return await gitFiles(root, (file) => !listed(excluded, file));
}

/**
 * What `deno publish --config packages/<dir>/deno.json` sends for a workspace member: its tracked
 * files under `publish.include`, member-relative with each file's size. `null` outside a git
 * checkout.
 */
export async function publishedMemberFiles(dir: string): Promise<Map<string, number> | null> {
  const root = new URL(`../packages/${dir}/`, import.meta.url);
  const deno = JSON.parse(await Deno.readTextFile(new URL("deno.json", root)));
  const include: string[] = deno.publish.include;
  return await gitFiles(root, (file) => listed(include, file));
}
