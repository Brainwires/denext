// The installers a packaged Deno Desktop app ships as, per OS, and the builders the scaffolded
// `scripts/package-*.ts` call to make them from the FINISHED bundle directory:
//
//   macOS    .app (always) + .dmg (default) / .pkg (`productbuild`, for MDM installs)
//   Linux    the bundle dir + .tar.gz and .deb (defaults) / .rpm (`rpmbuild`) / AppImage
//   Windows  the bundle dir + .msi (default; WiX 5) / .zip
//
// Why not `deno desktop --output app.msi|.deb|.rpm`: the runtime stages and wraps its own copy of
// the app directory in one step, so nothing denext adds to the bundle afterwards reaches the
// installer — the `laufey-launch.json` that turns DevTools off (`desktop.inspectable`), the VC++
// runtime DLLs that let the Windows app start on a machine without the redistributable, and the
// Authenticode signature on the `.exe`. Its MSI is also per-machine only and carries no major
// upgrade, so a newer version installs beside the old one. The builders here wrap the bundle the
// package script finished, so every format carries the same bytes as the `.tar.gz` / `.zip`.
//
// The `.deb` is written here directly (ar + ustar + gzip; no tool, cross-builds from any OS). The
// `.rpm` uses `rpmbuild` and the `.msi` uses WiX (`wix build`, pinned to 5.x: WiX 6+ carries the
// Open Source Maintenance Fee EULA); a format whose tool is missing is skipped with a warning when
// it is a default, and fails the run when it was asked for (`--format`, `desktop.installers`).

import { basename, dirname, fromFileUrl, join, relative, SEPARATOR } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import type { DesktopOs } from "./desktop-capabilities.ts";
import { gzipBytes } from "./precompress.ts";

/** Every installer format, by the OS it is built for. */
export const DESKTOP_INSTALLER_FORMATS = {
  darwin: ["dmg", "pkg"],
  linux: ["tar.gz", "deb", "rpm", "appimage"],
  windows: ["msi", "zip"],
} as const satisfies Record<DesktopOs, readonly string[]>;

/** One installer format (`desktop.installers.<os>` entries, `--format` values). */
export type DesktopInstallerFormat =
  (typeof DESKTOP_INSTALLER_FORMATS)[keyof typeof DESKTOP_INSTALLER_FORMATS][number];

/** The formats built when neither `--format` nor `desktop.installers.<os>` names any. */
export const DEFAULT_DESKTOP_INSTALLERS: Readonly<
  Record<DesktopOs, readonly DesktopInstallerFormat[]>
> = {
  darwin: ["dmg"],
  linux: ["tar.gz", "deb"],
  windows: ["msi"],
};

/** The `desktop.installers` key for each OS. */
const CONFIG_KEYS: Readonly<Record<DesktopOs, "macos" | "linux" | "windows">> = {
  darwin: "macos",
  linux: "linux",
  windows: "windows",
};

/** What a package script builds. */
export interface DesktopInstallerPlan {
  /** The formats, deduplicated, in the order asked for. */
  readonly formats: DesktopInstallerFormat[];
  /**
   * Whether the formats were asked for (`--format` or `desktop.installers.<os>`) rather than the
   * defaults: an asked-for format whose tool is missing fails the run instead of being skipped.
   */
  readonly explicit: boolean;
}

/** Split `--format a,b --format c` values into one lowercase list. */
export function splitFormatList(values: readonly string[]): string[] {
  return values.flatMap((v) => v.split(",")).map((v) => v.trim().toLowerCase()).filter(Boolean);
}

/** Validate `formats` for `os`; throws naming the bad value and the valid ones. */
function checkFormats(os: DesktopOs, formats: readonly string[], source: string): void {
  const valid: readonly string[] = DESKTOP_INSTALLER_FORMATS[os];
  for (const f of formats) {
    if (!valid.includes(f)) {
      throw new Error(
        `${source}: "${f}" is not a ${CONFIG_KEYS[os]} installer format (expected ${
          valid.join(", ")
        })`,
      );
    }
  }
}

/** `desktop.installers.<os>` from a loaded config, when it is set. */
function configuredFormats(config: unknown, os: DesktopOs): unknown {
  const installers = (config as { desktop?: { installers?: Record<string, unknown> } } | undefined)
    ?.desktop?.installers;
  return installers?.[CONFIG_KEYS[os]];
}

/**
 * Which installers to build for `os`: `requested` (`--format`) when it names any, else
 * `desktop.installers.<os>` from the config, else {@linkcode DEFAULT_DESKTOP_INSTALLERS}. `add`
 * (a script's legacy `--dmg` / `--appimage`) is appended to whichever list applies.
 *
 * @param os The target OS.
 * @param config The project's loaded `denext.config.ts` default export (or `undefined`).
 * @param requested `--format` values (comma lists allowed).
 * @param add Formats appended to the plan.
 * @returns The plan.
 */
export function planDesktopInstallers(
  os: DesktopOs,
  config: unknown,
  requested: readonly string[] = [],
  add: readonly string[] = [],
): DesktopInstallerPlan {
  const cli = splitFormatList(requested);
  const fromConfig = configuredFormats(config, os);
  let base: string[];
  let explicit = true;
  if (cli.length > 0) {
    checkFormats(os, cli, "--format");
    base = cli;
  } else if (fromConfig !== undefined) {
    if (!Array.isArray(fromConfig) || !fromConfig.every((f) => typeof f === "string")) {
      throw new Error(`desktop.installers.${CONFIG_KEYS[os]} must be an array of format names`);
    }
    checkFormats(os, fromConfig, `desktop.installers.${CONFIG_KEYS[os]}`);
    base = fromConfig;
  } else {
    base = [...DEFAULT_DESKTOP_INSTALLERS[os]];
    explicit = false;
  }
  const extra = splitFormatList(add);
  checkFormats(os, extra, "package script flag");
  const formats = [...new Set([...base, ...extra])] as DesktopInstallerFormat[];
  return { formats, explicit };
}

/**
 * `denext.config.ts` beside the scripts dir of `entryUrl` (a missing config is `undefined`). Shared
 * by the package-script helpers.
 */
export async function loadConfigBeside(entryUrl: string): Promise<unknown> {
  try {
    const mod = await import(new URL("../denext.config.ts", entryUrl).href);
    return (mod as { default?: unknown }).default;
  } catch {
    return undefined; // no denext.config.ts (or it exports no config): the defaults apply
  }
}

/**
 * {@linkcode planDesktopInstallers} for the project whose `scripts/` holds `entryUrl` (its
 * `denext.config.ts` supplies `desktop.installers`).
 *
 * @param entryUrl `import.meta.url` of a script in the project's `scripts/` folder.
 * @param os The target OS.
 * @param requested `--format` values.
 * @param add Formats appended to the plan (a script's legacy `--dmg` / `--appimage`).
 * @returns The plan.
 */
export async function desktopInstallerPlan(
  entryUrl: string,
  os: DesktopOs,
  requested: readonly string[] = [],
  add: readonly string[] = [],
): Promise<DesktopInstallerPlan> {
  return planDesktopInstallers(os, await loadConfigBeside(entryUrl), requested, add);
}

// ---------------------------------------------------------------------------------------------
// Package metadata
// ---------------------------------------------------------------------------------------------

