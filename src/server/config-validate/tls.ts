// `start.tls` (src/server/tls-certificates.ts): the certificates and the host names each serves,
// checked when the config loads so a typo is a config error, not a refused handshake. Import-free.

/** A host name as matched: lower case, no trailing dot. */
function normalizeHost(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

/** An environment variable's name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A host-name pattern: `"*"`, or a DNS name with an optional leading `*.` label. */
const HOST_PATTERN =
  /^(?:\*|(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/i;

/** The problem with one host name of a certificate, or null; a valid name joins `seen`. */
function hostnameProblem(host: unknown, seen: Set<string>): string | null {
  if (typeof host !== "string" || !HOST_PATTERN.test(host.replace(/\.$/, ""))) {
    return `${JSON.stringify(host)} is not a host name, a "*." wildcard or "*"`;
  }
  const name = normalizeHost(host);
  if (seen.has(name)) return `${JSON.stringify(host)} is listed by another certificate`;
  seen.add(name);
  return null;
}

/** The problems of a certificate's `hostnames`. */
function hostnamesProblems(hostnames: unknown, seen: Set<string>): string[] {
  if (!Array.isArray(hostnames) || hostnames.length === 0) {
    return ["must be a non-empty array of host names"];
  }
  return hostnames.map((host) => hostnameProblem(host, seen)).filter((p) => p !== null);
}

/** The problems of one `start.tls.certificates` entry, as `[key, message]` pairs. */
function certificateProblems(entry: unknown, where: string, seen: Set<string>): [string, string][] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [[where, "must be an object ({ hostnames, certFileEnv, keyFileEnv })"]];
  }
  const fields = entry as Record<string, unknown>;
  const out = hostnamesProblems(fields.hostnames, seen).map((m): [string, string] => [
    `${where}.hostnames`,
    m,
  ]);
  for (const key of ["certFileEnv", "keyFileEnv"] as const) {
    const value = fields[key];
    if (typeof value !== "string" || !ENV_NAME.test(value)) {
      out.push([`${where}.${key}`, "must name an environment variable that holds a file path"]);
    }
  }
  return out;
}

/**
 * What is wrong with a config's `start.tls`, as `[key, message]` pairs for the config validator
 * (none when it is unset or valid): an object whose `certificates` is a non-empty array of
 * `{ hostnames, certFileEnv, keyFileEnv }`, no host name listed twice.
 *
 * @param tls The config's `start.tls`.
 * @returns The problems.
 */
export function startTlsProblems(tls: unknown): [string, string][] {
  if (tls === undefined) return [];
  const certificates = (tls as { certificates?: unknown } | null)?.certificates;
  if (typeof tls !== "object" || tls === null || Array.isArray(tls)) {
    return [["start.tls", "must be an object ({ certificates: [...] })"]];
  }
  if (!Array.isArray(certificates) || certificates.length === 0) {
    return [["start.tls.certificates", "must be a non-empty array"]];
  }
  const seen = new Set<string>();
  return certificates.flatMap((entry, i) =>
    certificateProblems(entry, `start.tls.certificates[${i}]`, seen)
  );
}
