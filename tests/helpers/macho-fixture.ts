// A minimal thin 64-bit Mach-O with an embedded code signature, for the ad-hoc signature repair
// tests: a header, one LC_CODE_SIGNATURE load command, code pages and a super blob holding one
// code directory per requested hash type (the first in the primary slot, the rest alternates).

/** The code directory hash types: SHA-1, SHA-256, SHA-256 truncated, SHA-384. */
const DIGESTS: Record<number, { algorithm: string; size: number }> = {
  1: { algorithm: "SHA-1", size: 20 },
  2: { algorithm: "SHA-256", size: 32 },
  3: { algorithm: "SHA-256", size: 20 },
  4: { algorithm: "SHA-384", size: 48 },
};

/** Options of {@linkcode machoFixture}. */
export interface MachoFixtureOptions {
  /** Hash types of the code directories (default `[2]`). An unknown type gets 32-byte slots. */
  readonly hashTypes?: readonly number[];
  /** Code directory flags (default `0x20002`: ad-hoc, linker-signed). */
  readonly flags?: number;
  /** Code page indices whose hash is left stale (default `[]`). */
  readonly stale?: readonly number[];
  /** Bytes of code before the signature (default 3 pages and a partial one). */
  readonly codeBytes?: number;
}

/** The fixture, plus where each code directory's hash slots start. */
export interface MachoFixture {
  readonly bytes: Uint8Array;
  readonly slots: readonly number[];
  readonly pages: number;
}

/** Build a signed Mach-O whose `stale` pages carry a wrong hash. */
export async function machoFixture(options: MachoFixtureOptions = {}): Promise<MachoFixture> {
  const { hashTypes = [2], flags = 0x20002, stale = [], codeBytes = 3 * 4096 + 100 } = options;
  const pages = Math.ceil(codeBytes / 4096);
  const cdHeader = 48;
  const cds = hashTypes.map((type) => cdHeader + pages * (DIGESTS[type]?.size ?? 32));
  const superHeader = 12 + 8 * cds.length;
  const sigSize = superHeader + cds.reduce((a, b) => a + b, 0);
  const bytes = new Uint8Array(codeBytes + sigSize);
  for (let i = 32 + 16; i < codeBytes; i++) bytes[i] = (i * 31 + 7) & 0xff;
  const le = new DataView(bytes.buffer);
  le.setUint32(0, 0xfeedfacf, true);
  le.setUint32(4, 0x0100000c, true); // CPU_TYPE_ARM64
  le.setUint32(12, 2, true); // MH_EXECUTE
  le.setUint32(16, 1, true); // ncmds
  le.setUint32(20, 16, true); // sizeofcmds
  le.setUint32(32, 0x1d, true); // LC_CODE_SIGNATURE
  le.setUint32(36, 16, true);
  le.setUint32(40, codeBytes, true);
  le.setUint32(44, sigSize, true);
  const be = le;
  be.setUint32(codeBytes, 0xfade0cc0);
  be.setUint32(codeBytes + 4, sigSize);
  be.setUint32(codeBytes + 8, cds.length);
  const slots: number[] = [];
  let at = codeBytes + superHeader;
  for (const [i, type] of hashTypes.entries()) {
    const size = DIGESTS[type]?.size ?? 32;
    be.setUint32(codeBytes + 12 + i * 8, i === 0 ? 0 : 0x1000 + i - 1);
    be.setUint32(codeBytes + 16 + i * 8, at - codeBytes);
    be.setUint32(at, 0xfade0c02);
    be.setUint32(at + 4, cds[i]);
    be.setUint32(at + 8, 0x20400);
    be.setUint32(at + 12, flags);
    be.setUint32(at + 16, cdHeader); // hashOffset
    be.setUint32(at + 28, pages);
    be.setUint32(at + 32, codeBytes);
    be.setUint8(at + 36, size);
    be.setUint8(at + 37, type);
    be.setUint8(at + 39, 12); // 4 KiB pages
    for (let p = 0; p < pages; p++) {
      const page = bytes.subarray(p * 4096, Math.min((p + 1) * 4096, codeBytes));
      const digest = DIGESTS[type]
        ? new Uint8Array(
          await crypto.subtle.digest(DIGESTS[type].algorithm, page as BufferSource),
          0,
          size,
        )
        : new Uint8Array(size);
      if (stale.includes(p)) digest[0] ^= 0xff;
      bytes.set(digest, at + cdHeader + p * size);
    }
    slots.push(at + cdHeader);
    at += cds[i];
  }
  return { bytes, slots, pages };
}

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
