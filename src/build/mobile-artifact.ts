// Store artifacts as zip archives: the entry list from the central directory (no inflate), and
// the structural / signature checks `denext mobile build` records and `denext mobile submit`
// enforces (.ipa: a signed Payload/*.app; .aab: a bundle with a JAR signature; .apk: an APK
// Signing Block or a JAR signature).

import { basename } from "@std/path";

/**
 * The names of the entries in a zip archive's central directory.
 *
 * @param bytes The archive.
 * @returns The entry names, in directory order.
 * @throws {Error} When it is not a zip archive.
 */
export function listZipEntries(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) {
      throw new Error("corrupt zip central directory");
    }
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** What the artifact check found. */
export interface ArtifactCheck {
  readonly kind: "ipa" | "aab" | "apk";
  readonly signed: boolean;
  /** Problems that stop an upload. */
  readonly errors: string[];
}

/** Whether `bytes` contains the ASCII `needle`. */
function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= bytes.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/** A JAR signature file (the v1 scheme an .aab carries). */
const JAR_SIGNATURE = /^META-INF\/[^/]+\.(RSA|EC|DSA)$/;

/** Per-kind rules: whether the entries are signed, and what is missing. */
type KindCheck = (entries: string[], bytes: Uint8Array) => { signed: boolean; errors: string[] };

/** .ipa: a Payload/<name>.app with a code signature. */
const checkIpa: KindCheck = (entries) => {
  const errors: string[] = [];
  if (!entries.some((e) => /^Payload\/[^/]+\.app\//.test(e))) {
    errors.push("no Payload/<name>.app in the .ipa");
  }
  const signed = entries.some((e) =>
    /^Payload\/[^/]+\.app\/_CodeSignature\/CodeResources$/.test(e)
  );
  if (!signed) {
    errors.push(
      "the .ipa is unsigned (built with --unsigned): App Store Connect needs a signed build",
    );
  }
  return { signed, errors };
};

/** .aab: the bundle's config and base manifest, and a JAR signature. */
const checkAab: KindCheck = (entries) => {
  const errors = ["BundleConfig.pb", "base/manifest/AndroidManifest.xml"]
    .filter((need) => !entries.includes(need))
    .map((need) => `no ${need} in the .aab (not an Android App Bundle)`);
  const signed = entries.some((e) => JAR_SIGNATURE.test(e));
  if (!signed) {
    errors.push("the .aab is unsigned: Google Play needs it signed with your upload key");
  }
  return { signed, errors };
};

/** .apk: a manifest, and an APK Signing Block (v2+) or a JAR signature. */
const checkApk: KindCheck = (entries, bytes) => {
  const errors = entries.includes("AndroidManifest.xml")
    ? []
    : ["no AndroidManifest.xml in the .apk"];
  const tail = bytes.subarray(Math.max(0, bytes.length - 4 * 1024 * 1024));
  const signed = containsAscii(tail, "APK Sig Block 42") ||
    entries.some((e) => JAR_SIGNATURE.test(e));
  if (!signed) errors.push("the .apk is unsigned");
  return { signed, errors };
};

const KIND_CHECKS: Record<ArtifactCheck["kind"], KindCheck> = {
  ipa: checkIpa,
  aab: checkAab,
  apk: checkApk,
};

/** The artifact kind from its extension (anything else is treated as an .apk). */
function kindOf(path: string): ArtifactCheck["kind"] {
  if (path.endsWith(".ipa")) return "ipa";
  return path.endsWith(".aab") ? "aab" : "apk";
}

/**
 * Check a store artifact's structure and signature.
 *
 * @param path The .ipa / .aab / .apk (the extension picks the rules).
 * @param bytes Its content.
 */
export function checkArtifact(path: string, bytes: Uint8Array): ArtifactCheck {
  const kind = kindOf(path);
  let entries: string[];
  try {
    entries = listZipEntries(bytes);
  } catch (err) {
    return { kind, signed: false, errors: [`${basename(path)}: ${(err as Error).message}`] };
  }
  return { kind, ...KIND_CHECKS[kind](entries, bytes) };
}
