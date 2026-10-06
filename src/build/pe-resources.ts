// The icon and version resources of a Windows executable, rewritten in place of the ones it
// ships with (pure TypeScript, so a Windows app packages from any host).
//
// Deno Desktop's CEF backend runs web content in Chromium's sandbox, which on Windows lives in
// CEF's `bootstrap.exe`: that file becomes the app's `<App>.exe`, so out of the box the app shows
// up with CEF's icon and as "CEF bootstrap" in Task Manager. `stampPeResources` gives it the
// app's icon and a version resource naming the app, keeping every other resource (the manifest
// that turns on the Windows 10 compatibility mode, string tables).
//
// How: the existing resource tree is read, edited, and written to a NEW section appended after
// the last one, and the resource data directory is pointed at it. Nothing else in the image moves
// (code and data keep their RVAs, the base relocations stay valid); the old resource bytes stay
// behind, unreferenced. Any Authenticode signature is dropped (it no longer matches): signing
// comes after this step.

/** `RT_ICON`. */
const RT_ICON = 3;
/** `RT_GROUP_ICON`. */
const RT_GROUP_ICON = 14;
/** `RT_VERSION`. */
const RT_VERSION = 16;
/** U.S. English. */
const LANG_EN_US = 1033;
/** The resource data directory's index. */
const DIR_RESOURCE = 2;
/** The certificate table's index (a file offset, not an RVA). */
const DIR_SECURITY = 4;

/** A resource directory entry's name: a numeric id or a string. */
export type PeResourceName = number | string;

/** One resource's bytes and code page. */
export interface PeResourceData {
  data: Uint8Array;
  codepage: number;
}

/** A resource tree: type → name → language → data, in the image's order. */
export type PeResourceTree = Map<PeResourceName, Map<PeResourceName, Map<number, PeResourceData>>>;

/** What {@linkcode stampPeResources} writes. */
export interface PeStamp {
  /** An `.ico` file: replaces the executable's first icon group (its images and its group). */
  readonly icon?: Uint8Array;
  /** The four `VS_FIXEDFILEINFO` version words (`major.minor.build.revision`). */
  readonly version: readonly [number, number, number, number];
  /** The version resource's strings (`ProductName`, `FileDescription`, ...), U.S. English. */
  readonly strings: Readonly<Record<string, string>>;
}

interface Section {
  name: string;
  virtualSize: number;
  virtualAddress: number;
  sizeOfRawData: number;
  pointerToRawData: number;
}

interface Headers {
  /** The optional header's offset. */
  opt: number;
  pe32plus: boolean;
  /** The data directory array's offset and length. */
  dirs: number;
  dirCount: number;
  sectionTable: number;
  sections: Section[];
  sectionAlignment: number;
  fileAlignment: number;
  sizeOfHeaders: number;
}

function fail(message: string): never {
  throw new Error(`not a PE image this can edit: ${message}`);
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** The offset of the PE signature, after checking the DOS and PE magic. */
function peOffset(b: Uint8Array, v: DataView): number {
  if (b.length < 64 || b[0] !== 0x4d || b[1] !== 0x5a) fail("no MZ header");
  const pe = v.getUint32(0x3c, true);
  if (pe + 24 > b.length || v.getUint32(pe, true) !== 0x4550) fail("no PE signature");
  return pe;
}

/** The section table's `count` entries at `at`. */
function readSections(b: Uint8Array, v: DataView, at: number, count: number): Section[] {
  if (at + count * 40 > b.length) fail("truncated section table");
  return Array.from({ length: count }, (_, i) => {
    const s = at + i * 40;
    return {
      name: new TextDecoder().decode(b.subarray(s, s + 8)).replace(/\0+$/, ""),
      virtualSize: v.getUint32(s + 8, true),
      virtualAddress: v.getUint32(s + 12, true),
      sizeOfRawData: v.getUint32(s + 16, true),
      pointerToRawData: v.getUint32(s + 20, true),
    };
  });
}

function readHeaders(b: Uint8Array): Headers {
  const v = view(b);
  const coff = peOffset(b, v) + 4;
  const opt = coff + 20;
  const magic = v.getUint16(opt, true);
  if (magic !== 0x20b && magic !== 0x10b) fail(`unknown optional header magic ${magic}`);
  const pe32plus = magic === 0x20b;
  const dirs = opt + (pe32plus ? 112 : 96);
  const sectionTable = opt + v.getUint16(coff + 16, true);
  return {
    opt,
    pe32plus,
    dirs,
    dirCount: v.getUint32(dirs - 4, true),
    sectionTable,
    sections: readSections(b, v, sectionTable, v.getUint16(coff + 2, true)),
    sectionAlignment: v.getUint32(opt + 32, true),
    fileAlignment: v.getUint32(opt + 36, true),
    sizeOfHeaders: v.getUint32(opt + 60, true),
  };
}

function align(n: number, to: number): number {
  return Math.ceil(n / to) * to;
}

/**
 * The file offset of `rva`, through the section that maps it. An RVA in a section's virtual-only
 * tail (past its raw data, zeros once loaded) has no bytes in the file: refused, rather than read
 * from whatever follows the section's raw data (the next section).
 */
function rvaToOffset(h: Headers, rva: number): number {
  for (const s of h.sections) {
    const size = Math.max(s.virtualSize, s.sizeOfRawData);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
      if (rva - s.virtualAddress >= s.sizeOfRawData) {
        return fail(`RVA ${rva} is in the uninitialized tail of section ${s.name}`);
      }
      return s.pointerToRawData + (rva - s.virtualAddress);
    }
  }
  return fail(`RVA ${rva} is in no section`);
}

