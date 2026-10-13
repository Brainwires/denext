// Regenerate `src/build/desktop-runtime-pin.json` — the pinned denext Deno Desktop runtime (the
// prebuilt `libdenort` + laufey backend hosts from https://github.com/Brainwires/deno releases)
// that `denext desktop` and the scaffolded `scripts/package-*.ts` download, verify and hand to the
// stock `deno desktop` CLI (see `src/build/desktop-runtime.ts`) — and, from a release that ships
// the fork's own `deno` CLI (`deno-cli-<version>-<target>.zip`, the manifest's `cli` section,
// 2.9.7-denext.15 on), `src/build/deno-toolchain-pin.json`: denext's Deno toolchain (see
// `src/build/deno-toolchain.ts`). Both pins always come from the same release.
//
//   deno task desktop:pin-runtime <tag>        # e.g. denext-runtime-v2.9.7-denext.1
//   deno task desktop:pin-runtime <tag> --manifest <manifest.json> --sums <SHA256SUMS> \
//     [--archives <dir>]                         # local files (the archives too, by file name)
//
// Reads the release's `manifest.json` and `SHA256SUMS` and checks EVERY archive against both: the
// manifest's sha256 must equal the SHA256SUMS line for the same file, every SHA256SUMS archive must
// be in the manifest, and each URL must be this tag's release download URL for that file. Then
// every archive is fetched (or read from `--archives <dir>`), hashed against the pin, and its
// build provenance checked with `gh attestation verify` under the same constraints a packager's
// DENEXT_DESKTOP_RUNTIME_ATTEST=1 applies (the release workflow, this tag) — nothing is written
// unless all of them pass. The CLI archives get the same checks (manifest = SHA256SUMS, this tag's
// URL, every SHA256SUMS `deno-cli-*` archive listed, the hash and the attestation). A release with
// no `cli` section leaves the toolchain pin as it is. The output is deterministic; commit both.
//
// From 2.9.7-denext.17 each CLI zip also carries `esbuild[.exe]` (+ `esbuild.LICENSE`) and the
// manifest's `cli` target entry an `esbuild: { version, sha256 }`; it is pinned beside the archive
// (it must be the esbuild denext's vendored API speaks, src/build/esbuild/version.ts), and the
// attestation pass extracts it from each archive and checks that SHA-256 too. Before denext.17 the
// field is absent and denext's builds use the npm esbuild.

import { encodeHex } from "@std/encoding/hex";
import { fromFileUrl, join } from "@std/path";
import { runtimeAttestationArgs } from "../src/build/desktop-runtime.ts";
import { ESBUILD_VERSION } from "../src/build/esbuild/version.ts";
import { extractArchive } from "../src/build/safe-extract.ts";

const REPO = "Brainwires/deno";
const OUT = fromFileUrl(new URL("../src/build/desktop-runtime-pin.json", import.meta.url));
const TOOLCHAIN_OUT = fromFileUrl(
  new URL("../src/build/deno-toolchain-pin.json", import.meta.url),
);
/** The release's Rust target triple → the toolchain pin's `<os>-<arch>` key (`Deno.build`). */
const TOOLCHAIN_TARGETS: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin": "darwin-aarch64",
  "x86_64-apple-darwin": "darwin-x86_64",
  "aarch64-unknown-linux-gnu": "linux-aarch64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
  "x86_64-pc-windows-msvc": "windows-x86_64",
};
/** A CLI archive's name prefix (the rest is `<version>-<target>.zip`). */
const CLI_PREFIX = "deno-cli-";
const BACKENDS = ["webview", "cef"] as const;

/** One archive in the pin. */
interface PinArtifact {
  file: string;
  url: string;
  sha256: string;
  size: number;
  format: "tar.gz" | "zip";
}

/** The pin file's shape (mirrors `DesktopRuntimePin` in src/build/desktop-runtime.ts). */
export interface PinFile {
  schema: 1;
  version: string;
  tag: string;
  repository: string;
  deno: string;
  denoSha: string;
  laufeySha: string;
  laufeyApiVersion: number | null;
  targets: Record<string, { runtimeLib: string } & Partial<Record<"webview" | "cef", PinArtifact>>>;
}

