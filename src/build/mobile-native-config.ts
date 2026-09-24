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

// ---- deep links, push: URL types, entitlements, intent filters, AppDelegate ------------------

/** Where a plist value element starts and ends (just past its closing tag). */
interface PlistValueSpan {
  start: number;
  end: number;
  /** The element name (`array`, `dict`, `string`, …). */
  name: string;
  /** Whether it is an empty self-closing element (`<array/>`). */
  empty: boolean;
}

/** A `<dict>` / `<array>` open, close or self-closing tag. */
const CONTAINER_TAG = /<(\/?)(dict|array)\b[^>]*?(\/?)>/g;

/** The value element that follows a `<key>` ending at `keyEnd`, or null when there is none. */
function plistValueSpan(plist: string, keyEnd: number): PlistValueSpan | null {
  const open = /^\s*<(\w+)\b[^>]*?(\/?)>/.exec(plist.slice(keyEnd));
  if (!open) return null;
  const start = keyEnd + open[0].indexOf("<");
  const name = open[1];
  const afterOpen = keyEnd + open[0].length;
  if (open[2]) return { start, end: afterOpen, name, empty: true };
  if (name !== "dict" && name !== "array") {
    const close = plist.indexOf(`</${name}>`, afterOpen);
    return close < 0 ? null : { start, end: close + name.length + 3, name, empty: false };
  }
  let depth = 1;
  CONTAINER_TAG.lastIndex = afterOpen;
  for (let m = CONTAINER_TAG.exec(plist); m; m = CONTAINER_TAG.exec(plist)) {
    if (m[3]) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { start, end: m.index + m[0].length, name, empty: false };
  }
  return null;
}

/**
 * `text` with `block` (lines without their indent) inserted above the closing tag at `close`,
 * each line indented by `indent`. A closing tag that shares its line with other text gets the
 * block inline, before it.
 */
function insertAbove(text: string, close: number, block: string[], indent: string): string {
  const lineStart = text.lastIndexOf("\n", close - 1) + 1;
  const lines = block.map((line) => `${indent}${line}\n`).join("");
  if (text.slice(lineStart, close).trim() === "") {
    return text.slice(0, lineStart) + lines + text.slice(lineStart);
  }
  return `${text.slice(0, close)}\n${lines}${text.slice(close)}`;
}