/** One resource directory table's entries: name, offset, and whether it is a subdirectory. */
type DirEntry = [name: PeResourceName, offset: number, isDir: boolean];

/** Reads the resource directory tables of one image, refusing loops and tables past its end. */
class ResourceReader {
  private readonly seen = new Set<number>();
  constructor(
    private readonly pe: Uint8Array,
    private readonly v: DataView,
    private readonly base: number,
  ) {}

  /** A name: an id, or (high bit set) a length-prefixed UTF-16 string. */
  private name(field: number): PeResourceName {
    if (!(field & 0x80000000)) return field & 0xffff;
    const s = this.base + (field & 0x7fffffff);
    const units: number[] = [];
    for (let j = 0; j < this.v.getUint16(s, true); j++) {
      units.push(this.v.getUint16(s + 2 + j * 2, true));
    }
    return String.fromCharCode(...units);
  }

  table(at: number): DirEntry[] {
    if (this.seen.has(at) || this.base + at + 16 > this.pe.length) fail("bad resource directory");
    this.seen.add(at);
    const o = this.base + at;
    const count = this.v.getUint16(o + 12, true) + this.v.getUint16(o + 14, true);
    return Array.from({ length: count }, (_, i) => {
      const e = o + 16 + i * 8;
      const off = this.v.getUint32(e + 4, true);
      return [this.name(this.v.getUint32(e, true)), off & 0x7fffffff, (off & 0x80000000) !== 0];
    });
  }

  data(at: number, h: Headers): PeResourceData {
    const d = this.base + at;
    const size = this.v.getUint32(d + 4, true);
    const off = rvaToOffset(h, this.v.getUint32(d, true));
    if (off + size > this.pe.length) fail("resource data past the end of the file");
    return { data: this.pe.slice(off, off + size), codepage: this.v.getUint32(d + 8, true) };
  }
}

/**
 * The resource tree of a PE image (empty when it has none).
 *
 * @param pe The image's bytes.
 * @returns Its resources, by type, name and language.
 */
export function readPeResources(pe: Uint8Array): PeResourceTree {
  const h = readHeaders(pe);
  const v = view(pe);
  const tree: PeResourceTree = new Map();
  if (h.dirCount <= DIR_RESOURCE) return tree;
  const rva = v.getUint32(h.dirs + DIR_RESOURCE * 8, true);
  if (rva === 0 || v.getUint32(h.dirs + DIR_RESOURCE * 8 + 4, true) === 0) return tree;
  const r = new ResourceReader(pe, v, rvaToOffset(h, rva));
  const subdir = ([, at, isDir]: DirEntry, what: string) =>
    isDir ? r.table(at) : fail(`a resource ${what} is not a directory`);
  for (const type of r.table(0)) {
    const names = new Map<PeResourceName, Map<number, PeResourceData>>();
    for (const name of subdir(type, "type")) {
      const langs = new Map<number, PeResourceData>();
      for (const [lang, at, isDir] of subdir(name, "name")) {
        if (isDir || typeof lang !== "number") fail("a resource language is not data");
        langs.set(lang, r.data(at, h));
      }
      names.set(name[0], langs);
    }
    tree.set(type[0], names);
  }
  return tree;
}