/** The esbuild a CLI zip carries (mirrors `DenoToolchainEsbuild`). */
interface PinEsbuild {
  version: string;
  sha256: string;
}

/** One CLI archive in the toolchain pin. */
type CliPinArtifact = PinArtifact & { format: "zip"; esbuild?: PinEsbuild };

/** The toolchain pin's shape (mirrors `DenoToolchainPin` in src/build/deno-toolchain.ts). */
export interface ToolchainPinFile {
  schema: 1;
  version: string;
  tag: string;
  repository: string;
  deno: string;
  targets: Record<string, CliPinArtifact>;
}

/** Parse GNU `sha256sum` output into file → digest. */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** Untyped JSON from the release (validated field by field below). */
// deno-lint-ignore no-explicit-any
type Loose = any;

function fail(message: string): never {
  throw new Error(`desktop:pin-runtime: ${message}`);
}

/** The manifest's version + Deno version, after checking it is this tag's runtime manifest. */
function checkManifest(tag: string, m: Loose): { version: string; deno: string } {
  if (m?.schema !== 1 || m?.name !== "deno-desktop-runtime") {
    fail("not a schema-1 runtime manifest");
  }
  if (m.tag !== tag) fail(`manifest is for tag ${m.tag}, not ${tag}`);
  const version = String(m.version ?? "");
  if (`denext-runtime-v${version}` !== tag) fail(`tag ${tag} does not match version ${version}`);
  const deno = String(m.deno?.version ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(deno) || !version.startsWith(`${deno}-denext.`)) {
    fail(`bad deno version ${JSON.stringify(deno)} for runtime ${version}`);
  }
  return { version, deno };
}

/** What every archive check needs: the tag, the version and the SHA256SUMS lines. */
type ReleaseCtx = { tag: string; version: string; sums: Map<string, string> };

/**
 * One release archive entry, checked against its expected name, format, URL, SHA256SUMS line and
 * size (`where` names it in an error).
 */
function checkedArtifact<F extends PinArtifact["format"]>(
  ctx: ReleaseCtx,
  where: string,
  file: string,
  format: F,
  a: Loose,
): PinArtifact & { format: F } {
  if (a?.file !== file) fail(`${where}: file ${a?.file}, expected ${file}`);
  if (a.format !== format) fail(`${where}: format ${a.format}, expected ${format}`);
  const url = `https://github.com/${REPO}/releases/download/${ctx.tag}/${file}`;
  if (a.url !== url) fail(`${where}: url ${a.url}, expected ${url}`);
  const size = Number(a.size);
  if (!Number.isSafeInteger(size) || size <= 0) fail(`${file}: bad size ${a.size}`);
  return { file, url, sha256: listedSha256(ctx, file, a.sha256), size, format };
}

/** The manifest's sha256 for `file`, after checking it is the SHA256SUMS line for it. */
function listedSha256(ctx: ReleaseCtx, file: string, raw: unknown): string {
  const sha256 = String(raw ?? "");
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`${file}: bad sha256`);
  const listed = ctx.sums.get(file);
  if (listed === undefined) fail(`${file} is not in SHA256SUMS`);
  if (listed !== sha256) fail(`${file}: manifest sha256 ${sha256} != SHA256SUMS ${listed}`);
  return sha256;
}

/** One runtime archive entry (a target's backend), checked by {@linkcode checkedArtifact}. */
function pinArtifact(ctx: ReleaseCtx, target: string, backend: string, a: Loose): PinArtifact {
  const format = target.includes("windows") ? "zip" : "tar.gz";
  const file = `deno-desktop-runtime-${ctx.version}-${target}-${backend}.${format}`;
  return checkedArtifact(ctx, `${target}/${backend}`, file, format, a);
}

const RUNTIME_LIBS = ["libdenort.dylib", "libdenort.so", "denort.dll"];

