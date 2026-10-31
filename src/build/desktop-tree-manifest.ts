// The tree manifest of a Windows app: every file of the bundle that is not a PE image, with its
// size and SHA-256, written into the main executable as the `RT_RCDATA` resource `DENEXT_TREE`
// BEFORE the executable is Authenticode-signed (so the signature covers it).
//
// Why: on Windows the runtime's full-app updater checks the Authenticode signature of every PE
// image of a staged update (the `.exe`, every `.dll`, any `.node`), but the other files of the app
// (`laufey-launch.json` with the window's bridge origins and inspectable policy, CEF's `.pak` /
// `icudtl.dat` / `v8_context_snapshot.bin`, sidecar JavaScript, `.deno-desktop-app`) carry no
// signature of their own: the update key alone protected them. With the manifest in the signed
// executable, the runtime refuses a staged app whose loose files are not exactly the listed ones
// (a changed, missing or extra file, or any symlink), and a running app that has a manifest
// refuses an update that has none. The runtime side: `runtime/ops/desktop_update/treecheck.rs` in
// denext's Deno fork.

import { basename, join } from "@std/path";
import { type PeResourceTree, readPeResources, writePeResources } from "./pe-resources.ts";

/** The `RT_RCDATA` resource name the manifest is stored under. */
export const DESKTOP_TREE_RESOURCE = "DENEXT_TREE";

/** `RT_RCDATA`. */
const RT_RCDATA = 10;
/** U.S. English. */
const LANG_EN_US = 1033;

/** One listed file: its path relative to the bundle directory (`/`-separated), size and SHA-256. */
export interface DesktopTreeFile {
  /** Relative to the bundle directory, `/`-separated. */
  readonly path: string;
  /** Its size in bytes. */
  readonly size: number;
  /** Lowercase hex. */
  readonly sha256: string;
}

/** The manifest's JSON shape (version 1). */
export interface DesktopTreeManifest {
  /** The format version. */
  readonly v: 1;
  /** Every listed file. */
  readonly files: readonly DesktopTreeFile[];
}

/** Whether an open file has a PE image's headers: `MZ` at 0, `PE\0\0` at its `e_lfanew`. */
async function isPe(file: Deno.FsFile): Promise<boolean> {
  const dos = await readExact(file, 64);
  if (!dos || dos[0] !== 0x4d || dos[1] !== 0x5a) return false;
  await file.seek(new DataView(dos.buffer).getUint32(0x3c, true), Deno.SeekMode.Start);
  const sig = await readExact(file, 4);
  return sig !== null && sig.every((b, i) => b === PE_SIGNATURE[i]);
}

/** `PE\0\0`. */
const PE_SIGNATURE = [0x50, 0x45, 0, 0];

/** The next `n` bytes of `file`, or `null` when it ends first. */
async function readExact(file: Deno.FsFile, n: number): Promise<Uint8Array | null> {
  const buf = new Uint8Array(n);
  for (let got = 0; got < n;) {
    const r = await file.read(buf.subarray(got));
    if (r === null) return null;
    got += r;
  }
  return buf;
}

/** The SHA-256 (lowercase hex) of a file's bytes. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The manifest of a Windows bundle directory: every regular file that is not a PE image (by the
 * same header test as the runtime: `MZ` at 0, `PE\0\0` at `e_lfanew`), sorted by path.
 *
 * @param dir The bundle directory.
 * @returns The manifest.
 * @throws When the bundle holds a symlink (the runtime refuses an update with one).
 */
export async function desktopTreeManifest(dir: string): Promise<DesktopTreeManifest> {
  const files: DesktopTreeFile[] = [];
  const walk = async (d: string, rel: string) => {
    for await (const e of Deno.readDir(d)) {
      const path = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymlink) {
        throw new Error(
          `${path} is a symlink: a Windows app's update may hold none (copy the file instead)`,
        );
      }
      if (e.isDirectory) {
        await walk(path, r);
        continue;
      }
      if (!e.isFile) continue;
      const f = await Deno.open(path, { read: true });
      let pe: boolean;
      try {
        pe = await isPe(f);
      } finally {
        f.close();
      }
      if (pe) continue;
      const bytes = await Deno.readFile(path);
      files.push({ path: r, size: bytes.length, sha256: await sha256Hex(bytes) });
    }
  };
  await walk(dir, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { v: 1, files };
}

/**
 * `pe` with `manifest` as its `RT_RCDATA` `DENEXT_TREE` resource (replacing one it has), every
 * other resource kept. Any Authenticode signature is dropped: sign after this.
 *
 * @param pe The executable's bytes.
 * @param manifest The manifest to embed.
 * @returns The new executable's bytes.
 */
export function embedDesktopTreeManifest(
  pe: Uint8Array,
  manifest: DesktopTreeManifest,
): Uint8Array {
  const tree: PeResourceTree = readPeResources(pe);
  const rcdata = tree.get(RT_RCDATA) ?? new Map();
  for (const name of [...rcdata.keys()]) {
    if (typeof name === "string" && name.toUpperCase() === DESKTOP_TREE_RESOURCE) {
      rcdata.delete(name);
    }
  }
  const data = new TextEncoder().encode(JSON.stringify(manifest));
  rcdata.set(DESKTOP_TREE_RESOURCE, new Map([[LANG_EN_US, { data, codepage: 0 }]]));
  tree.set(RT_RCDATA, rcdata);
  return writePeResources(pe, tree);
}