/** Names sorted as the PE format requires: strings (case-insensitively) first, then ids. */
function sortedNames<T>(m: Map<PeResourceName, T>): [PeResourceName, T][] {
  return [...m.entries()].sort(([a], [b]) => {
    if (typeof a === "string" && typeof b === "string") {
      const x = a.toUpperCase();
      const y = b.toUpperCase();
      return x < y ? -1 : x > y ? 1 : 0;
    }
    if (typeof a === "string") return -1;
    if (typeof b === "string") return 1;
    return a - b;
  });
}

/** The `.rsrc` bytes for `tree`, its data entries pointing at RVAs from `rva`. */
function buildResourceSection(tree: PeResourceTree, rva: number): Uint8Array {
  // Layout: every directory table, then every data entry, then the name strings, then the data.
  type Dir = { entries: { name: PeResourceName; child: Dir | PeResourceData }[] };
  const toDir = (m: Map<PeResourceName, unknown>): Dir => ({
    entries: sortedNames(m).map(([name, child]) => ({
      name,
      child: child instanceof Map
        ? toDir(child as Map<PeResourceName, unknown>)
        : child as PeResourceData,
    })),
  });
  const root = toDir(tree as Map<PeResourceName, unknown>);
  const dirs: Dir[] = [];
  const datas: PeResourceData[] = [];
  const strings: string[] = [];
  const walk = (d: Dir) => {
    dirs.push(d);
    for (const e of d.entries) {
      if (typeof e.name === "string" && !strings.includes(e.name)) strings.push(e.name);
      if ("entries" in e.child) walk(e.child);
      else datas.push(e.child);
    }
  };
  walk(root);
  const dirAt = new Map<Dir, number>();
  let at = 0;
  for (const d of dirs) {
    dirAt.set(d, at);
    at += 16 + d.entries.length * 8;
  }
  const entryAt = new Map<PeResourceData, number>();
  for (const d of datas) {
    entryAt.set(d, at);
    at += 16;
  }
  const stringAt = new Map<string, number>();
  for (const s of strings) {
    stringAt.set(s, at);
    at += 2 + s.length * 2;
  }
  at = align(at, 8);
  const blobAt = new Map<PeResourceData, number>();
  for (const d of datas) {
    blobAt.set(d, at);
    at = align(at + d.data.length, 8);
  }
  const out = new Uint8Array(at);
  const v = view(out);
  for (const d of dirs) {
    const o = dirAt.get(d)!;
    v.setUint16(o + 12, d.entries.filter((e) => typeof e.name === "string").length, true);
    v.setUint16(o + 14, d.entries.filter((e) => typeof e.name === "number").length, true);
    d.entries.forEach((e, i) => {
      const eo = o + 16 + i * 8;
      v.setUint32(
        eo,
        typeof e.name === "string" ? (0x80000000 | stringAt.get(e.name)!) >>> 0 : e.name,
        true,
      );
      v.setUint32(
        eo + 4,
        "entries" in e.child ? (0x80000000 | dirAt.get(e.child)!) >>> 0 : entryAt.get(e.child)!,
        true,
      );
    });
  }
  for (const d of datas) {
    const o = entryAt.get(d)!;
    v.setUint32(o, rva + blobAt.get(d)!, true);
    v.setUint32(o + 4, d.data.length, true);
    v.setUint32(o + 8, d.codepage, true);
    out.set(d.data, blobAt.get(d)!);
  }
  for (const s of strings) {
    const o = stringAt.get(s)!;
    v.setUint16(o, s.length, true);
    for (let i = 0; i < s.length; i++) v.setUint16(o + 2 + i * 2, s.charCodeAt(i), true);
  }
  return out;
}