/** What every installer says about the app. */
export interface DesktopPackageMeta {
  /** The display name (`desktop.app.name` in deno.json): the Start-menu / launcher name. */
  readonly name: string;
  /** deno.json `version`, or `"1.0.0"` (what `deno desktop` stamps when none is set). */
  readonly version: string;
  /** `desktop.installers.publisher`, else the app name: MSI Manufacturer, deb Maintainer, rpm Vendor. */
  readonly publisher: string;
  /** One line describing the app (`desktop.installers.description`). */
  readonly description: string;
  /** The reverse-DNS app identifier (deno.json `desktop.app.identifier`). */
  readonly identifier: string;
  /** The deep-link URL schemes the installer registers (`desktop.app.deepLinks`). */
  readonly deepLinks: string[];
  /** Whether the launcher turns the single-instance lock on (`desktop.app.singleInstance`). */
  readonly singleInstance: boolean;
  /** deno.json `license` (the `.rpm` License tag), when it is a string. */
  readonly license?: string;
  /** The `deno desktop` backend (`"webview"` unless deno.json `desktop.backend` says otherwise). */
  readonly backend: string;
  /**
   * Whether `desktop.capabilities.secureStore` is on: the Linux packages then depend on libsecret,
   * which the runtime loads at run time (absent means off).
   */
  readonly secureStore?: boolean;
}

type Obj = Record<string, unknown>;

/** A plain object field, or `{}`. */
function field(o: unknown, key: string): Obj {
  const v = (o as Obj | undefined)?.[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Obj : {};
}

/** A non-empty trimmed string, or `undefined`. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The project's deno.json (or deno.jsonc), parsed; `{}` when there is none. */
export async function readDenoJson(root: string): Promise<Obj> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      return (parseJsonc(await Deno.readTextFile(join(root, name))) ?? {}) as Obj;
    } catch { /* not this one */ }
  }
  return {};
}

