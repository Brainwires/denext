// `denext desktop add <capability...>`: enable the Deno Desktop capabilities behind
// denext/mobile's functions (secureStore, readFile, openSqlite, showContextMenu, …) in a project.
// The desktop twin of `mobile add` (./mobile-capabilities.ts), with a different mechanism: a
// desktop app's "native side" is the Deno process `denext/desktop` runs, so enabling a
// capability installs nothing. It writes the capability into `desktop.capabilities` in
// denext.config.ts, which is the single source of truth for both the runtime's allowlist (a call
// to a capability that is not listed is refused `unavailable`) and the least-privilege Deno flags
// the package scripts derive (each capability declares the `--allow-*` it needs, per OS).
//
// The config edit is the comment-preserving splice `denext ui` uses (./config-edit.ts): only the
// `desktop.capabilities.<key>` value is written; everything else keeps its bytes. A key already
// present is left as the user wrote it.

import { basename, join } from "@std/path";
import { CONFIG_FILES } from "./paths.ts";
import { readConfigModel, setConfigValue } from "./config-edit.ts";
import { createUnifiedDiff } from "./patch-diff.ts";

/** The operating systems a Deno Desktop app ships for (`Deno.build.os` spelling). */
export type DesktopOs = "darwin" | "windows" | "linux";

/** Every desktop OS, in table order. */
const DESKTOP_OSES: readonly DesktopOs[] = ["darwin", "windows", "linux"];

/**
 * The Deno permissions a capability needs, as `--allow-<kind>=<values>`. `"*"` alone means the
 * flag without a list (unscoped: the whole filesystem, every program, …).
 */
export interface DesktopPermissionSet {
  /** `--allow-ffi`: libraries loaded with `Deno.dlopen` (full trust: native code). */
  readonly ffi?: readonly string[];
  /** `--allow-run`: programs spawned with `Deno.Command` (full trust over each program). */
  readonly run?: readonly string[];
  /** `--allow-read`: paths (`$APPDATA`, `$CACHE`, `$DOCUMENTS` are resolved at packaging). */
  readonly read?: readonly string[];
  /** `--allow-write`: paths. */
  readonly write?: readonly string[];
  /** `--allow-net`: hosts. */
  readonly net?: readonly string[];
  /** `--allow-env`: variables. */
  readonly env?: readonly string[];
  /** `--allow-sys`: system-information APIs. */
  readonly sys?: readonly string[];
}

/**
 * How much trust a capability adds beyond the baseline (`--allow-net=127.0.0.1`, read of the
 * bundle and the app-support folder, write of the app-support folder):
 *
 * - `none`: no new permission.
 * - `scoped`: permissions limited to named paths / APIs.
 * - `broad`: an unscoped read or write (paths the user picks at run time cannot be listed at
 *   build time, and Deno Desktop bakes permissions at build time), so the runtime's
 *   per-session picked-path allowlist is the only thing narrowing it.
 * - `full`: a spawned program or a native library, which can do anything the user can.
 */
export type DesktopTrust = "none" | "scoped" | "broad" | "full";

/** One desktop capability: what it enables and what it costs. */
export interface DesktopCapability {
  /** The `desktop.capabilities` key it writes. */
  readonly key: string;
  /** The value written when the key is absent. */
  readonly value: unknown;
  /** The page APIs it backs (from `denext/mobile` unless noted). */
  readonly api: readonly string[];
  /** The permissions it needs on every OS. */
  readonly all?: DesktopPermissionSet;
  /** The permissions it needs per OS, on top of {@linkcode DesktopCapability.all}. */
  readonly os?: Partial<Readonly<Record<DesktopOs, DesktopPermissionSet>>>;
  /** The trust it adds (see {@linkcode DesktopTrust}). */
  readonly trust: DesktopTrust;
  /** A one-line note printed with the table and the plan. */
  readonly notes: string;
  /** Steps `denext desktop add` cannot do, printed after the run. */
  readonly manual?: readonly string[];
}

/** The app's folders the `fs` capability may use by default. */
const APP_FOLDERS = ["$APPDATA", "$CACHE"];

/**
 * The capability table: `denext desktop add <name>`. Names mirror `denext mobile add` where
 * the capability exists on both.
 */
