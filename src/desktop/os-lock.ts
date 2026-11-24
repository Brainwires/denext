/**
 * Exclusive OS advisory locks for the desktop runtime (`flock` on macOS / Linux, `LockFileEx` on
 * Windows, through `Deno.FsFile.lock`), as denext's build locks use (`src/build/file-lock.ts`,
 * which also carries the CLI's lock ranks and Blocking lines this runtime code does not need).
 *
 * The OS releases a lock when its holder closes the file or exits, crashed or killed, so there is
 * no stale-lock heuristic and nothing that ever breaks a lock another process holds. Two opens of
 * one lock file are separate owners, in one process too, so two starts in the same app also take
 * turns. The lock file itself is never removed: removing it would let a later opener lock a new
 * file while an earlier holder still locks the old one.
 *
 * Runtime-only.
 *
 * @module
 */

/** A held lock: {@linkcode OsLock.release} (or exit) frees it. */
export interface OsLock extends Disposable {
  /** Release the lock (idempotent). */
  release(): void;
}

/** Open (creating, `0600`) the lock file at `path`. */
function openLockFile(path: string): Promise<Deno.FsFile> {
  // Write access alone (no read grant needed); never truncated: the file carries no content.
  return Deno.open(path, { write: true, create: true, mode: 0o600 });
}

/** The lock over an open, locked `file`. */
function heldLock(file: Deno.FsFile): OsLock {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      file.close(); // closing the descriptor releases the OS lock
    } catch { /* already closed */ }
  };
  return { release, [Symbol.dispose]: release };
}

/**
 * Take the exclusive lock on `path`, waiting (polling every `pollMs`) up to `timeoutMs` for its
 * holder to release it (`timeoutMs: 0` tries once).
 *
 * @param path The lock file (created `0600` when missing; its folder must exist).
 * @param options How long to wait, and how often to try.
 * @returns The lock, or `null` when it was still held once `timeoutMs` passed.
 */
export async function acquireOsLock(
  path: string,
  options: { readonly timeoutMs: number; readonly pollMs?: number },
): Promise<OsLock | null> {
  const file = await openLockFile(path);
  const deadline = Date.now() + options.timeoutMs;
  try {
    for (;;) {
      if (await file.tryLock(true)) return heldLock(file);
      if (Date.now() >= deadline) break;
      await new Promise((r) =>
        setTimeout(r, Math.min(options.pollMs ?? 50, deadline - Date.now()))
      );
    }
  } catch (err) {
    file.close();
    throw err;
  }
  file.close();
  return null;
}
