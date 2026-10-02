// Safe extraction of a `.tar.gz` or `.zip` archive into a FRESH directory, for the pinned Deno
// Desktop runtime (`desktop-runtime.ts`). The archive's SHA-256 is verified against the pin before
// this runs; extraction is still hostile-input safe on its own:
//
//   - every entry path is relative and normalized: no absolute path, drive letter, backslash, `:`,
//     NUL or `..` segment (tar-slip / zip-slip);
//   - only regular files, directories and symlinks; a hard link, device, FIFO or any other entry
//     type is refused;
//   - a symlink must be relative and resolve INSIDE the destination, and symlinks are created LAST,
//     after every file, with no symlinked parent — so no entry is ever written through a link;
//   - a duplicate entry path is refused (no overwrite-after-validate tricks);
//   - file modes keep only the permission bits (no setuid / setgid / sticky);
//   - the total extracted size and entry count are capped (a decompression bomb stops).
//
// Each extracted file's size + SHA-256 is returned so the caller can record and later re-verify
// what is on disk without the archive.

import { createHash } from "node:crypto";
import { dirname, join, SEPARATOR as SEP } from "@std/path";

/** One extracted regular file. */
export interface ExtractedFile {
  /** Size in bytes. */
  readonly size: number;
  /** Lowercase hex SHA-256 of the contents. */
  readonly sha256: string;
}

/** What an extraction wrote (paths are `/`-separated, relative to the destination). */
export interface ExtractResult {
  readonly files: Record<string, ExtractedFile>;
  readonly dirs: string[];
  /** Symlink path → its (relative) target. */
  readonly symlinks: Record<string, string>;
}

/** Limits for {@linkcode extractArchive}. */
export interface ExtractLimits {
  /** Total uncompressed bytes allowed (default 4 GiB). */
  readonly maxBytes?: number;
  /** Entries allowed (default 100 000). */
  readonly maxEntries?: number;
}

/** Raised for an archive entry that is refused (the message names the entry). */
export class UnsafeArchiveError extends Error {
  override name = "UnsafeArchiveError";
}

const DEFAULT_MAX_BYTES = 4 * 1024 ** 3;
const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * Validate and normalize an archive entry path: `/`-separated, relative, no `..`, no `.` segments,
 * no backslash / `:` / NUL / drive letter. Returns the normalized path, or `""` for the archive
 * root (`./`). Throws {@linkcode UnsafeArchiveError} otherwise.
 *
 * @param raw The entry name as stored in the archive.
 * @returns The normalized relative path.
 */
export function safeEntryPath(raw: string): string {
  if (raw.includes("\0")) {
    throw new UnsafeArchiveError(`entry name contains NUL: ${JSON.stringify(raw)}`);
  }
  if (raw.includes("\\")) throw new UnsafeArchiveError(`entry name contains a backslash: ${raw}`);
  if (raw.startsWith("/")) throw new UnsafeArchiveError(`absolute entry path: ${raw}`);
  if (/^[A-Za-z]:/.test(raw) || raw.includes(":")) {
    throw new UnsafeArchiveError(`entry name contains ':' (drive letter or stream): ${raw}`);
  }
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new UnsafeArchiveError(`entry path escapes the destination: ${raw}`);
    parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Whether symlink `linkPath` (normalized, relative to the root) pointing at `target` stays inside
 * the root. An absolute or backslash target is refused outright.
 */
function symlinkStaysInside(linkPath: string, target: string): boolean {
  if (target === "" || target.startsWith("/") || target.includes("\\") || target.includes("\0")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(target)) return false;
  // Resolve lexically from the link's own directory; popping past the root is an escape.
  const stack = linkPath.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") stack.push(seg);
    else if (stack.pop() === undefined) return false;
  }
  return true;
}

/**
 * Create the symlink `dest` -> `target` (an archive's relative, `/`-separated target). Windows
 * needs the native separator in a relative target, and says whether the link is a file or a
 * directory link: Deno cannot infer that there, because it checks whether `target` exists relative
 * to the process's working directory rather than the link's own (every file is written before the
 * links, so an internal target exists by now; a missing one is a file link, refused as dangling
 * right after).
 */