/** The `<string>` values directly inside an array's text. */
function arrayStrings(arrayText: string): string[] {
  return [...arrayText.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

/** A `<array>` of `values` as lines (no indent on the first level). */
function arrayLines(values: readonly string[]): string[] {
  return ["<array>", ...values.map((v) => `\t<string>${xmlText(v)}</string>`), "</array>"];
}

/**
 * `plist` with the top-level array `key` holding every string in `values`: missing ones are
 * appended (existing entries, and their order, are kept), and an absent key is added. Null
 * without a top-level dict, or when `key` holds something other than an array.
 */
export function withPlistStringArray(
  plist: string,
  key: string,
  values: readonly string[],
): string | null {
  const top = plistTopDict(plist);
  if (!top) return null;
  const found = top.keys.find((k) => k.name === key);
  if (!found) {
    return insertAbove(plist, top.close, [`<key>${key}</key>`, ...arrayLines(values)], "\t");
  }
  const span = plistValueSpan(plist, found.end);
  if (!span || span.name !== "array") return null;
  const have = span.empty ? [] : arrayStrings(plist.slice(span.start, span.end));
  const missing = values.filter((v) => !have.includes(xmlText(v)));
  if (missing.length === 0) return plist;
  if (span.empty) {
    return plist.slice(0, span.start) + arrayLines(missing).join("\n\t") +
      plist.slice(span.end);
  }
  const close = plist.lastIndexOf("</array>", span.end);
  return insertAbove(plist, close, missing.map((v) => `<string>${xmlText(v)}</string>`), "\t\t");
}

/** One `CFBundleURLTypes` entry registering `scheme`, as lines. */
function urlTypeLines(scheme: string): string[] {
  return [
    "<dict>",
    "\t<key>CFBundleURLName</key>",
    "\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>",
    "\t<key>CFBundleURLSchemes</key>",
    "\t<array>",
    `\t\t<string>${xmlText(scheme)}</string>`,
    "\t</array>",
    "</dict>",
  ];
}

/** Every scheme the `CFBundleURLTypes` array text already registers, lower-cased. */
function registeredSchemes(urlTypes: string): string[] {
  const lists = urlTypes.matchAll(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g);
  return [...lists].flatMap((m) => arrayStrings(m[1]).map((s) => s.toLowerCase()));
}

/**
 * `plist` with a custom URL scheme registered under `CFBundleURLTypes`: unchanged when any
 * entry already lists it (case-insensitively), else a new entry is appended (named after
 * `$(PRODUCT_BUNDLE_IDENTIFIER)`), adding the key when absent. Null without a top-level dict,
 * or when `CFBundleURLTypes` is not an array.
 */
export function withPlistUrlScheme(plist: string, scheme: string): string | null {
  const top = plistTopDict(plist);
  if (!top) return null;
  const found = top.keys.find((k) => k.name === "CFBundleURLTypes");
  if (!found) {
    const lines = ["<key>CFBundleURLTypes</key>", "<array>"];
    lines.push(...urlTypeLines(scheme).map((l) => `\t${l}`), "</array>");
    return insertAbove(plist, top.close, lines, "\t");
  }
  const span = plistValueSpan(plist, found.end);
  if (!span || span.name !== "array") return null;
  const text = plist.slice(span.start, span.end);
  if (registeredSchemes(text).includes(scheme.toLowerCase())) return plist;
  if (span.empty) {
    const lines = ["<array>", ...urlTypeLines(scheme).map((l) => `\t${l}`), "</array>"];
    return plist.slice(0, span.start) + lines.join("\n\t") + plist.slice(span.end);
  }
  const close = plist.lastIndexOf("</array>", span.end);
  return insertAbove(plist, close, urlTypeLines(scheme), "\t\t");
}

/** An empty entitlements plist, for an app that has none yet. */
export const EMPTY_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
`;

/** An intent filter for the main activity: a custom scheme, or a verified https host. */
export type ManifestLinkFilter = { scheme: string } | { host: string };

/** An `<activity>`: where its open tag starts, and where its `</activity>` is. */
interface ActivitySpan {
  start: number;
  close: number;
}

/** An `<activity …>` open tag (group 1: `/` when self-closing). */
const ACTIVITY_OPEN = /<activity\b(?:[^>"]|"[^"]*")*?(\/?)>/g;

/**
 * The launcher activity: the one whose intent filters include `android.intent.action.MAIN`,
 * else the only activity. Null when there is no such activity.
 */
function mainActivity(manifest: string): ActivitySpan | null {
  const spans: ActivitySpan[] = [];
  ACTIVITY_OPEN.lastIndex = 0;
  for (let m = ACTIVITY_OPEN.exec(manifest); m; m = ACTIVITY_OPEN.exec(manifest)) {
    if (m[1]) continue;
    const close = manifest.indexOf("</activity>", m.index);
    if (close < 0) return null;
    spans.push({ start: m.index, close });
    ACTIVITY_OPEN.lastIndex = close;
  }
  const main = spans.filter((s) =>
    manifest.slice(s.start, s.close).includes('"android.intent.action.MAIN"')
  );
  if (main.length === 1) return main[0];
  return main.length === 0 && spans.length === 1 ? spans[0] : null;
}

/** The lines of an intent filter for `filter`. */
function intentFilterLines(filter: ManifestLinkFilter): string[] {
  const verified = "host" in filter;
  const data = verified
    ? `<data android:scheme="https" android:host="${xmlText(filter.host)}" />`
    : `<data android:scheme="${xmlText(filter.scheme)}" />`;
  return [
    verified ? '<intent-filter android:autoVerify="true">' : "<intent-filter>",
    '    <action android:name="android.intent.action.VIEW" />',
    '    <category android:name="android.intent.category.DEFAULT" />',
    '    <category android:name="android.intent.category.BROWSABLE" />',
    `    ${data}`,
    "</intent-filter>",
  ];
}

/**
 * `manifest` with a VIEW / DEFAULT / BROWSABLE intent filter for `filter` in the launcher
 * activity: a custom `scheme`, or an `https` `host` with `android:autoVerify="true"` (an App
 * Link). Unchanged when the activity already names that scheme or host; null when there is no
 * launcher activity to add it to.
 */
export function withManifestIntentFilter(
  manifest: string,
  filter: ManifestLinkFilter,
): string | null {
  const activity = mainActivity(manifest);
  if (!activity) return null;
  const body = manifest.slice(activity.start, activity.close);
  const attr = "host" in filter
    ? `android:host="${xmlText(filter.host)}"`
    : `android:scheme="${xmlText(filter.scheme)}"`;
  if (body.includes(attr)) return manifest;
  const lineStart = manifest.lastIndexOf("\n", activity.close - 1) + 1;
  const closeIndent = manifest.slice(lineStart, activity.close);
  const indent = closeIndent.trim() === "" ? `${closeIndent}    ` : "    ";
  return insertAbove(manifest, activity.close, intentFilterLines(filter), indent);
}

/** The `didRegister…` / `didFail…` forwarding `@capacitor/push-notifications` needs, as lines. */
const PUSH_FORWARDING = [
  "",
  "func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {",
  "    NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)",
  "}",
  "",
  "func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {",
  "    NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)",
  "}",
];

/** The index of the `"` closing a one-line string literal opened at `i`; -1 when it never does. */
function swiftStringEnd(source: string, i: number): number {
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === "\\") j++;
    else if (source[j] === '"') return j;
    else if (source[j] === "\n") return -1;
  }
  return -1;
}