/** The bare schemes of a deep-link list (`"myapp://"` → `"myapp"`), lowercased and deduplicated. */
function schemes(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = list.filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().replace(/:\/*$/, "").toLowerCase())
    .filter((s) => /^[a-z][a-z0-9+.-]*$/.test(s));
  return [...new Set(out)];
}

/**
 * Resolve {@linkcode DesktopPackageMeta} from deno.json (`version`, `license`, `desktop.app`,
 * `desktop.backend`) and `denext.config.ts` (`desktop.installers`; `desktop.app.name` and
 * `identifier` ahead of deno.json's, its other `desktop.app` keys as the fallback).
 *
 * @param deno The parsed deno.json.
 * @param config The loaded `denext.config.ts` default export.
 * @param fallbackName The name to use when neither file names the app.
 * @returns The metadata.
 */
export function packageMetaFrom(
  deno: unknown,
  config: unknown,
  fallbackName: string,
): DesktopPackageMeta {
  const denoApp = field(field(deno, "desktop"), "app");
  const cfgDesktop = field(config, "desktop");
  const cfgApp = field(cfgDesktop, "app");
  const installers = field(cfgDesktop, "installers");
  // denext.config.ts first (the package scripts mirror it into deno.json), then deno.json.
  const name = str(cfgApp.name) ?? str(denoApp.name) ?? fallbackName;
  const identifier = str(cfgApp.identifier) ?? str(denoApp.identifier) ??
    `com.deno.desktop.${debianPackageName(name)}`;
  return {
    name,
    version: str((deno as Obj | undefined)?.version) ?? "1.0.0",
    publisher: str(installers.publisher) ?? name,
    description: str(installers.description) ?? `${name} desktop application`,
    identifier,
    deepLinks: schemes(denoApp.deepLinks ?? cfgApp.deepLinks),
    singleInstance: (denoApp.singleInstance ?? cfgApp.singleInstance) === true,
    license: str((deno as Obj | undefined)?.license),
    backend: str(field(deno, "desktop").backend) ?? "webview",
    secureStore: capabilityOn(field(cfgDesktop, "capabilities"), "secureStore", "secure-store"),
  };
}

/** Whether a `desktop.capabilities` entry is on (present, not `false` / `null`), by either name. */
function capabilityOn(caps: Obj, ...names: string[]): boolean {
  return names.some((n) => caps[n] !== undefined && caps[n] !== false && caps[n] !== null);
}

/**
 * {@linkcode packageMetaFrom} for the project whose `scripts/` holds `entryUrl`.
 *
 * @param entryUrl `import.meta.url` of a script in the project's `scripts/` folder.
 * @param fallbackName The name to use when deno.json names no app.
 * @returns The metadata.
 */
export async function desktopPackageMeta(
  entryUrl: string,
  fallbackName: string,
): Promise<DesktopPackageMeta> {
  const root = new URL("../", entryUrl);
  const deno = await readDenoJson(
    root.protocol === "file:" ? fromFileUrl(root) : ".",
  );
  return packageMetaFrom(deno, await loadConfigBeside(entryUrl), fallbackName);
}

/**
 * The warnings for metadata {@linkcode packageMetaFrom} had to make up: version `1.0.0` when
 * deno.json has no `version` (every build then claims the same version, so no installer can
 * upgrade the last), and the identifier `com.deno.desktop.<name>` when no `desktop.app.identifier`
 * is set (it derives the MSI UpgradeCode and names the app to the OS, so setting one LATER makes
 * the next version install beside the old one instead of upgrading it).
 *
 * @param deno The parsed deno.json.
 * @param config The loaded `denext.config.ts` default export.
 * @param meta What {@linkcode packageMetaFrom} resolved from them.
 * @returns One line per fallback (none when both are set).
 */
export function packageMetaWarnings(
  deno: unknown,
  config: unknown,
  meta: DesktopPackageMeta,
): string[] {
  const out: string[] = [];
  if (!str((deno as Obj | undefined)?.version)) {
    out.push(
      `  ⚠ deno.json has no "version": the installers say ${meta.version}. Set one (and raise it ` +
        "for each release) so a newer installer upgrades the installed app.",
    );
  }
  const identifier = str(field(field(config, "desktop"), "app").identifier) ??
    str(field(field(deno, "desktop"), "app").identifier);
  if (!identifier) {
    out.push(
      `  ⚠ no desktop.app.identifier: using ${meta.identifier}. Set your own reverse-DNS id now — ` +
        "it derives the .msi UpgradeCode and names the app to the OS, so changing it after a " +
        "release makes the next version install beside the old one instead of upgrading it.",
    );
  }
  return out;
}

/**
 * {@linkcode packageMetaWarnings} for the project whose `scripts/` holds `entryUrl`.
 *
 * @param entryUrl `import.meta.url` of a script in the project's `scripts/` folder.
 * @param meta The resolved metadata.
 * @returns The warning lines.
 */
export async function desktopPackageMetaWarnings(
  entryUrl: string,
  meta: DesktopPackageMeta,
): Promise<string[]> {
  const root = new URL("../", entryUrl);
  const deno = await readDenoJson(root.protocol === "file:" ? fromFileUrl(root) : ".");
  return packageMetaWarnings(deno, await loadConfigBeside(entryUrl), meta);
}

// ---------------------------------------------------------------------------------------------
// Versions and names
// ---------------------------------------------------------------------------------------------

/**
 * The MSI `ProductVersion` for a deno.json version: its numeric `major.minor.build` (a prerelease
 * or build suffix is dropped — MSI accepts only numbers), `"1.0.0"` when none is set. Windows
 * Installer packs the fields into 8/8/16 bits, so a field past 255/255/65535 is an error rather
 * than a silently different version.
 *
 * @param version deno.json `version`.
 * @returns The ProductVersion.
 */
export function msiProductVersion(version: string | undefined): string {
  if (!version) return "1.0.0";
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!m) {
    throw new Error(`version "${version}" has no numeric major.minor.build for an MSI`);
  }
  const fields = [m[1], m[2] ?? "0", m[3] ?? "0"].map(Number);
  const limits = [255, 255, 65535];
  fields.forEach((n, i) => {
    if (n > limits[i]) {
      throw new Error(
        `version "${version}" cannot be an MSI ProductVersion: field ${i + 1} exceeds ${
          limits[i]
        } (MSI packs major.minor.build into 8/8/16 bits)`,
      );
    }
  });
  return fields.join(".");
}

/**
 * The `.deb` / `.rpm` version for a deno.json version: it must start with a digit and use only
 * alphanumerics and `. + ~ -`; a semver prerelease `-` becomes `~` (which both formats order
 * BEFORE the release, the semver meaning). `"1.0.0"` when none is set.
 *
 * @param version deno.json `version`.
 * @returns The package version.
 */
export function linuxPackageVersion(version: string | undefined): string {
  if (!version) return "1.0.0";
  if (!/^\d[A-Za-z0-9.+~-]*$/.test(version)) {
    throw new Error(
      `version "${version}" cannot be a Debian/RPM package version (start with a digit; use only ` +
        "alphanumerics and . + ~ -)",
    );
  }
  return version.replaceAll("-", "~");
}

/**
 * A Debian package name for an app name: lowercase `[a-z0-9+.-]`, starting alphanumeric (other
 * characters become `-`), `"app"` when fewer than two characters remain.
 *
 * @param name The app name.
 * @returns The package name.
 */
export function debianPackageName(name: string): string {
  const out = name.toLowerCase().replace(/[^a-z0-9+.-]/g, "-")
    .replace(/^[^a-z0-9]+/, "").replace(/-+$/, "");
  return out.length < 2 ? "app" : out;
}

/** The namespace `deno desktop`'s MSI derives its GUIDs from (UUIDv5), kept so the two agree. */
const MSI_GUID_NAMESPACE = "6f1d3c8a-4b2e-4f5a-9c7d-8e0f1a2b3c4d";

/** An RFC 4122 version-5 UUID (SHA-1 of namespace + name), uppercase and hyphenated. */
async function uuidV5(namespace: string, name: string): Promise<string> {
  const ns = namespace.replaceAll("-", "").match(/../g)!.map((h) => parseInt(h, 16));
  const data = new Uint8Array([...ns, ...new TextEncoder().encode(name)]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}

/**
 * The MSI UpgradeCode for an app identifier: stable across versions (so a newer installer
 * replaces an older one) and the SAME GUID `deno desktop --output app.msi` derives, so an app that
 * shipped the runtime's MSI is upgraded in place by this one.
 *
 * @param identifier The reverse-DNS app identifier.
 * @returns The braced, uppercase GUID.
 */
export async function msiUpgradeCode(identifier: string): Promise<string> {
  return `{${await uuidV5(MSI_GUID_NAMESPACE, `${identifier}\0upgrade`)}}`;
}

// ---------------------------------------------------------------------------------------------
// Bundle walking
// ---------------------------------------------------------------------------------------------

/** One entry of a bundle tree, `/`-separated relative to its root. */
export interface BundleEntry {
  readonly path: string;
  readonly kind: "file" | "dir" | "symlink";
  /** POSIX mode bits (0o755 / 0o644 when the platform reports none). */
  readonly mode: number;
  readonly size: number;
  /** A symlink's target. */
  readonly target?: string;
}

/** Walk `root` (sorted, deterministic), directories before their contents. */
export async function walkBundle(root: string): Promise<BundleEntry[]> {
  const out: BundleEntry[] = [];
  const visit = async (dir: string): Promise<void> => {
    const names: string[] = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    names.sort();
    for (const name of names) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(SEPARATOR).join("/");
      const st = await Deno.lstat(abs);
      if (st.isSymlink) {
        out.push({
          path: rel,
          kind: "symlink",
          mode: 0o777,
          size: 0,
          // A link written on Windows may read back with backslash separators; a package stores `/`.
          target: (await Deno.readLink(abs)).replaceAll("\\", "/"),
        });
      } else if (st.isDirectory) {
        out.push({ path: rel, kind: "dir", mode: 0o755, size: 0 });
        await visit(abs);
      } else {
        const head = posixModes(st.mode) ? new Uint8Array() : await fileHead(abs);
        out.push({ path: rel, kind: "file", mode: bundleFileMode(st.mode, head), size: st.size });
      }
    }
  };
  await visit(root);
  return out;
}

/** The first bytes of `path` (enough for a magic number). */
async function fileHead(path: string): Promise<Uint8Array> {
  using f = await Deno.open(path);
  const buf = new Uint8Array(4);
  const n = await f.read(buf);
  return buf.subarray(0, n ?? 0);
}

/** Whether the platform's file mode carries real POSIX permission bits (not on Windows). */
function posixModes(mode: number | null, os: string = Deno.build.os): mode is number {
  return mode !== null && os !== "windows";
}

/**
 * The POSIX mode a bundle file is packaged with: `0o755` when it is executable, else `0o644`.
 * Where the platform keeps POSIX permissions, its executable bits decide. On Windows (packaging a
 * Linux bundle cross-OS) they mean nothing — Deno reports `0o666` / `0o444` — so the file's
 * content does: an ELF image (the launcher, its shared libraries) or a `#!` script is executable.
 * Else every file of a Windows-built `.deb` / `.tar.gz` installs without its executable bit and
 * the app cannot start.
 *
 * @param mode The platform's mode (`Deno.FileInfo.mode`).
 * @param head The file's first bytes (read where the mode does not decide).
 * @param os The host OS (default `Deno.build.os`).
 * @returns `0o755` or `0o644`.
 */
export function bundleFileMode(
  mode: number | null,
  head: Uint8Array,
  os: string = Deno.build.os,
): number {
  const exec = posixModes(mode, os)
    ? (mode & 0o111) !== 0
    : isElf(head) || (head[0] === 0x23 && head[1] === 0x21);
  return exec ? 0o755 : 0o644;
}

/** Whether `head` starts with the ELF magic. */
function isElf(head: Uint8Array): boolean {
  return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
}

// ---------------------------------------------------------------------------------------------
// Windows: the .msi (WiX 5)
// ---------------------------------------------------------------------------------------------

/**
 * XML-escape an attribute value, and escape WiX's own substitutions in it: the preprocessor's
 * `$(var.X)` / `$(env.X)` / `$(sys.X)` and the binder's `!(loc.X)` / `!(bind.X)` are recognized
 * anywhere in the source, so a literal `$(` / `!(` is doubled (`$$(` / `!!(`).
 */
function xml(s: string): string {
  return s.replaceAll("$(", "$$$$(").replaceAll("!(", "!!(").replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * {@linkcode xml} for a value Windows Installer reads as Formatted (a registry key or value),
 * where `[Property]` expands: each literal bracket becomes the `[\[]` / `[\]]` escape.
 */
function xmlFormatted(s: string): string {
  return xml(s.replace(/[[\]]/g, (c) => `[\\${c}]`));
}

/** What {@linkcode wixSource} authors. */
export interface WixSourceOptions {
  readonly meta: DesktopPackageMeta;
  /** The bundle directory (absolute) the files are read from at `wix build` time. */
  readonly bundleDir: string;
  /** The bundle's entries ({@linkcode walkBundle}). */
  readonly entries: readonly BundleEntry[];
  /** The launcher, relative to the bundle (`MyApp-x64.exe`). */
  readonly exe: string;
  /** {@linkcode msiUpgradeCode} of the identifier. */
  readonly upgradeCode: string;
}

/** The `<File>` / `<Directory>` tree under INSTALLFOLDER, as WiX elements. */
function wixTree(o: WixSourceOptions, ids: Map<string, string>): string {
  const children = new Map<string, BundleEntry[]>();
  for (const e of o.entries) {
    if (e.kind === "symlink") continue;
    const parent = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    children.set(parent, [...(children.get(parent) ?? []), e]);
  }
  const winPath = (rel: string) => join(o.bundleDir, ...rel.split("/"));
  const render = (dir: string, indent: string): string =>
    (children.get(dir) ?? []).map((e) => {
      const name = xml(e.path.slice(e.path.lastIndexOf("/") + 1));
      if (e.kind === "dir") {
        return `${indent}<Directory Id="${ids.get(e.path)}" Name="${name}">\n` +
          render(e.path, indent + "  ") + `${indent}</Directory>\n`;
      }
      const id = ids.get(e.path)!;
      return `${indent}<Component Id="c_${id}">\n` +
        `${indent}  <File Id="${id}" Name="${name}" Source="${
          xml(winPath(e.path))
        }" KeyPath="yes" />\n` +
        `${indent}</Component>\n`;
    }).join("");
  return render("", "        ");
}

/**
 * The `shell\open\command` of a deep-link scheme. The `--` ends option parsing before the URL:
 * Windows splices the URL into `%1` verbatim, so a URL carrying a `"` could otherwise close the
 * quoted argument and smuggle switches (`--runtime`, Chromium flags) onto the command line (the
 * Electron CVE-2018-1000006 class). Everything after `--` is a positional.
 */
const WIX_SCHEME_COMMAND = `"[#MainExe]" -- "%1"`;

/** One deep-link scheme's registry component (`HKMU`: HKCU per-user, HKLM per-machine). */
function wixScheme(scheme: string, i: number, identifier: string): string {
  const cmd = xml(WIX_SCHEME_COMMAND);
  return `      <Component Id="Scheme${i}" Directory="INSTALLFOLDER">
        <RegistryKey Root="HKMU" Key="Software\\Classes\\${scheme}" ForceDeleteOnUninstall="yes">
          <RegistryValue Type="string" Value="URL:${scheme}" KeyPath="yes" />
          <RegistryValue Name="URL Protocol" Type="string" Value="" />
          <RegistryValue Name="DenoDesktopAppId" Type="string" Value="${
    xmlFormatted(identifier)
  }" />
          <RegistryKey Key="DefaultIcon">
            <RegistryValue Type="string" Value="${xml(`"[#MainExe]",0`)}" />
          </RegistryKey>
          <RegistryKey Key="shell\\open\\command">
            <RegistryValue Type="string" Value="${cmd}" />
          </RegistryKey>
        </RegistryKey>
      </Component>
`;
}

/**
 * The WiX 5 source (`.wxs`) for a Windows bundle directory: a dual-purpose package
 * (`Scope="perUserOrMachine"`) that installs per-user into `%LOCALAPPDATA%\Programs\<App>` with no
 * elevation by default, and per-machine into `Program Files\<App>` with `ALLUSERS=1`; a major
 * upgrade keyed on the identifier's stable UpgradeCode (a newer version replaces the old one, a
 * same-version rebuild reinstalls, a downgrade is refused); a Start-menu shortcut; the deep-link
 * schemes under `Software\Classes` in the install's own hive, marked with `DenoDesktopAppId` as the
 * runtime marks its own registration; and the bundle's icon in Add/Remove Programs.
 *
 * @param o What to author.
 * @returns The `.wxs` text.
 */
export function wixSource(o: WixSourceOptions): string {
  const ids = new Map<string, string>();
  let n = 0;
  for (const e of o.entries) {
    ids.set(e.path, e.path === o.exe ? "MainExe" : `${e.kind === "dir" ? "d" : "f"}${n++}`);
  }
  if (!ids.has(o.exe)) throw new Error(`the bundle has no launcher at ${o.exe}`);
  const icon = o.entries.some((e) => e.path === "AppIcon.ico")
    ? join(o.bundleDir, "AppIcon.ico")
    : undefined;
  const m = o.meta;
  const iconXml = icon
    ? `    <Icon Id="AppIcon.ico" SourceFile="${xml(icon)}" />\n` +
      `    <Property Id="ARPPRODUCTICON" Value="AppIcon.ico" />\n`
    : "";
  const shortcutIcon = icon ? ` Icon="AppIcon.ico"` : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by denext (scripts/package-windows.ts); rebuilt on every package run. -->
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="${xml(m.name)}" Manufacturer="${xml(m.publisher)}" Version="${
    msiProductVersion(m.version)
  }" UpgradeCode="${o.upgradeCode}" Scope="perUserOrMachine" Language="1033" InstallerVersion="500">
    <SummaryInformation Description="${xml(m.description)}" />
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer version of [ProductName] is already installed." />
    <MediaTemplate EmbedCab="yes" />
${iconXml}    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="${xml(m.name)}">
${wixTree(o, ids)}      </Directory>
    </StandardDirectory>
    <StandardDirectory Id="ProgramMenuFolder" />
    <Feature Id="Main" Title="${xml(m.name)}" Level="1">
      <ComponentGroupRef Id="AppFiles" />
      <Component Id="StartMenuShortcut" Directory="ProgramMenuFolder">
        <Shortcut Id="AppShortcut" Name="${
    xml(m.name)
  }" Target="[#MainExe]" WorkingDirectory="INSTALLFOLDER"${shortcutIcon} />
        <RegistryValue Root="HKMU" Key="Software\\${xmlFormatted(m.publisher)}\\${
    xmlFormatted(m.name)
  }" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
${m.deepLinks.map((s, i) => wixScheme(s, i, m.identifier)).join("")}    </Feature>
  </Package>
  <Fragment>
    <ComponentGroup Id="AppFiles">
${
    [...ids.entries()].filter(([p]) => o.entries.find((e) => e.path === p)?.kind === "file")
      .map(([, id]) => `      <ComponentRef Id="c_${id}" />\n`).join("")
  }    </ComponentGroup>
  </Fragment>
</Wix>
`;
}

/** The `wix build -arch` value for a bundle arch. */
export function wixArch(arch: "x86_64" | "arm64"): "x64" | "arm64" {
  return arch === "arm64" ? "arm64" : "x64";
}

/** What {@linkcode buildDesktopMsi} builds. */
export interface BuildMsiOptions {
  /** What the package says about the app ({@linkcode desktopPackageMeta}). */
  readonly meta: DesktopPackageMeta;
  /** The finished bundle directory (signed `.exe`, VC++ runtime, `laufey-launch.json`). */
  readonly bundleDir: string;
  /** The launcher's file name inside the bundle. */
  readonly exe: string;
  /** The bundle's CPU architecture. */
  readonly arch: "x86_64" | "arm64";
  /** The `.msi` to write. */
  readonly out: string;
  /** The WiX CLI (default `wix`). */
  readonly wix?: string;
}

/**
 * Author and build the `.msi` for a finished Windows bundle with WiX 5 (`wix build`); the `.wxs`
 * is kept beside the `.msi` for inspection. Windows-only (WiX builds on Windows).
 *
 * @param o What to build.
 * @returns The `.msi` path.
 */
export async function buildDesktopMsi(o: BuildMsiOptions): Promise<string> {
  const bundleDir = await Deno.realPath(o.bundleDir);
  const wxs = wixSource({
    meta: o.meta,
    bundleDir,
    entries: await walkBundle(bundleDir),
    exe: o.exe,
    upgradeCode: await msiUpgradeCode(o.meta.identifier),
  });
  const src = o.out.replace(/\.msi$/i, "") + ".wxs";
  await Deno.writeTextFile(src, wxs);
  await Deno.remove(o.out).catch(() => {});
  await runTool(o.wix ?? "wix", ["build", "-arch", wixArch(o.arch), "-o", o.out, src]);
  return o.out;
}

/** Run a tool with inherited stdio; throws on a non-zero exit. */
async function runTool(cmd: string, args: string[], cwd?: string): Promise<void> {
  const { code } = await new Deno.Command(cmd, { args, cwd, stdout: "inherit", stderr: "inherit" })
    .output();
  if (code !== 0) throw new Error(`command failed (${code}): ${cmd} ${args.join(" ")}`);
}

// ---------------------------------------------------------------------------------------------
// Linux: the installed tree, .deb (built here) and .rpm (rpmbuild)
// ---------------------------------------------------------------------------------------------

/** The shared libraries the launcher links, per backend, as (soname, Debian package). */
const LINUX_RUNTIME_DEPS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  webview: [
    ["libwebkit2gtk-4.1.so.0", "libwebkit2gtk-4.1-0"],
    ["libgtk-3.so.0", "libgtk-3-0"],
  ],
  cef: [
    ["libgtk-3.so.0", "libgtk-3-0"],
    ["libnss3.so", "libnss3"],
    ["libasound.so.2", "libasound2"],
    ["libX11.so.6", "libx11-6"],
    ["libXcomposite.so.1", "libxcomposite1"],
    ["libXdamage.so.1", "libxdamage1"],
    ["libXext.so.6", "libxext6"],
    ["libXfixes.so.3", "libxfixes3"],
    ["libXrandr.so.2", "libxrandr2"],
    ["libgbm.so.1", "libgbm1"],
    ["libxkbcommon.so.0", "libxkbcommon0"],
    ["libpango-1.0.so.0", "libpango-1.0-0"],
    ["libcairo.so.2", "libcairo2"],
    ["libatk-1.0.so.0", "libatk1.0-0"],
    ["libdbus-1.so.3", "libdbus-1-3"],
    ["libexpat.so.1", "libexpat1"],
    ["libxcb.so.1", "libxcb1"],
    ["libdrm.so.2", "libdrm2"],
  ],
};

/** The runtime dependencies for a backend (`webview` for an unknown one). */
function linuxDeps(backend: string): ReadonlyArray<readonly [string, string]> {
  return LINUX_RUNTIME_DEPS[backend] ?? LINUX_RUNTIME_DEPS.webview;
}

/**
 * The packages an enabled capability needs, as (Debian package, RPM package): the secure store's
 * libsecret, which the runtime `dlopen`s (`libsecret-1.so.0`) to reach the Secret Service.
 */
function linuxCapabilityDeps(meta: DesktopPackageMeta): ReadonlyArray<readonly [string, string]> {
  return meta.secureStore === true ? [["libsecret-1-0", "libsecret"]] : [];
}

/** Strip control characters (a `.desktop` / control value is one line). */
function oneLine(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

/**
 * The `.desktop` entry an installed package puts in `/usr/share/applications/<identifier>.desktop`:
 * `Exec` runs the `/usr/bin/<package>` link with the app id (and the single-instance lock) in the
 * environment, `StartupWMClass` matches the window's app id, and each deep-link scheme is claimed as
 * `x-scheme-handler/<scheme>` with the URL passed as `%u`. Unlike Windows' `%1`, the `%u` field
 * code is expanded by the launcher into exactly one argv element (no shell, no re-splitting), and
 * the value is a URL that starts with its scheme, so it can never be read as an option; it stays
 * the last token, with no `--` that a runtime predating `--` handling would take as the URL.
 * `Icon` names the app id, the name {@linkcode stageLinuxRoot} installs the icon under in the
 * hicolor theme (and pixmaps); with no icon to install, the entry names none.
 *
 * @param meta The package metadata.
 * @param icon Whether the package installs an icon (default `true`).
 * @returns The entry text.
 */
export function linuxDesktopEntry(meta: DesktopPackageMeta, icon = true): string {
  const pkg = debianPackageName(meta.name);
  const id = linuxAppId(meta);
  const env = `LAUFEY_APP_ID=${id}${meta.singleInstance ? " LAUFEY_SINGLE_INSTANCE=1" : ""}`;
  const mime = meta.deepLinks.map((s) => `x-scheme-handler/${s};`).join("");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${oneLine(meta.name)}`,
    `Comment=${oneLine(meta.description)}`,
    `Exec=env ${env} ${pkg}${mime ? " %u" : ""}`,
    ...(icon ? [`Icon=${id}`] : []),
    `StartupWMClass=${id}`,
    "Terminal=false",
    "Categories=Utility;",
    ...(mime ? [`MimeType=${mime}`] : []),
    "",
  ].join("\n");
}