async function createLink(target: string, dest: string): Promise<void> {
  if (Deno.build.os !== "windows") return await Deno.symlink(target, dest);
  const native = target.replaceAll("/", "\\");
  const info = await Deno.stat(join(dirname(dest), native)).catch(() => null);
  try {
    await Deno.symlink(native, dest, { type: info?.isDirectory ? "dir" : "file" });
  } catch (err) {
    // ERROR_PRIVILEGE_NOT_HELD: a standard user without Developer Mode cannot create symlinks.
    if (!/os error 1314\b/.test(String(err))) throw err;
    throw new Error(
      `cannot create the symlink ${dest}: Windows allows symlinks only with Developer Mode on ` +
        "or from an elevated process",
      { cause: err },
    );
  }
}

/** Bookkeeping shared by the tar and zip walkers. */
class Writer {
  readonly files: Record<string, ExtractedFile> = {};
  readonly dirs: string[] = [];
  readonly symlinks: Record<string, string> = {};
  #seen = new Set<string>();
  #bytes = 0;
  #entries = 0;
  readonly #maxBytes: number;
  readonly #maxEntries: number;

  constructor(readonly root: string, limits: ExtractLimits) {
    this.#maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Register an entry path (refusing duplicates and the entry-count cap). */
  #claim(path: string): void {
    if (++this.#entries > this.#maxEntries) {
      throw new UnsafeArchiveError(`archive has more than ${this.#maxEntries} entries`);
    }
    if (this.#seen.has(path)) throw new UnsafeArchiveError(`duplicate archive entry: ${path}`);
    this.#seen.add(path);
  }

  /** Account `n` more uncompressed bytes against the cap. */
  addBytes(n: number): void {
    this.#bytes += n;
    if (this.#bytes > this.#maxBytes) {
      throw new UnsafeArchiveError(`archive expands past ${this.#maxBytes} bytes`);
    }
  }

  async dir(path: string): Promise<void> {
    if (path === "") return;
    this.#claim(path);
    await Deno.mkdir(join(this.root, ...path.split("/")), { recursive: true });
    this.dirs.push(path);
  }

  /** Write a regular file from `body`, hashing it; `expected` (when known) must match exactly. */
  async file(
    path: string,
    mode: number,
    body: ReadableStream<Uint8Array>,
    expected?: number,
  ): Promise<void> {
    if (path === "") throw new UnsafeArchiveError("a file entry names the archive root");
    this.#claim(path);
    const dest = join(this.root, ...path.split("/"));
    await Deno.mkdir(dirname(dest), { recursive: true });
    // createNew: never write through anything already at the path. Only permission bits survive.
    const perm = (mode & 0o777) | 0o600;
    const file = await Deno.open(dest, { write: true, createNew: true, mode: perm });
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of body) {
        size += chunk.byteLength;
        if (expected !== undefined && size > expected) {
          throw new UnsafeArchiveError(`entry ${path} is longer than its header says`);
        }
        this.addBytes(chunk.byteLength);
        hash.update(chunk);
        let off = 0;
        while (off < chunk.byteLength) off += await file.write(chunk.subarray(off));
      }
    } finally {
      file.close();
    }
    if (expected !== undefined && size !== expected) {
      throw new UnsafeArchiveError(`entry ${path} is truncated (${size} of ${expected} bytes)`);
    }
    if (Deno.build.os !== "windows") await Deno.chmod(dest, perm);
    this.files[path] = { size, sha256: hash.digest("hex") };
  }

  /** Queue a symlink (validated now, created by {@linkcode finish} after every file). */
  symlink(path: string, target: string): void {
    if (path === "") throw new UnsafeArchiveError("a symlink entry names the archive root");
    this.#claim(path);
    if (!symlinkStaysInside(path, target)) {
      throw new UnsafeArchiveError(`symlink ${path} -> ${target} points outside the destination`);
    }
    this.symlinks[path] = target;
  }

  /** Create the queued symlinks; none may sit under another symlink or replace an entry. */
  async finish(): Promise<ExtractResult> {
    const links = Object.keys(this.symlinks).sort();
    for (const path of links) {
      const segs = path.split("/");
      for (let i = 1; i < segs.length; i++) {
        const parent = segs.slice(0, i).join("/");
        if (parent in this.symlinks) {
          throw new UnsafeArchiveError(`symlink ${path} sits under another symlink (${parent})`);
        }
        const info = await Deno.lstat(join(this.root, ...segs.slice(0, i))).catch(() => null);
        if (info?.isSymlink) throw new UnsafeArchiveError(`symlink ${path} sits under a symlink`);
      }
      const dest = join(this.root, ...segs);
      await Deno.mkdir(dirname(dest), { recursive: true });
      await createLink(this.symlinks[path], dest);
    }
    // The lexical check above can't see a target that walks THROUGH another link (`p/..` where
    // `p -> .`), so resolve every link for real: it must exist and land inside the destination.
    const realRoot = await Deno.realPath(this.root);
    for (const path of links) {
      const real = await Deno.realPath(join(this.root, ...path.split("/"))).catch(() => null);
      if (real === null) throw new UnsafeArchiveError(`dangling symlink: ${path}`);
      if (real !== realRoot && !real.startsWith(realRoot + SEP)) {
        throw new UnsafeArchiveError(`symlink ${path} resolves outside the destination`);
      }
    }
    return { files: this.files, dirs: this.dirs, symlinks: this.symlinks };
  }
}