export const DESKTOP_CAPABILITIES: Readonly<Record<string, DesktopCapability>> = {
  "secure-store": {
    key: "secureStore",
    value: true,
    api: ["secureStore"],
    os: {
      darwin: { ffi: ["/System/Library/Frameworks/Security.framework/Security"] },
      windows: { ffi: ["advapi32.dll"] },
      linux: { ffi: ["libsecret-1.so.0"] },
    },
    trust: "full",
    notes: "OS keychain (Keychain / Credential Manager / libsecret) over FFI",
    manual: [
      "secure-store: Linux users need libsecret and a running Secret Service (GNOME Keyring, KWallet); without one the runtime refuses rather than writing a plain file.",
    ],
  },
  fs: {
    key: "fs",
    value: { read: APP_FOLDERS, write: APP_FOLDERS },
    api: ["readFile", "writeFile", "deleteFile", "listDir", "downloadToFile"],
    all: { read: APP_FOLDERS, write: APP_FOLDERS },
    trust: "scoped",
    notes: "app files under the OS app-support / cache folders (survive relaunch)",
    manual: [
      'fs: `directory: "documents"` needs "$DOCUMENTS" in desktop.capabilities.fs.read/write (it maps to ~/Documents/<app>); add it by hand if you use it.',
      "fs: downloadToFile fetches in the Deno process, so each download host needs network permission in the packaged app (beyond the loopback baseline).",
    ],
  },
  sqlite: {
    key: "sqlite",
    value: true,
    api: ["openSqlite", "deleteSqlite"],
    all: { read: ["$APPDATA"], write: ["$APPDATA"] },
    trust: "scoped",
    notes: "node:sqlite database files in the app-support folder",
  },
  "context-menu": {
    key: "contextMenu",
    value: true,
    api: ["showContextMenu"],
    trust: "none",
    notes: "native menu at the pointer (BrowserWindow.showContextMenu)",
  },
  shell: {
    key: "shell",
    value: { openExternal: ["https:", "mailto:"], openPath: true, reveal: true, trash: true },
    api: ["openExternal", "openPath", "revealInFileManager", "moveToTrash"],
    os: {
      darwin: { run: ["open", "osascript"] },
      windows: { run: ["explorer.exe", "rundll32.exe", "powershell.exe"] },
      linux: { run: ["xdg-open", "gio", "dbus-send"] },
    },
    trust: "full",
    notes: "system browser, open with the default app, reveal, trash",
    manual: [
      "shell: --allow-run of the OS opener (open / explorer / xdg-open) can start any app the user can; the runtime only passes URLs of the listed schemes and paths inside the fs scope or picked this session.",
    ],
  },
  dialogs: {
    key: "dialogs",
    value: true,
    api: ["pickDocument", "saveFile", "pickFolder"],
    all: { read: ["*"], write: ["*"] },
    os: {
      darwin: { run: ["osascript"] },
      windows: { ffi: ["comdlg32.dll", "shell32.dll", "ole32.dll"] },
      linux: { run: ["zenity", "kdialog"] },
    },
    trust: "broad",
    notes: "native open / save / folder panels returning paths",
    manual: [
      "dialogs: a path the user picks is only known at run time, but Deno Desktop bakes permissions at build time, so reading or writing it needs an unscoped --allow-read / --allow-write. The runtime narrows it to the paths picked this session; any other code in the Deno process is not narrowed.",
      "dialogs: Linux users need zenity or kdialog installed.",
    ],
  },
  notifications: {
    key: "notifications",
    value: true,
    api: [
      "scheduleNotification",
      "cancelNotification",
      "pendingNotifications",
      "onLocalNotificationTapped",
    ],
    trust: "none",
    notes: "OS notifications; a click focuses the window and routes data.path",
    manual: [
      "notifications: macOS shows them only from a signed .app (`denext desktop package` signs ad-hoc at least); scheduled ones fire only while the app runs.",
    ],
  },
  "keep-awake": {
    key: "keepAwake",
    value: true,
    api: ["useKeepAwake"],
    os: {
      darwin: { run: ["caffeinate"] },
      windows: { ffi: ["kernel32.dll"] },
      linux: { run: ["systemd-inhibit"] },
    },
    trust: "full",
    notes:
      "keep the display and machine awake (caffeinate / SetThreadExecutionState / systemd-inhibit)",
  },
  clipboard: {
    key: "clipboard",
    value: true,
    api: ["readClipboard", "writeClipboard"],
    trust: "none",
    notes: "text clipboard from the Deno side (no user gesture needed)",
  },
  device: {
    key: "device",
    value: true,
    api: ["deviceInfo"],
    all: { sys: ["osRelease"] },
    trust: "scoped",
    notes: "OS name and release",
  },
};

/** A capability name as typed (`secure-store`, or its config key `secureStore`) → its table name. */
function canonicalName(name: string): string | undefined {
  if (Object.hasOwn(DESKTOP_CAPABILITIES, name)) return name;
  return Object.keys(DESKTOP_CAPABILITIES).find((n) => DESKTOP_CAPABILITIES[n].key === name);
}