/**
 * The app id a Linux package installs under: `desktop.app.identifier` when it is a valid
 * `.desktop` file id, else `com.deno.desktop.<package>`. It names the `.desktop` entry, the
 * window's `StartupWMClass` and the icon.
 */
function linuxAppId(meta: DesktopPackageMeta): string {
  return /^[A-Za-z0-9.-]+$/.test(meta.identifier)
    ? meta.identifier
    : `com.deno.desktop.${debianPackageName(meta.name)}`;
}

/** The width × height of a PNG (its IHDR), or `undefined` for anything else. */
function pngSize(bytes: Uint8Array): [number, number] | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47];
  if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
}

/** The hicolor sizes an icon theme lists. */
const HICOLOR_SIZES = [16, 22, 24, 32, 48, 64, 96, 128, 256, 512];

/**
 * The hicolor directory size for a square icon of `size` pixels: its own size when the theme lists
 * it, else the largest listed size below it (a launcher scales the bigger image down); `undefined`
 * below 16 px.
 */
function hicolorSize(size: number): number | undefined {
  return HICOLOR_SIZES.filter((s) => s <= size).at(-1);
}

/**
 * The Linux packages' install hooks: refresh the desktop-entry database (the `MimeType`
 * scheme handlers) and the hicolor icon cache, where those tools exist; a missing tool or a
 * failed refresh never fails the install.
 */
