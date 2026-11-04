// What the generated deploy files need when the server serves HTTPS itself (`start.tls`, see
// src/server/tls-certificates.ts): the environment variables naming each certificate's and key's
// PEM file (passed through as placeholders, never values), the files readable by the server, the
// unstable net APIs for several certificates, and a health probe over `https:`.
//
// The Docker generator and `denext ui` run no project code, so `start.tls` is read as
// `start.limits` is (src/build/resource-limits.ts): from the deploy manifest the last `denext
// build` wrote (the evaluated config), else from the config file's text (literal values only).
// The deploy presets read the manifest they are handed.
//
// Several certificates need `--unstable-net`. `deno run` honours `"unstable": ["net"]` from the
// project's deno.json for a local or `jsr:` CLI module, which is how the Docker image's `CMD` and
// the systemd unit's `ExecStart` run the start task (from the project directory), so those files
// carry no flag and the generators warn when deno.json lacks it. `deno compile` runs with a config
// of its own (src/build/compile-app.ts), which carries no `unstable`, so a compile bakes
// `--unstable-net` itself ({@linkcode tlsCompileFlags}).
//
// Build-time only; never imported by a shipped bundle.

import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";
import type { DeployServerTls, DeployTlsCertificate } from "../deploy/manifest.ts";
import type { StartTls } from "../server/config.ts";
import { CONFIG_FILES } from "./config-files.ts";
import { objectBody, withoutComments } from "./resource-limits.ts";

/** Where the Docker image reads certificate files from: `./certs` is mounted there read-only. */
export const TLS_CERT_DIR = "/certs";

/**
 * The deploy manifest's `server.tls` for a config's `start.tls`.
 *
 * @param tls The config's `start.tls`.
 * @returns The certificates, or `null` for plain HTTP.
 */
export function deployTls(tls: StartTls | undefined): DeployServerTls | null {
  if (!tls || tls.certificates.length === 0) return null;
  return {
    certificates: tls.certificates.map((c) => ({
      hostnames: [...c.hostnames],
      certFileEnv: c.certFileEnv,
      keyFileEnv: c.keyFileEnv,
    })),
  };
}

/** Every quoted string in `text`, in order. */
function quoted(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|`([^`$]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** A quoted string after `key:` in `body`, if there is one. */
function stringAt(body: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`$]*)\`)`).exec(body);
  return m ? m[1] ?? m[2] ?? m[3] : undefined;
}

/** The body of the literal opening right after the match of `pattern` in `text`, if any. */
function bodyAfter(text: string, pattern: RegExp, close = "}"): string | undefined {
  const m = pattern.exec(text);
  return m ? objectBody(text, m.index + m[0].length - 1, close) : undefined;
}

/** One `{ hostnames, certFileEnv, keyFileEnv }` object's literal values, if both names are set. */
function certificateOf(body: string): DeployTlsCertificate | undefined {
  const certFileEnv = stringAt(body, "certFileEnv");
  const keyFileEnv = stringAt(body, "keyFileEnv");
  if (certFileEnv === undefined || keyFileEnv === undefined) return undefined;
  const hosts = bodyAfter(body, /\bhostnames\s*:\s*\[/, "]");
  return { hostnames: hosts === undefined ? [] : quoted(hosts), certFileEnv, keyFileEnv };
}

/**
 * The `start.tls` a config file's text sets with literal values (comments ignored), or `null`:
 * each certificate object whose `certFileEnv` and `keyFileEnv` are string literals. What
 * {@linkcode configuredTls} reads before a first build; a computed value needs a build.
 *
 * @param text The config file's text.
 * @returns The certificates, or `null`.
 */
export function configTextTls(text: string): DeployServerTls | null {
  const clean = withoutComments(text);
  const start = bodyAfter(clean, /\bstart\s*:\s*\{/);
  const tls = start === undefined ? undefined : bodyAfter(start, /\btls\s*:\s*\{/);
  const list = tls === undefined ? undefined : bodyAfter(tls, /\bcertificates\s*:\s*\[/, "]");
  if (list === undefined) return null;
  const certificates: DeployTlsCertificate[] = [];
  for (let i = list.indexOf("{"); i !== -1; i = list.indexOf("{", i + 1)) {
    const body = objectBody(list, i);
    const cert = certificateOf(body);
    if (cert) certificates.push(cert);
    i += body.length + 1;
  }
  return certificates.length ? { certificates } : null;
}

/** The manifest's `server.tls` from the last `denext build` in `dir` (`undefined`: none / older). */
async function builtTls(dir: string): Promise<DeployServerTls | null | undefined> {
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, ".denext", "deploy-manifest.json")),
    ) as { server?: { tls?: unknown } };
    const value = manifest.server?.tls;
    if (value === null) return null;
    const list = (value as { certificates?: unknown } | undefined)?.certificates;
    return Array.isArray(list) ? value as DeployServerTls : undefined;
  } catch {
    return undefined; // no build yet, or one from before the field
  }
}