/** One `VS_VERSIONINFO` block: header, key, value, children, each 32-bit aligned. */
function versionBlock(
  key: string,
  value: Uint8Array,
  valueLength: number,
  text: boolean,
  children: Uint8Array[],
): Uint8Array {
  const parts: number[] = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < key.length; i++) parts.push(key.charCodeAt(i) & 0xff, key.charCodeAt(i) >> 8);
  parts.push(0, 0);
  while (parts.length % 4) parts.push(0);
  parts.push(...value);
  for (const c of children) {
    while (parts.length % 4) parts.push(0);
    parts.push(...c);
  }
  const out = Uint8Array.from(parts);
  const v = view(out);
  v.setUint16(0, out.length, true);
  v.setUint16(2, valueLength, true);
  v.setUint16(4, text ? 1 : 0, true);
  return out;
}

function utf16z(s: string): Uint8Array {
  const out = new Uint8Array((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) view(out).setUint16(i * 2, s.charCodeAt(i), true);
  return out;
}

/**
 * A `VS_VERSIONINFO` resource: the fixed file info carrying `version` (file and product), and a
 * U.S. English / Unicode string table with `strings`.
 *
 * @param version The four version words.
 * @param strings The string table.
 * @returns The resource's bytes.
 */
export function versionInfoResource(
  version: readonly [number, number, number, number],
  strings: Readonly<Record<string, string>>,
): Uint8Array {
  const [a, b, c, d] = version.map((n) => Math.max(0, Math.min(0xffff, Math.trunc(n))));
  const fixed = new Uint8Array(52);
  const f = view(fixed);
  f.setUint32(0, 0xfeef04bd, true); // dwSignature
  f.setUint32(4, 0x00010000, true); // dwStrucVersion
  f.setUint32(8, ((a << 16) | b) >>> 0, true); // dwFileVersionMS
  f.setUint32(12, ((c << 16) | d) >>> 0, true); // dwFileVersionLS
  f.setUint32(16, ((a << 16) | b) >>> 0, true); // dwProductVersionMS
  f.setUint32(20, ((c << 16) | d) >>> 0, true); // dwProductVersionLS
  f.setUint32(24, 0x3f, true); // dwFileFlagsMask
  f.setUint32(32, 0x00040004, true); // dwFileOS: VOS_NT_WINDOWS32
  f.setUint32(36, 1, true); // dwFileType: VFT_APP
  const entries = Object.entries(strings).map(([k, s]) =>
    versionBlock(k, utf16z(s), s.length + 1, true, [])
  );
  const table = versionBlock("040904B0", new Uint8Array(), 0, true, entries);
  const stringFileInfo = versionBlock("StringFileInfo", new Uint8Array(), 0, true, [table]);
  const translation = new Uint8Array(4);
  view(translation).setUint16(0, 0x0409, true);
  view(translation).setUint16(2, 0x04b0, true);
  const varFileInfo = versionBlock("VarFileInfo", new Uint8Array(), 0, true, [
    versionBlock("Translation", translation, 4, false, []),
  ]);
  return versionBlock("VS_VERSION_INFO", fixed, 52, false, [stringFileInfo, varFileInfo]);
}

/** The images of an `.ico` file: each one's 16-byte directory entry and bytes. */
function icoImages(ico: Uint8Array): { entry: Uint8Array; data: Uint8Array }[] {
  const v = view(ico);
  if (ico.length < 6 || v.getUint16(0, true) !== 0 || v.getUint16(2, true) !== 1) {
    throw new Error("not an .ico file");
  }
  const count = v.getUint16(4, true);
  if (count === 0) throw new Error("the .ico file has no images");
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 16 > ico.length) throw new Error("truncated .ico directory");
    const size = v.getUint32(e + 8, true);
    const offset = v.getUint32(e + 12, true);
    if (offset + size > ico.length) throw new Error("truncated .ico image");
    out.push({ entry: ico.subarray(e, e + 16), data: ico.slice(offset, offset + size) });
  }
  return out;
}

/** The `RT_ICON` ids a group icon directory (`GRPICONDIR`) lists. */
function groupIconIds(group: Map<number, PeResourceData>): number[] {
  const out: number[] = [];
  for (const { data } of group.values()) {
    const v = view(data);
    const count = data.length < 6 ? 0 : v.getUint16(4, true);
    for (let i = 0; i < count && 6 + i * 14 + 14 <= data.length; i++) {
      out.push(v.getUint16(6 + i * 14 + 12, true));
    }
  }
  return out;
}