// ---------------------------------------------------------------------------------------------
// tar (ustar + pax + GNU long names), read as a stream through gzip.

/** Pull-based exact reads over a byte stream. */
class ByteReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** Read exactly `n` bytes, or fewer only at end of stream. */
  async read(n: number): Promise<Uint8Array> {
    while (this.#buf.byteLength < n) {
      const { value, done } = await this.#reader.read();
      if (done) break;
      const next = new Uint8Array(this.#buf.byteLength + value.byteLength);
      next.set(this.#buf);
      next.set(value, this.#buf.byteLength);
      this.#buf = next;
    }
    const out = this.#buf.subarray(0, Math.min(n, this.#buf.byteLength));
    this.#buf = this.#buf.subarray(out.byteLength);
    return out;
  }

  /** Exactly `n` bytes, or a truncation error. */
  async exact(n: number, what: string): Promise<Uint8Array> {
    const out = await this.read(n);
    if (out.byteLength !== n) throw new UnsafeArchiveError(`archive truncated in ${what}`);
    return out;
  }

  /** `n` bytes as a stream of chunks (at most 1 MiB at a time). */
  body(n: number, what: string): ReadableStream<Uint8Array> {
    let left = n;
    return new ReadableStream({
      pull: async (ctrl) => {
        if (left === 0) return ctrl.close();
        const chunk = await this.exact(Math.min(left, 1 << 20), what);
        left -= chunk.byteLength;
        ctrl.enqueue(chunk.slice());
      },
    });
  }

  async skip(n: number, what: string): Promise<void> {
    for await (const _ of this.body(n, what)) { /* discard */ }
  }

  cancel(): Promise<void> {
    return this.#reader.cancel().catch(() => {});
  }
}

const dec = new TextDecoder();

function cstr(b: Uint8Array): string {
  const end = b.indexOf(0);
  return dec.decode(end === -1 ? b : b.subarray(0, end));
}

function octal(b: Uint8Array, what: string): number {
  if (b[0] & 0x80) throw new UnsafeArchiveError(`unsupported base-256 ${what} in a tar header`);
  const s = cstr(b).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new UnsafeArchiveError(`bad tar ${what}: ${JSON.stringify(s)}`);
  return parseInt(s, 8);
}

/** Parse pax extended-header records (`"<len> <key>=<value>\n"`). */
function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.byteLength) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = Number(dec.decode(data.subarray(i, sp)));
    if (!Number.isInteger(len) || len <= 0 || i + len > data.byteLength) {
      throw new UnsafeArchiveError("malformed pax header");
    }
    const rec = dec.decode(data.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

const pad512 = (n: number) => (512 - (n % 512)) % 512;
/** Metadata entries are small; refuse a huge one rather than buffer it. */
const MAX_META = 1 << 20;

/** Verify a tar header's checksum (the sum of its bytes with the checksum field as spaces). */
function checksumOk(h: Uint8Array): boolean {
  const stored = octal(h.subarray(148, 156), "checksum");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum === stored;
}

/** One parsed tar header, with any pending pax / GNU long-name overrides applied. */
interface TarHeader {
  type: string;
  /** The header's own size field (the metadata payload size for x / g / L / K). */
  size: number;
  /** The entry's data size (pax `size` wins). */
  entrySize: number;
  rawName: string;
  rawLink: string;
  mode: number;
}

/** Overrides carried from metadata entries to the next real entry. */
interface TarPending {
  pax: Record<string, string>;
  longName?: string;
  longLink?: string;
}

/** Parse a 512-byte header block (checksum-verified), applying `pending`. */
function parseTarHeader(h: Uint8Array, pending: TarPending): TarHeader {
  if (!checksumOk(h)) throw new UnsafeArchiveError("tar header checksum mismatch");
  const size = octal(h.subarray(124, 136), "size");
  // POSIX ustar ("ustar\0") has a name prefix field; old GNU ("ustar  ") reuses those bytes.
  const prefix = cstr(h.subarray(257, 263)) === "ustar" ? cstr(h.subarray(345, 500)) : "";
  const baseName = cstr(h.subarray(0, 100));
  const { pax } = pending;
  return {
    type: String.fromCharCode(h[156] || 0x30),
    size,
    entrySize: pax.size !== undefined ? Number(pax.size) : size,
    rawName: pax.path ?? pending.longName ?? (prefix ? `${prefix}/${baseName}` : baseName),
    rawLink: pax.linkpath ?? pending.longLink ?? cstr(h.subarray(157, 257)),
    mode: octal(h.subarray(100, 108), "mode"),
  };
}

/** The metadata entry types (pax extended / global, GNU long name / long link). */
const TAR_META = new Set(["x", "g", "L", "K"]);

/** Read a metadata entry's payload into `pending` ("g", a global pax header, carries nothing used). */
async function readTarMeta(r: ByteReader, h: TarHeader, pending: TarPending): Promise<void> {
  if (h.size > MAX_META) throw new UnsafeArchiveError("oversized tar metadata entry");
  const data = await r.exact(h.size, "a metadata entry");
  await r.skip(pad512(h.size), "padding");
  if (h.type === "x") pending.pax = parsePax(data);
  else if (h.type === "L") pending.longName = cstr(data);
  else if (h.type === "K") pending.longLink = cstr(data);
}

const REFUSED_TAR_TYPES: Record<string, string> = {
  "1": "hard link",
  "3": "character device",
  "4": "block device",
  "6": "FIFO",
};

/** Write one real (non-metadata) entry, or refuse its type. */
async function writeTarEntry(r: ByteReader, w: Writer, h: TarHeader): Promise<void> {
  const size = h.entrySize;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new UnsafeArchiveError(`bad size for ${h.rawName}`);
  }
  const name = safeEntryPath(h.rawName);
  if (h.type === "0" || h.type === "7") {
    await w.file(name, h.mode, r.body(size, name), size);
    await r.skip(pad512(size), "padding");
    return;
  }
  if (h.type === "5") await w.dir(name);
  else if (h.type === "2") w.symlink(name, h.rawLink);
  else {
    const kind = REFUSED_TAR_TYPES[h.type] ?? `type '${h.type}'`;
    throw new UnsafeArchiveError(`refusing ${kind} entry: ${name || h.rawName}`);
  }
  await r.skip(size + pad512(size), "padding");
}

/** The next header block, or `null` at the end-of-archive marker. */
async function nextTarBlock(r: ByteReader): Promise<Uint8Array | null> {
  const h = await r.read(512);
  if (h.byteLength === 0) throw new UnsafeArchiveError("archive truncated (no end marker)");
  if (h.byteLength < 512) throw new UnsafeArchiveError("archive truncated in a header");
  return h.every((b) => b === 0) ? null : h;
}

async function extractTarGz(path: string, w: Writer): Promise<void> {
  const file = await Deno.open(path, { read: true });
  const r = new ByteReader(file.readable.pipeThrough(new DecompressionStream("gzip")));
  try {
    let pending: TarPending = { pax: {} };
    for (let block = await nextTarBlock(r); block; block = await nextTarBlock(r)) {
      const h = parseTarHeader(block, pending);
      if (TAR_META.has(h.type)) {
        await readTarMeta(r, h, pending);
        continue;
      }
      pending = { pax: {} };
      await writeTarEntry(r, w, h);
    }
  } finally {
    await r.cancel();
    try {
      file.close();
    } catch { /* closed with the stream */ }
  }
}

// ---------------------------------------------------------------------------------------------
// zip (stored / deflate, zip64), read from the central directory.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

async function readAt(
  file: Deno.FsFile,
  offset: number,
  n: number,
): Promise<Uint8Array<ArrayBuffer>> {
  await file.seek(offset, Deno.SeekMode.Start);
  const out = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const k = await file.read(out.subarray(got));
    if (k === null) throw new UnsafeArchiveError("zip truncated");
    got += k;
  }
  return out;
}