/** One target's entry (its runtime lib + each backend's archive). */
function pinTarget(
  ctx: ReleaseCtx,
  target: string,
  e: Loose,
): PinFile["targets"][string] {
  const runtimeLib = String(e.runtimeLib ?? "");
  if (!RUNTIME_LIBS.includes(runtimeLib)) {
    fail(`${target}: unexpected runtimeLib ${JSON.stringify(runtimeLib)}`);
  }
  const out: PinFile["targets"][string] = { runtimeLib };
  for (const backend of BACKENDS) {
    if (e[backend]) out[backend] = pinArtifact(ctx, target, backend, e[backend]);
  }
  return out;
}

/**
 * Build the pin from a release's `manifest.json` (parsed) and `SHA256SUMS` text, cross-checking
 * every archive. Throws on any inconsistency.
 *
 * @param tag The release tag (`denext-runtime-v<deno>-denext.<n>`).
 * @param manifest The parsed manifest.json.
 * @param sumsText The SHA256SUMS text.
 * @returns The pin.
 */
export function pinFromRelease(tag: string, manifest: unknown, sumsText: string): PinFile {
  const m = manifest as Loose;
  const { version, deno } = checkManifest(tag, m);
  const ctx = { tag, version, sums: parseSha256Sums(sumsText) };
  const targets: PinFile["targets"] = {};
  for (const target of Object.keys(m.targets ?? {}).sort()) {
    targets[target] = pinTarget(ctx, target, m.targets[target]);
  }
  const pinned = new Set(
    Object.values(targets).flatMap((t) => BACKENDS.flatMap((b) => t[b] ? [t[b]!.file] : [])),
  );
  if (pinned.size === 0) fail("the manifest lists no archives");
  for (const file of ctx.sums.keys()) {
    // The CLI archives are toolchainPinFromRelease's to check.
    if (file.startsWith(CLI_PREFIX)) continue;
    if (/\.(tar\.gz|zip)$/.test(file) && !pinned.has(file)) fail(`${file} is in SHA256SUMS only`);
  }
  return {
    schema: 1,
    version,
    tag,
    repository: `https://github.com/${REPO}`,
    deno,
    denoSha: String(m.deno?.sha ?? ""),
    laufeySha: String(m.laufey?.sha ?? ""),
    laufeyApiVersion: typeof m.laufey?.apiVersion === "number" ? m.laufey.apiVersion : null,
    targets,
  };
}

/** One CLI archive entry, checked like {@linkcode pinArtifact} (a zip on every target). */
function cliArtifact(ctx: ReleaseCtx, target: string, a: Loose): CliPinArtifact {
  const where = `cli ${target}`;
  const binary = target.includes("windows") ? "deno.exe" : "deno";
  if (a?.binary !== undefined && a.binary !== binary) {
    fail(`${where}: binary ${a.binary}, expected ${binary}`);
  }
  const artifact = checkedArtifact(
    ctx,
    where,
    `${CLI_PREFIX}${ctx.version}-${target}.zip`,
    "zip",
    a,
  );
  const esbuild = cliEsbuild(where, a.esbuild);
  return esbuild ? { ...artifact, esbuild } : artifact;
}