/** The index of the last character of the `close` delimiter after `from`; -1 without one. */
function delimitedEnd(source: string, from: number, close: string): number {
  const end = source.indexOf(close, from);
  return end < 0 ? -1 : end + close.length - 1;
}

/**
 * When a Swift string literal or comment starts at `i`, the index of its last character;
 * otherwise `i`. -1 when it never ends.
 */
function skipSwiftOpaque(source: string, i: number): number {
  if (source.startsWith('"""', i)) return delimitedEnd(source, i + 3, '"""');
  if (source[i] === '"') return swiftStringEnd(source, i);
  if (source.startsWith("/*", i)) return delimitedEnd(source, i + 2, "*/");
  if (!source.startsWith("//", i)) return i;
  const end = source.indexOf("\n", i);
  return end < 0 ? source.length : end;
}

/**
 * The index just past the `}` that closes the `{` at `open` in Swift source, skipping string
 * literals and comments; -1 when unbalanced.
 */
function swiftBlockEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    i = skipSwiftOpaque(source, i);
    if (i < 0) return -1;
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * `AppDelegate.swift` with the remote-notification callbacks forwarded to Capacitor (what the
 * push plugin's README asks for), appended to the `AppDelegate` class. Unchanged when it
 * already posts `.capacitorDidRegisterForRemoteNotifications`; null when the class cannot be
 * found or already implements the callback itself (add the post to your method by hand).
 */
export function withAppDelegatePushForwarding(source: string): string | null {
  if (source.includes(".capacitorDidRegisterForRemoteNotifications")) return source;
  if (source.includes("didRegisterForRemoteNotificationsWithDeviceToken")) return null;
  const decl = /\bclass\s+AppDelegate\b[^{]*\{/.exec(source);
  if (!decl) return null;
  const end = swiftBlockEnd(source, decl.index + decl[0].length - 1);
  if (end < 0) return null;
  const close = end - 1;
  const lineStart = source.lastIndexOf("\n", close - 1) + 1;
  const outer = source.slice(lineStart, close).trim() === "" ? source.slice(lineStart, close) : "";
  const lines = PUSH_FORWARDING.map((l) => l === "" ? "" : `${outer}    ${l}`);
  const block = lines.map((l) => `${l}\n`).join("");
  if (outer === "" && source.slice(lineStart, close).trim() !== "") {
    return `${source.slice(0, close)}\n${block}${source.slice(close)}`;
  }
  // Drop the blank line the block starts with when the class body already ends with one.
  const trimmed = /\n\s*\n$/.test(source.slice(0, lineStart)) ? block.slice(1) : block;
  return source.slice(0, lineStart) + trimmed + source.slice(lineStart);
}
