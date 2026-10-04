/**
 * The stable page origin (`desktop.app.origin`) and app identifier (`desktop.app.identifier`) of a
 * Deno Desktop app, validated exactly as the denext-pinned desktop runtime validates them
 * (`cli/lib/standalone/app_origin.rs` and `app_id.rs` in the runtime), so a value denext accepts is
 * one the runtime accepts, and an error surfaces at config load instead of at launch.
 *
 * Pure: no Deno APIs, no I/O. Shared by the config validator, the packager and the runtime gate.
 *
 * @module
 */

/** The origin the runtime serves the app at when `desktop.app.origin` is not configured. */
export const DEFAULT_DESKTOP_APP_ORIGIN = "app://localhost";

/**
 * Schemes that may not be a desktop app origin (the runtime's `RESERVED_SCHEMES`): the WHATWG
 * special schemes, the engine-handled ones, and the browser-internal ones.
 */
export const RESERVED_DESKTOP_SCHEMES: readonly string[] = [
  // WHATWG special schemes.
  "http",
  "https",
  "ws",
  "wss",
  "file",
  "ftp",
  // Engine-handled schemes.
  "blob",
  "data",
  "javascript",
  "about",
  // Browser-internal schemes.
  "applewebdata",
  "chrome",
  "chrome-devtools",
  "chrome-extension",
  "chrome-untrusted",
  "devtools",
  "filesystem",
  "view-source",
  "webkit",
];

/** The longest accepted origin (the runtime's `MAX_LEN`). */
const MAX_ORIGIN_LEN = 255;
/** The longest accepted identifier (Apple's `CFBundleIdentifier` limit, the runtime's `MAX_LEN`). */
const MAX_IDENTIFIER_LEN = 155;

/** A string's UTF-8 byte length (the runtime measures `str::len()`, i.e. bytes). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** A validated, normalized desktop app origin. */
export interface DesktopAppOrigin {
  /** The lower-cased scheme (`myapp` in `myapp://app`): the scheme the webview registers. */
  readonly scheme: string;
  /** The lower-cased host (`app` in `myapp://app`). */
  readonly host: string;
  /** The serialized origin, `scheme://host`: `location.origin` and the `Origin` header value. */
  readonly origin: string;
}

/** A parse result: the origin, or the runtime's error message for the value. */
export type DesktopAppOriginResult =
  | { readonly ok: true; readonly value: DesktopAppOrigin }
  | { readonly ok: false; readonly error: string };

/** RFC 3986 `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`, minus the reserved schemes. */
function schemeError(scheme: string): string | null {
  if (scheme === "") return "scheme is empty";
  if (!/^[A-Za-z]/.test(scheme)) return "scheme must start with an ASCII letter";
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) {
    return "scheme may only contain ASCII letters, digits, '+', '-' and '.' (RFC 3986)";
  }
  const lower = scheme.toLowerCase();
  if (RESERVED_DESKTOP_SCHEMES.includes(lower)) {
    return `scheme "${lower}" is reserved by browsers and cannot be an app origin`;
  }
  return null;
}

/** A bare host: DNS-style labels of ASCII letters, digits and `-`, joined by `.`. */
function hostError(host: string): string | null {
  if (host === "") return "host is empty";
  if (/[/?#]/.test(host)) return "origin must not carry a path, query or fragment";
  if (host.includes("@")) return "origin must not carry userinfo (found '@')";
  if (host.includes(":")) return "origin must not carry a port (found ':')";
  const labelsOk = host.split(".").every((label) => /^[A-Za-z0-9-]+$/.test(label));
  if (!labelsOk) {
    return "host may only contain ASCII letters, digits, '-' and '.', with no empty label";
  }
  return null;
}

/**
 * Parse and normalize a `desktop.app.origin` value as the runtime does: `scheme://host` with an
 * optional single trailing `/`, surrounding whitespace trimmed, scheme and host lower-cased. The
 * scheme is a custom one (not `http`/`https`/`file`/`ws`/… — see
 * {@linkcode RESERVED_DESKTOP_SCHEMES}); the host carries no port, userinfo, path, query or
 * fragment.
 *
 * @param input The configured value.
 * @returns The normalized origin, or the runtime's error message.
 */
export function parseDesktopAppOrigin(input: string): DesktopAppOriginResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "origin is empty" };
  if (byteLength(trimmed) > MAX_ORIGIN_LEN) {
    return { ok: false, error: `origin is longer than ${MAX_ORIGIN_LEN} characters` };
  }
  const sep = trimmed.indexOf("://");
  if (sep === -1) {
    return {
      ok: false,
      error: 'origin must be of the form <scheme>://<host> (e.g. "myapp://app")',
    };
  }
  const scheme = trimmed.slice(0, sep);
  const rest = trimmed.slice(sep + 3);
  const sErr = schemeError(scheme);
  if (sErr) return { ok: false, error: sErr };
  // A lone trailing slash is the URL serializer's doing, not a path.
  const host = rest.endsWith("/") ? rest.slice(0, -1) : rest;
  const hErr = hostError(host);
  if (hErr) return { ok: false, error: hErr };
  const s = scheme.toLowerCase();
  const h = host.toLowerCase();
  return { ok: true, value: { scheme: s, host: h, origin: `${s}://${h}` } };
}

