// Which esbuild executable denext's vendored esbuild API (./mod.ts) spawns. In order:
//
//   1. `ESBUILD_BINARY_PATH` when set — esbuild's own override, used as given (the version
//      handshake still refuses a binary that is not ESBUILD_VERSION);
//   2. the esbuild that denext's Deno toolchain ships beside its `deno` (2.9.7-denext.17 on):
//      extracted from the verified toolchain zip, checked against the pin's SHA-256 and recorded in
//      the toolchain stamp by `ensureDenoToolchain` — see `toolchainEsbuild` in ../deno-toolchain.ts.
//      A toolchain that is installed but whose esbuild was refused (a SHA-256 or version mismatch)
//      falls through to 3 with ONE warning per process;
//   3. the official `@esbuild/<platform>` npm package's binary, as stock Deno's npm resolution got
//      it before: taken from denext's own cache, else from Deno's npm cache, else downloaded from
//      the registry (`NPM_CONFIG_REGISTRY`, default registry.npmjs.org). The tarball is checked
//      against its pinned npm `integrity` (SHA-512) and the binary against its pinned SHA-256
//      before it is made executable; nothing unverified ever runs. This is the path for
//      `DENEXT_DENO=stock`, plain stock Deno, and every toolchain before denext.17.

import { join } from "@std/path";
import { encodeBase64 } from "@std/encoding/base64";
import { denoCacheDir, renameRetrying } from "../desktop-runtime.ts";
import { denoToolchainTarget, toolchainEsbuild } from "../deno-toolchain.ts";
import type { DenoToolchainPin } from "../deno-toolchain.ts";
import { acquireCacheLock } from "../project-locks.ts";
import { extractArchive } from "../safe-extract.ts";
import { readJsonFile, sha256File, sweepLeftovers } from "../verified-download.ts";
import { ESBUILD_VERSION } from "./version.ts";

/** esbuild's own override: the binary to run, unverified. */
export const ESBUILD_BINARY_PATH_ENV = "ESBUILD_BINARY_PATH";

/** One pinned `@esbuild/<platform>` npm package. */
export interface EsbuildNpmArtifact {
  /** The npm package (`@esbuild/darwin-arm64`). */
  readonly pkg: string;
  /** The binary's path inside the package (`bin/esbuild`, `esbuild.exe`). */
  readonly binary: string;
  /** The tarball's npm `integrity` (SRI, SHA-512). */
  readonly integrity: string;
  /** Lowercase hex SHA-256 of the binary. */
  readonly sha256: string;
  /** The binary's size in bytes. */
  readonly size: number;
}

/**
 * The official esbuild {@linkcode ESBUILD_VERSION} binaries, per toolchain target (`Deno.build`'s
 * `<os>-<arch>`). Integrity values are the registry's; the SHA-256s are of the binaries inside.
 */
