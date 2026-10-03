// CI check for a cross-built desktop package (`.github/workflows/desktop-ci.yml`, cross-package):
// the bundle a `denext desktop package --target-os <os>` wrote on ANOTHER host is the target's —
// the launcher has the target's executable name and format (PE / ELF, and the arch's machine),
// every native binary inside is the target's (nothing of the host's leaked in), and each archive
// holds the launcher (executable in the .tar.gz and the .deb, where a POSIX mode applies).
//
//   deno run -A scripts/ci/desktop-cross-package-check.ts <dist> <name> <windows|linux> <x64|arm64> <formats>
//   deno run -A scripts/ci/desktop-cross-package-check.ts examples/native/dist denext-native windows x64 zip
//
// It reads magic bytes itself (no `file`, which Windows runners lack).

import { join, relative, SEPARATOR } from "@std/path";

/** A native binary's container format and machine. */
export interface BinaryKind {
  readonly format: "pe" | "elf" | "macho";
  /** `x64` | `arm64` | another machine id, as text. */
  readonly arch: string;
}

const PE_MACHINES: Record<number, string> = { 0x8664: "x64", 0xaa64: "arm64", 0x14c: "x86" };
const ELF_MACHINES: Record<number, string> = { 62: "x64", 183: "arm64", 3: "x86" };
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]);

/** The PE machine of `b`, or `null` when `b` is not a PE image. */
function peKind(b: Uint8Array): BinaryKind | null {
  if (b.length < 64 || b[0] !== 0x4d || b[1] !== 0x5a) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const pe = view.getUint32(0x3c, true);
  if (pe + 6 > b.length || view.getUint32(pe, false) !== 0x50450000) return null;
  const machine = view.getUint16(pe + 4, true);
  return { format: "pe", arch: PE_MACHINES[machine] ?? `0x${machine.toString(16)}` };
}

/** The ELF machine of `b`, or `null` when `b` is not an ELF file. */
function elfKind(b: Uint8Array): BinaryKind | null {
  if (b.length < 20 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46) {
    return null;
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const machine = view.getUint16(18, b[5] === 1);
  return { format: "elf", arch: ELF_MACHINES[machine] ?? String(machine) };
}

/**
 * What native binary `bytes` (a file's head — 4 KiB is plenty) is, or `null` for anything else.
 *
 * @param bytes The file's first bytes.
 * @returns The format and machine.
 */
export function binaryKind(bytes: Uint8Array): BinaryKind | null {
  const pe = peKind(bytes);
  if (pe) return pe;
  const elf = elfKind(bytes);
  if (elf) return elf;
  if (bytes.length >= 4) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    if (MACHO_MAGICS.has(magic)) return { format: "macho", arch: "?" };
  }
  return null;
}

/** One tar entry: its normalized path (no leading `./`), POSIX mode and type flag. */
export interface TarEntry {
  readonly path: string;
  readonly mode: number;
  readonly type: string;
  readonly linkName: string;
}

const DEC = new TextDecoder();

/** A NUL-terminated field. */
function field(b: Uint8Array, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const end = s.indexOf(0);
  return DEC.decode(end < 0 ? s : s.subarray(0, end));
}

/** An octal numeric field. */
function octal(b: Uint8Array, off: number, len: number): number {
  return parseInt(field(b, off, len).trim() || "0", 8);
}

/** A pax extended header's `path` / `linkpath` records. */
function paxRecords(body: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of DEC.decode(body).split("\n")) {
    const m = /^\d+ ([^=]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Strip `./` and a trailing `/`. */
function normalize(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/$/, "");
}

/**
 * The entries of an uncompressed tar (ustar, GNU long names and pax headers).
 *
 * @param tar The archive bytes.
 * @returns Every member.
 */
export function tarEntries(tar: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let pending: Record<string, string> = {};
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") pending = { ...pending, ...paxRecords(body) };
    else if (type === "L") pending = { ...pending, path: field(body, 0, body.length) };
    else if (type === "K") pending = { ...pending, linkpath: field(body, 0, body.length) };
    else if (type !== "g") {
      const prefix = field(h, 345, 155);
      const name = pending.path ?? (prefix ? `${prefix}/` : "") + field(h, 0, 100);
      const linkName = pending.linkpath ?? field(h, 157, 100);
      out.push({ path: normalize(name), mode: octal(h, 100, 8) & 0o7777, type, linkName });
      pending = {};
    }
  }
  return out;
}