/** `n` bytes from `offset`, as a stream of ≤ 1 MiB chunks. */
function rangeStream(
  file: Deno.FsFile,
  offset: number,
  n: number,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let pos = offset;
  let left = n;
  return new ReadableStream({
    pull: async (ctrl) => {
      if (left === 0) return ctrl.close();
      const k = Math.min(left, 1 << 20);
      ctrl.enqueue(await readAt(file, pos, k));
      pos += k;
      left -= k;
    },
  });
}

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  csize: number;
  usize: number;
  offset: number;
  madeBy: number;
  external: number;
}

/** Locate the central directory (classic or zip64 end record). */
async function zipDirectory(
  file: Deno.FsFile,
  size: number,
): Promise<{ count: number; offset: number; length: number }> {
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = await readAt(file, size - tailLen, tailLen);
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let at = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      at = i;
      break;
    }
  }
  if (at === -1) throw new UnsafeArchiveError("not a zip archive (no end of central directory)");
  let count = dv.getUint16(at + 10, true);
  let length = dv.getUint32(at + 12, true);
  let offset = dv.getUint32(at + 16, true);
  if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) {
    const locAt = size - tailLen + at - 20;
    if (locAt < 0) throw new UnsafeArchiveError("zip64 locator missing");
    const loc = new DataView((await readAt(file, locAt, 20)).buffer);
    if (loc.getUint32(0, true) !== SIG_EOCD64_LOC) {
      throw new UnsafeArchiveError("zip64 locator missing");
    }
    const recAt = Number(loc.getBigUint64(8, true));
    const rec = new DataView((await readAt(file, recAt, 56)).buffer);
    if (rec.getUint32(0, true) !== SIG_EOCD64) throw new UnsafeArchiveError("bad zip64 end record");
    count = Number(rec.getBigUint64(32, true));
    length = Number(rec.getBigUint64(40, true));
    offset = Number(rec.getBigUint64(48, true));
  }
  if (offset + length > size) throw new UnsafeArchiveError("zip central directory out of range");
  return { count, offset, length };
}