const ESBUILD_NPM: Readonly<Record<string, EsbuildNpmArtifact>> = {
  "darwin-aarch64": {
    pkg: "@esbuild/darwin-arm64",
    binary: "bin/esbuild",
    integrity:
      "sha512-GtaBgammVvdF7aPIgH2jxMDdivezgFu6iKpmT+48+F8Hhg5J/sfnDieg0aeG/jfSvkYQU2/pceFPDKlqZzwnfQ==",
    sha256: "58d144357454bca840167171380785b133b1e5e682d0c51afa8c80158bfd3f8a",
    size: 9833874,
  },
  "darwin-x86_64": {
    pkg: "@esbuild/darwin-x64",
    binary: "bin/esbuild",
    integrity:
      "sha512-1iT4FVL0dJ76/q1wd7XDsXrSW+oLoquptvh4CLR4kITDtqi2e/xwXwdCVH8hVHU43wgJdsq7Gxuzcs6Iq/7bxQ==",
    sha256: "e7b2a105f88836f1e080a76180e5cd8e59d1c22f6575d63f5a77a104954c427e",
    size: 10515136,
  },
  "linux-aarch64": {
    pkg: "@esbuild/linux-arm64",
    binary: "bin/esbuild",
    integrity:
      "sha512-Z9kfb1v6ZlGbWj8EJk9T6czVEjjq2ntSYLY2cw6pAZl4oKtfgQuS4HOq41M/BcoLPzrUbNd+R4BXFyH//nHxVg==",
    sha256: "d6d656d9326ce1c55c01f73604a3cffda35c63cce60016e9ed795ac91cd1e67d",
    size: 9633944,
  },
  "linux-x86_64": {
    pkg: "@esbuild/linux-x64",
    binary: "bin/esbuild",
    integrity:
      "sha512-uhj8N2obKTE6pSZ+aMUbqq+1nXxNjZIIjCjGLfsWvVpy7gKCOL6rsY1MhRh9zLtUtAI7vpgLMK6DxjO8Qm9lJw==",
    sha256: "3331e0b23c99d93d9a39e436a4838de40ca1c95ac3bcbd9874ba169d8545b634",
    size: 10268824,
  },
  "windows-aarch64": {
    pkg: "@esbuild/win32-arm64",
    binary: "esbuild.exe",
    integrity:
      "sha512-O2S7SNZzdcFG7eFKgvwUEZ2VG9D/sn/eIiz8XRZ1Q/DO5a3s76Xv0mdBzVM5j5R639lXQmPmSo0iRpHqUUrsxw==",
    sha256: "34dd62536675871311e6e0d2bf9917f5671f3ecee695205dc4eaf649947348e7",
    size: 9656832,
  },
  "windows-x86_64": {
    pkg: "@esbuild/win32-x64",
    binary: "esbuild.exe",
    integrity:
      "sha512-TXv6YnJ8ZMVdX+SXWVBo/0p8LTcrUYngpWjvm91TMjjBQii7Oz11Lw5lbDV5Y0TzuhSJHwiH4hEtC1I42mMS0g==",
    sha256: "889543031385fb79a28b09a5611a3a03f913beb5a608c7de29390c13f1030994",
    size: 10520064,
  },
};

/** Where an esbuild binary came from. */
export type EsbuildBinarySource = "env" | "toolchain" | "npm";

/** The esbuild binary to run. */
export interface ResolvedEsbuildBinary {
  /** Its absolute path (as given, for `ESBUILD_BINARY_PATH`). */
  readonly path: string;
  readonly source: EsbuildBinarySource;
  /** Say this once (the toolchain's esbuild was refused and the npm one runs instead). */
  readonly warning?: string;
}

/** Env reader. */
type EnvGet = (k: string) => string | undefined;
const processEnv: EnvGet = (k) => {
  try {
    return Deno.env.get(k);
  } catch {
    return undefined; // no env permission
  }
};

/** Seams for {@linkcode resolveEsbuildBinary} and {@linkcode ensureNpmEsbuild}. */
export interface ResolveEsbuildBinaryOptions {
  readonly env?: EnvGet;
  /** The toolchain pin (default: the one in force). */
  readonly pin?: DenoToolchainPin;
  /** Default {@linkcode denoToolchainTarget}. */
  readonly target?: string;
  /** The OS the binary runs on (its file name), default the host's. */
  readonly os?: string;
  /** The toolchain cache root (default `<deno cache>/denext-deno`). */
  readonly toolchainCacheRoot?: string;
  /** denext's esbuild cache root (default `<deno cache>/denext-esbuild`). */
  readonly npmCacheRoot?: string;
  /** Deno's own cache dir, searched for an npm-installed copy (default `DENO_DIR`'s). */
  readonly denoDir?: string;
  /** The npm pin table (default {@linkcode ESBUILD_NPM}). */
  readonly npm?: Readonly<Record<string, EsbuildNpmArtifact>>;
  /** Progress output (default `console.error`). */
  readonly log?: (line: string) => void;
  /** Test seam. */
  readonly fetch?: typeof fetch;
}

/**
 * Pick the esbuild binary (see the module header for the order). Never downloads unless the npm
 * fallback has nothing cached.
 *
 * @param options Seams; all default to the process.
 * @returns The binary, and a warning to print once when the toolchain's esbuild was refused.
 */
