// Direction-split network permissions. denext's Deno from `3.0.0-rc.2` (the toolchain and the Deno
// Desktop runtime) splits `--allow-net` into `--allow-net-connect=<hosts>` (outbound: fetch,
// WebSocket, Deno.connect, database clients) and `--allow-net-listen=<addrs>` (Deno.listen,
// Deno.serve, node:net servers), with `--allow-net`'s host syntax (`host`, `host:port`, a bare
// `:port` for 0.0.0.0, 127.0.0.1 and localhost on that port). `--allow-net` keeps meaning both
// directions, and the two models are exclusive per invocation: `--allow-net` (or `--allow-all`)
// next to a directional flag is an error. Upstream Deno knows only `--allow-net`.
//
// Every runtime denext 5.0 runs on has the split, so where denext bakes or derives least-privilege
// flags it bakes the split, so a server may listen only on its own port while connecting where it
// needs: a compromised dependency can no longer open a listener of its own.

/** One permission flag from its values: `"*"` (or none given) is the unscoped flag. */
function scoped(flag: string, values: readonly string[] | undefined): string {
  const set = new Set(values ?? []);
  return set.size === 0 || set.has("*") ? flag : `${flag}=${[...set].sort().join(",")}`;
}

/**
 * The two directional flags: `--allow-net-connect[=<hosts>]` and `--allow-net-listen[=<addrs>]`.
 * An empty or absent list, or one holding `"*"`, is the unscoped flag (that direction is open).
 *
 * @param connect Outbound hosts.
 * @param listen Listen addresses.
 * @returns The two flags.
 */
export function netSplitFlags(
  connect: readonly string[] | undefined,
  listen: readonly string[] | undefined,
): string[] {
  return [scoped("--allow-net-connect", connect), scoped("--allow-net-listen", listen)];
}

/** Whether `word` already picks a network model (`--allow-net*`, `--deny-net*`) or grants all. */
function picksNetModel(word: string): boolean {
  return /^--(allow|deny)-net(-connect|-listen)?(=|$)/.test(word) || word === "-A" ||
    word === "--allow-all" || /^-N(=|$)/.test(word);
}

/**
 * A `deno run …` command with its unscoped `--allow-net` replaced by the directional pair: listen
 * is `listen` (the served address) and connect `connect`, unscoped by default (the app's own
 * outbound hosts are unknown). The command is returned unchanged unless it has exactly one bare
 * `--allow-net` and no other network or all-permission flag: a scoped `--allow-net=<hosts>`,
 * `-A` or a directional flag already says what the app's author meant.
 *
 * @param words The command's words.
 * @param listen The listen addresses (e.g. `[":3000"]`; none: unscoped).
 * @param connect The outbound hosts (none: unscoped).
 * @returns The command.
 */
export function splitNetFlag(
  words: readonly string[],
  listen: readonly string[] | undefined,
  connect?: readonly string[],
): string[] {
  const at = words.indexOf("--allow-net");
  if (at === -1 || words.filter(picksNetModel).length !== 1) return [...words];
  return [...words.slice(0, at), ...netSplitFlags(connect, listen), ...words.slice(at + 1)];
}
