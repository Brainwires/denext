// Files denext itself writes inside a watched source tree, so the dev watcher can tell its
// own writes from the developer's edits.
//
// The CSS graph crawl rewrites the project's `deno.json` for the length of a `deno info` run
// (it strips the transient css→shim redirects, then puts the file back). When the SPA entry
// sits at the project root, the SPA watcher watches that directory, so each build's two writes
// looked like two edits: the generation bumped, the next request rebuilt, the rebuild wrote
// again, and pages chasing the churn hit 404s on pruned chunks. Recording the exact content of
// every such write lets the watcher drop an event whose file still holds something denext
// wrote, while a real edit (content denext never wrote) still goes through.

import { resolve } from "@std/path";

/** How many recent contents are remembered per file (the stripped copy and the original). */
const KEEP = 4;

/** Absolute path (as written, and its real path) → the contents denext last wrote there. */
const written = new Map<string, string[]>();

/** The spellings a watcher may report for `path`: as given, and resolved through symlinks. */
function spellings(path: string): string[] {
  const abs = resolve(path);
  try {
    const real = Deno.realPathSync(abs);
    return real === abs ? [abs] : [abs, real];
  } catch {
    return [abs];
  }
}

/**
 * Remember that denext wrote `content` to `path`.
 *
 * @param path The file.
 * @param content What was written.
 */
export function recordSelfWrite(path: string, content: string): void {
  for (const key of spellings(path)) {
    const list = (written.get(key) ?? []).filter((c) => c !== content);
    list.push(content);
    written.set(key, list.slice(-KEEP));
  }
}

/**
 * Write `content` to `path` unless the file already holds exactly that, recording the write
 * (or the unchanged content) as denext's own.
 *
 * @param path The file.
 * @param content The full new content.
 * @returns Whether the file was written.
 */
export async function writeManagedFile(path: string, content: string): Promise<boolean> {
  const current = await Deno.readTextFile(path).catch(() => null);
  recordSelfWrite(path, content);
  if (current === content) return false;
  await Deno.writeTextFile(path, content);
  return true;
}

/**
 * Whether a watcher event on `path` is denext's own write: the file currently holds content
 * denext wrote there. A file denext never wrote, or one now holding anything else, is an edit.
 *
 * @param path The path the watcher reported.
 * @returns True when the event should be ignored.
 */
export function isSelfWrite(path: string): boolean {
  const contents = written.get(resolve(path));
  if (!contents) return false;
  try {
    return contents.includes(Deno.readTextFileSync(path));
  } catch {
    return false; // removed or unreadable: let the watcher see it
  }
}
