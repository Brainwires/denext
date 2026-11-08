// What the Linux packages say about the app to the desktop: the freedesktop `.desktop` keys from
// `desktop.linux.desktopEntry` (escaped per the Desktop Entry specification), the bundle's own
// entry rewritten after `deno desktop` writes it, and the AppStream metainfo.
//
// `deno desktop` writes `<app id>.desktop` into the Linux bundle with `Name=` the bundle
// directory's name (`my-app-x64`), `Icon=AppIcon` (no icon theme has that name) and a fixed
// `Categories=Utility;`. The `.tar.gz` and the AppImage carry that file, so the package scripts
// rewrite it ({@linkcode finishLinuxBundleEntry}) once the bundle is built: the app's name, an icon
// id with the icon file beside it, and the configured keys. Only the `[Desktop Entry]` group's
// display keys change; `Exec` (the app id in the environment, the quoted launcher) stays as the
// runtime wrote it.

import { join } from "@std/path";
import type { DesktopPackageMeta } from "./desktop-installers.ts";

/** The Desktop Entry keys a package writes, resolved ({@linkcode linuxEntryKeys}). */
export interface LinuxEntryKeys {
  /** `Categories` (default `["Utility"]`), invalid ones dropped. */
  readonly categories: readonly string[];
  readonly keywords: readonly string[];
  readonly genericName?: string;
  readonly startupWMClass?: string;
  /** File types the app opens (after any deep-link scheme handlers). */
  readonly mimeTypes: readonly string[];
}

/** A freedesktop category: letters, digits and `-`. */
const CATEGORY = /^[A-Za-z0-9-]+$/;
/** A MIME type (RFC 6838 names). */
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/** The strings of `v` (an array), or `[]`. */
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s !== "") : [];
}

/** A non-empty string, or `undefined`. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * The Desktop Entry keys of `meta.desktopEntry` (`desktop.linux.desktopEntry`), with the defaults:
 * `Categories=Utility;` and nothing else. A category or MIME type that could break the line is
 * dropped (the config validation refuses it first).
 *
 * @param meta The package metadata.
 * @returns The keys.
 */
export function linuxEntryKeys(meta: DesktopPackageMeta): LinuxEntryKeys {
  const e = (meta.desktopEntry ?? {}) as Record<string, unknown>;
  const categories = strings(e.categories).filter((c) => CATEGORY.test(c));
  return {
    categories: categories.length > 0 ? categories : ["Utility"],
    keywords: strings(e.keywords),
    genericName: str(e.genericName),
    startupWMClass: str(e.startupWMClass),
    mimeTypes: strings(e.mimeTypes).filter((m) => MIME.test(m)),
  };
}

/**
 * A Desktop Entry `string` / `localestring` value, escaped per the specification: `\\`, `\n`,
 * `\t`, `\r`, and a leading space as `\s`; any other control character becomes a space. The
 * result is always one line.
 *
 * @param value The value.
 * @returns The escaped value.
 */
export function desktopEntryString(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");
  return escaped.startsWith(" ") ? `\\s${escaped.slice(1)}` : escaped;
}

/**
 * A Desktop Entry list value (`Keywords`, `Categories`, `MimeType`): each item escaped as a
 * {@linkcode desktopEntryString} with its `;` as `\;`, every item followed by `;`.
 *
 * @param items The items.
 * @returns The list value (empty for no items).
 */
export function desktopEntryList(items: readonly string[]): string {
  return items.map((i) => `${desktopEntryString(i).replaceAll(";", "\\;")};`).join("");
}

/**
 * The display keys of `meta`'s `.desktop` entry, as the values {@linkcode rewriteDesktopEntry}
 * takes: `Categories`, and `Keywords` / `GenericName` / `StartupWMClass` when configured. `MimeType`
 * is the caller's (it merges the deep-link schemes).
 *
 * @param keys The resolved keys.
 * @returns The values, by key (`null`: no such key).
 */
export function linuxEntryValues(keys: LinuxEntryKeys): Record<string, string | null> {
  return {
    ...(keys.genericName !== undefined
      ? { GenericName: desktopEntryString(keys.genericName) }
      : {}),
    ...(keys.startupWMClass !== undefined
      ? { StartupWMClass: desktopEntryString(keys.startupWMClass) }
      : {}),
    Categories: desktopEntryList(keys.categories),
    ...(keys.keywords.length > 0 ? { Keywords: desktopEntryList(keys.keywords) } : {}),
  };
}