export async function resolveEsbuildBinary(
  options: ResolveEsbuildBinaryOptions = {},
): Promise<ResolvedEsbuildBinary> {
  const env = options.env ?? processEnv;
  const override = env(ESBUILD_BINARY_PATH_ENV);
  if (override) return { path: override, source: "env" };
  const tc = await toolchainEsbuild({
    env,
    pin: options.pin,
    target: options.target,
    os: options.os,
    cacheRoot: options.toolchainCacheRoot,
  });
  if (tc.state === "ok" && tc.path) return { path: tc.path, source: "toolchain" };
  const path = await ensureNpmEsbuild(options);
  if (tc.state !== "refused") return { path, source: "npm" };
  return {
    path,
    source: "npm",
    warning: `denext: ${tc.detail}; using the npm esbuild ${ESBUILD_VERSION} instead.`,
  };
}

/** What {@linkcode esbuildBinaryStatus} reports. */
export interface EsbuildBinaryStatus {
  /** Where the binary comes from on the next build. */
  readonly source: EsbuildBinarySource;
  /** The binary, when it is already in place (`null`: the npm one downloads on first use). */
  readonly path: string | null;
  /** `false` when the toolchain's esbuild was refused (the npm one runs instead). */
  readonly ok: boolean;
  /** One line for a report. */
  readonly detail: string;
}

/**
 * Which esbuild the next build spawns, without downloading anything (`denext toolchain status`).
 *
 * @param options Seams; all default to the process.
 * @returns The source, the binary when present, and a line for a report.
 */
export async function esbuildBinaryStatus(
  options: ResolveEsbuildBinaryOptions = {},
): Promise<EsbuildBinaryStatus> {
  const env = options.env ?? processEnv;
  const override = env(ESBUILD_BINARY_PATH_ENV);
  if (override) {
    return {
      source: "env",
      path: override,
      ok: true,
      detail: `${ESBUILD_BINARY_PATH_ENV}=${override} (unverified; must be esbuild ` +
        `${ESBUILD_VERSION})`,
    };
  }
  const tc = await toolchainEsbuild({
    env,
    pin: options.pin,
    target: options.target,
    os: options.os,
    cacheRoot: options.toolchainCacheRoot,
  });
  if (tc.state === "ok") {
    return {
      source: "toolchain",
      path: tc.path,
      ok: true,
      detail: `${tc.detail}, from the toolchain`,
    };
  }
  const target = options.target ?? denoToolchainTarget();
  const a = (options.npm ?? ESBUILD_NPM)[target];
  const dir = join(options.npmCacheRoot ?? esbuildNpmCacheRoot(env), ESBUILD_VERSION, target);
  const path = join(dir, (options.os ?? Deno.build.os) === "windows" ? "esbuild.exe" : "esbuild");
  const cached = a !== undefined && await cachedOk(path, dir, a);
  const npm = a
    ? `npm ${a.pkg}@${ESBUILD_VERSION} ${
      cached ? "(cached, verified)" : "(fetched on first build)"
    }`
    : `no npm esbuild is pinned for ${target}`;
  const why = tc.state === "refused" ? `${tc.detail}; ` : "";
  return {
    source: "npm",
    path: cached ? path : null,
    ok: tc.state !== "refused" && a !== undefined,
    detail: `${why}esbuild ${ESBUILD_VERSION} from ${npm}`,
  };
}

/** `<deno cache>/denext-esbuild`. */
function esbuildNpmCacheRoot(env: EnvGet = processEnv): string {
  return join(denoCacheDir(env), "denext-esbuild");
}

/** The stamp beside a verified npm binary. */
const STAMP = ".denext-esbuild.json";
const CACHE_DESCR = "esbuild cache";
/** Refuse a tarball larger than this (the real ones are ~4.5 MB). */
const MAX_TARBALL = 64 * 1024 * 1024;

interface NpmStamp {
  schema: 1;
  version: string;
  pkg: string;
  sha256: string;
  size: number;
  mtimeMs: number | null;
}

/** The pinned npm package for `target`, or why there is none. */
function npmArtifact(
  table: Readonly<Record<string, EsbuildNpmArtifact>>,
  target: string,
): EsbuildNpmArtifact {
  const a = table[target];
  if (a) return a;
  throw new Error(
    `denext: no esbuild ${ESBUILD_VERSION} binary is pinned for ${target} (pinned: ` +
      `${Object.keys(table).join(", ")}). Set ${ESBUILD_BINARY_PATH_ENV} to an esbuild ` +
      `${ESBUILD_VERSION} binary.`,
  );
}

