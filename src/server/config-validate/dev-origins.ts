// `allowedDevOrigins`: the entries the dev origin gate matches exactly. `devOriginError` is
// shared with `denext dev --allowed-dev-origin`.

import { parseDesktopAppOrigin } from "../../desktop/app-origin.ts";
import type { Fail } from "./shared.ts";

/**
 * Why `entry` is not a usable `allowedDevOrigins` entry, or `null` when it is one: an origin
 * (`http(s)://host[:port]`, nothing after it), a custom-scheme app origin (`myapp://app`,
 * validated as `desktop.app.origin` is — a Deno Desktop window's) or a bare host (`host` or
 * `host:port`, a raw IPv6 address included). The dev origin gate matches entries exactly, so a wildcard is
 * refused rather than silently never matching. Shared by the config validator and
 * `denext dev --allowed-dev-origin`.
 *
 * @param entry One entry, as given.
 * @returns The problem, ready to append to the entry, or `null`.
 */
export function devOriginError(entry: unknown): string | null {
  if (typeof entry !== "string" || entry.trim() === "") return "must be a non-empty string";
  if (entry.includes("*")) return "has a wildcard, which is not supported: list each host";
  if (/\s/.test(entry)) return "must not contain whitespace";
  return entry.includes("://") ? originEntryError(entry) : hostEntryError(entry);
}

/**
 * An `allowedDevOrigins` entry written as an origin: `http(s)://host[:port]` exactly, or a
 * custom-scheme app origin (`myapp://app`) by `desktop.app.origin`'s rules.
 */
function originEntryError(entry: string): string | null {
  if (!/^https?:\/\//i.test(entry)) {
    const parsed = parseDesktopAppOrigin(entry);
    return parsed.ok ? null : `must be an http(s) origin or a custom-scheme app origin like ` +
      `myapp://app (${parsed.error})`;
  }
  if (!URL.canParse(entry)) return "is not a valid origin";
  const url = new URL(entry);
  if (url.protocol !== "http:" && url.protocol !== "https:") return "must be an http(s) origin";
  return url.origin === entry
    ? null
    : "must be an origin like http://192.168.1.5:3000 (lowercase, no path, no trailing /)";
}

/** An `allowedDevOrigins` entry written as a bare host: `host[:port]`, or a raw IPv6 address. */
function hostEntryError(entry: string): string | null {
  // A raw IPv6 address (the gate compares it to the bracket-stripped Host hostname).
  if ((entry.match(/:/g) ?? []).length > 1) {
    return URL.canParse(`http://[${entry}]`) ? null : "is not a valid IPv6 address";
  }
  const ok = URL.canParse(`http://${entry}`) && new URL(`http://${entry}`).host === entry;
  return ok
    ? null
    : "must be a host like 192.168.1.5, mac.local or mac.local:3000 (lowercase, no path)";
}

/** `allowedDevOrigins` is a list of origins or bare hosts, no wildcards. */
export function validateAllowedDevOrigins(value: unknown, fail: Fail): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return fail("allowedDevOrigins", "must be an array of origins");
  value.forEach((entry, i) => {
    const problem = devOriginError(entry);
    if (problem) fail(`allowedDevOrigins[${i}]`, problem);
  });
}