/** A CLI entry's `esbuild` (absent before denext.17), checked against denext's esbuild version. */
function cliEsbuild(where: string, e: Loose): PinEsbuild | undefined {
  if (e === undefined || e === null) return undefined;
  const version = String(e.version ?? "");
  const sha256 = String(e.sha256 ?? "");
  if (version !== ESBUILD_VERSION) {
    fail(`${where}: esbuild ${version}, but denext's esbuild API speaks ${ESBUILD_VERSION}`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`${where}: bad esbuild sha256`);
  return { version, sha256 };
}

/**
 * Build the toolchain pin (`deno-toolchain-pin.json`) from the same release's manifest `cli`
 * section, cross-checking every CLI archive against SHA256SUMS. A release without a `cli`
 * section (before 2.9.7-denext.15) gives `null`. Throws on any inconsistency.
 *
 * @param tag The release tag.
 * @param manifest The parsed manifest.json.
 * @param sumsText The SHA256SUMS text.
 * @returns The toolchain pin, or `null`.
 */
export function toolchainPinFromRelease(
  tag: string,
  manifest: unknown,
  sumsText: string,
): ToolchainPinFile | null {
  const m = manifest as Loose;
  const { version, deno } = checkManifest(tag, m);
  const sums = parseSha256Sums(sumsText);
  const listedCli = [...sums.keys()].filter((f) => f.startsWith(CLI_PREFIX));
  if (m.cli === undefined || m.cli === null) {
    if (listedCli.length > 0) fail(`${listedCli[0]} is in SHA256SUMS only`);
    return null;
  }
  if (m.cli.version !== version) fail(`cli version ${m.cli.version}, expected ${version}`);
  const ctx = { tag, version, sums };
  const targets: ToolchainPinFile["targets"] = {};
  for (const triple of Object.keys(m.cli.targets ?? {}).sort()) {
    const key = TOOLCHAIN_TARGETS[triple];
    if (!key) fail(`cli: unknown target ${triple}`);
    targets[key] = cliArtifact(ctx, triple, m.cli.targets[triple]);
  }
  if (Object.keys(targets).length === 0) fail("the manifest's cli section lists no archives");
  const pinned = new Set(Object.values(targets).map((a) => a.file));
  for (const file of listedCli) {
    if (!pinned.has(file)) fail(`${file} is in SHA256SUMS only`);
  }
  const sorted = Object.fromEntries(Object.entries(targets).sort(([a], [b]) => a < b ? -1 : 1));
  return {
    schema: 1,
    version,
    tag,
    repository: `https://github.com/${REPO}`,
    deno,
    targets: sorted,
  };
}

/** How {@linkcode attestPin} reaches the archives and `gh` (tests pass fakes). */
export interface AttestPinOptions {
  /** A directory holding the archives already (by file name); else each is downloaded. */
  readonly archives?: string;
  /** Download (default `fetch`). */
  readonly fetch?: typeof fetch;
  /** Run `gh` with these args, resolving its exit code (default: a real `gh`, output inherited). */
  readonly run?: GhRun;
  /** The same release's toolchain pin: its CLI archives are checked too. */
  readonly cli?: ToolchainPinFile | null;
}

/** Run `gh` with `args`, resolving its exit code. */
type GhRun = (args: string[]) => Promise<number>;

const runGh: GhRun = async (args) =>
  (await new Deno.Command("gh", { args, stdout: "inherit", stderr: "inherit" }).output()).code;

/** SHA-256 of a file, hex. */
async function sha256File(path: string): Promise<string> {
  return encodeHex(await crypto.subtle.digest("SHA-256", await Deno.readFile(path)));
}

/** The pin's archives, in target then backend order (then the CLI archives, when given). */
function pinArchives(
  pin: PinFile,
  cli?: ToolchainPinFile | null,
): (PinArtifact & { esbuild?: PinEsbuild })[] {
  return [
    ...Object.values(pin.targets).flatMap((t) => BACKENDS.flatMap((b) => t[b] ? [t[b]!] : [])),
    ...Object.values(cli?.targets ?? {}),
  ];
}

/** The archive's local path: from `--archives`, else downloaded into `tmp`. */
async function archiveFile(
  a: PinArtifact,
  tmp: string,
  options: AttestPinOptions,
): Promise<string> {
  if (options.archives) return join(options.archives, a.file);
  const res = await (options.fetch ?? fetch)(a.url);
  if (!res.ok || !res.body) fail(`GET ${a.url}: ${res.status}`);
  const path = join(tmp, a.file);
  await Deno.writeFile(path, res.body);
  return path;
}

/** The esbuild inside a CLI zip must hash to its pinned SHA-256 (checked in a temp dir). */
async function checkZipEsbuild(
  a: PinArtifact & { esbuild?: PinEsbuild },
  path: string,
  tmp: string,
): Promise<void> {
  if (!a.esbuild) return;
  const out = await Deno.makeTempDir({ dir: tmp, prefix: "x-" });
  try {
    const dest = join(out, "x");
    const result = await extractArchive(path, "zip", dest);
    const exe = a.file.includes("windows") ? "esbuild.exe" : "esbuild";
    const got = result.files[exe]?.sha256;
    if (!got) fail(`${a.file}: the manifest pins an esbuild, the archive has no top-level ${exe}`);
    if (got !== a.esbuild.sha256) {
      fail(`${a.file}: esbuild sha256 ${got} != pinned ${a.esbuild.sha256}`);
    }
  } finally {
    await Deno.remove(out, { recursive: true }).catch(() => {});
  }
}

/** Hash one archive against the pin and `gh attestation verify` it; throws on a failure. */
async function attestArchive(pin: PinFile, a: PinArtifact, path: string, run: GhRun) {
  const got = await sha256File(path);
  if (got !== a.sha256) fail(`${a.file}: sha256 ${got} != pinned ${a.sha256}`);
  const code = await run(runtimeAttestationArgs(path, pin.repository, pin.tag)).catch(() =>
    fail("the attestation check needs the GitHub CLI (gh)")
  );
  if (code !== 0) fail(`${a.file}: gh attestation verify failed (wrong workflow or tag?)`);
}

/**
 * Cross-check every archive of `pin` before it is written: its bytes hash to the pinned SHA-256,
 * and `gh attestation verify` accepts it as built by the runtime repository's release workflow
 * from the pinned tag ({@linkcode runtimeAttestationArgs}). Throws on the first failure.
 *
 * @param pin The pin built from the release.
 * @param options Where the archives are, and the fetch / gh runners.
 */
export async function attestPin(pin: PinFile, options: AttestPinOptions = {}): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "denext-pin-attest-" });
  try {
    for (const a of pinArchives(pin, options.cli)) {
      const path = await archiveFile(a, tmp, options);
      await attestArchive(pin, a, path, options.run ?? runGh);
      await checkZipEsbuild(a, path, tmp);
      if (!options.archives) await Deno.remove(path);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) fail(`GET ${url}: ${res.status} ${res.statusText}`);
  return await res.text();
}

