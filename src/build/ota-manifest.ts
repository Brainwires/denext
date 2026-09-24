// The build side of over-the-air UI updates: walk a static export, hash every file and
// write `_denext/ota.json` into it. `denext export` runs it as its last step when
// `spa.ota` is on, and `denext ota manifest <dir>` runs it on demand (for an app that
// post-processes its export, e.g. swapping brand icons in, and must re-stamp afterwards).
// The version algorithm lives in src/mobile/ota-manifest.ts, shared with the client; signing
// (a key given, or DENEXT_OTA_SIGNING_KEY) lives in ./ota-signing.ts.

import { dirname, join } from "@std/path";
import {
  isExcludedFromOtaManifest,
  makeOtaManifest,
  OTA_MANIFEST_PATH,
  type OtaManifest,
  type OtaManifestFile,
  type OtaManifestMeta,
  sha256Hex,
} from "../mobile/ota-manifest.ts";
import { signOtaManifest } from "./ota-signing.ts";

/** Every regular file under `dir`, as forward-slash paths prefixed with `prefix`. */
async function listFiles(dir: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory) out.push(...await listFiles(join(dir, entry.name), rel));
    // Only regular files: a symlink is skipped, so the manifest never lists a path that
    // resolves outside the web root.
    else if (entry.isFile) out.push(rel);
  }
  return out;
}

/**
 * Hash every file of the web root `dir` (minus `*.gz` and the manifest itself) into an
 * {@linkcode OtaManifest}.
 *
 * @param dir The web root (e.g. `out/`).
 * @param meta Optional `required` / `notes` to carry (never part of the version).
 * @returns The manifest, files sorted by path.
 */
export async function collectOtaManifest(
  dir: string,
  meta: OtaManifestMeta = {},
): Promise<OtaManifest> {
  const paths = (await listFiles(dir, "")).filter((p) => !isExcludedFromOtaManifest(p));
  const files: OtaManifestFile[] = [];
  for (const path of paths) {
    const bytes = await Deno.readFile(join(dir, ...path.split("/")));
    files.push({ path, sha256: await sha256Hex(bytes), size: bytes.byteLength });
  }
  return await makeOtaManifest(files, meta);
}

/**
 * (Re)write `<dir>/_denext/ota.json` for the web root `dir`.
 *
 * @param dir The web root (e.g. `out/`); it must contain an `index.html`.
 * @param meta Optional `required` / `notes`; a key left out is left out of the manifest.
 * @param signingKey An ECDSA P-256 private key (`loadOtaSigningKey`): the manifest then carries
 *   a `signature` over its version, `required` and `notes`.
 * @returns The manifest written.
 * @throws When `dir` has no `index.html` (the native side refuses such a UI), or when
 *   `meta.notes` is too long.
 */
export async function writeOtaManifest(
  dir: string,
  meta: OtaManifestMeta = {},
  signingKey?: CryptoKey,
): Promise<OtaManifest> {
  try {
    if (!(await Deno.stat(join(dir, "index.html"))).isFile) throw new Error("not a file");
  } catch {
    throw new Error(`${dir} has no index.html, so it is not a web root an app can boot`);
  }
  const collected = await collectOtaManifest(dir, meta);
  const manifest = signingKey ? await signOtaManifest(collected, signingKey) : collected;
  const target = join(dir, ...OTA_MANIFEST_PATH.split("/"));
  await Deno.mkdir(dirname(target), { recursive: true });
  await Deno.writeTextFile(target, JSON.stringify(manifest) + "\n");
  return manifest;
}