/** Gunzip `bytes`. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The members of a `!<arch>` (ar) archive, as a `.deb` is.
 *
 * @param ar The archive bytes.
 * @returns Each member's name and bytes.
 */
export function arMembers(ar: Uint8Array): Map<string, Uint8Array> {
  if (DEC.decode(ar.subarray(0, 8)) !== "!<arch>\n") throw new Error("not an ar archive");
  const out = new Map<string, Uint8Array>();
  for (let off = 8; off + 60 <= ar.length;) {
    const name = DEC.decode(ar.subarray(off, off + 16)).trim().replace(/\/$/, "");
    const size = parseInt(DEC.decode(ar.subarray(off + 48, off + 58)).trim(), 10);
    out.set(name, ar.subarray(off + 60, off + 60 + size));
    off += 60 + size + (size % 2);
  }
  return out;
}

/** What one check run expects. */
export interface CrossExpectation {
  readonly dist: string;
  readonly name: string;
  readonly os: "windows" | "linux";
  readonly label: "x64" | "arm64";
  readonly formats: readonly string[];
}

const EXPECTED_FORMAT = { windows: "pe", linux: "elf" } as const;

/** Read a file's first 4 KiB. */
async function head(path: string): Promise<Uint8Array> {
  using f = await Deno.open(path);
  const buf = new Uint8Array(4096);
  const n = await f.read(buf);
  return buf.subarray(0, n ?? 0);
}

/** Every regular file under `root`, `/`-separated relative paths. */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const abs = join(dir, e.name);
      if (e.isDirectory) await visit(abs);
      else if (e.isFile) out.push(relative(root, abs).split(SEPARATOR).join("/"));
    }
  };
  await visit(root);
  return out.sort();
}

/** Whether `kind` is a binary for the expectation's OS and arch. */
function matches(kind: BinaryKind, x: CrossExpectation): boolean {
  return kind.format === EXPECTED_FORMAT[x.os] && kind.arch === x.label;
}

/** Problems with the bundle directory: the launcher, and every native binary inside. */
async function checkBundle(x: CrossExpectation, problems: string[]): Promise<void> {
  const base = `${x.name}-${x.label}`;
  const dir = join(x.dist, base);
  const exe = base + (x.os === "windows" ? ".exe" : "");
  const files = await walkFiles(dir).catch(() => null);
  if (!files) return void problems.push(`no bundle directory at ${dir}`);
  console.log(`bundle ${dir} (${files.length} files):`);
  let libs = 0;
  for (const rel of files) {
    if (await checkBundleFile(x, dir, rel, problems)) libs++;
  }
  if (!files.includes(exe)) problems.push(`no launcher ${exe} at the bundle's top level`);
  if (libs === 0) problems.push(`no ${x.os === "windows" ? ".dll" : ".so"} in the bundle`);
}

/** Check one bundle file; returns whether it is a native shared library. */
async function checkBundleFile(
  x: CrossExpectation,
  dir: string,
  rel: string,
  problems: string[],
): Promise<boolean> {
  const kind = binaryKind(await head(join(dir, ...rel.split("/"))));
  console.log(`  ${rel}${kind ? `  [${kind.format} ${kind.arch}]` : ""}`);
  if (rel.endsWith(".denext-cross-host.json")) problems.push(`the cross-host stamp leaked: ${rel}`);
  if (!kind) return false;
  if (!matches(kind, x)) {
    problems.push(`${rel} is ${kind.format} ${kind.arch}, not ${EXPECTED_FORMAT[x.os]} ${x.label}`);
  }
  return /\.(dll|so)(\.|$)/.test(rel);
}

/** Problems with the Windows .zip: present, a zip, and holding the launcher. */
async function checkZip(x: CrossExpectation, problems: string[]): Promise<void> {
  const zip = join(x.dist, `${x.name}-${x.label}-windows.zip`);
  const bytes = await Deno.readFile(zip).catch(() => null);
  if (!bytes) return void problems.push(`no ${zip}`);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) problems.push(`${zip} is not a zip`);
  const exe = `${x.name}-${x.label}/${x.name}-${x.label}.exe`;
  if (!DEC.decode(bytes).includes(exe)) problems.push(`${zip} does not hold ${exe}`);
  console.log(`✓ checked ${zip} (${bytes.length} bytes)`);
}

