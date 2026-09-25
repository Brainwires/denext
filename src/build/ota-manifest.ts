// The build side of over-the-air UI updates: walk a static export, hash every file and
// write `_denext/ota.json` into it. `denext export` runs it as its last step when
// `spa.ota` is on, and `denext ota manifest <dir>` runs it on demand (for an app that
// post-processes its export, e.g. swapping brand icons in, and must re-stamp afterwards).
// The version algorithm lives in src/mobile/ota-manifest.ts, shared with the client; signing
// (a key given, or DENEXT_OTA_SIGNING_KEY) lives in ./ota-signing.ts.

import { dirname, join } from "@std/path";
import {
  isExcludedFromOtaManifest,
  isOtaManifestPath,
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
 * @param meta Optional `required` / `notes` / `sequence` / `minNative` / `nativeFingerprint` to
 *   carry (never part of the version).
 * @returns The manifest, files sorted by path.
 * @throws RangeError when a file's path holds a control character (U+0000–U+001F, U+007F): such
 *   a path could forge the lines the version hashes, so no side of OTA accepts it.
 */
export async function collectOtaManifest(
  dir: string,
  meta: OtaManifestMeta = {},
): Promise<OtaManifest> {
  const paths = (await listFiles(dir, "")).filter((p) => !isExcludedFromOtaManifest(p));
  const bad = paths.find((p) => !isOtaManifestPath(p));
  if (bad !== undefined) {
    throw new RangeError(
      `${JSON.stringify(bad)} holds a control character, so it cannot be listed in an OTA manifest`,
    );
  }
  const files: OtaManifestFile[] = [];
  for (const path of paths) {
    const bytes = await Deno.readFile(join(dir, ...path.split("/")));
    files.push({ path, sha256: await sha256Hex(bytes), size: bytes.byteLength });
  }
  return await makeOtaManifest(files, meta);
}

/** The default signed `sequence`: the current Unix time in whole seconds. */
export function defaultOtaSequence(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}

/**
 * (Re)write `<dir>/_denext/ota.json` for the web root `dir`.
 *
 * The manifest is written last and atomically (a temporary file in `_denext/`, then a rename),
 * so a server re-reading it never sees half a file. Swapping a whole export under a running
 * server is still not atomic: export into a new directory and switch to it (a symlink, or the
 * server's configured directory) once its manifest is written.
 *
 * @param dir The web root (e.g. `out/`); it must contain an `index.html`.
 * @param meta Optional `required` / `notes` / `sequence` / `minNative` / `nativeFingerprint`; a
 *   key left out is left out of the manifest, except that a signed manifest without a `sequence`
 *   gets {@linkcode defaultOtaSequence} (so it is signed with the v2 payload, or v3 with a
 *   `nativeFingerprint`).
 * @param signingKey An ECDSA P-256 private key (`loadOtaSigningKey`): the manifest then carries
 *   a `signature` over its version and metadata.
 * @returns The manifest written.
 * @throws When `dir` has no `index.html` (the native side refuses such a UI), when
 *   `meta.notes` is too long, or when a path or number is not allowed in a manifest.
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
  const stamped = signingKey && meta.sequence === undefined
    ? { ...meta, sequence: defaultOtaSequence() }
    : meta;
  const collected = await collectOtaManifest(dir, stamped);
  const manifest = signingKey ? await signOtaManifest(collected, signingKey) : collected;
  const target = join(dir, ...OTA_MANIFEST_PATH.split("/"));
  await Deno.mkdir(dirname(target), { recursive: true });
  const temp = await Deno.makeTempFile({ dir: dirname(target), prefix: ".ota-", suffix: ".tmp" });
  try {
    await Deno.writeTextFile(temp, JSON.stringify(manifest) + "\n");
    // makeTempFile creates 0600; the manifest is as public as the files it lists.
    if (Deno.build.os !== "windows") await Deno.chmod(temp, 0o644);
    await Deno.rename(temp, target);
  } catch (err) {
    await Deno.remove(temp).catch(() => {});
    throw err;
  }
  return manifest;
}