/** Parse the central directory entries. */
/** Apply a zip64 extra field (id 1) in `[x, end)`: the 0xffffffff fields, in order usize, csize,
 * offset, become their 64-bit values. */
function applyZip64Extra(dv: DataView, x: number, end: number, e: ZipEntry): void {
  for (; x + 4 <= end; x += 4 + dv.getUint16(x + 2, true)) {
    if (dv.getUint16(x, true) !== 1) continue;
    let q = x + 4;
    for (const key of ["usize", "csize", "offset"] as const) {
      if (e[key] !== 0xffffffff) continue;
      e[key] = Number(dv.getBigUint64(q, true));
      q += 8;
    }
  }
}

function zipEntries(cen: Uint8Array, count: number): ZipEntry[] {
  const dv = new DataView(cen.buffer, cen.byteOffset, cen.byteLength);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cen.byteLength || dv.getUint32(p, true) !== SIG_CEN) {
      throw new UnsafeArchiveError("bad zip central directory entry");
    }
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const e: ZipEntry = {
      madeBy: dv.getUint16(p + 4, true),
      flags: dv.getUint16(p + 8, true),
      method: dv.getUint16(p + 10, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      external: dv.getUint32(p + 38, true),
      offset: dv.getUint32(p + 42, true),
      name: dec.decode(cen.subarray(p + 46, p + 46 + nameLen)),
    };
    const xEnd = p + 46 + nameLen + extraLen;
    applyZip64Extra(dv, p + 46 + nameLen, xEnd, e);
    out.push(e);
    p = xEnd + commentLen;
  }
  return out;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** The Unix file-type bits of an entry (0 when not made on Unix), refusing special files. */
