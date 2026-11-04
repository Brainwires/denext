// `start.tls`: HTTPS for `denext start` (and a `build --compile` server) without a proxy in front.
//
// One certificate is the plain `cert` / `key` pair every Deno takes. Several — one per host name,
// chosen by the name the client asks for in its TLS handshake (SNI) — use `resolveCertificate`,
// which denext's Deno has from runtime 3.0.0-denext.3 (Brainwires/deno DENEXT.md item 159) behind
// `--unstable-net`; on an older or stock runtime a config with several certificates is refused
// with the reason rather than served with the wrong one. The files' paths come from environment
// variables the config names, never from the config itself, so a key's location (and a key) stays
// out of the repository; the files are read once, when the server starts.

import { currentDenoIdentity, supportsResolveCertificate } from "../build/deno-version.ts";
import type { StartTls } from "./config.ts";

/** A certificate and its key, PEM. */
export interface CertifiedKeyPem {
  /** The certificate chain, PEM. */
  cert: string;
  /** The private key, PEM. */
  key: string;
}

/** What `Deno.serve` gets for TLS: a static pair, or a resolver by server name. */
export type ServeTls =
  | CertifiedKeyPem
  | { resolveCertificate: (serverName: string) => CertifiedKeyPem };

/** Where {@linkcode serveTlsOptions} reads from; every field has a default. */
export interface ServeTlsDeps {
  /** Reads an environment variable (default: `Deno.env.get`). */
  env?: (name: string) => string | undefined;
  /** Reads a file as text (default: `Deno.readTextFileSync`). */
  readFile?: (path: string) => string;
  /**
   * The running runtime's denext version (default: `Deno.build.denext`; `undefined` on stock
   * Deno).
   */
  runtime?: string | undefined;
  /** Whether the unstable net APIs are on (default: `Deno.listenDatagram` exists). */
  unstableNet?: boolean;
}

/** The certificates loaded, by the host-name pattern each serves. */
type Certificates = Map<string, CertifiedKeyPem>;

/** A host name as matched: lower case, no trailing dot. */
function normalizeHost(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

/**
 * The certificate for a server name: an exact match, else the `*.` wildcard for its parent
 * domain, else `"*"`. An empty name (no SNI) matches only `"*"`.
 *
 * @param certificates The loaded certificates by host-name pattern (lower case).
 * @param serverName The SNI name the client sent (`""` for none).
 * @returns The pair, or `undefined` when nothing matches.
 */
export function certificateFor(
  certificates: ReadonlyMap<string, CertifiedKeyPem>,
  serverName: string,
): CertifiedKeyPem | undefined {
  const name = normalizeHost(serverName);
  if (name !== "") {
    const exact = certificates.get(name);
    if (exact) return exact;
    const dot = name.indexOf(".");
    if (dot > 0) {
      const wildcard = certificates.get(`*${name.slice(dot)}`);
      if (wildcard) return wildcard;
    }
  }
  return certificates.get("*");
}

/** The PEM text of the file an environment variable points at, or a clear error. */
function readPem(
  env: (name: string) => string | undefined,
  readFile: (path: string) => string,
  where: string,
  variable: string,
): string {
  const path = env(variable);
  if (!path) {
    throw new Error(`denext start: ${where} names $${variable}, which is not set (a file path)`);
  }
  try {
    return readFile(path);
  } catch (err) {
    throw new Error(
      `denext start: ${where}: cannot read $${variable} (${path}): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Read every certificate's files, keyed by each of its host names. */
function loadCertificates(
  tls: StartTls,
  env: (name: string) => string | undefined,
  readFile: (path: string) => string,
): Certificates {
  const out: Certificates = new Map();
  tls.certificates.forEach((entry, i) => {
    const where = `start.tls.certificates[${i}]`;
    const pair = {
      cert: readPem(env, readFile, `${where}.certFileEnv`, entry.certFileEnv),
      key: readPem(env, readFile, `${where}.keyFileEnv`, entry.keyFileEnv),
    };
    for (const host of entry.hostnames) out.set(normalizeHost(host), pair);
  });
  return out;
}

/** Whether the unstable net APIs are on in this process (`--unstable-net`). */
function unstableNetOn(): boolean {
  return typeof (Deno as { listenDatagram?: unknown }).listenDatagram === "function";
}

/**
 * The TLS options `Deno.serve` gets for `start.tls`: the one certificate's `cert` / `key`, or,
 * with several, a `resolveCertificate` that picks one by the client's server name
 * ({@linkcode certificateFor}) and refuses a name none matches. Several certificates need denext's
 * Deno from runtime 3.0.0-denext.3 with the unstable net APIs on (`"unstable": ["net"]` in
 * `deno.json`); without either this throws, saying which.
 *
 * @param tls The config's `start.tls` (`undefined`: plain HTTP).
 * @param deps Where the paths, the files and the runtime come from.
 * @returns The options, or `undefined` for plain HTTP.
 */
export function serveTlsOptions(
  tls: StartTls | undefined,
  deps: ServeTlsDeps = {},
): ServeTls | undefined {
  if (!tls || tls.certificates.length === 0) return undefined;
  const env = deps.env ?? ((name: string) => Deno.env.get(name));
  const readFile = deps.readFile ?? Deno.readTextFileSync;
  const certificates = loadCertificates(tls, env, readFile);
  if (tls.certificates.length === 1) return certificates.values().next().value!;
  const runtime = "runtime" in deps ? deps.runtime : currentDenoIdentity().denext;
  if (runtime === undefined || !supportsResolveCertificate(runtime)) {
    throw new Error(
      `denext start: start.tls lists ${tls.certificates.length} certificates; a certificate per ` +
        `host name needs denext's Deno from runtime 3.0.0-denext.3, and this is ` +
        `${runtime === undefined ? "a stock Deno" : `runtime ${runtime}`}. Run it with ` +
        "`denext start` on the pinned toolchain, or list one certificate.",
    );
  }
  if (!(deps.unstableNet ?? unstableNetOn())) {
    throw new Error(
      `denext start: start.tls lists ${tls.certificates.length} certificates, which needs the ` +
        `unstable net APIs: add "unstable": ["net"] to deno.json.`,
    );
  }
  return {
    resolveCertificate(serverName: string): CertifiedKeyPem {
      const pair = certificateFor(certificates, serverName);
      if (!pair) {
        throw new Error(`no certificate in start.tls for ${JSON.stringify(serverName)}`);
      }
      return pair;
    },
  };
}