/**
 * The CLI: fetch (or read, with `--manifest` / `--sums`) the release's files, build the pins and
 * write them to `out` (the runtime) and `toolchainOut` (the Deno toolchain, when the release ships
 * CLI archives).
 *
 * @param args The command line (`<tag> [--manifest <file> --sums <file>] [--archives <dir>]`).
 * @param out Where the runtime pin is written (default: `src/build/desktop-runtime-pin.json`).
 * @param attest The archive cross-check run before writing (default {@linkcode attestPin}).
 * @param toolchainOut Where the toolchain pin is written (default:
 *   `src/build/deno-toolchain-pin.json`).
 */
export async function main(
  args: string[],
  out: string = OUT,
  attest: (pin: PinFile, options: AttestPinOptions) => Promise<void> = attestPin,
  toolchainOut: string = TOOLCHAIN_OUT,
): Promise<void> {
  const tag = args[0];
  if (!tag || tag.startsWith("-")) {
    fail(
      "usage: deno task desktop:pin-runtime <tag> [--manifest <file> --sums <file>] " +
        "[--archives <dir>]",
    );
  }
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const manifestText = flag("--manifest")
    ? await Deno.readTextFile(flag("--manifest")!)
    : await fetchText(`${base}/manifest.json`);
  const sumsText = flag("--sums")
    ? await Deno.readTextFile(flag("--sums")!)
    : await fetchText(`${base}/SHA256SUMS`);
  const manifest = JSON.parse(manifestText);
  const pin = pinFromRelease(tag, manifest, sumsText);
  const cli = toolchainPinFromRelease(tag, manifest, sumsText);
  await attest(pin, { archives: flag("--archives"), cli });
  await Deno.writeTextFile(out, JSON.stringify(pin, null, 2) + "\n");
  if (cli) {
    await Deno.writeTextFile(toolchainOut, JSON.stringify(cli, null, 2) + "\n");
    console.log(
      `wrote ${toolchainOut}: deno toolchain ${cli.version}, ` +
        `${Object.keys(cli.targets).length} CLI archives`,
    );
  }
  const count = Object.values(pin.targets).reduce(
    (n, t) => n + BACKENDS.filter((b) => t[b]).length,
    0,
  );
  console.log(`wrote ${out}: runtime ${pin.version} (deno ${pin.deno}), ${count} archives`);
}

if (import.meta.main) await main(Deno.args);