/**
 * The `start.tls` the project in `dir` configures: what the last `denext build` recorded in its
 * deploy manifest (the evaluated config); before any build, the literal values in the config
 * file's text. The config is never imported here.
 *
 * @param dir The project directory.
 * @returns The certificates, or `null` for plain HTTP.
 */
export async function configuredTls(dir: string): Promise<DeployServerTls | null> {
  const built = await builtTls(dir);
  if (built !== undefined) return built;
  for (const name of CONFIG_FILES) {
    try {
      const tls = configTextTls(await Deno.readTextFile(join(dir, name)));
      if (tls) return tls;
    } catch { /* absent or unreadable */ }
  }
  return null;
}

/**
 * The environment variables `start.tls` reads, each once: a certificate's, then its key's.
 *
 * @param tls The certificates.
 * @returns The variable names, in config order.
 */
export function tlsEnvNames(tls: DeployServerTls): string[] {
  return [...new Set(tls.certificates.flatMap((c) => [c.certFileEnv, c.keyFileEnv]))];
}

/**
 * Whether a handshake for `localhost` (a health probe's) gets a certificate: one certificate is
 * served for every name; with several, one must list `"localhost"` or `"*"`.
 *
 * @param tls The certificates.
 * @returns Whether the probe's handshake succeeds.
 */
export function tlsServesLocalhost(tls: DeployServerTls): boolean {
  return tls.certificates.length === 1 ||
    tls.certificates.some((c) => c.hostnames.some((h) => h === "*" || h === "localhost"));
}

/**
 * The health probe's `deno eval` arguments over `https:` (after `deno`): `localhost`, whose
 * certificate is not checked (the probe asks whether the server answers, not who it is).
 *
 * @param port The port the server listens on.
 * @param path The path probed.
 * @returns `["eval", "--unsafely-ignore-certificate-errors=localhost", "<code>"]`.
 */
export function tlsProbeArgs(port: number, path: string): string[] {
  return [
    "eval",
    "--unsafely-ignore-certificate-errors=localhost",
    `fetch('https://localhost:${port}${path}').then((r)=>Deno.exit(r.ok?0:1)).catch(()=>Deno.exit(1))`,
  ];
}

/**
 * Whether the project's deno.json(c) turns the unstable net APIs on (`"unstable": ["net"]`).
 *
 * @param dir The project directory.
 * @returns Whether it does.
 */
export async function projectUnstableNet(dir: string): Promise<boolean> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      const parsed = parseJsonc(await Deno.readTextFile(join(dir, name))) as {
        unstable?: unknown;
      };
      return Array.isArray(parsed?.unstable) && parsed.unstable.includes("net");
    } catch { /* absent or unparsable */ }
  }
  return false;
}

/**
 * What a generated deploy file should warn about `start.tls`: several certificates without
 * `"unstable": ["net"]` in deno.json (the server would refuse to start).
 *
 * @param tls The certificates (`null`: none).
 * @param unstableNet Whether the project's deno.json turns the unstable net APIs on.
 * @param where The generator, for the message.
 * @returns The warnings.
 */
export function tlsUnstableNetWarnings(
  tls: DeployServerTls | null | undefined,
  unstableNet: boolean,
  where: string,
): string[] {
  if (!tls || tls.certificates.length < 2 || unstableNet) return [];
  return [
    `${where}: start.tls lists ${tls.certificates.length} certificates, which needs the unstable ` +
    `net APIs: add "unstable": ["net"] to deno.json (the server refuses to start without them)`,
  ];
}

/**
 * The flags a `build --compile` executable gets for `start.tls`: `--unstable-net` for several
 * certificates. The compile runs with a config of its own, which carries no `unstable` from the
 * project's deno.json, so it is passed here.
 *
 * @param tls The config's `start.tls`.
 * @returns The flags.
 */
export function tlsCompileFlags(tls: StartTls | undefined): string[] {
  return (tls?.certificates.length ?? 0) > 1 ? ["--unstable-net"] : [];
}

/**
 * A start command's words with `dir` added to a scoped `--allow-read=…` (an unscoped one already
 * reads it), so the server can read the certificate files mounted there.
 *
 * @param words The command.
 * @param dir The directory the certificate files are in.
 * @returns The command, changed or not.
 */
export function withCertificateReads(words: readonly string[], dir: string): readonly string[] {
  return words.map((w) =>
    w.startsWith("--allow-read=") && !w.slice("--allow-read=".length).split(",").includes(dir)
      ? `${w},${dir}`
      : w
  );
}