/** Problems with one tar member that must be an executable regular file. */
function checkExecutable(entries: TarEntry[], path: string, where: string, problems: string[]) {
  const e = entries.find((e) => e.path === path);
  if (!e) problems.push(`${where} does not hold ${path}`);
  else if (e.type !== "0") problems.push(`${where}: ${path} is type ${e.type}, not a file`);
  else if ((e.mode & 0o111) === 0) {
    problems.push(`${where}: ${path} is not executable (mode ${e.mode.toString(8)})`);
  }
}

/** Problems with the Linux .tar.gz: the bundle, launcher executable. */
async function checkTarball(x: CrossExpectation, problems: string[]): Promise<void> {
  const tgz = join(x.dist, `${x.name}-${x.label}-linux.tar.gz`);
  const bytes = await Deno.readFile(tgz).catch(() => null);
  if (!bytes) return void problems.push(`no ${tgz}`);
  const entries = tarEntries(await gunzip(bytes));
  const base = `${x.name}-${x.label}`;
  checkExecutable(entries, `${base}/${base}`, tgz, problems);
  console.log(`✓ checked ${tgz} (${entries.length} entries)`);
}

/** Problems with the .deb: the arch in `control`, the launcher executable, the /usr/bin link. */
async function checkDeb(x: CrossExpectation, problems: string[]): Promise<void> {
  const deb = join(x.dist, `${x.name}-${x.label}.deb`);
  const bytes = await Deno.readFile(deb).catch(() => null);
  if (!bytes) return void problems.push(`no ${deb}`);
  const members = arMembers(bytes);
  const controlTar = await gunzip(members.get("control.tar.gz") ?? new Uint8Array());
  if (!tarEntries(controlTar).some((e) => e.path === "control")) {
    problems.push(`${deb} has no control file`);
  }
  const arch = x.label === "x64" ? "amd64" : "arm64";
  if (!DEC.decode(controlTar).includes(`Architecture: ${arch}\n`)) {
    problems.push(`${deb}: control does not say Architecture: ${arch}`);
  }
  const data = tarEntries(await gunzip(members.get("data.tar.gz") ?? new Uint8Array()));
  const bin = data.find((e) => e.path.startsWith("usr/bin/") && e.type === "2");
  if (!bin) return void problems.push(`${deb} has no /usr/bin symlink`);
  const pkg = bin.path.slice("usr/bin/".length);
  checkExecutable(data, `usr/lib/${pkg}/${x.name}-${x.label}`, deb, problems);
  console.log(`✓ checked ${deb} (${data.length} data entries)`);
}

const ARCHIVES: Record<string, (x: CrossExpectation, problems: string[]) => Promise<void>> = {
  zip: checkZip,
  "tar.gz": checkTarball,
  deb: checkDeb,
};

/**
 * Check a cross-built package against what it should be.
 *
 * @param x The dist directory, app name, target OS / arch and the archive formats built.
 * @returns The problems (empty when it is right).
 */
export async function checkCrossPackage(x: CrossExpectation): Promise<string[]> {
  const problems: string[] = [];
  await checkBundle(x, problems);
  for (const format of x.formats) {
    const check = ARCHIVES[format];
    if (!check) problems.push(`no check for the format ${format}`);
    else await check(x, problems);
  }
  return problems;
}

if (import.meta.main) {
  const [dist, name, os, label, formats] = Deno.args;
  if (!formats || (os !== "windows" && os !== "linux") || (label !== "x64" && label !== "arm64")) {
    console.error(
      "usage: desktop-cross-package-check.ts <dist> <name> <windows|linux> <x64|arm64> <formats>",
    );
    Deno.exit(2);
  }
  const problems = await checkCrossPackage({
    dist,
    name,
    os,
    label,
    formats: formats.split(","),
  });
  if (problems.length > 0) {
    console.error(`\n✗ cross-built ${os} ${label} package:\n  - ${problems.join("\n  - ")}`);
    Deno.exit(1);
  }
  console.log(`\n✓ the cross-built ${os} ${label} package is the target's`);
}
