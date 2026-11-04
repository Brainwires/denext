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

/**
 * The problem with one network permission entry (`--allow-net`'s host syntax: `host`,
 * `host:port`, a bare `:port`, an IP, `[IPv6]`, `*.example.com`, `unix:<path>`, or `"*"`), else
 * `null`. Deno refuses a URL there, and a comma would split it into two entries.
 *
 * @param entry The entry.
 * @returns The message, or `null`.
 */
export function netHostError(entry: string): string | null {
  if (entry === "" || /[\s,]/.test(entry)) {
    return `has ${JSON.stringify(entry)}: an entry is one host, without spaces or commas`;
  }
  if (entry.includes("://")) {
    return `has ${JSON.stringify(entry)}: a host (api.example.com, :3000), not a URL`;
  }
  return null;
}

/**
 * The problem with one entry of a `kind` permission list, else `null`: a network entry by
 * {@linkcode netHostError}; any other (a path, a program, a library, a variable, a sys API) is one
 * non-empty value without a comma.
 *
 * @param kind The permission kind (`run`, `ffi`, `net`, `netConnect`, …).
 * @param entry The entry.
 * @returns The message, or `null`.
 */
export function permissionEntryError(kind: string, entry: string): string | null {
  if (NET_KINDS.has(kind)) return netHostError(entry);
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
 * @returns The message, or `null`.
 */
export function permissionListError(kind: string, list: unknown): string | null {
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) {
    return "must be an array of strings";
  }
  for (const entry of list as string[]) {
    const error = permissionEntryError(kind, entry);
    if (error) return error;
  }
  return null;
}