type ResourceNames = Map<PeResourceName, Map<number, PeResourceData>>;

/** Remove `group` from `groups`, and the icons no other group uses. */
function removeGroup(groups: ResourceNames, icons: ResourceNames, name: PeResourceName) {
  const group = groups.get(name)!;
  groups.delete(name);
  const kept = new Set([...groups.values()].flatMap(groupIconIds));
  for (const id of groupIconIds(group)) if (!kept.has(id)) icons.delete(id);
}

/** Replace the first icon group of `tree` (and the icons only it uses) with `ico`'s images. */
function replaceIcon(tree: PeResourceTree, ico: Uint8Array): void {
  const images = icoImages(ico);
  const groups: ResourceNames = tree.get(RT_GROUP_ICON) ?? new Map();
  const icons: ResourceNames = tree.get(RT_ICON) ?? new Map();
  const first = sortedNames(groups)[0];
  const name: PeResourceName = first?.[0] ?? 1;
  const lang = (first && [...first[1].keys()][0]) ?? LANG_EN_US;
  if (first) removeGroup(groups, icons, first[0]);
  const ids = [...icons.keys()].filter((k): k is number => typeof k === "number");
  let next = Math.max(0, ...ids) + 1;
  if (next + images.length - 1 > 0xffff) throw new Error("no icon id left");
  const group = new Uint8Array(6 + images.length * 14);
  const g = view(group);
  g.setUint16(2, 1, true);
  g.setUint16(4, images.length, true);
  images.forEach((img, i) => {
    const id = next++;
    // GRPICONDIRENTRY: the .ico entry's first 12 bytes, then the RT_ICON id.
    group.set(img.entry.subarray(0, 12), 6 + i * 14);
    g.setUint16(6 + i * 14 + 12, id, true);
    icons.set(id, new Map([[lang, { data: img.data, codepage: 0 }]]));
  });
  groups.set(name, new Map([[lang, { data: group, codepage: 0 }]]));
  tree.set(RT_ICON, icons);
  tree.set(RT_GROUP_ICON, groups);
}

