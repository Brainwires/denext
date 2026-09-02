// Read a file shipped inside the denext package, working both from a local checkout
// (a `file:` module URL) and when installed from JSR (an `https:` module URL). Used by the
// MCP server to serve documentation resources (AGENTS.md) and to read its own version.

/**
 * Read a package-relative file as text.
 *
 * @param relPath Path relative to the package root (e.g. `"AGENTS.md"`, `"deno.json"`).
 * @returns The file's text contents.
 */
export async function readPackageFile(relPath: string): Promise<string> {
  const url = new URL(`../../${relPath}`, import.meta.url);
  if (url.protocol === "file:") return await Deno.readTextFile(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot read ${relPath} (${res.status})`);
  return await res.text();
}
