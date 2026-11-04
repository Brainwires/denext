// The tree manifest of a Windows app: the app's identifier and version, and every file of the
// bundle but the executable itself (PE images included, as signed), with its size and SHA-256,
// written into the main executable as the `RT_RCDATA` resource `DENEXT_TREE` BEFORE the executable
// is Authenticode-signed (so the signature covers it).
//
// Why: on Windows the runtime's full-app updater checks the Authenticode signature of every PE
// image of a staged update (the `.exe`, every `.dll`, any `.node`), but the other files of the app
// (`laufey-launch.json` with the window's bridge origins and inspectable policy, CEF's `.pak` /
// `icudtl.dat` / `v8_context_snapshot.bin`, sidecar JavaScript, `.deno-desktop-app`) carry no
// signature of their own: the update key alone protected them. And a signature says who signed a
// PE image, not which release or product it belongs to: with only the loose files listed, whoever
// held the update key could still combine the publisher's signed files (one release's runtime DLL
// under another release's executable and loose files, or another product's). With the manifest
// in the signed executable, the runtime requires it to name the installed app and the version
// offered, and refuses a staged app whose files are not exactly the listed ones (a changed,
// missing or extra file, a DLL from another build, or any symlink); a running app that has a
// manifest refuses an update that has none. The DLLs are listed as shipped, so they are signed
// before the manifest is written and the executable signed after it (`desktopSignWindows` keeps
// that order whatever its caller's). The runtime side: `runtime/ops/desktop_update/treecheck.rs`
// in denext's Deno fork.

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

/** The app a manifest is written for: the runtime refuses a manifest for another app or version. */
export interface DesktopTreeIdentity {
  /** `desktop.app.identifier` (the installed app's, as compiled into it). */
  readonly appId: string;
  /** The app's version (deno.json `version`: the version the update offers). */
  readonly version: string;
}

/** The manifest's JSON shape (version 1). */
export interface DesktopTreeManifest extends DesktopTreeIdentity {
  /** The format version. */
  readonly v: 1;
  /** Every listed file. */
  readonly files: readonly DesktopTreeFile[];
}

/** The SHA-256 (lowercase hex) of a file's bytes. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The manifest of a Windows bundle directory for `identity`: every regular file but the executable
 * `exe` (the manifest's carrier, which cannot hold its own hash: its signature is its check), PE
 * images included, sorted by path.
 *
 * @param dir The bundle directory.
 * @param exe The executable's name inside it (`<App>.exe`).
 * @param identity The app and version the manifest is for.
 * @returns The manifest.
 * @throws When the bundle holds a symlink (the runtime refuses an update with one), or `identity`
 *   has no app identifier or version.
 */
export async function desktopTreeManifest(
  dir: string,
  exe: string,
  identity: DesktopTreeIdentity,
): Promise<DesktopTreeManifest> {
  checkIdentity(identity);
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
      if (!e.isFile || r === exe) continue;
      const bytes = await Deno.readFile(path);
      files.push({ path: r, size: bytes.length, sha256: await sha256Hex(bytes) });
    }
  };
  await walk(dir, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { v: 1, appId: identity.appId, version: identity.version, files };
}

/** `identity` names an app and a version (what the runtime parses: no blank or odd identifier). */
function checkIdentity(identity: DesktopTreeIdentity): void {
  if (!/^\S+$/.test(identity.appId)) {
    throw new Error(
      `a tree manifest needs the app's identifier (desktop.app.identifier), got ${
        JSON.stringify(identity.appId)
      }`,
    );
  }
  if (!/^\d+\.\d+\.\d+/.test(identity.version)) {
    throw new Error(
      `a tree manifest needs a semver version, got ${JSON.stringify(identity.version)}`,
    );
  }
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
  if (
    parsed?.v !== 1 || typeof parsed.appId !== "string" || typeof parsed.version !== "string" ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error(`the ${DESKTOP_TREE_RESOURCE} resource is not a version-1 tree manifest`);
  }
  return parsed as DesktopTreeManifest;
}

/**
 * Write the tree manifest of a finished Windows bundle into its executable. Run it once nothing
 * else will be written into the bundle (after the VC++ runtime and `laufey-launch.json`) and once
 * every other PE image is signed as it ships (the manifest lists their bytes), and before the
 * executable is signed: its Authenticode signature then covers every file of the app.
 * `desktopSignWindows` runs it again between signing the DLLs and the executable, so a bundle
 * stamped before signing (as `buildDesktopBundle` does) ends up right whatever the order.
 *
 * @param dir The bundle directory.
 * @param exe The executable's name inside it (`<App>.exe`).
 * @param identity The app and version the manifest is for.
 * @returns The manifest written.
 */
export async function stampDesktopTreeManifest(
  dir: string,
  exe: string,
  identity: DesktopTreeIdentity,
): Promise<DesktopTreeManifest> {
  const manifest = await desktopTreeManifest(dir, exe, identity);
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
 * refuse it as an update), or why the manifest is not for `identity` when one is given, or
 * `undefined` when all is well. A bundle whose executable carries no manifest is reported with
 * `unlisted: true`: its other files would be protected by the update key alone, and an installed
 * app that has a manifest refuses it.
 *
 * @param dir The bundle directory.
 * @param exe The executable's name inside it.
 * @param identity The app and version the manifest must be for (when known).
 * @returns The problem, if any.
 */
export async function desktopTreeManifestProblem(
  dir: string,
  exe: string,
  identity?: DesktopTreeIdentity,
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
        `protects its other files, and an installed app that has one refuses it (package it ` +
        `again with this denext: scripts/package-windows.ts writes one)`,
      unlisted: true,
    };
  }
  if (identity && (signed.appId !== identity.appId || signed.version !== identity.version)) {
    return fail(
      `${exe}'s tree manifest is for ${signed.appId} ${signed.version}, not ${identity.appId} ${identity.version}`,
    );
  }
  let now: DesktopTreeManifest;
  try {
    now = await desktopTreeManifest(dir, exe, { appId: signed.appId, version: signed.version });
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
 * the manifest was signed, or a manifest for another app or version (the runtime would refuse the
 * update), fail the publish; an executable without a manifest is a warning. Other platforms, and
 * an artifact without `<dir>.exe`, pass.
 *
 * @param artifact The packaged app.
 * @param platform Its platform key.
 * @param identity The app and version being published (when known).
 * @returns The warning, if any.
 */
export async function windowsTreeManifestWarning(
  artifact: string,
  platform: string,
  identity?: DesktopTreeIdentity,
): Promise<string | undefined> {
  if (!platform.includes("windows")) return undefined;
  const exe = `${basename(artifact)}.exe`;
  const isFile = await Deno.stat(join(artifact, exe)).then((s) => s.isFile, () => false);
  if (!isFile) return undefined;
  const found = await desktopTreeManifestProblem(artifact, exe, identity);
  if (found && !found.unlisted) {
    throw new Error(
      `${found.problem}: installed apps would refuse this update (os_signature); package and ` +
        `sign it again instead of changing the bundle afterwards`,
    );
  }
  return found?.problem;
}