/** The permission kinds, in flag order. */
const PERMISSION_KINDS = ["read", "write", "net", "env", "sys", "run", "ffi"] as const;

/**
 * The union of the permissions `names` need on `os`, as `--allow-*` flags (the capabilities'
 * share only; the runtime adds its baseline).
 *
 * @param names Table names (see {@linkcode DESKTOP_CAPABILITIES}).
 * @param os The target OS.
 * @returns The flags, e.g. `["--allow-run=caffeinate,osascript"]`.
 */
export function desktopPermissionFlags(names: readonly string[], os: DesktopOs): string[] {
  const union = new Map<string, Set<string>>();
  for (const name of names) {
    const cap = DESKTOP_CAPABILITIES[canonicalName(name) ?? ""];
    if (!cap) continue;
    for (const set of [cap.all, cap.os?.[os]]) {
      for (const kind of PERMISSION_KINDS) {
        for (const v of set?.[kind] ?? []) {
          const values = union.get(kind) ?? new Set<string>();
          values.add(v);
          union.set(kind, values);
        }
      }
    }
  }
  return PERMISSION_KINDS.filter((k) => union.has(k)).map((kind) => {
    const values = [...union.get(kind)!].sort();
    return values.includes("*") ? `--allow-${kind}` : `--allow-${kind}=${values.join(",")}`;
  });
}

/**
 * The `--list` table: name, config key, trust, note.
 *
 * @param table The capabilities (tests pass their own).
 * @returns The formatted table.
 */
export function formatDesktopCapabilityTable(
  table: Readonly<Record<string, DesktopCapability>> = DESKTOP_CAPABILITIES,
): string {
  return Object.entries(table).map(([name, c]) =>
    `  ${name.padEnd(15)}${c.key.padEnd(15)}${c.trust.padEnd(8)}${c.notes}`
  ).join("\n");
}

/** Options for {@linkcode addDesktopCapabilities}. */
export interface AddDesktopCapabilitiesOptions {
  /** Capability names (table names or config keys). */
  readonly capabilities: readonly string[];
  /** The project directory. */
  readonly dir: string;
  /** Plan only: compute the edit and write nothing. */
  readonly dryRun?: boolean;
}

/** What {@linkcode addDesktopCapabilities} did (or would do, with `dryRun`). */
export interface AddDesktopCapabilitiesReport {
  /** The config file edited (or created). */
  readonly configPath: string;
  /** Whether the config file was created. */
  readonly created: boolean;
  /** Capabilities whose key was written. */
  readonly added: readonly string[];
  /** Capabilities already present (left as written). */
  readonly kept: readonly string[];
  /** The unified diff of the config edit (empty when nothing changed). */
  readonly diff: string;
  /** The `--allow-*` flags the enabled capabilities need, per OS. */
  readonly permissions: Readonly<Record<DesktopOs, readonly string[]>>;
  /** The highest trust among the requested capabilities. */
  readonly trust: DesktopTrust;
  /** Steps to do by hand. */
  readonly manual: readonly string[];
}

/** Trust levels, lowest first. */
const TRUST_ORDER: readonly DesktopTrust[] = ["none", "scoped", "broad", "full"];

/** The first existing config file under `dir`, or undefined. */
async function findConfig(dir: string): Promise<string | undefined> {
  for (const name of CONFIG_FILES) {
    try {
      await Deno.stat(join(dir, name));
      return join(dir, name);
    } catch {
      // not this one
    }
  }
  return undefined;
}

/** The value at `desktop.capabilities.<key>` in a config source, when it is a data literal. */
async function presentKeys(source: string): Promise<Set<string>> {
  const model = await readConfigModel(source);
  const desktop = model.keys.desktop;
  const caps = desktop?.kind === "editable"
    ? (desktop.value as { capabilities?: unknown } | null)?.capabilities
    : undefined;
  return new Set(
    typeof caps === "object" && caps !== null ? Object.keys(caps as Record<string, unknown>) : [],
  );
}

/** The config a project without one gets. */
const NEW_CONFIG = "// denext.config.ts\nexport default {};\n";