/**
 * Validate a deep-link URL scheme (`desktop.app.deepLinks`): the same RFC 3986 and reserved-scheme
 * rules as an origin's scheme, given bare (`"myapp"`, no `:`).
 *
 * @param scheme The scheme.
 * @returns The error message, or `null` when valid.
 */
export function desktopSchemeError(scheme: string): string | null {
  return schemeError(scheme);
}

/**
 * `desktop.app.deepLinks` validated (each a {@linkcode desktopSchemeError}-clean scheme) and
 * lower-cased, or `[]` when unset. Throws on a non-array or an invalid scheme.
 *
 * @param raw The configured value.
 * @returns The schemes.
 */
export function normalizeDesktopDeepLinks(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("desktop.app.deepLinks must be an array");
  return raw.map((scheme) => {
    const err = typeof scheme === "string" ? schemeError(scheme) : "must be a string";
    if (err) throw new Error(`invalid desktop.app.deepLinks scheme: ${err}`);
    return (scheme as string).toLowerCase();
  });
}

/**
 * Validate a reverse-DNS app identifier as the runtime does (Apple's `CFBundleIdentifier` rules:
 * ASCII letters, digits, `-` and `.`, at least one dot, no empty segment, at most 155 characters).
 * An identifier that passes is also a valid laufey app id (`[A-Za-z0-9._-]+`).
 *
 * @param id The identifier.
 * @returns The runtime's error message, or `null` when valid.
 */
export function desktopAppIdentifierError(id: string): string | null {
  // The runtime formats with Rust's `{:?}`: a string in double quotes, a char in single quotes.
  const q = JSON.stringify(id);
  if (id === "") return "bundle identifier is empty";
  if (byteLength(id) > MAX_IDENTIFIER_LEN) {
    return `bundle identifier ${q} is longer than ${MAX_IDENTIFIER_LEN} characters`;
  }
  if (!id.includes(".")) {
    return `bundle identifier ${q} must be in reverse-DNS form (e.g. com.acme.foo)`;
  }
  const bad = [...id].find((c) => !/^[A-Za-z0-9.-]$/.test(c));
  if (bad !== undefined) {
    return `bundle identifier ${q} must match [A-Za-z0-9.-]+, but contains '${
      JSON.stringify(bad).slice(1, -1)
    }'`;
  }
  if (id.split(".").some((seg) => seg === "")) {
    return `bundle identifier ${q} has an empty segment`;
  }
  return null;
}

/**
 * The error the runtime raises for an origin configured without an identifier: web storage is
 * keyed by origin, so two apps sharing an origin would share it.
 *
 * @param origin The configured origin.
 * @returns The message.
 */
export function originWithoutIdentifierMessage(origin: string): string {
  return `desktop.app.origin "${origin}" requires desktop.app.identifier. Web storage is keyed by ` +
    "origin, so without a per-app identifier two apps with the same origin could share it. Set a " +
    'reverse-DNS identifier, e.g. desktop: { app: { identifier: "com.example.myapp" } }.';
}

/** The ports WHATWG special schemes leave out of a serialized origin. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ftp: 21,
};
/** Schemes whose documents have opaque origins: never a bridge origin. */
const OPAQUE_SCHEMES: ReadonlySet<string> = new Set([
  "file",
  "data",
  "about",
  "javascript",
  "blob",
]);

/**
 * One `desktop.app.bridgeOrigins` entry in the form the webview backend keeps
 * (`laufey-launch.json` `"bridgeOrigins"`): `"*"` (every document), `"<scheme>://*"` (every origin
 * of a scheme), or an origin `"<scheme>://<host>[:<port>]"` (nothing after the host and port but an
 * optional `/`), serialized as a browser serializes it — lowercase, a scheme's default port left
 * out. `null` for anything else (a path, a query, credentials, an opaque-origin scheme).
 *
 * @param entry The configured entry.
 * @returns The normalized entry, or `null` when it is not one.
 */
export function normalizeDesktopBridgeOrigin(entry: string): string | null {
  if (entry === "*") return "*";
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(entry);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (OPAQUE_SCHEMES.has(scheme)) return null;
  const rest = m[2].endsWith("/") ? m[2].slice(0, -1) : m[2];
  if (rest === "*") return `${scheme}://*`;
  const hp = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~-]+)(?::(\d{1,5}))?$/.exec(rest);
  if (!hp) return null;
  const port = hp[2] === undefined ? undefined : Number(hp[2]);
  if (port !== undefined && port > 65535) return null;
  const host = hp[1].toLowerCase();
  return port === undefined || port === DEFAULT_PORTS[scheme]
    ? `${scheme}://${host}`
    : `${scheme}://${host}:${port}`;
}
