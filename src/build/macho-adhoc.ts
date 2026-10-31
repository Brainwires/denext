// Repair the page hashes of an ad-hoc code signature in a Mach-O executable.
//
// Apple Silicon kernels check every page of a signed executable against its code directory as
// the page is mapped, and SIGKILL the process on a mismatch (exit 137, `CODE SIGNING:
// cs_invalid_page … denying page sending SIGKILL` in the kernel log). Some ad-hoc signed
// executables ship with stale page hashes: Bun's `--compile` writes its payload and re-signs the
// file itself, and the Tailwind standalone binaries it builds (v4.3.0 … v4.3.3 at least) carry a
// wrong hash for the last page before the signature, so whether one runs depends on whether that
// page is ever touched. Recomputing the code slots is what `codesign --force --sign -` does for an
// ad-hoc signature (no identity, no CMS blob, nothing else covers the code directory), but done
// here it changes only the hash bytes, so the result is deterministic and can be pinned.

/** Mach-O 64-bit magic, as read little-endian (the only byte order Apple ships). */
const MH_MAGIC_64 = 0xfeedfacf;
/** `LC_CODE_SIGNATURE`. */
const LC_CODE_SIGNATURE = 0x1d;
/** The embedded signature super blob's magic. */
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
/** A code directory blob's magic. */
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
/** The code directory flag of an ad-hoc signature. */
const CS_ADHOC = 0x2;

/** The primary code directory's slot type, and the range of the alternate ones. */
const CSSLOT_CODEDIRECTORY = 0;
const CSSLOT_ALTERNATE_FIRST = 0x1000;
const CSSLOT_ALTERNATE_LAST = 0x1004;

/** A code directory hash type → WebCrypto digest + how many bytes of it a slot keeps. */
const HASH_TYPES: Record<number, { readonly algorithm: string; readonly size: number }> = {
  1: { algorithm: "SHA-1", size: 20 },
  2: { algorithm: "SHA-256", size: 32 },
  3: { algorithm: "SHA-256", size: 20 }, // SHA-256, truncated
  4: { algorithm: "SHA-384", size: 48 },
};

/** How many page digests are in flight at once. */
const DIGEST_BATCH = 256;

/** The code directories (absolute offsets in the file) of a thin 64-bit Mach-O, or `[]`. */
function codeDirectories(bytes: Uint8Array): number[] {
  if (bytes.byteLength < 32) return [];
  const le = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (le.getUint32(0, true) !== MH_MAGIC_64) return [];
  const ncmds = le.getUint32(16, true);
  let cmd = 32;
  for (let i = 0; i < ncmds && cmd + 16 <= bytes.byteLength; i++) {
    const kind = le.getUint32(cmd, true);
    const size = le.getUint32(cmd + 4, true);
    if (kind === LC_CODE_SIGNATURE) {
      return superBlobDirectories(le, le.getUint32(cmd + 8, true), le.getUint32(cmd + 12, true));
    }
    if (size < 8) return [];
    cmd += size;
  }
  return [];
}

/** Whether a super blob index slot type names a code directory (primary or alternate). */
function isDirectorySlot(type: number): boolean {
  return type === CSSLOT_CODEDIRECTORY ||
    (type >= CSSLOT_ALTERNATE_FIRST && type <= CSSLOT_ALTERNATE_LAST);
}

/**
 * The code directory the super blob index entry at `entry` points at (an absolute offset), or
 * `null` when it is another blob or runs past the super blob's `end`.
 */
function directoryAt(view: DataView, start: number, end: number, entry: number): number | null {
  if (!isDirectorySlot(view.getUint32(entry))) return null;
  const at = start + view.getUint32(entry + 4);
  return at + 40 <= end && view.getUint32(at) === CSMAGIC_CODEDIRECTORY ? at : null;
}

/** The code directory offsets listed in the super blob at `start` (`size` bytes long). */
function superBlobDirectories(view: DataView, start: number, size: number): number[] {
  const end = start + size;
  if (start + 12 > view.byteLength || end > view.byteLength) return [];
  if (view.getUint32(start) !== CSMAGIC_EMBEDDED_SIGNATURE) return [];
  const count = view.getUint32(start + 8);
  const found: number[] = [];
  for (let i = 0; i < count && start + 20 + i * 8 <= end; i++) {
    const at = directoryAt(view, start, end, start + 12 + i * 8);
    if (at !== null) found.push(at);
  }
  return found;
}

/**
 * Write the correct page hashes into the ad-hoc code directory at `cd` of `out`.
 * Returns whether any slot changed.
 */
async function repairDirectory(out: Uint8Array, cd: number): Promise<boolean> {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if ((view.getUint32(cd + 12) & CS_ADHOC) === 0) return false; // a real signature: not ours
  const hashOffset = view.getUint32(cd + 16);
  const nCodeSlots = view.getUint32(cd + 28);
  const codeLimit = view.getUint32(cd + 32);
  const hashSize = view.getUint8(cd + 36);
  const type = HASH_TYPES[view.getUint8(cd + 37)];
  const pageShift = view.getUint8(cd + 39);
  if (!type || type.size !== hashSize || codeLimit > out.byteLength) return false;
  const pageSize = pageShift === 0 ? codeLimit : 2 ** pageShift;
  const slots = cd + hashOffset;
  if (slots + nCodeSlots * hashSize > out.byteLength) return false;
  let changed = false;
  for (let first = 0; first < nCodeSlots; first += DIGEST_BATCH) {
    const last = Math.min(nCodeSlots, first + DIGEST_BATCH);
    const digests = await Promise.all(
      Array.from({ length: last - first }, (_, k) => {
        const page = first + k;
        const from = page * pageSize;
        const to = Math.min(from + pageSize, codeLimit);
        return crypto.subtle.digest(
          type.algorithm,
          out.subarray(from, Math.max(from, to)) as BufferSource,
        );
      }),
    );
    digests.forEach((digest, k) => {
      const want = new Uint8Array(digest, 0, hashSize);
      const at = slots + (first + k) * hashSize;
      for (let b = 0; b < hashSize; b++) {
        if (out[at + b] !== want[b]) {
          out.set(want, at);
          changed = true;
          break;
        }
      }
    });
  }
  return changed;
}

/**
 * Recompute the code-page hashes of an ad-hoc signed, thin 64-bit Mach-O executable.
 *
 * Only the hash slots of ad-hoc code directories are rewritten, so the result is a deterministic
 * function of the input. Anything else (not a Mach-O, a universal binary, no signature, a real
 * identity's signature, an unknown hash type) is left alone.
 *
 * @param bytes The executable's bytes (not modified).
 * @returns The repaired bytes, or `null` when there was nothing to repair.
 */
export async function repairAdhocSignature(bytes: Uint8Array): Promise<Uint8Array | null> {
  const directories = codeDirectories(bytes);
  if (directories.length === 0) return null;
  const out = bytes.slice();
  let changed = false;
  for (const cd of directories) {
    if (await repairDirectory(out, cd)) changed = true;
  }
  return changed ? out : null;
}