/**
 * Set keys in the `[Desktop Entry]` group of a `.desktop` file: a key present is replaced in
 * place, a missing one is appended at the group's end, and a `null` value removes the key. Other
 * groups (`[Desktop Action …]`), comments and the remaining keys are kept as they are.
 *
 * @param text The file.
 * @param updates The values, already escaped, by key.
 * @returns The new text.
 */
export function rewriteDesktopEntry(
  text: string,
  updates: Readonly<Record<string, string | null>>,
): string {
  const edit = new EntryEdit(updates);
  for (const line of text.replace(/\n$/, "").split("\n")) edit.line(line);
  return edit.finish();
}

/** {@linkcode rewriteDesktopEntry}'s state, one line at a time. */
class EntryEdit {
  readonly #out: string[] = [];
  readonly #done = new Set<string>();
  readonly #updates: Readonly<Record<string, string | null>>;
  #inMain = false;

  constructor(updates: Readonly<Record<string, string | null>>) {
    this.#updates = updates;
  }

  /** Take one line of the file. */
  line(line: string): void {
    if (line.startsWith("[")) {
      if (this.#inMain) this.#flush();
      this.#inMain = line.trim() === "[Desktop Entry]";
      this.#out.push(line);
      return;
    }
    const key = this.#inMain ? /^([A-Za-z0-9-]+)\s*=/.exec(line)?.[1] : undefined;
    if (key === undefined || !(key in this.#updates)) this.#out.push(line);
    else this.#set(key);
  }

  /** The new text. */
  finish(): string {
    if (this.#inMain) this.#flush();
    return `${this.#out.join("\n")}\n`;
  }

  /** Write `key`'s new value once (none for `null`). */
  #set(key: string): void {
    const v = this.#updates[key];
    if (v !== null && !this.#done.has(key)) this.#out.push(`${key}=${v}`);
    this.#done.add(key);
  }

  /** The keys not seen yet, at the group's end, before the blank lines that close it. */
  #flush(): void {
    const tail: string[] = [];
    while (this.#out.length > 0 && this.#out.at(-1) === "") tail.unshift(this.#out.pop()!);
    for (const key of Object.keys(this.#updates)) this.#set(key);
    this.#out.push(...tail);
  }
}

/** The `[Desktop Entry]` group's value of `key`, or `undefined`. */
function entryValue(text: string, key: string): string | undefined {
  let inMain = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) inMain = line.trim() === "[Desktop Entry]";
    else if (inMain && line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
  return undefined;
}

/** The `.desktop` files at the top of `dir`, sorted. */
async function topLevelEntries(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".desktop")) out.push(e.name);
  }
  return out.sort();
}

/**
 * The bundle's own `.desktop` entry (the one `deno desktop` writes beside the launcher, named after
 * the app id), or `null` when the bundle has none.
 *
 * @param bundleDir The Linux bundle directory.
 * @returns The entry's file name.
 */
export async function bundleDesktopEntryName(bundleDir: string): Promise<string | null> {
  return (await topLevelEntries(bundleDir))[0] ?? null;
}

/**
 * Rewrite the bundle's own `.desktop` entry after `deno desktop` wrote it: `Name` is the app name
 * (`desktop.app.name`, not the bundle directory's `<name>-<arch>`), `Comment` the description,
 * `Icon` the entry's own id with the bundle's `AppIcon.png` / `AppIcon.svg` copied beside it as
 * `<id>.png` / `<id>.svg` (no icon: no `Icon=`), and the `desktop.linux.desktopEntry` keys;
 * `MimeType` gains the configured file types (and `Exec` a `%F` when it had no field code). Every
 * other line stays as the runtime wrote it.
 *
 * @param bundleDir The finished Linux bundle directory.
 * @param meta The package metadata.
 * @returns The entry's path, or `null` when the bundle has no entry.
 */
export async function finishLinuxBundleEntry(
  bundleDir: string,
  meta: DesktopPackageMeta,
): Promise<string | null> {
  const name = await bundleDesktopEntryName(bundleDir);
  if (name === null) return null;
  const path = join(bundleDir, name);
  const id = name.slice(0, -".desktop".length);
  let icon = false;
  for (const ext of ["png", "svg"]) {
    const bytes = await Deno.readFile(join(bundleDir, `AppIcon.${ext}`)).catch(() => undefined);
    if (!bytes) continue;
    await Deno.writeFile(join(bundleDir, `${id}.${ext}`), bytes);
    icon = true;
  }
  const text = await Deno.readTextFile(path);
  const keys = linuxEntryKeys(meta);
  const updates: Record<string, string | null> = {
    Name: desktopEntryString(meta.name),
    Comment: desktopEntryString(meta.description),
    Icon: icon ? id : null,
    ...linuxEntryValues(keys),
  };
  if (keys.mimeTypes.length > 0) {
    const have = (entryValue(text, "MimeType") ?? "").split(";").filter(Boolean);
    const merged = [...new Set([...have, ...keys.mimeTypes])];
    updates.MimeType = merged.map((m) => `${m};`).join("");
    const exec = entryValue(text, "Exec");
    if (exec !== undefined && !/%[fFuU]/.test(exec)) updates.Exec = `${exec} %F`;
  }
  await Deno.writeTextFile(path, rewriteDesktopEntry(text, updates));
  return path;
}

/** XML text / attribute escaping. */
function xml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
}

/** What {@linkcode linuxMetainfo} writes besides the metadata. */
export interface LinuxMetainfoOptions {
  /** The component id (default `meta.identifier`). */
  readonly id?: string;
  /** The `.desktop` file the component launches (default `<id>.desktop`). */
  readonly desktopId?: string;
  /** The release date, `YYYY-MM-DD`. */
  readonly date: string;
  /** Shared libraries the host must provide (the AppImage's), listed in the description. */
  readonly requires?: readonly string[];
}

/**
 * The release date of a build at `epochSeconds` (UTC), as AppStream writes it.
 *
 * @param epochSeconds Seconds since the epoch.
 * @returns `YYYY-MM-DD`.
 */
export function appStreamDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The AppStream metainfo (`usr/share/metainfo/<id>.metainfo.xml`) software centres read: the id
 * (`desktop.app.identifier`), name, summary (the description), license (deno.json `license`),
 * developer (the publisher), update contact (`desktop.installers.email`), the `.desktop` file it
 * launches, an all-ages OARS content rating and the version as its one release. An AppImage's
 * also lists the libraries the host must provide (`requires`): AppStream's `<requires>` has no
 * element for a shared library, so they go in the description.
 *
 * @param meta The package metadata.
 * @param o The id, release date and host libraries.
 * @returns The XML text.
 */
export function linuxMetainfo(meta: DesktopPackageMeta, o: LinuxMetainfoOptions): string {
  const id = o.id ?? meta.identifier;
  const desktopId = o.desktopId ?? `${id}.desktop`;
  const summary = meta.description.replace(/[\s.]+$/, "");
  const requires = o.requires ?? [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<component type="desktop-application">',
    `  <id>${xml(id)}</id>`,
    "  <metadata_license>CC0-1.0</metadata_license>",
    ...(meta.license ? [`  <project_license>${xml(meta.license)}</project_license>`] : []),
    `  <name>${xml(meta.name)}</name>`,
    `  <summary>${xml(summary)}</summary>`,
    "  <description>",
    `    <p>${xml(meta.description)}</p>`,
    ...(requires.length > 0
      ? [`    <p>Needs these libraries on the host: ${xml(requires.join(", "))}.</p>`]
      : []),
    "  </description>",
    `  <developer><name>${xml(meta.publisher)}</name></developer>`,
    ...(meta.email ? [`  <update_contact>${xml(meta.email)}</update_contact>`] : []),
    `  <launchable type="desktop-id">${xml(desktopId)}</launchable>`,
    '  <content_rating type="oars-1.1"/>',
    "  <releases>",
    `    <release version="${xml(meta.version)}" date="${xml(o.date)}"/>`,
    "  </releases>",
    "</component>",
    "",
  ].join("\n");
}
