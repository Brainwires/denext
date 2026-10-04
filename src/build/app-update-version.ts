// The version a packaged Deno Desktop app was BUILT as, read back from the artifact, so `denext
// desktop publish-update` refuses to sign a manifest whose `version` the app does not carry. The
// pinned runtime refuses such an update on every installed app at `stage()` (`version_mismatch`),
// after the download; checking here turns that into a publish-time error. The rules are the
// runtime's (`runtime/ops/desktop_update/embedded.rs`):
//
// - Every artifact but an AppImage: `deno desktop` compiles deno.json `version` into the app's
//   runtime library (`<App>.dll` next to `<App>.exe`, `<App>.so` next to a Linux `<App>`,
//   `<exe>.dylib` or `libruntime.dylib` in a macOS bundle) as the `app_version` of its standalone
//   metadata: the magic `d3n0l4nd`, a little-endian u64 length, then the metadata JSON. It must
//   equal the offered version (semver precedence: build metadata aside).
// - macOS, in addition: Info.plist `CFBundleShortVersionString` (numeric MAJOR.MINOR.PATCH).
// - AppImage: its runtime is inside the compressed squashfs; not read (the runtime doesn't either).

import { join } from "@std/path";

/** The standalone data section's magic. */
const MAGIC = new TextEncoder().encode("d3n0l4nd");
/** The largest metadata JSON believed (it holds argv, flags, CA data). */
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

/** The compiled metadata found in a runtime library. */
export interface EmbeddedAppMetadata {
  /** deno.json `version`, when the app was built with one. */
  readonly appVersion: string | null;
}

/** The metadata JSON just past a magic at `at`, if that is what is there. */
function metadataAt(bytes: Uint8Array, at: number): EmbeddedAppMetadata | null {
  if (at + 8 > bytes.length) return null;
  const len = new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(0, true);
  if (len < 2n || len > BigInt(MAX_METADATA_BYTES)) return null;
  const start = at + 8;
  const end = start + Number(len);
  if (end > bytes.length || bytes[start] !== 0x7b /* { */) return null;
  let map: unknown;
  try {
    map = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end)));
  } catch {
    return null;
  }
  if (typeof map !== "object" || map === null || Array.isArray(map)) return null;
  const m = map as Record<string, unknown>;
  // Keys every serialized standalone `Metadata` has, whatever else it holds.
  if (!("argv" in m) || !("entrypoint_key" in m)) return null;
  return { appVersion: typeof m.app_version === "string" ? m.app_version : null };
}

/**
 * Find the standalone metadata in a runtime library's bytes: the first magic followed by a
 * plausible length and a JSON object with the metadata's required keys (the bare magic also
 * appears in the code that looks for the section, followed by anything).
 *
 * @param bytes The library's contents.
 * @returns The metadata, or `null` when there is none.
 */
export function readEmbeddedAppMetadata(bytes: Uint8Array): EmbeddedAppMetadata | null {
  for (let i = bytes.indexOf(MAGIC[0]); i >= 0; i = bytes.indexOf(MAGIC[0], i + 1)) {
    let hit = i + MAGIC.length <= bytes.length;
    for (let j = 1; hit && j < MAGIC.length; j++) hit = bytes[i + j] === MAGIC[j];
    if (!hit) continue;
    const meta = metadataAt(bytes, i + MAGIC.length);
    if (meta) return meta;
  }
  return null;
}

/** The `<string>` value of `key` in an XML property list. */
function plistString(xml: string, key: string): string | null {
  const marker = `<key>${key}</key>`;
  const at = xml.indexOf(marker);
  if (at < 0) return null;
  const rest = xml.slice(at + marker.length).trimStart();
  if (!rest.startsWith("<string>")) return null;
  const end = rest.indexOf("</string>");
  return end < 0 ? null : rest.slice("<string>".length, end).trim();
}

/** The numeric MAJOR.MINOR.PATCH of a dotted version (missing fields 0), or `null`. */
function numericCore(text: string): string | null {
  const parts = text.split(".");
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  while (parts.length < 3) parts.push("0");
  return parts.map((p) => String(Number(p))).join(".");
}

/** A version without its build metadata: two semvers equal in precedence compare equal. */
const precedence = (v: string): string => v.split("+", 1)[0];

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isFile;
  } catch {
    return false;
  }
}

/** The runtime libraries a macOS bundle may carry its compiled data in, most likely first. */
async function bundleLibraries(app: string): Promise<{ libs: string[]; plist: string | null }> {
  const plist = await Deno.readTextFile(join(app, "Contents", "Info.plist")).catch(() => null);
  const exe = plist === null ? null : plistString(plist, "CFBundleExecutable");
  const macos = join(app, "Contents", "MacOS");
  return {
    libs: [
      ...(exe ? [join(macos, `${exe}.dylib`)] : []),
      join(app, "Contents", "Frameworks", "libruntime.dylib"),
      join(macos, "libruntime.dylib"),
    ],
    plist,
  };
}

/** An app directory's runtime libraries: `X.dll` beside `X.exe` (Windows), `X.so` beside `X`. */
async function appDirLibraries(dir: string, windows: boolean): Promise<string[]> {
  const libs: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile) continue;
    const ext = windows ? ".dll" : ".so";
    if (!e.name.toLowerCase().endsWith(ext)) continue;
    const stem = e.name.slice(0, -ext.length);
    if (await isFile(join(dir, windows ? `${stem}.exe` : stem))) libs.push(join(dir, e.name));
  }
  return libs.sort();
}

/**
 * Check that the packaged `artifact` was built as `version`, the way the pinned runtime checks a
 * staged update (see the module docs). An AppImage is not checked.
 *
 * @param artifact The packaged `.app`, app directory or `.AppImage`.
 * @param platform The manifest platform key (`<target>-<backend>[-appimage]`): which layout to read.
 * @param version The version being published.
 * @throws Error naming what the artifact carries instead, or that it carries no version.
 */
export async function checkArtifactVersion(
  artifact: string,
  platform: string,
  version: string,
): Promise<void> {
  if (platform.endsWith("-appimage")) return;
  const mac = platform.includes("apple-darwin");
  const { libs, plist } = mac
    ? await bundleLibraries(artifact)
    : { libs: await appDirLibraries(artifact, platform.includes("windows")), plist: null };
  let found: { lib: string; meta: EmbeddedAppMetadata } | null = null;
  for (const lib of libs) {
    if (!(await isFile(lib))) continue;
    const meta = readEmbeddedAppMetadata(await Deno.readFile(lib));
    if (meta) {
      found = { lib, meta };
      break;
    }
  }
  if (!found) {
    throw new Error(
      `version_mismatch: ${artifact} carries no compiled app metadata (looked in ` +
        `${libs.join(", ") || "no runtime library"}): publish the app \`deno desktop\` packaged`,
    );
  }
  const built = found.meta.appVersion;
  if (built === null || precedence(built) !== precedence(version)) {
    throw new Error(
      `version_mismatch: ${artifact} was built as ${built ?? "no version"} (deno.json "version" ` +
        `at packaging), but the manifest would offer ${version}: installed apps refuse it. ` +
        "Repackage with the version you publish, or publish the version it was built as.",
    );
  }
  const short = plist === null ? null : plistString(plist, "CFBundleShortVersionString");
  if (short !== null && numericCore(short) !== numericCore(precedence(version).split("-", 1)[0])) {
    throw new Error(
      `version_mismatch: ${artifact}'s CFBundleShortVersionString is ${short}, but the manifest ` +
        `would offer ${version}: installed apps refuse it.`,
    );
  }
}
