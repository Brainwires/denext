// Desktop CI: the Linux packages' NEEDED check. Every ELF file a .deb / .rpm installs (the launcher,
// the runtime library, CEF and its helpers, Node-API addons) names the shared libraries it needs in
// its dynamic section (DT_NEEDED). Each one must be found on a machine that installed the package
// through its package manager, so each must be:
//
//   - part of the C runtime every distribution has (glibc, libgcc_s, zlib, libudev),
//   - shipped in the package itself (a file there by that name, or whose DT_SONAME it is),
//   - declared: a soname the package's own Depends / Requires name (by Debian package, through
//     LINUX_RUNTIME_DEPS in src/build/desktop-installers.ts, or by an RPM `soname()(64bit)`), or
//   - brought in by a declared library's own package dependencies (TRANSITIVE below: GTK 3 pulls in
//     GLib, Cairo, Pango, Wayland's client library, ...).
//
// Anything else fails, and so does a distribution's shared Node.js (`libnode.so*`, which `node-gyp`
// links under Debian's / Fedora's `nodejs`), wherever it is declared or not. The ELF files are read
// here (no readelf / objdump needed), so the check runs on any host:
//
//   deno run -A scripts/ci/linux-needed-check.ts <dir> --declared "<Depends field or rpm -qpR output>"
//
// <dir> is an unpacked package (`dpkg-deb -x`, `rpm2cpio | cpio -id`) or an installed tree.

import { walk } from "@std/fs/walk";
import { relative } from "@std/path";
import { LINUX_RUNTIME_DEPS } from "../../src/build/desktop-installers.ts";

/** What one ELF file's dynamic section says. */
export interface ElfDynamic {
  /** Its DT_NEEDED entries, in order. */
  readonly needed: string[];
  /** Its DT_SONAME, when it has one. */
  readonly soname?: string;
}

/** Libraries every glibc distribution has: the C runtime, the GCC runtime, zlib and libudev. */
export const BASE_LIBRARIES: ReadonlySet<string> = new Set([
  "libc.so.6",
  "libm.so.6",
  "libdl.so.2",
  "libpthread.so.0",
  "librt.so.1",
  "libutil.so.1",
  "libresolv.so.2",
  "ld-linux-x86-64.so.2",
  "ld-linux-aarch64.so.1",
  "libgcc_s.so.1",
  // Debian marks zlib1g and libudev1 required (in every install); Fedora's base has zlib(-ng) and
  // systemd-libs, which dnf itself depends on.
  "libz.so.1",
  "libudev.so.1",
]);

/**
 * Libraries a declared one's package brings in through its own dependencies, keyed by the declared
 * soname (what Debian's libgtk-3-0 / libwebkit2gtk-4.1-0 / libatk-bridge2.0-0 and Fedora's gtk3 /
 * webkit2gtk4.1 / at-spi2-atk depend on).
 */
export const TRANSITIVE: Readonly<Record<string, readonly string[]>> = {
  "libgtk-3.so.0": [
    "libgdk-3.so.0",
    "libglib-2.0.so.0",
    "libgobject-2.0.so.0",
    "libgio-2.0.so.0",
    "libgmodule-2.0.so.0",
    "libcairo.so.2",
    "libcairo-gobject.so.2",
    "libgdk_pixbuf-2.0.so.0",
    "libpango-1.0.so.0",
    "libpangocairo-1.0.so.0",
    "libharfbuzz.so.0",
    "libatk-1.0.so.0",
    "libX11.so.6",
    "libxcb.so.1",
    "libwayland-client.so.0",
    "libwayland-cursor.so.0",
    "libwayland-egl.so.1",
    "libepoxy.so.0",
    "libfontconfig.so.1",
    "libstdc++.so.6",
  ],
  "libwebkit2gtk-4.1.so.0": ["libjavascriptcoregtk-4.1.so.0", "libsoup-3.0.so.0", "libstdc++.so.6"],
  "libatk-bridge-2.0.so.0": ["libatspi.so.0"],
};

