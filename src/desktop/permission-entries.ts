/**
 * One entry of a permission list a project bakes into a binary (`desktop.extraPermissions`, a
 * sidecar's `permissions`, `compile.permissions`): each entry becomes one value of an
 * `--allow-<kind>=<a>,<b>` flag, so an entry must be exactly one value. Deno splits a flag's value
 * on commas, so `"api.example.com,0.0.0.0"` would grant two hosts where one was written, and an
 * empty entry is a flag Deno refuses. A network entry is a host (`--allow-net`'s syntax), never a
 * URL. Pure, no imports: the config validator, the sidecar validator and the flag derivation share
 * it.
 *
 * @module
 */

/** The kinds whose entries are network hosts. */
const NET_KINDS: ReadonlySet<string> = new Set(["net", "netConnect", "netListen"]);

/** How an entry list is baked: into a Deno Desktop app (`desktopTokens`) or a compiled binary. */
export interface PermissionEntryOptions {
  /**
   * The list is baked into a Deno Desktop app (`desktop.extraPermissions`, a sidecar's
   * `permissions`), where a runtime that expands the app-folder tokens in a network grant takes a
   * `unix:$DENO_DESKTOP_DATA/<path>` or `unix:$DENO_DESKTOP_CACHE/<path>` socket entry
   * ({@linkcode isDesktopUnixTokenEntry}). Default `false` (`compile.permissions`: a compiled
   * server binary expands no token).
   */
  readonly desktopTokens?: boolean;
}

/**
 * The problem with one network permission entry (`--allow-net`'s host syntax: `host`,
 * `host:port`, a bare `:port`, an IP, `[IPv6]`, `*.example.com`, `unix:<path>`, or `"*"`), else
 * `null`. Deno refuses a URL there, and a comma would split it into two entries. A `unix:` entry
 * is an absolute socket path; in a desktop list (`options.desktopTokens`) it may instead start
 * with the app's data or cache folder token.
 *
 * @param entry The entry.
 * @param options Where the list is baked.
 * @returns The message, or `null`.
 */
export function netHostError(entry: string, options: PermissionEntryOptions = {}): string | null {
  if (entry === "" || /[\s,]/.test(entry)) {
    return `has ${JSON.stringify(entry)}: an entry is one host, without spaces or commas`;
  }
  if (entry.includes("://")) {
    return `has ${JSON.stringify(entry)}: a host (api.example.com, :3000), not a URL`;
  }
  if (!entry.startsWith("unix:") || UNIX_SOCKET_PATH.test(entry.slice(5))) return null;
  if (options.desktopTokens) {
    if (isDesktopUnixTokenEntry(entry)) return null;
    return `has ${JSON.stringify(entry)}: a unix: entry is an absolute socket path ` +
      "(unix:/run/app.sock, unix:\\\\.\\pipe\\app) or a path in the app's own folders " +
      "(unix:$DENO_DESKTOP_DATA/ipc/app.sock, unix:$DENO_DESKTOP_CACHE/x.sock, with no .. " +
      "segment); the runtime expands no other token or relative path in a network grant and " +
      "refuses to start";
  }
  return `has ${JSON.stringify(entry)}: a unix: entry is an absolute socket path ` +
    "(unix:/run/app.sock, unix:\\\\.\\pipe\\app); a compiled binary expands no folder token " +
    "or relative path in a network grant and refuses to start";
}

/** The folder tokens a desktop `unix:` entry may start with (the app's data and cache folders). */
const DESKTOP_UNIX_TOKEN = /^unix:\$DENO_DESKTOP_(?:DATA|CACHE)(?:[\\/](.*))?$/;

/**
 * Whether `entry` is a `unix:` network entry in the app's own folders that a Deno Desktop runtime
 * expands at launch: `unix:$DENO_DESKTOP_DATA` or `unix:$DENO_DESKTOP_CACHE`, alone or followed by
 * a separator and a path with no `..` segment. The runtime drops an allow entry it cannot expand
 * (never widens it); one with the token anywhere else is not a token entry.
 *
 * @param entry The entry.
 * @returns Whether the runtime expands it to a path in the app's folders.
 */
export function isDesktopUnixTokenEntry(entry: string): boolean {
  const m = DESKTOP_UNIX_TOKEN.exec(entry);
  if (!m) return false;
  return !(m[1] ?? "").split(/[\\/]/).includes("..");
}

/**
 * An absolute path a `unix:` network entry may name, as the runtime parses one: a POSIX `/path`, a
 * drive path (`C:\x`, `C:/x`) or a UNC / device path (`\\.\pipe\name`).
 */
const UNIX_SOCKET_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * The problem with one entry of a `kind` permission list, else `null`: a network entry by
 * {@linkcode netHostError}; any other (a path, a program, a library, a variable, a sys API) is one
 * non-empty value without a comma.
 *
 * @param kind The permission kind (`run`, `ffi`, `net`, `netConnect`, …).
 * @param entry The entry.
 * @param options Where the list is baked.
 * @returns The message, or `null`.
 */
export function permissionEntryError(
  kind: string,
  entry: string,
  options: PermissionEntryOptions = {},
): string | null {
  if (NET_KINDS.has(kind)) return netHostError(entry, options);
  if (entry === "" || entry.includes(",")) {
    return `has ${JSON.stringify(entry)}: an entry is one value, without commas`;
  }
  return null;
}

/**
 * The problem with a whole permission list, else `null`: an array of strings whose every entry
 * passes {@linkcode permissionEntryError}.
 *
 * @param kind The permission kind.
 * @param list The configured value.
 * @param options Where the list is baked.
 * @returns The message, or `null`.
 */
export function permissionListError(
  kind: string,
  list: unknown,
  options: PermissionEntryOptions = {},
): string | null {
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) {
    return "must be an array of strings";
  }
  for (const entry of list as string[]) {
    const error = permissionEntryError(kind, entry, options);
    if (error) return error;
  }
  return null;
}