/** Whether the cached binary at `path` is the pinned one (cheap when its stamp still holds). */
async function cachedOk(path: string, dir: string, a: EsbuildNpmArtifact): Promise<boolean> {
  const info = await Deno.stat(path).catch(() => null);
  if (!info?.isFile || info.size !== a.size) return false;
  const mtime = info.mtime?.getTime() ?? null;
  if (mtime !== null && stampVouches(await readJsonFile<NpmStamp>(join(dir, STAMP)), a, mtime)) {
    return true;
  }
  return await sha256File(path) === a.sha256;
}

/** Whether `stamp` records exactly `a`, installed with modification time `mtime`. */
function stampVouches(stamp: NpmStamp | null, a: EsbuildNpmArtifact, mtime: number): boolean {
  if (stamp?.schema !== 1 || stamp.version !== ESBUILD_VERSION) return false;
  return stamp.pkg === a.pkg && stamp.sha256 === a.sha256 && stamp.size === a.size &&
    stamp.mtimeMs === mtime;
}

/**
 * The verified npm esbuild binary for this host, in denext's cache — copied from Deno's npm cache
 * when a verified copy is there, else downloaded and verified. See the module header.
 *
 * @param options Seams.
 * @returns The binary's path.
 */
export async function ensureNpmEsbuild(options: ResolveEsbuildBinaryOptions = {}): Promise<string> {
  const env = options.env ?? processEnv;
  const target = options.target ?? denoToolchainTarget();
  const a = npmArtifact(options.npm ?? ESBUILD_NPM, target);
  const root = options.npmCacheRoot ?? esbuildNpmCacheRoot(env);
  const dir = join(root, ESBUILD_VERSION, target);
  const exe = (options.os ?? Deno.build.os) === "windows" ? "esbuild.exe" : "esbuild";
  const path = join(dir, exe);
  await Deno.mkdir(root, { recursive: true });
  {
    using _shared = await acquireCacheLock(root, "shared", CACHE_DESCR);
    if (await cachedOk(path, dir, a)) return path;
  }
  using _write = await acquireCacheLock(root, "mutate", CACHE_DESCR);
  if (await cachedOk(path, dir, a)) return path; // another process installed it meanwhile
  await Deno.mkdir(dir, { recursive: true });
  await sweepLeftovers(dir);
  const scratch = await Deno.makeTempDir({ dir, prefix: ".tmp-" });
  try {
    const found = await fromDenoNpmCache(a, options.denoDir ?? denoCacheDir(env), env) ??
      await fromRegistry(a, scratch, env, options);
    const staged = join(scratch, exe);
    await Deno.copyFile(found, staged);
    if (await sha256File(staged) !== a.sha256) {
      throw new Error(`denext: the esbuild binary changed while it was copied (${found})`);
    }
    if ((options.os ?? Deno.build.os) !== "windows") await Deno.chmod(staged, 0o755);
    await Deno.remove(join(dir, STAMP)).catch(() => {});
    await renameRetrying(staged, path);
    const info = await Deno.stat(path);
    const stamp: NpmStamp = {
      schema: 1,
      version: ESBUILD_VERSION,
      pkg: a.pkg,
      sha256: a.sha256,
      size: info.size,
      mtimeMs: info.mtime?.getTime() ?? null,
    };
    await Deno.writeTextFile(join(dir, STAMP), JSON.stringify(stamp, null, 2) + "\n");
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
  return path;
}

/** The npm registry base URL (`NPM_CONFIG_REGISTRY`, as npm and Deno read it). */
function registryBase(env: EnvGet): string {
  return (env("NPM_CONFIG_REGISTRY") || "https://registry.npmjs.org").replace(/\/+$/, "");
}

/**
 * The directory Deno's npm cache keeps a registry's packages in, as path segments under
 * `<DENO_DIR>/npm/` — Deno's own `root_url_to_safe_local_dirname`: the domain (none for an IP
 * address), `_<port>` for a non-default port, then the URL's path segments, with `/`, `\` and
 * the characters some file system bans (`<>:"|?` and the asterisk) made `_` — never `host:port`
 * itself (`:` is no file name character on Windows).
 *
 * @internal
 * @param registry The registry URL.
 * @returns The segments (`["registry.npmjs.org"]`, `["localhost_4873"]`, `["4873"]`).
 */
export function denoNpmRegistryDir(registry: string): string[] {
  const url = new URL(registry);
  const safe = (text: string) => text.replace(/[<>:"|?*/\\]/g, "_");
  const ip = /^\d+(\.\d+){3}$/.test(url.hostname) || url.hostname.startsWith("[");
  let first = ip ? "" : safe(url.hostname);
  if (url.port) first += `${first ? "_" : ""}${url.port}`;
  const rest = url.pathname.split("/").filter((s) => s !== "").map(safe);
  return [first, ...rest].filter((s) => s !== "");
}

/**
 * A verified copy of the binary in Deno's npm cache (`<DENO_DIR>/npm/<registry host>/<pkg>/<ver>/`),
 * which a stock-Deno project that ever resolved `npm:esbuild@0.25.5` already has; `null` when there
 * is none or it does not hash to the pin.
 */
async function fromDenoNpmCache(
  a: EsbuildNpmArtifact,
  denoDir: string,
  env: EnvGet,
): Promise<string | null> {
  let registry: string[];
  try {
    registry = denoNpmRegistryDir(registryBase(env));
  } catch {
    return null;
  }
  const candidate = join(
    denoDir,
    "npm",
    ...registry,
    ...a.pkg.split("/"),
    ESBUILD_VERSION,
    a.binary,
  );
  const info = await Deno.stat(candidate).catch(() => null);
  if (!info?.isFile || info.size !== a.size) return null;
  return await sha256File(candidate) === a.sha256 ? candidate : null;
}

/** Download the package tarball, check its integrity, extract it and check the binary. */
async function fromRegistry(
  a: EsbuildNpmArtifact,
  scratch: string,
  env: EnvGet,
  options: ResolveEsbuildBinaryOptions,
): Promise<string> {
  const name = a.pkg.split("/")[1];
  const url = `${registryBase(env)}/${a.pkg}/-/${name}-${ESBUILD_VERSION}.tgz`;
  (options.log ?? ((l: string) => console.error(l)))(
    `  denext: downloading esbuild ${ESBUILD_VERSION} (${a.pkg})…`,
  );
  const bytes = await downloadCapped(url, options.fetch ?? fetch);
  const got = "sha512-" + encodeBase64(await crypto.subtle.digest("SHA-512", bytes));
  if (got !== a.integrity) {
    throw new Error(
      `denext: REFUSING esbuild ${ESBUILD_VERSION} from ${url}: integrity mismatch.\n` +
        `  pinned ${a.integrity}\n  got    ${got}\n  Nothing was extracted or run.`,
    );
  }
  const tgz = join(scratch, `${name}.tgz`);
  await Deno.writeFile(tgz, bytes);
  const out = join(scratch, "x");
  const result = await extractArchive(tgz, "tar.gz", out, { maxBytes: 256 * 1024 * 1024 });
  const entry = `package/${a.binary}`;
  const file = result.files[entry];
  if (!file) throw new Error(`denext: ${url} has no ${entry}`);
  if (file.sha256 !== a.sha256) {
    throw new Error(
      `denext: REFUSING esbuild ${ESBUILD_VERSION} from ${url}: the binary's SHA-256 is ` +
        `${file.sha256}, pinned ${a.sha256}.`,
    );
  }
  return join(out, ...entry.split("/"));
}

/** GET `url` into memory, refusing more than {@linkcode MAX_TARBALL} bytes. */
async function downloadCapped(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "follow" });
  } catch (err) {
    throw new Error(
      `denext: could not download esbuild ${ESBUILD_VERSION} from ${url}: ` +
        `${err instanceof Error ? err.message : err}. Are you offline? Set ` +
        `${ESBUILD_BINARY_PATH_ENV} to an esbuild ${ESBUILD_VERSION} binary to skip the download.`,
    );
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(`denext: downloading esbuild failed: GET ${url} → ${res.status}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > MAX_TARBALL) throw new Error(`denext: refusing ${url}: larger than ${MAX_TARBALL}`);
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