const LINUX_REFRESH = [
  "command -v update-desktop-database >/dev/null 2>&1 && " +
  "update-desktop-database -q /usr/share/applications || :",
  "command -v gtk-update-icon-cache >/dev/null 2>&1 && " +
  "gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || :",
];

/**
 * Whether `id` can be a D-Bus well-known name and GApplication id (what the runtime needs to own
 * it and to post notifications through the portal): at most 255 bytes, two or more `.`-separated
 * elements of `[A-Za-z0-9_-]`, none empty or starting with a digit.
 *
 * @param id The app id.
 * @returns Whether it is one.
 */
export function isDbusAppId(id: string): boolean {
  const parts = id.split(".");
  return id.length <= 255 && parts.length >= 2 &&
    parts.every((p) => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(p));
}

/**
 * The D-Bus service file a package installs as `/usr/share/dbus-1/services/<app id>.service`, so
 * D-Bus starts the app for a click on one of its notifications while it isn't running (the
 * runtime posts them through the xdg-desktop-portal and owns the app id's name while it runs,
 * runtime 2.9.7-denext.11). `Exec` runs the launcher with the environment the `.desktop` entry
 * sets, plus `--laufey-dbus-activated` (the click that follows is the launch). `undefined` when
 * the app id can't be a D-Bus name.
 *
 * @param meta The package metadata.
 * @returns The service file text, or `undefined`.
 */
export function linuxDbusService(meta: DesktopPackageMeta): string | undefined {
  const id = linuxAppId(meta);
  if (!isDbusAppId(id)) return undefined;
  const env = `LAUFEY_APP_ID=${id}${meta.singleInstance ? " LAUFEY_SINGLE_INSTANCE=1" : ""}`;
  const pkg = debianPackageName(meta.name);
  return [
    "[D-BUS Service]",
    `Name=${id}`,
    `Exec=/usr/bin/env ${env} /usr/bin/${pkg} --laufey-dbus-activated`,
    "",
  ].join("\n");
}

/** The longest app id part the runtime's notification timer unit names keep. */
const TIMER_APP_ID_MAX = 200;

/** The 16 lowercase hex digits of the FNV-1a 64 hash of `text`'s UTF-8 bytes (the runtime's tag ids). */
function fnv1a64Hex(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(text)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * The app id as the runtime's scheduled-notification timer unit names carry it
 * (`laufey-<this>-<tag id>.timer`): a byte a unit name can't hold becomes `_`, and an id longer
 * than 200 bytes keeps its first 191 plus `_` and the first 8 hex digits of its own FNV-1a 64
 * hash, so the unit name stays within systemd's 255 characters.
 *
 * @param id The app id.
 * @returns The part of the unit name.
 */
export function linuxTimerAppPart(id: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(id)) {
    const c = String.fromCharCode(b);
    out += /^[A-Za-z0-9_.:-]$/.test(c) ? c : "_";
  }
  return out.length > TIMER_APP_ID_MAX
    ? `${out.slice(0, TIMER_APP_ID_MAX - 9)}_${fnv1a64Hex(id).slice(0, 8)}`
    : out;
}