/** The table names for `raw` (deduplicated), or a throw for an empty list / unknown name. */
function resolveNames(raw: readonly string[]): string[] {
  if (raw.length === 0) {
    throw new Error("name at least one capability (see `denext desktop add --list`)");
  }
  const names: string[] = [];
  for (const r of raw) {
    const name = canonicalName(r);
    if (!name) throw new Error(`unknown capability "${r}" (see \`denext desktop add --list\`)`);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Splice each capability not yet present into `source`; throws with the by-hand snippet. */
async function spliceCapabilities(
  before: string,
  names: readonly string[],
  configPath: string,
): Promise<{ source: string; added: string[]; kept: string[] }> {
  const present = await presentKeys(before);
  let source = before;
  const added: string[] = [];
  const kept: string[] = [];
  for (const name of names) {
    const cap = DESKTOP_CAPABILITIES[name];
    if (present.has(cap.key)) {
      kept.push(name);
      continue;
    }
    const edit = await setConfigValue(source, ["desktop", "capabilities", cap.key], cap.value);
    if (!edit.ok) {
      throw new Error(
        `cannot edit ${configPath}: ${edit.reason}\n  Add by hand: desktop: { capabilities: { ${cap.key}: ${
          JSON.stringify(cap.value)
        } } }`,
      );
    }
    source = edit.source;
    added.push(name);
  }
  return { source, added, kept };
}

/** The highest trust among `names`. */
function highestTrust(names: readonly string[]): DesktopTrust {
  return names.map((n) => DESKTOP_CAPABILITIES[n].trust)
    .reduce<DesktopTrust>(
      (a, b) => TRUST_ORDER.indexOf(b) > TRUST_ORDER.indexOf(a) ? b : a,
      "none",
    );
}

/**
 * Enable `capabilities` in the project's `desktop.capabilities`. Idempotent: a key already
 * present is kept as written.
 *
 * @param opts The capabilities, the project directory, and `dryRun`.
 * @returns What changed (or would change), with the permissions the capabilities need.
 * Throws for an unknown capability, or when the config cannot be edited (its `desktop` value is
 * code, not data); the message then carries the snippet to add by hand.
 */
export async function addDesktopCapabilities(
  opts: AddDesktopCapabilitiesOptions,
): Promise<AddDesktopCapabilitiesReport> {
  const names = resolveNames(opts.capabilities);
  const existing = await findConfig(opts.dir);
  const configPath = existing ?? join(opts.dir, "denext.config.ts");
  const before = existing ? await Deno.readTextFile(existing) : NEW_CONFIG;
  const { source, added, kept } = await spliceCapabilities(before, names, configPath);
  const changed = source !== before || !existing;
  const label = basename(configPath);
  const diff = changed
    ? createUnifiedDiff(existing ? before : "", source, `a/${label}`, `b/${label}`)
    : "";
  if (changed && !opts.dryRun) await Deno.writeTextFile(configPath, source);
  const permissions = Object.fromEntries(
    DESKTOP_OSES.map((os) => [os, desktopPermissionFlags(names, os)]),
  ) as Record<DesktopOs, string[]>;
  const trust = highestTrust(names);
  return {
    configPath,
    created: !existing,
    added,
    kept,
    diff,
    permissions,
    trust,
    manual: names.flatMap((n) => DESKTOP_CAPABILITIES[n].manual ?? []),
  };
}

/**
 * The human report for an add (or a `--dry-run` plan).
 *
 * @param report What {@linkcode addDesktopCapabilities} returned.
 * @param dryRun Whether nothing was written.
 * @returns The lines to print.
 */
export function formatDesktopAddReport(
  report: AddDesktopCapabilitiesReport,
  dryRun: boolean,
): string {
  const lines: string[] = [];
  const verb = dryRun ? "would enable" : "enabled";
  if (report.added.length > 0) {
    lines.push(`  ${verb}: ${report.added.join(", ")}  (${report.configPath})`);
  }
  if (report.kept.length > 0) lines.push(`  already enabled: ${report.kept.join(", ")}`);
  if (report.created) lines.push(`  ${dryRun ? "would create" : "created"} ${report.configPath}`);
  if (report.diff) lines.push("", report.diff.trimEnd());
  lines.push("", "  Deno permissions these capabilities add (the package scripts derive them):");
  for (const os of DESKTOP_OSES) {
    const flags = report.permissions[os];
    lines.push(`    ${os.padEnd(8)}${flags.length > 0 ? flags.join(" ") : "(none)"}`);
  }
  if (report.trust === "broad" || report.trust === "full") {
    lines.push(
      "",
      report.trust === "full"
        ? "  Trust: FULL: a spawned program or native library can do anything the user can."
        : "  Trust: BROAD: an unscoped filesystem permission (see the dialogs note).",
    );
  }
  if (report.manual.length > 0) {
    lines.push("", "  By hand:", ...report.manual.map((m) => `    - ${m}`));
  }
  return lines.join("\n");
}
