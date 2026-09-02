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
  // Defensive: only fixed literals are passed today, but never let a `..`/absolute path
  // walk out of the package (traversal → arbitrary file read / URL fetch).
  if (relPath.includes("..") || relPath.startsWith("/") || relPath.includes("\0")) {
    throw new Error(`invalid package file path: ${relPath}`);
  }
  const url = new URL(`../../${relPath}`, import.meta.url);
  if (url.protocol === "file:") return await Deno.readTextFile(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot read ${relPath} (${res.status})`);
  return await res.text();
}