/**
 * The systemd glob for every one of the app's scheduled-notification timers and no other app's:
 * `laufey-<app part>-`, exactly 16 `[0-9a-f]`, then `.timer`, so an app whose id extends this
 * one's (`<id>-extra`) keeps its timers.
 *
 * @param id The app id.
 * @returns The glob.
 */
export function linuxTimerGlob(id: string): string {
  return `laufey-${linuxTimerAppPart(id)}-${"[0-9a-f]".repeat(16)}.timer`;
}

/**
 * Shell lines a package's removal runs to stop the scheduled-notification timers the runtime made
 * for `id` in each user's systemd manager (`laufey-<app id>-<tag id>.timer`, transient; each would
 * otherwise run the removed executable at its time), matched by {@linkcode linuxTimerGlob}: every
 * user logind knows (logged in or lingering). `--no-block` and, where it exists, `timeout 10` keep
 * a manager that doesn't answer from stalling the package manager; `|| :` keeps a user without a
 * running manager, or a system without systemd, from failing the removal.
 *
 * @param id The app id.
 * @returns The lines.
 */
export function linuxTimerCleanup(id: string): string[] {
  return [
    "if command -v loginctl >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then",
    "  laufey_timeout=",
    '  if command -v timeout >/dev/null 2>&1; then laufey_timeout="timeout 10"; fi',
    "  for user in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $2}'); do",
    `    $laufey_timeout systemctl --user --machine="$user"@ --no-block stop '${
      linuxTimerGlob(id)
    }' >/dev/null 2>&1 || :`,
    "  done",
    "fi",
  ];
}

/**
 * The `.deb` maintainer script `name` (`postinst` / `postrm`): {@linkcode LINUX_REFRESH} (dpkg's
 * own triggers do the same on Debian / Ubuntu; this covers a system without them); `postrm` also
 * stops the app's scheduled-notification timers ({@linkcode linuxTimerCleanup}) when the package
 * has a D-Bus app id.
 *
 * @param name The script.
 * @param appId The package's D-Bus app id, if it has one.
 * @returns The script text.
 */