/** Read `length` bytes at `offset` (fewer at the end of the file). */
async function readAt(file: Deno.FsFile, offset: number, length: number): Promise<Uint8Array> {
  const buf = new Uint8Array(length);
  await file.seek(offset, Deno.SeekMode.Start);
  let got = 0;
  while (got < length) {
    const n = await file.read(buf.subarray(got));
    if (n === null) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** Where the fields this reader needs sit, for 32- and 64-bit ELF. */
interface ElfLayout {
  readonly is64: boolean;
  readonly le: boolean;
  /** e_phoff, e_phentsize, e_phnum. */
  readonly phoff: number;
  readonly phentsize: number;
  readonly phnum: number;
  /** p_offset, p_vaddr, p_filesz within a program header. */
  readonly pOffset: number;
  readonly pVaddr: number;
  readonly pFilesz: number;
  /** The size of one dynamic entry. */
  readonly dynEntry: number;
}

const LAYOUT64 = {
  phoff: 0x20,
  phentsize: 0x36,
  phnum: 0x38,
  pOffset: 0x08,
  pVaddr: 0x10,
  pFilesz: 0x20,
  dynEntry: 16,
};
const LAYOUT32 = {
  phoff: 0x1c,
  phentsize: 0x2a,
  phnum: 0x2c,
  pOffset: 0x04,
  pVaddr: 0x08,
  pFilesz: 0x10,
  dynEntry: 8,
};

/** An address-sized field. */
function word(v: DataView, at: number, l: { is64: boolean; le: boolean }): number {
  return l.is64 ? Number(v.getBigUint64(at, l.le)) : v.getUint32(at, l.le);
}

/** A view over bytes. */
function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** The ELF identification and header fields, or `null` when the bytes are not ELF. */
function elfLayout(ident: Uint8Array): ElfLayout | null {
  const magic = [0x7f, 0x45, 0x4c, 0x46];
  if (ident.length < 52 || magic.some((b, i) => ident[i] !== b)) return null;
  const is64 = ident[4] === 2;
  const le = ident[5] === 1;
  const fields = is64 ? LAYOUT64 : LAYOUT32;
  const v = view(ident);
  return {
    ...fields,
    is64,
    le,
    phoff: word(v, fields.phoff, { is64, le }),
    phentsize: v.getUint16(fields.phentsize, le),
    phnum: v.getUint16(fields.phnum, le),
  };
}

/** One program header's type and placement. */
interface Segment {
  readonly type: number;
  readonly offset: number;
  readonly vaddr: number;
  readonly filesz: number;
}

/** The program headers. */
function segments(ph: Uint8Array, l: ElfLayout): Segment[] {
  const v = view(ph);
  const out: Segment[] = [];
  for (let at = 0; out.length < l.phnum && at + l.phentsize <= ph.length; at += l.phentsize) {
    out.push({
      type: v.getUint32(at, l.le),
      offset: word(v, at + l.pOffset, l),
      vaddr: word(v, at + l.pVaddr, l),
      filesz: word(v, at + l.pFilesz, l),
    });
  }
  return out;
}

/** The dynamic entries this check reads: NEEDED / SONAME string offsets, STRTAB, STRSZ. */
function dynamicTags(dyn: Uint8Array, l: ElfLayout) {
  const v = view(dyn);
  const tags = { needed: [] as number[], soname: -1, strtab: -1, strsz: 0 };
  for (let at = 0; at + l.dynEntry <= dyn.length; at += l.dynEntry) {
    const tag = word(v, at, l);
    const val = word(v, at + l.dynEntry / 2, l);
    if (tag === 0) break; // DT_NULL
    if (tag === 1) tags.needed.push(val);
    if (tag === 14) tags.soname = val;
    if (tag === 5) tags.strtab = val; // an address
    if (tag === 10) tags.strsz = val;
  }
  return tags;
}

/** The NUL-terminated string at `i`. */
function cString(strings: Uint8Array, i: number): string {
  const end = strings.indexOf(0, i);
  return new TextDecoder().decode(strings.subarray(i, end < 0 ? strings.length : end));
}

/**
 * The dynamic section of an ELF file, or `null` for a file that is not ELF (or has no dynamic
 * section: a static executable). Only the headers, the dynamic segment and the strings it names are
 * read, so a large library costs a few reads.
 *
 * @param path The file.
 */
export async function readElfDynamic(path: string): Promise<ElfDynamic | null> {
  using file = await Deno.open(path, { read: true });
  const l = elfLayout(await readAt(file, 0, 64));
  if (!l) return null;
  const segs = segments(await readAt(file, l.phoff, l.phentsize * l.phnum), l);
  const dynamic = segs.find((s) => s.type === 2); // PT_DYNAMIC
  if (!dynamic) return null;
  const tags = dynamicTags(await readAt(file, dynamic.offset, dynamic.filesz), l);
  if (tags.strtab < 0) return { needed: [] };
  // DT_STRTAB is an address: the PT_LOAD segment holding it maps it to a file offset.
  const load = segs.find((s) =>
    s.type === 1 && tags.strtab >= s.vaddr && tags.strtab < s.vaddr + s.filesz
  );
  const strings = await readAt(
    file,
    load ? tags.strtab - load.vaddr + load.offset : tags.strtab,
    tags.strsz,
  );
  const needed = tags.needed.map((i) => cString(strings, i));
  return tags.soname < 0 ? { needed } : { needed, soname: cString(strings, tags.soname) };
}

/**
 * The sonames a package's declared dependencies provide: a Debian `Depends` field (packages, with
 * versions and `|` alternatives) or `rpm -qpR` output (one requirement per line; `soname()(64bit)`
 * names a library outright). A Debian package counts through LINUX_RUNTIME_DEPS' mapping.
 *
 * @param declared The field or listing.
 */
export function declaredSonames(declared: string): Set<string> {
  const byPackage = new Map<string, string[]>();
  for (const deps of Object.values(LINUX_RUNTIME_DEPS)) {
    for (const [so, pkg] of deps) byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), so]);
  }
  const out = new Set<string>();
  for (const token of declared.split(/[,\n|]/)) {
    const t = token.trim();
    const so = /^(\S+?\.so(?:\.[\w.]+)?)\(\)/.exec(t);
    if (so) {
      out.add(so[1]);
      continue;
    }
    const name = t.split(/[\s(]/)[0];
    for (const lib of byPackage.get(name) ?? []) out.add(lib);
  }
  return out;
}

