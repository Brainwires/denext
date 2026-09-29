// Temp-dir cleanup that tolerates Windows' sharing rules.
//
// Some modules under test keep a node:sqlite handle open for the life of the process (the
// durable cache store, an example app's auth database). POSIX unlinks an open file; Windows
// refuses ("The process cannot access the file because it is being used by another process",
// os error 32). That one case leaves the directory to the OS temp sweep instead of failing
// the test — every other removal error still throws.

/** Whether `err` is Windows' sharing violation (a file another handle still holds). */
function isSharingViolation(err: unknown): boolean {
  return Deno.build.os === "windows" && err instanceof Error && /os error 32\b/.test(err.message);
}

/**
 * Recursively remove a test's temp directory (sync).
 *
 * @param dir The directory to remove.
 */
export function removeTempDirSync(dir: string): void {
  try {
    Deno.removeSync(dir, { recursive: true });
  } catch (err) {
    if (!isSharingViolation(err)) throw err;
  }
}

/**
 * Recursively remove a test's temp directory, retrying briefly while Windows still reports a
 * sharing violation — a worker or subprocess the test just disposed of releases its file
 * handles a moment after it is told to stop. Any other error, or a violation that outlasts
 * the retries, throws.
 *
 * @param dir The directory to remove.
 * @param attempts How many tries before giving up (default 20, ~2 s).
 */
export async function removeTempDir(dir: string, attempts = 20): Promise<void> {
  for (let i = 1;; i++) {
    try {
      return await Deno.remove(dir, { recursive: true });
    } catch (err) {
      if (!isSharingViolation(err) || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