/**
 * The `DENEXT_TREE` manifest an executable carries, or `null` when it has none.
 *
 * @param pe The executable's bytes.
 * @returns The manifest.
 * @throws When the resource is in more than one language or is not a version-1 manifest.
 */
export function readDesktopTreeManifest(pe: Uint8Array): DesktopTreeManifest | null {
  const rcdata = readPeResources(pe).get(RT_RCDATA);
  const found = [...(rcdata?.entries() ?? [])].filter(([name]) =>
    typeof name === "string" && name.toUpperCase() === DESKTOP_TREE_RESOURCE
  );
  if (found.length === 0) return null;
  const langs = [...found[0][1].values()];
  if (found.length > 1 || langs.length !== 1) {
    throw new Error(`the ${DESKTOP_TREE_RESOURCE} resource is ambiguous`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(langs[0].data));
  if (parsed?.v !== 1 || !Array.isArray(parsed.files)) {
    throw new Error(`the ${DESKTOP_TREE_RESOURCE} resource is not a version-1 tree manifest`);
  }
  return parsed as DesktopTreeManifest;
}

/**
 * Write the tree manifest of a finished Windows bundle into its executable. Run it once nothing
 * else will be written into the bundle (after the VC++ runtime and `laufey-launch.json`) and
 * before signing: the executable's Authenticode signature then covers every file of the app.
 *
 * @param dir The bundle directory.
 * @param exe The executable's name inside it (`<App>.exe`).
 * @returns The manifest written.
 */
export async function stampDesktopTreeManifest(
  dir: string,
  exe: string,
): Promise<DesktopTreeManifest> {
  const manifest = await desktopTreeManifest(dir);
  const path = join(dir, exe);
  await Deno.writeFile(path, embedDesktopTreeManifest(await Deno.readFile(path), manifest));
  return manifest;
}

/** Why a bundle's files don't match its executable's tree manifest. */
export interface DesktopTreeManifestProblem {
  /** What differs. */
  readonly problem: string;
  /** `true` when the executable carries no manifest at all (packaged before the manifest). */
  readonly unlisted: boolean;
}

/**
 * Why a Windows bundle's files no longer match its executable's tree manifest (the runtime would
 * refuse it as an update), or `undefined` when they match. A bundle whose executable carries no
 * manifest is reported with `unlisted: true`: its loose files would be protected by the update
 * key alone, and an installed app that has a manifest refuses it.
 *
 * @param dir The bundle directory.
 * @param exe The executable's name inside it.
 * @returns The problem, if any.
 */
export async function desktopTreeManifestProblem(
  dir: string,
  exe: string,
): Promise<DesktopTreeManifestProblem | undefined> {
  const fail = (problem: string) => ({ problem, unlisted: false });
  let signed: DesktopTreeManifest | null;
  try {
    signed = readDesktopTreeManifest(await Deno.readFile(join(dir, exe)));
  } catch (e) {
    return fail(`${exe}: ${(e as Error).message}`);
  }
  if (!signed) {
    return {
      problem:
        `${exe} carries no ${DESKTOP_TREE_RESOURCE} tree manifest, so the update key alone ` +
        `protects its files that are not PE images, and an installed app that has one refuses ` +
        `it (package it again with this denext: scripts/package-windows.ts writes one)`,
      unlisted: true,
    };
  }
  let now: DesktopTreeManifest;
  try {
    now = await desktopTreeManifest(dir);
  } catch (e) {
    return fail((e as Error).message);
  }
  const want = new Map(signed.files.map((f) => [f.path, f]));
  for (const f of now.files) {
    const w = want.get(f.path);
    if (!w) return fail(`${f.path} is not in ${exe}'s signed tree manifest`);
    if (w.size !== f.size || w.sha256 !== f.sha256) {
      return fail(`${f.path} changed after ${exe}'s tree manifest was written`);
    }
    want.delete(f.path);
  }
  const missing = want.keys().next();
  return missing.done
    ? undefined
    : fail(`${missing.value} is listed in ${exe}'s tree manifest but missing`);
}

/**
 * A Windows app directory's tree manifest check before it is published: files that changed after
 * the manifest was signed (the runtime would refuse the update) fail the publish; an executable
 * without a manifest is a warning. Other platforms, and an artifact without `<dir>.exe`, pass.
 *
 * @param artifact The packaged app.
 * @param platform Its platform key.
 * @returns The warning, if any.
 */
export async function windowsTreeManifestWarning(
  artifact: string,
  platform: string,
): Promise<string | undefined> {
  if (!platform.includes("windows")) return undefined;
  const exe = `${basename(artifact)}.exe`;
  const isFile = await Deno.stat(join(artifact, exe)).then((s) => s.isFile, () => false);
  if (!isFile) return undefined;
  const found = await desktopTreeManifestProblem(artifact, exe);
  if (found && !found.unlisted) {
    throw new Error(
      `${found.problem}: installed apps would refuse this update (os_signature); package and ` +
        `sign it again instead of changing the bundle afterwards`,
    );
  }
  return found?.problem;
}