/** One library an ELF file needs that the package cannot count on. */
export interface NeededProblem {
  /** The file, relative to the checked tree. */
  readonly file: string;
  /** The soname it needs. */
  readonly library: string;
  readonly reason: string;
}

/**
 * Check every ELF file's needs (see the header).
 *
 * @param files Each ELF file (relative path) with its dynamic section.
 * @param declared The sonames the package declares ({@linkcode declaredSonames}).
 * @param bundled The names of every file in the package (basename) besides the ELF files' sonames.
 */
export function neededProblems(
  files: ReadonlyMap<string, ElfDynamic>,
  declared: ReadonlySet<string>,
  bundled: ReadonlySet<string>,
): NeededProblem[] {
  const shipped = new Set(bundled);
  for (const d of files.values()) if (d.soname) shipped.add(d.soname);
  const covered = new Set(declared);
  for (const so of declared) for (const t of TRANSITIVE[so] ?? []) covered.add(t);
  const problems: NeededProblem[] = [];
  for (const [file, { needed }] of files) {
    for (const library of needed) {
      if (/^libnode\.so(\.\d+)*$/.test(library)) {
        problems.push({
          file,
          library,
          reason: "a distribution's shared Node.js, which no packaged app can load (rebuild the " +
            "addon against Node's headers, or use a prebuilt one)",
        });
      } else if (!BASE_LIBRARIES.has(library) && !shipped.has(library) && !covered.has(library)) {
        problems.push({
          file,
          library,
          reason: "not in the package, not declared in its dependencies and not brought in by one",
        });
      }
    }
  }
  return problems;
}

/**
 * Check an unpacked package.
 *
 * @param dir The unpacked tree.
 * @param declared Its Depends field or `rpm -qpR` output.
 * @returns The ELF files read and the problems.
 */
export async function checkTree(
  dir: string,
  declared: string,
): Promise<{ files: Map<string, ElfDynamic>; problems: NeededProblem[] }> {
  const files = new Map<string, ElfDynamic>();
  const names = new Set<string>();
  for await (const e of walk(dir, { includeDirs: false, followSymlinks: false })) {
    if (!e.isFile) continue;
    names.add(e.name);
    const dyn = await readElfDynamic(e.path);
    if (dyn) files.set(relative(dir, e.path), dyn);
  }
  return { files, problems: neededProblems(files, declaredSonames(declared), names) };
}

if (import.meta.main) {
  const [dir, flag, declared] = Deno.args;
  if (!dir || flag !== "--declared" || declared === undefined) {
    console.error('usage: linux-needed-check.ts <dir> --declared "<Depends / rpm -qpR output>"');
    Deno.exit(2);
  }
  const { files, problems } = await checkTree(dir, declared);
  for (const [file, d] of files) console.log(`${file}: NEEDED ${d.needed.join(", ") || "(none)"}`);
  if (files.size === 0) {
    console.error(`::error::no ELF file under ${dir}: is it the unpacked package?`);
    Deno.exit(1);
  }
  for (const p of problems) console.error(`::error::${p.file} needs ${p.library}: ${p.reason}`);
  if (problems.length > 0) Deno.exit(1);
  console.log(`\n✓ ${files.size} ELF file(s): every NEEDED library is base, bundled or declared`);
}
