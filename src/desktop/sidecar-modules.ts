/**
 * The packages a bundled Node backend sidecar loads with `require()` at run time (native addons,
 * `external` ones), carried as ONE archive file beside its bundle (`modules.pack`) and unpacked
 * into the app's cache folder before the sidecar starts.
 *
 * Why not a `node_modules` folder embedded as it is: `deno desktop` (a compile) analyses every
 * embedded CommonJS file's re-exports (`__exportStar(require("dep"), exports)`), and under
 * `--node-modules-dir=none` — what the package scripts use for any project with a `package.json`
 * or `node_modules` — a bare re-export from a file that is not one of Deno's own npm packages fails
 * the build ("Could not find referrer npm package"), whatever the folder is called. An archive is
 * data, not code, so the compile embeds it untouched; unpacked on a real disk, Node's own
 * resolution and native addons work as in `node`.
 *
 * Format: `DNXSCPK1\n`, a 4-byte big-endian header length, a JSON header
 * `{ files: [{ p, s, m }] }` (path, size, executable), then each file's bytes in order. The
 * bundle's `modules.json` carries the archive's SHA-256, so a launch that finds that version
 * unpacked already reads nothing more.
 *
 * Runtime-safe (Deno APIs only when called).
 *
 * @module
 */

import { dirname, join } from "@std/path";

/** The archive's file name beside the bundle's `main.mjs`. */
export const SIDECAR_MODULES_PACK = "modules.pack";
/** Its small descriptor: `{ hash, files, bytes }`. */
export const SIDECAR_MODULES_INFO = "modules.json";

const MAGIC = new TextEncoder().encode("DNXSCPK1\n");

/** One archived file. */
interface PackEntry {
  /** Its path, `/`-separated, relative to the unpack root. */
  readonly p: string;
  /** Its size in bytes. */
  readonly s: number;
  /** Whether it is executable. */
  readonly m?: 1;
}

/** What {@linkcode packSidecarModules} wrote. */
export interface SidecarModulesInfo {
  /** The archive's SHA-256 (hex). */
  readonly hash: string;
  /** How many files it holds. */
  readonly files: number;
  /** Their total size. */
  readonly bytes: number;
}

/** Every file under `dir`, as paths relative to it (`/`-separated), sorted. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(join(dir, prefix))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) out.push(...await listFiles(dir, rel));
    else if (e.isFile) out.push(rel);
  }
  return out.sort();
}

/** Hex SHA-256 of `bytes`. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Pack every file under `dir` into `<outDir>/modules.pack` and describe it in `modules.json`.
 *
 * @param dir The folder to pack (its contents become the unpack root's).
 * @param outDir Where the archive and descriptor go.
 * @returns The descriptor.
 */
export async function packSidecarModules(dir: string, outDir: string): Promise<SidecarModulesInfo> {
  const files = await listFiles(dir);
  const entries: PackEntry[] = [];
  const chunks: Uint8Array[] = [];
  for (const p of files) {
    const path = join(dir, ...p.split("/"));
    const data = await Deno.readFile(path);
    const mode = Deno.build.os === "windows" ? 0 : (await Deno.stat(path)).mode ?? 0;
    entries.push({ p, s: data.length, ...(mode & 0o111 ? { m: 1 as const } : {}) });
    chunks.push(data);
  }
  const header = new TextEncoder().encode(JSON.stringify({ files: entries }));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.length);
  const parts = [MAGIC, length, header, ...chunks];
  const total = parts.reduce((n, c) => n + c.length, 0);
  const pack = new Uint8Array(total);
  let at = 0;
  for (const c of parts) {
    pack.set(c, at);
    at += c.length;
  }
  await Deno.writeFile(join(outDir, SIDECAR_MODULES_PACK), pack);
  const info: SidecarModulesInfo = {
    hash: await sha256Hex(pack),
    files: entries.length,
    bytes: chunks.reduce((n, c) => n + c.length, 0),
  };
  await Deno.writeTextFile(join(outDir, SIDECAR_MODULES_INFO), JSON.stringify(info) + "\n");
  return info;
}

/** Whether `rel` stays inside the unpack root (no absolute path, no `..`). */
function safeRelative(rel: string): boolean {
  return rel !== "" && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel) &&
    rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Unpack the archive `pack` into `root` (an empty folder). Throws on a malformed archive. */
async function unpack(pack: Uint8Array, root: string): Promise<void> {
  if (!MAGIC.every((b, i) => pack[i] === b)) throw new Error("not a sidecar modules archive");
  const length = new DataView(pack.buffer, pack.byteOffset + MAGIC.length, 4).getUint32(0);
  const start = MAGIC.length + 4;
  const { files } = JSON.parse(new TextDecoder().decode(pack.subarray(start, start + length))) as {
    files: PackEntry[];
  };
  let at = start + length;
  for (const f of files) {
    if (!safeRelative(f.p) || at + f.s > pack.length) {
      throw new Error(`malformed sidecar modules archive (${f.p})`);
    }
    const path = join(root, ...f.p.split("/"));
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeFile(path, pack.subarray(at, at + f.s), f.m ? { mode: 0o755 } : {});
    at += f.s;
  }
}

/**
 * The folder a bundled sidecar's `require()`s resolve from: its archived packages unpacked under
 * `<cacheDir>/sidecars/<name>/modules-<hash>/` (once per version: a finished unpack leaves a
 * marker, and older versions of this sidecar are removed), or `undefined` when the bundle has no
 * archive (nothing to require beyond the bundle).
 *
 * @param bundleDir The bundle folder (`.deno-desktop/sidecars/<name>`, in the app's embedded file
 *   system or on disk).
 * @param name The sidecar's name.
 * @param cacheDir The app's cache folder.
 * @returns The unpack root.
 */
export async function prepareSidecarModules(
  bundleDir: string,
  name: string,
  cacheDir: string,
): Promise<string | undefined> {
  const infoText = await Deno.readTextFile(join(bundleDir, SIDECAR_MODULES_INFO)).catch(() => null);
  if (infoText === null) return undefined;
  const { hash } = JSON.parse(infoText) as SidecarModulesInfo;
  const parent = join(cacheDir, "sidecars", name);
  const root = join(parent, `modules-${hash.slice(0, 16)}`);
  const marker = join(root, ".complete");
  if ((await Deno.readTextFile(marker).catch(() => "")) === hash) return root;
  await Deno.remove(root, { recursive: true }).catch(() => {});
  const temp = `${root}.${crypto.randomUUID()}.tmp`;
  await Deno.mkdir(temp, { recursive: true });
  try {
    await unpack(await Deno.readFile(join(bundleDir, SIDECAR_MODULES_PACK)), temp);
    await Deno.writeTextFile(join(temp, ".complete"), hash);
    await Deno.rename(temp, root);
  } catch (err) {
    await Deno.remove(temp, { recursive: true }).catch(() => {});
    // Another launch of the app unpacked the same version first.
    if ((await Deno.readTextFile(marker).catch(() => "")) !== hash) throw err;
  }
  for await (const e of Deno.readDir(parent)) {
    if (e.name !== `modules-${hash.slice(0, 16)}` && e.name.startsWith("modules-")) {
      await Deno.remove(join(parent, e.name), { recursive: true }).catch(() => {});
    }
  }
  return root;
}