/** The PE checksum (as `CheckSumMappedFile` computes it), the field itself counted as zero. */
function peChecksum(b: Uint8Array, checksumAt: number): number {
  let sum = 0;
  const v = view(b);
  const words = Math.floor(b.length / 2);
  for (let i = 0; i < words; i++) {
    const at = i * 2;
    const w = at === checksumAt || at === checksumAt + 2 ? 0 : v.getUint16(at, true);
    sum += w;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (b.length % 2) {
    sum += b[b.length - 1];
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + b.length) >>> 0;
}

/**
 * Give a Windows executable an icon and a version resource, keeping every other resource.
 *
 * The resources are rewritten into a section appended after the last one (see
 * {@linkcode writePeResources}).
 *
 * @param pe The executable's bytes.
 * @param stamp The icon (optional) and version to write.
 * @returns The new executable's bytes.
 */
export function stampPeResources(pe: Uint8Array, stamp: PeStamp): Uint8Array {
  const tree = readPeResources(pe);
  if (stamp.icon) replaceIcon(tree, stamp.icon);
  const versionLang = [...(tree.get(RT_VERSION)?.values() ?? [])][0]?.keys().next().value ??
    LANG_EN_US;
  const version = new Map<number, PeResourceData>([[versionLang, {
    data: versionInfoResource(stamp.version, stamp.strings),
    codepage: 0,
  }]]);
  tree.set(RT_VERSION, new Map<PeResourceName, Map<number, PeResourceData>>([[1, version]]));
  return writePeResources(pe, tree);
}

/**
 * A PE image with `tree` as its resources: written to a new section appended after the last one,
 * with the resource data directory pointed at it. The image's code and data don't move; the old
 * resource section keeps its bytes (renamed `.rsrc0`), unreferenced. An Authenticode signature is
 * removed (it no longer matches). Refuses an image with data past its last section other than a
 * signature, or no room in its headers for one more section.
 *
 * @param pe The image's bytes.
 * @param tree The resources it should have.
 * @returns The new image's bytes.
 */
export function writePeResources(pe: Uint8Array, tree: PeResourceTree): Uint8Array {
  const h = readHeaders(pe);
  if (h.dirCount <= DIR_RESOURCE) fail("no resource data directory");

  // Where the image's sections end, and what follows them: nothing, or the certificate table.
  const v0 = view(pe);
  let end = h.sizeOfHeaders;
  let vend = 0;
  for (const s of h.sections) {
    end = Math.max(end, s.pointerToRawData + s.sizeOfRawData);
    vend = Math.max(vend, s.virtualAddress + Math.max(s.virtualSize, s.sizeOfRawData));
  }
  const certAt = h.dirCount > DIR_SECURITY ? v0.getUint32(h.dirs + DIR_SECURITY * 8, true) : 0;
  const certSize = h.dirCount > DIR_SECURITY
    ? v0.getUint32(h.dirs + DIR_SECURITY * 8 + 4, true)
    : 0;
  const overlayEnd = certSize > 0 ? certAt : pe.length;
  if (certSize > 0 && certAt + certSize !== pe.length) {
    fail("its signature is not at the end of the file");
  }
  if (overlayEnd > align(end, h.fileAlignment)) fail("it has data past its last section");
  const headerEnd = h.sectionTable + (h.sections.length + 1) * 40;
  const firstRaw = Math.min(
    ...h.sections.filter((s) => s.sizeOfRawData > 0).map((s) => s.pointerToRawData),
    h.sizeOfHeaders,
  );
  if (headerEnd > firstRaw) fail("no room in its headers for another section");

  const rva = align(vend, h.sectionAlignment);
  const rsrc = buildResourceSection(tree, rva);
  const raw = align(end, h.fileAlignment);
  const rawSize = align(rsrc.length, h.fileAlignment);
  const out = new Uint8Array(raw + rawSize);
  out.set(pe.subarray(0, Math.min(raw, overlayEnd)));
  out.set(rsrc, raw);
  const v = view(out);

  // The new section header (".rsrc"; the old section keeps its bytes under ".rsrc0").
  for (let i = 0; i < h.sections.length; i++) {
    if (h.sections[i].name === ".rsrc") out[h.sectionTable + i * 40 + 5] = 0x30; // ".rsrc0"
  }
  const s = h.sectionTable + h.sections.length * 40;
  out.fill(0, s, s + 40);
  out.set(new TextEncoder().encode(".rsrc"), s);
  v.setUint32(s + 8, rsrc.length, true);
  v.setUint32(s + 12, rva, true);
  v.setUint32(s + 16, rawSize, true);
  v.setUint32(s + 20, raw, true);
  v.setUint32(s + 36, 0x40000040, true); // INITIALIZED_DATA | MEM_READ
  const coff = h.opt - 20;
  v.setUint16(coff + 2, h.sections.length + 1, true);
  v.setUint32(h.opt + 8, v.getUint32(h.opt + 8, true) + rawSize, true); // SizeOfInitializedData
  v.setUint32(h.opt + 56, align(rva + rsrc.length, h.sectionAlignment), true); // SizeOfImage
  v.setUint32(h.dirs + DIR_RESOURCE * 8, rva, true);
  v.setUint32(h.dirs + DIR_RESOURCE * 8 + 4, rsrc.length, true);
  if (h.dirCount > DIR_SECURITY) {
    v.setUint32(h.dirs + DIR_SECURITY * 8, 0, true);
    v.setUint32(h.dirs + DIR_SECURITY * 8 + 4, 0, true);
  }
  v.setUint32(h.opt + 64, peChecksum(out, h.opt + 64), true);
  return out;
}

/**
 * The `VS_FIXEDFILEINFO` words for a deno.json version: its numeric `major.minor.build`, padded
 * to four (`1.0.0.0` when there is none), each clamped to 65535.
 *
 * @param version The version (`2.5.1-rc.1` → `[2, 5, 1, 0]`).
 * @returns The four words.
 */
export function peVersionWords(version: string | undefined): [number, number, number, number] {
  const core = (version ?? "").split(/[-+]/, 1)[0].split(".").slice(0, 3);
  const nums = core.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.length === 0 || nums.some((n) => Number.isNaN(n))) return [1, 0, 0, 0];
  const w = [...nums, 0, 0, 0].slice(0, 4).map((n) => Math.min(n, 0xffff));
  return [w[0], w[1], w[2], w[3]];
}
