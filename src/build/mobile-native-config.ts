// Text edits to a Capacitor app's native config files, shared by `denext mobile add-ota`
// (src/build/mobile-ota-install.ts) and `denext mobile add` (src/build/mobile-capabilities.ts):
// a top-level string key in ios/App/App/Info.plist and a `<uses-permission>` in
// android/app/src/main/AndroidManifest.xml. Each works on the file's text, never rewriting
// anything but the span it changes.

/** The top-level dict of a plist: where its `</dict>` is, and its keys with their offsets. */
export interface PlistTopDict {
  /** Offset of the top-level `</dict>`. */
  close: number;
  /** Each top-level `<key>`: its name and the offset just past `</key>`. */
  keys: Array<{ name: string; end: number }>;
}

/** A `<key>…</key>` (group 1: its text) or a `<dict>` / `<array>` tag (2: `/`, 3: name, 4: `/`). */
const PLIST_TAG = /<key>([^<]*)<\/key>|<(\/?)(dict|array)\b[^>]*?(\/?)>/g;

/**
 * What a `<dict>` / `<array>` tag at `depth` means for the top-level dict: `"ok"` to go on,
 * `"end"` for its closing tag, `"bad"` when the plist has no top-level dict to speak of.
 */
function topLevelStep(tag: RegExpMatchArray, depth: number): "ok" | "end" | "bad" {
  const [, key, closing, name, selfClosing] = tag;
  if (key !== undefined) return "ok";
  if (depth === 0) return !closing && !selfClosing && name === "dict" ? "ok" : "bad";
  if (depth === 1 && closing) return name === "dict" ? "end" : "bad";
  return "ok";
}

/** How a tag changes the nesting depth: a `<key>` or a self-closing tag does not. */
function depthDelta(tag: RegExpMatchArray): number {
  if (tag[1] !== undefined || tag[4]) return 0;
  return tag[2] ? -1 : 1;
}

/**
 * The top-level `<dict>` of `plist`, scanning `<dict>` / `<array>` nesting so a key of a nested
 * dict (an ATS exception, say) never counts; null without a top-level dict.
 */
export function plistTopDict(plist: string): PlistTopDict | null {
  const start = plist.indexOf("<plist");
  if (start < 0) return null;
  const keys: PlistTopDict["keys"] = [];
  let depth = 0;
  for (const tag of plist.slice(start).matchAll(PLIST_TAG)) {
    const index = start + tag.index;
    if (tag[1] !== undefined && depth === 1) {
      keys.push({ name: tag[1], end: index + tag[0].length });
    }
    const step = topLevelStep(tag, depth);
    if (step !== "ok") return step === "end" ? { close: index, keys } : null;
    depth += depthDelta(tag);
  }
  return null;
}

/** The `<string>` right after a top-level key ending at `end`, as its span and value. */
function plistStringAfter(
  plist: string,
  end: number,
): { end: number; value: string } | null {
  const m = /^\s*<string>([^<]*)<\/string>/.exec(plist.slice(end));
  return m ? { end: end + m[0].length, value: m[1] } : null;
}

/** The top-level `key` entry of `plist`, if any: where `</key>` ends, and its string value. */
export function plistEntry(
  plist: string,
  top: PlistTopDict,
  key: string,
): { keyEnd: number; value: { end: number; value: string } | null } | undefined {
  const found = top.keys.find((k) => k.name === key);
  return found && { keyEnd: found.end, value: plistStringAfter(plist, found.end) };
}

/** Escape `&`, `<` and `>` for plist / XML text. */
function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * `plist` with the top-level string `key` set to `value`, or null when it has no top-level dict
 * (or the key holds something other than a string). An existing entry is replaced only with
 * `overwrite`; without it, `plist` comes back unchanged. A new entry goes last in the dict.
 * `value` is written as given (escape it first if it may contain markup).
 */
export function withPlistString(
  plist: string,
  key: string,
  value: string,
  overwrite: boolean,
): string | null {
  const top = plistTopDict(plist);
  if (!top) return null;
  const entry = `<key>${key}</key>\n\t<string>${value}</string>`;
  const existing = plistEntry(plist, top, key);
  if (existing) {
    if (!existing.value) return null;
    if (!overwrite) return plist;
    const keyStart = plist.lastIndexOf("<key>", existing.keyEnd);
    return plist.slice(0, keyStart) + entry + plist.slice(existing.value.end);
  }
  const end = top.close;
  const lineStart = plist.lastIndexOf("\n", end - 1) + 1;
  // A `</dict>` on a line of its own gets the entry on the lines above it.
  if (plist.slice(lineStart, end).trim() === "") {
    return `${plist.slice(0, lineStart)}\t${entry}\n${plist.slice(lineStart)}`;
  }
  return `${plist.slice(0, end)}\t${entry}\n${plist.slice(end)}`;
}

/**
 * `plist` with the top-level string `key` added as `value` (XML-escaped) unless the key is
 * already there, whatever it holds: an app's own usage description is never replaced. Null
 * without a top-level dict.
 */
export function withPlistDefault(plist: string, key: string, value: string): string | null {
  const top = plistTopDict(plist);
  if (!top) return null;
  if (top.keys.some((k) => k.name === key)) return plist;
  return withPlistString(plist, key, xmlText(value), false);
}

/** A `<uses-permission>` (or `-sdk-23`) element naming `permission`. */
function usesPermission(permission: string): RegExp {
  const name = permission.replaceAll(".", "\\.");
  return new RegExp(`<uses-permission(?:-sdk-23)?\\b[^>]*android:name="${name}"`);
}

/**
 * `manifest` with `<uses-permission android:name="…" />` added before `<application` (with the
 * `<application>` line's indent), unchanged when it already declares `permission`, or null
 * without an `<application` element. `permission` is a full name, e.g.
 * `android.permission.ACCESS_NETWORK_STATE`.
 */
export function withManifestPermission(manifest: string, permission: string): string | null {
  if (usesPermission(permission).test(manifest)) return manifest;
  const at = manifest.search(/<application\b/);
  if (at < 0) return null;
  const element = `<uses-permission android:name="${permission}" />`;
  const lineStart = manifest.lastIndexOf("\n", at - 1) + 1;
  const indent = manifest.slice(lineStart, at);
  if (indent.trim() !== "") return `${manifest.slice(0, at)}${element}\n${manifest.slice(at)}`;
  return `${manifest.slice(0, lineStart)}${indent}${element}\n${manifest.slice(lineStart)}`;
}