function zipFileType(e: ZipEntry): { unixMode: number; fmt: number } {
  const unixMode = (e.madeBy >> 8) === 3 ? (e.external >>> 16) : 0;
  const fmt = unixMode & S_IFMT;
  if (fmt !== 0 && fmt !== S_IFREG && fmt !== S_IFDIR && fmt !== S_IFLNK) {
    throw new UnsafeArchiveError(`refusing special zip entry: ${e.name}`);
  }
  return { unixMode, fmt };
}

/** The decompressed data stream of a file entry (stored or deflated), bounds-checked. */
async function zipEntryBody(
  file: Deno.FsFile,
  size: number,
  e: ZipEntry,
): Promise<ReadableStream<Uint8Array>> {
  if (e.method !== 0 && e.method !== 8) {
    throw new UnsafeArchiveError(`unsupported zip compression method ${e.method}: ${e.name}`);
  }
  const loc = new DataView((await readAt(file, e.offset, 30)).buffer);
  if (loc.getUint32(0, true) !== SIG_LOC) {
    throw new UnsafeArchiveError(`bad zip local header: ${e.name}`);
  }
  const dataAt = e.offset + 30 + loc.getUint16(26, true) + loc.getUint16(28, true);
  if (dataAt + e.csize > size) throw new UnsafeArchiveError(`zip entry out of range: ${e.name}`);
  const raw = rangeStream(file, dataAt, e.csize);
  return e.method === 8 ? raw.pipeThrough(new DecompressionStream("deflate-raw")) : raw;
}

/** Write one zip entry (directory, symlink or file). */
async function writeZipEntry(file: Deno.FsFile, size: number, w: Writer, e: ZipEntry) {
  if (e.flags & 1) throw new UnsafeArchiveError(`encrypted zip entry: ${e.name}`);
  const { unixMode, fmt } = zipFileType(e);
  const name = safeEntryPath(e.name);
  if (e.name.endsWith("/") || fmt === S_IFDIR) return await w.dir(name);
  const body = await zipEntryBody(file, size, e);
  if (fmt !== S_IFLNK) {
    return await w.file(name, unixMode ? unixMode & 0o777 : 0o644, body, e.usize);
  }
  if (e.usize > 4096) throw new UnsafeArchiveError(`oversized symlink target: ${name}`);
  w.symlink(name, dec.decode(await new Response(body).arrayBuffer()));
}

async function extractZip(path: string, w: Writer): Promise<void> {
  const file = await Deno.open(path, { read: true });
  try {
    const size = (await file.stat()).size;
    const dir = await zipDirectory(file, size);
    const entries = zipEntries(await readAt(file, dir.offset, dir.length), dir.count);
    for (const e of entries) await writeZipEntry(file, size, w, e);
  } finally {
    file.close();
  }
}

/**
 * Extract `archive` (`.tar.gz` or `.zip`, chosen by `format`) into `dest`, which must not exist yet
 * (it is created). Throws {@linkcode UnsafeArchiveError} on any refused entry; the caller discards
 * `dest` then (it lives in a temp dir).
 *
 * @param archive The archive file.
 * @param format `"tar.gz"` or `"zip"`.
 * @param dest A new directory to extract into.
 * @param limits Size / entry caps.
 * @returns What was written.
 */
export async function extractArchive(
  archive: string,
  format: "tar.gz" | "zip",
  dest: string,
  limits: ExtractLimits = {},
): Promise<ExtractResult> {
  await Deno.mkdir(dest);
  const w = new Writer(dest, limits);
  if (format === "zip") await extractZip(archive, w);
  else await extractTarGz(archive, w);
  return await w.finish();
}