export function debMaintainerScript(name: "postinst" | "postrm", appId?: string): string {
  // postrm: after a remove or a purge; an upgrade's old-version postrm leaves it to the postinst.
  const when = name === "postinst" ? "configure" : "remove|purge";
  const cleanup = name === "postrm" && appId ? linuxTimerCleanup(appId) : [];
  return [
    "#!/bin/sh",
    "set -e",
    'case "$1" in',
    `  ${when})`,
    ...[...LINUX_REFRESH, ...cleanup].map((l) => `    ${l}`),
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

/** The package's D-Bus app id, when its app id can be one. */
function dbusAppIdOf(meta: DesktopPackageMeta): string | undefined {
  const id = linuxAppId(meta);
  return isDbusAppId(id) ? id : undefined;
}

/** Copy `src` into `dest` recursively, keeping executable bits and symlinks. */
async function copyTree(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for (const e of await walkBundle(src)) {
    const to = join(dest, ...e.path.split("/"));
    if (e.kind === "dir") await Deno.mkdir(to, { recursive: true });
    else if (e.kind === "symlink") {
      // Windows needs the link's kind up front (its target is relative, not to the cwd).
      const isDir = (await Deno.stat(join(src, ...e.path.split("/"))).catch(() => null))
        ?.isDirectory;
      await Deno.symlink(e.target!, to, { type: isDir ? "dir" : "file" });
    } else {
      await Deno.copyFile(join(src, ...e.path.split("/")), to);
      await Deno.chmod(to, e.mode);
    }
  }
}

/**
 * The CEF backend's setuid sandbox helper, at the bundle's root (laufey's `chrome-sandbox`). A
 * `.deb` / `.rpm` installs it root-owned with mode 4755, so web content runs in Chromium's
 * sandbox even where unprivileged user namespaces are restricted (Ubuntu 23.10+'s AppArmor);
 * Chromium uses it only when it cannot create a user namespace. Every other file keeps its
 * `0o755` / `0o644` ({@linkcode bundleFileMode}): nothing else is setuid, setgid or writable by
 * group or others. A tarball or an AppImage cannot install it so (the user unpacks it, or it
 * mounts `nosuid`), and the runtime then turns the sandbox off with a warning.
 */
export const CEF_SANDBOX_HELPER = "chrome-sandbox";

/** The mode a system package installs the sandbox helper with (setuid root, `rwsr-xr-x`). */
const SANDBOX_HELPER_MODE = 0o4755;

/**
 * A `.deb` data entry's mode: the sandbox helper of the app's install directory is setuid root,
 * every other entry keeps its own (already masked) mode.
 *
 * @param e The staged entry ({@linkcode walkBundle} of the staged root).
 * @param pkg The package name (the app installs under `usr/lib/<pkg>`).
 * @returns The entry with the mode the package installs it with.
 */
function linuxPackageEntry(e: BundleEntry, pkg: string): BundleEntry {
  return e.kind === "file" && e.path === `usr/lib/${pkg}/${CEF_SANDBOX_HELPER}`
    ? { ...e, mode: SANDBOX_HELPER_MODE }
    : e;
}

/** One `%files` line of an `.rpm` spec: a path, owned as a directory only, or setuid root. */
export interface RpmFile {
  readonly path: string;
  readonly attr?: "dir" | "setuid";
}

/**
 * The `%files` an `.rpm` owns: `owned` as staged, except that when the app ships the sandbox
 * helper its install directory is listed entry by entry (`%dir` for the directory itself) so the
 * helper alone carries `%attr(4755,root,root)`; rpm has no per-file override inside a directory
 * it owns whole.
 *
 * @param stage The staged root ({@linkcode stageLinuxRoot}).
 * @param pkg The package name.
 * @param owned The installed paths the package owns.
 * @returns The `%files` entries.
 */
export async function rpmFiles(
  stage: string,
  pkg: string,
  owned: readonly string[],
): Promise<RpmFile[]> {
  const lib = `/usr/lib/${pkg}`;
  const libDir = join(stage, "usr", "lib", pkg);
  const helper = await Deno.lstat(join(libDir, CEF_SANDBOX_HELPER)).catch(() => undefined);
  if (!helper?.isFile) return owned.map((path) => ({ path }));
  const names: string[] = [];
  for await (const e of Deno.readDir(libDir)) names.push(e.name);
  names.sort();
  return owned.flatMap((path): RpmFile[] =>
    path !== lib ? [{ path }] : [
      { path: lib, attr: "dir" },
      ...names.map((name): RpmFile => ({
        path: `${lib}/${name}`,
        ...(name === CEF_SANDBOX_HELPER ? { attr: "setuid" as const } : {}),
      })),
    ]
  );
}

/**
 * Lay out the installed filesystem of a Linux package under `root`: the bundle at
 * `/usr/lib/<package>/`, a `/usr/bin/<package>` link to its launcher, the `.desktop` entry, and the
 * bundle's icon under the app id: `AppIcon.png` as `/usr/share/pixmaps/<id>.png` and, when it is
 * square, `/usr/share/icons/hicolor/<n>x<n>/apps/<id>.png` (the theme size at or below it), and an
 * `AppIcon.svg` as `/usr/share/icons/hicolor/scalable/apps/<id>.svg`. The entry's `Icon=` names
 * that id, or is left out when the bundle has no icon.
 *
 * @param bundleDir The finished bundle directory.
 * @param exe The launcher's file name inside the bundle.
 * @param meta The package metadata.
 * @param root The (empty) staging root to write.
 * @returns The installed paths the package owns (absolute, for an `.rpm` `%files` list).
 */
export async function stageLinuxRoot(
  bundleDir: string,
  exe: string,
  meta: DesktopPackageMeta,
  root: string,
): Promise<string[]> {
  const pkg = debianPackageName(meta.name);
  await copyTree(bundleDir, join(root, "usr", "lib", pkg));
  await Deno.mkdir(join(root, "usr", "bin"), { recursive: true });
  // `type`: Windows refuses a link whose (relative) target it cannot resolve from the cwd unless
  // told its kind — a Linux package built on Windows.
  await Deno.symlink(`../lib/${pkg}/${exe}`, join(root, "usr", "bin", pkg), { type: "file" });
  const id = linuxAppId(meta);
  const entry = `${id}.desktop`;
  const owned = [`/usr/lib/${pkg}`, `/usr/bin/${pkg}`, `/usr/share/applications/${entry}`];
  const icons: Array<[string, Uint8Array]> = [];
  const png = await Deno.readFile(join(bundleDir, "AppIcon.png")).catch(() => undefined);
  const size = png && pngSize(png);
  if (png && size) {
    icons.push([`usr/share/pixmaps/${id}.png`, png]);
    const theme = size[0] === size[1] ? hicolorSize(size[0]) : undefined;
    if (theme) icons.push([`usr/share/icons/hicolor/${theme}x${theme}/apps/${id}.png`, png]);
  }
  const svg = await Deno.readFile(join(bundleDir, "AppIcon.svg")).catch(() => undefined);
  if (svg) icons.push([`usr/share/icons/hicolor/scalable/apps/${id}.svg`, svg]);
  for (const [t, bytes] of icons) {
    await Deno.mkdir(dirname(join(root, t)), { recursive: true });
    await Deno.writeFile(join(root, t), bytes);
    owned.push(`/${t}`);
  }
  const apps = join(root, "usr", "share", "applications");
  await Deno.mkdir(apps, { recursive: true });
  await Deno.writeTextFile(join(apps, entry), linuxDesktopEntry(meta, icons.length > 0));
  const service = linuxDbusService(meta);
  if (service) {
    const services = join(root, "usr", "share", "dbus-1", "services");
    await Deno.mkdir(services, { recursive: true });
    await Deno.writeTextFile(join(services, `${id}.service`), service);
    owned.push(`/usr/share/dbus-1/services/${id}.service`);
  }
  return owned;
}

/** The Debian architecture of a bundle arch. */
function debianArch(arch: "x86_64" | "arm64"): "amd64" | "arm64" {
  return arch === "arm64" ? "arm64" : "amd64";
}

/**
 * The `.deb` `control` file.
 *
 * @param meta The package metadata.
 * @param arch The bundle arch.
 * @param installedKiB The installed size, in KiB.
 * @returns The control text.
 */
export function debControl(
  meta: DesktopPackageMeta,
  arch: "x86_64" | "arm64",
  installedKiB: number,
): string {
  return [
    `Package: ${debianPackageName(meta.name)}`,
    `Version: ${linuxPackageVersion(meta.version)}`,
    `Architecture: ${debianArch(arch)}`,
    `Maintainer: ${oneLine(meta.publisher)}`,
    `Installed-Size: ${installedKiB}`,
    `Depends: ${
      [...linuxDeps(meta.backend).map(([, p]) => p), ...linuxCapabilityDeps(meta).map(([d]) => d)]
        .join(", ")
    }`,
    "Section: utils",
    "Priority: optional",
    `Description: ${oneLine(meta.description)}`,
    "",
  ].join("\n");
}

const ENC = new TextEncoder();

/** Write `value` as a NUL-terminated, zero-padded octal field of `len` bytes. */
function octal(buf: Uint8Array, at: number, len: number, value: number): void {
  buf.set(ENC.encode(value.toString(8).padStart(len - 1, "0") + "\0"), at);
}

/** Split a tar path into ustar (prefix, name), or throw when it cannot fit. */
function ustarName(path: string): [string, string] {
  if (ENC.encode(path).length <= 100) return ["", path];
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (ENC.encode(prefix).length <= 155 && ENC.encode(name).length <= 100) return [prefix, name];
  }
  throw new Error(`path too long for a .deb tar entry: ${path}`);
}

/** One ustar header (root:root, the given mtime). */
function tarHeader(e: BundleEntry, path: string, mtime: number): Uint8Array {
  const h = new Uint8Array(512);
  const [prefix, name] = ustarName(path);
  h.set(ENC.encode(name), 0);
  octal(h, 100, 8, e.mode);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, e.kind === "file" ? e.size : 0);
  octal(h, 136, 12, mtime);
  h.set(ENC.encode("        "), 148);
  h[156] = ENC.encode(e.kind === "dir" ? "5" : e.kind === "symlink" ? "2" : "0")[0];
  if (e.target) h.set(ENC.encode(e.target), 157);
  h.set(ENC.encode("ustar\x0000root"), 257);
  h.set(ENC.encode("root"), 297);
  h.set(ENC.encode(prefix), 345);
  const sum = h.reduce((a, b) => a + b, 0);
  h.set(ENC.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return h;
}

/**
 * A ustar archive of `entries` (paths as `./<path>`, a `./` root first), with file bodies read from
 * `root`.
 *
 * @param root The directory the entries are relative to.
 * @param entries The entries ({@linkcode walkBundle}).
 * @param mtime The timestamp every entry carries.
 * @returns The tar bytes.
 */
async function tarEntries(
  root: string,
  entries: readonly BundleEntry[],
  mtime: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [
    tarHeader({ path: "", kind: "dir", mode: 0o755, size: 0 }, "./", mtime),
  ];
  for (const e of entries) {
    parts.push(tarHeader(e, `./${e.path}${e.kind === "dir" ? "/" : ""}`, mtime));
    if (e.kind !== "file") continue;
    const body = await Deno.readFile(join(root, ...e.path.split("/")));
    parts.push(body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return concat(parts);
}

/** Concatenate byte arrays. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An `ar` archive (the `.deb` container) of `[name, bytes]` members. */
export function arArchive(
  members: ReadonlyArray<readonly [string, Uint8Array]>,
  mtime: number,
): Uint8Array {
  const parts: Uint8Array[] = [ENC.encode("!<arch>\n")];
  for (const [name, data] of members) {
    const header = name.padEnd(16) + String(mtime).padEnd(12) + "0".padEnd(6) + "0".padEnd(6) +
      "100644".padEnd(8) + String(data.length).padEnd(10) + "`\n";
    parts.push(ENC.encode(header), data);
    if (data.length % 2) parts.push(ENC.encode("\n"));
  }
  return concat(parts);
}

/** What {@linkcode buildDesktopDeb} / {@linkcode buildDesktopRpm} build. */
export interface BuildLinuxPackageOptions {
  /** What the package says about the app ({@linkcode desktopPackageMeta}). */
  readonly meta: DesktopPackageMeta;
  /** The finished bundle directory (`laufey-launch.json` written). */
  readonly bundleDir: string;
  /** The launcher's file name inside the bundle. */
  readonly exe: string;
  /** The bundle's CPU architecture. */
  readonly arch: "x86_64" | "arm64";
  /** The package file to write. */
  readonly out: string;
}

/** The entry timestamp: `SOURCE_DATE_EPOCH` when set (reproducible builds), else now. */
function buildTime(): number {
  const epoch = Number(Deno.env.get("SOURCE_DATE_EPOCH"));
  return Number.isFinite(epoch) && epoch > 0 ? Math.floor(epoch) : Math.floor(Date.now() / 1000);
}

/**
 * Build a `.deb` for a finished Linux bundle, with no packaging tool (ar + ustar + gzip written
 * here), so it cross-builds from any OS. Installs into `/usr/lib/<package>` with a
 * `/usr/bin/<package>` link, the `.desktop` entry (deep-link schemes as `x-scheme-handler/*`) and
 * the icon; the `postinst` / `postrm` refresh the desktop and icon databases
 * ({@linkcode debMaintainerScript}).
 *
 * @param o What to build.
 * @returns The `.deb` path.
 */
export async function buildDesktopDeb(o: BuildLinuxPackageOptions): Promise<string> {
  const top = await Deno.makeTempDir({ prefix: "denext-deb-" });
  try {
    const stage = join(top, "root");
    const controlDir = join(top, "control");
    await stageLinuxRoot(o.bundleDir, o.exe, o.meta, stage);
    const pkg = debianPackageName(o.meta.name);
    const entries = (await walkBundle(stage)).map((e) => linuxPackageEntry(e, pkg));
    const kib = Math.ceil(entries.reduce((n, e) => n + e.size, 0) / 1024);
    const mtime = buildTime();
    await Deno.mkdir(controlDir);
    await Deno.writeTextFile(join(controlDir, "control"), debControl(o.meta, o.arch, kib));
    for (const script of ["postinst", "postrm"] as const) {
      const file = join(controlDir, script);
      await Deno.writeTextFile(file, debMaintainerScript(script, dbusAppIdOf(o.meta)));
      if (Deno.build.os !== "windows") await Deno.chmod(file, 0o755);
    }
    const control = await gzipBytes(
      await tarEntries(controlDir, await walkBundle(controlDir), mtime),
    );
    const data = await gzipBytes(await tarEntries(stage, entries, mtime));
    const members: Array<[string, Uint8Array]> = [
      ["debian-binary", ENC.encode("2.0\n")],
      ["control.tar.gz", control],
      ["data.tar.gz", data],
    ];
    await Deno.writeFile(o.out, arArchive(members, mtime));
  } finally {
    await Deno.remove(top, { recursive: true }).catch(() => {});
  }
  return o.out;
}

/** What {@linkcode buildDesktopTarball} archives. */
export interface BuildDesktopTarballOptions {
  /** The finished bundle directory; the archive holds it as its top-level directory. */
  readonly bundleDir: string;
  /** The `.tar.gz` to write. */
  readonly out: string;
}

/**
 * The `.tar.gz` of a finished Linux bundle, written here (ustar + gzip) rather than by the host's
 * `tar`, so a bundle packaged on Windows keeps its executables' mode bits (see
 * {@linkcode bundleFileMode}) and the archive is the same from every host.
 *
 * @param o The bundle directory and the archive path.
 * @returns The archive path.
 */
export async function buildDesktopTarball(o: BuildDesktopTarballOptions): Promise<string> {
  const top = basename(o.bundleDir);
  const entries: BundleEntry[] = [
    { path: top, kind: "dir", mode: 0o755, size: 0 },
    ...(await walkBundle(o.bundleDir)).map((e) => ({ ...e, path: `${top}/${e.path}` })),
  ];
  await Deno.writeFile(
    o.out,
    await gzipBytes(await tarEntries(dirname(o.bundleDir), entries, buildTime())),
  );
  return o.out;
}

/**
 * The `rpmbuild` spec for a staged Linux root: the files are copied as staged (no strip, no
 * debuginfo, no automatic dependency scan), `Requires` names the backend's shared libraries by
 * soname (every RPM distro provides those, whatever it calls the package) and `libsecret` (the
 * library the runtime loads) when the secure store is on; `%post` / `%postun` refresh the desktop
 * and icon databases.
 *
 * @param meta The package metadata.
 * @param stage The staged root ({@linkcode stageLinuxRoot}).
 * @param owned The installed paths the package owns ({@linkcode rpmFiles}: the sandbox helper
 *   setuid root).
 * @returns The spec text.
 */
export function rpmSpec(
  meta: DesktopPackageMeta,
  stage: string,
  owned: readonly (string | RpmFile)[],
): string {
  const requires = [
    ...linuxDeps(meta.backend).map(([so]) => `Requires: ${so}()(64bit)`),
    ...linuxCapabilityDeps(meta).map(([, rpm]) => `Requires: ${rpm}`),
  ];
  // rpmbuild expands `%macro` / `%(shell)` / `%{lua:…}` everywhere in the spec, so every value
  // that comes from the project carries its `%` as the literal `%%`.
  const lit = (s: string) => s.replaceAll("%", "%%");
  return [
    `Name: ${debianPackageName(meta.name)}`,
    `Version: ${linuxPackageVersion(meta.version)}`,
    "Release: 1",
    `Summary: ${lit(oneLine(meta.description))}`,
    `License: ${lit(oneLine(meta.license ?? "Proprietary"))}`,
    `Vendor: ${lit(oneLine(meta.publisher))}`,
    "AutoReqProv: no",
    ...requires,
    "%global debug_package %{nil}",
    "%global __os_install_post %{nil}",
    "%global _build_id_links none",
    "",
    "%description",
    lit(oneLine(meta.description)),
    "",
    "%install",
    "mkdir -p %{buildroot}",
    `cp -a '${lit(stage.replaceAll("'", "'\\''"))}'/. %{buildroot}/`,
    "",
    // Scriptlets run under /bin/sh; `|| :` keeps a missing tool from failing the transaction.
    "%post",
    ...LINUX_REFRESH,
    "",
    "%postun",
    ...LINUX_REFRESH,
    // An erase ($1 is 0), not an upgrade: stop the app's scheduled-notification timers.
    ...(dbusAppIdOf(meta)
      ? [
        'if [ "$1" = 0 ]; then',
        ...linuxTimerCleanup(dbusAppIdOf(meta)!).map((l) => `  ${l}`),
        "fi",
      ]
      : []),
    "",
    "%files",
    "%defattr(-,root,root,-)",
    ...owned.map((f) => {
      const { path, attr } = typeof f === "string" ? { path: f, attr: undefined } : f;
      const prefix = attr === "dir"
        ? "%dir "
        : attr === "setuid"
        ? `%attr(${SANDBOX_HELPER_MODE.toString(8)},root,root) `
        : "";
      return prefix + lit(path);
    }),
    "",
  ].join("\n");
}

/** The rpm architecture of a bundle arch. */
function rpmArch(arch: "x86_64" | "arm64"): "x86_64" | "aarch64" {
  return arch === "arm64" ? "aarch64" : "x86_64";
}

/**
 * Build an `.rpm` for a finished Linux bundle with `rpmbuild` (Fedora/RHEL, `apt install rpm` on
 * Debian/Ubuntu, `brew install rpm` on macOS). Same installed layout as the `.deb`.
 *
 * @param o What to build.
 * @returns The `.rpm` path.
 */
export async function buildDesktopRpm(o: BuildLinuxPackageOptions): Promise<string> {
  const top = await Deno.makeTempDir({ prefix: "denext-rpm-" });
  try {
    const stage = join(top, "root");
    const owned = await stageLinuxRoot(o.bundleDir, o.exe, o.meta, stage);
    const files = await rpmFiles(stage, debianPackageName(o.meta.name), owned);
    const spec = join(top, "app.spec");
    await Deno.writeTextFile(spec, rpmSpec(o.meta, stage, files));
    const rpms = join(top, "rpms");
    await runTool("rpmbuild", [
      "-bb",
      "--target",
      `${rpmArch(o.arch)}-linux`,
      "--define",
      `_topdir ${top}`,
      "--define",
      `_rpmdir ${rpms}`,
      "--define",
      "_build_name_fmt %%{NAME}.rpm",
      spec,
    ]);
    for await (const e of Deno.readDir(rpms)) {
      if (e.name.endsWith(".rpm")) await Deno.copyFile(join(rpms, e.name), o.out);
    }
  } finally {
    await Deno.remove(top, { recursive: true }).catch(() => {});
  }
  return o.out;
}
