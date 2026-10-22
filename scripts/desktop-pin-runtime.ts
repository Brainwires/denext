// Regenerate `src/build/desktop-runtime-pin.json` — the pinned denext Deno Desktop runtime (the
// prebuilt `libdenort` + laufey backend hosts from https://github.com/Brainwires/deno releases)
// that `denext desktop` and the scaffolded `scripts/package-*.ts` download, verify and hand to the
// stock `deno desktop` CLI (see `src/build/desktop-runtime.ts`) — and, from a release that ships
// the fork's own `deno` CLI (`deno-cli-<version>-<target>.zip`, the manifest's `cli` section,
// 2.9.7-denext.15 on), `src/build/deno-toolchain-pin.json`: denext's Deno toolchain (see
// `src/build/deno-toolchain.ts`). Both pins always come from the same release.
//
//   deno task desktop:pin-runtime <tag>        # e.g. denext-runtime-v3.0.0-rc.1
//
// The tag is `denext-runtime-v<version>`: the fork's own version from 3.0.0-rc.1 on (the manifest's
// `deno.version` is then the stock Deno it is built from), `<deno>-denext.N` up to 2.9.7-denext.22.
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
//
// From the first runtime with native type checking each CLI zip also carries `typescript-check/` (the native
// TypeScript compiler, `tsc[.exe]` + its `lib.*.d.ts`) and the manifest's `cli` target entry a
// `typescript_check: { version, sha256, tree_sha256 }`; it is pinned beside the archive as `tsgo: { version,
// sha256, treeSha256 }`, and the attestation pass extracts each archive and re-hashes the binary
// and the whole directory. Before that release the field is absent (the toolchain type-checks
// with its in-process TypeScript).
//
// The same zips (2.9.7-denext.22 on) carry `typescript-lsp/` too: the dated TypeScript 7.1 nightly
// `deno lsp`'s tsgo backend runs (`tsc[.exe]`, its `lib.*.d.ts`, and a `typescript.json` naming role
// `lsp` and the version). It is pinned beside the archive as `tsgoLsp: { version, sha256,
// treeSha256 }`: from the manifest's `typescript_lsp` entry when the release records one (checked
// against the archive like `typescript_check`), else recorded from the attested archive itself —
// the binary's hash must match what its `typescript.json` claims, and the directory is hashed the
// same way. denext's toolchain installs it beside `deno`, where `deno lsp` looks first.
//
// From 2.9.7-denext.20 the release also ships `deno-denort-<version>-<target>.zip` (the standalone
// runtime the fork's `deno compile` builds onto, holding `denort[.exe]`; the manifest's `denort`
// section): the toolchain pin records them under `denort`, keyed like the CLI archives, with the
// same checks (manifest = SHA256SUMS, this tag's URL, every SHA256SUMS `deno-denort-*` archive
// listed, the hash and the attestation). `denext build --compile` hands the verified copy to
// `deno compile` (src/build/compile-app.ts).

import { encodeHex } from "@std/encoding/hex";
import { fromFileUrl, join } from "@std/path";
import { runtimeAttestationArgs } from "../src/build/desktop-runtime.ts";
import { ESBUILD_VERSION } from "../src/build/esbuild/version.ts";
import { extractArchive } from "../src/build/safe-extract.ts";
import { tsgoTreeSha256 } from "../src/build/deno-toolchain.ts";
import {
  compareDenoVersions,
  denextVersionLine,
  FIRST_MARKER_RUNTIME,
  isDenextReleaseVersion,
  pinnedDenoReleaseVersion,
} from "../src/build/deno-version.ts";

const REPO = "Brainwires/deno";
const OUT = fromFileUrl(new URL("../src/build/desktop-runtime-pin.json", import.meta.url));
const TOOLCHAIN_OUT = fromFileUrl(
  new URL("../src/build/deno-toolchain-pin.json", import.meta.url),
);
/**
 * The release's Rust target triple → the toolchain pin's `<os>-<arch>` key (`Deno.build`). Windows
 * on Arm (`aarch64-pc-windows-msvc`) ships from 2.9.7-denext.21.
 */
const TOOLCHAIN_TARGETS: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin": "darwin-aarch64",
  "x86_64-apple-darwin": "darwin-x86_64",
  "aarch64-unknown-linux-gnu": "linux-aarch64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
  "x86_64-pc-windows-msvc": "windows-x86_64",
  "aarch64-pc-windows-msvc": "windows-aarch64",
};
/** A CLI archive's name prefix (the rest is `<version>-<target>.zip`). */
const CLI_PREFIX = "deno-cli-";
/** A denort archive's name prefix (the rest is `<version>-<target>.zip`). */
const DENORT_PREFIX = "deno-denort-";
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

/** The native TypeScript compiler a CLI zip carries (mirrors `DenoToolchainTsgo`). */
interface PinTsgo {
  version: string;
  sha256: string;
  treeSha256: string;
}

/** One CLI archive in the toolchain pin. */
type CliPinArtifact = PinArtifact & {
  format: "zip";
  esbuild?: PinEsbuild;
  tsgo?: PinTsgo;
  tsgoLsp?: PinTsgo;
};

/** One denort archive in the toolchain pin. */
type DenortPinArtifact = PinArtifact & { format: "zip" };

/** The toolchain pin's shape (mirrors `DenoToolchainPin` in src/build/deno-toolchain.ts). */
export interface ToolchainPinFile {
  schema: 1;
  version: string;
  tag: string;
  repository: string;
  deno: string;
  targets: Record<string, CliPinArtifact>;
  /** The `denort` archives per `<os>-<arch>` (2.9.7-denext.20 on). */
  denort?: Record<string, DenortPinArtifact>;
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

/**
 * Whether `version` is a release of denext's Deno built from stock Deno `deno`: `<deno>-denext.N`
 * (up to 2.9.7-denext.22), or the fork's own version (3.0.0-rc.1 on), which names no stock
 * release, so any `deno` goes with it. Never a CI build (`+ci.N`).
 */
function runtimeVersionOk(version: string, deno: string): boolean {
  return !version.includes("+") && isDenextReleaseVersion(version) &&
    pinnedDenoReleaseVersion(version, deno) === deno;
}

/**
 * From {@linkcode FIRST_MARKER_RUNTIME} the release's CLI carries denext's identity marker
 * (`Deno.build.denext` and the `denext <version> (Brainwires)` line of `deno --version`), which is
 * how denext tells it from upstream Deno of the same version, and the manifest's `cli.identity`
 * records it. A release that should carry it and does not is refused: pinned, denext would not
 * recognise its own toolchain.
 */
function checkCliIdentity(version: string, cli: Loose): void {
  if (compareDenoVersions(version, FIRST_MARKER_RUNTIME) < 0) return;
  const id = cli?.identity;
  if (id?.buildDenext !== version || id?.versionLine !== denextVersionLine(version)) {
    fail(
      `cli.identity is ${JSON.stringify(id ?? null)}; a ${FIRST_MARKER_RUNTIME}+ release must ` +
        `record { buildDenext: "${version}", versionLine: "${denextVersionLine(version)}" }`,
    );
  }
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
  if (!/^\d+\.\d+\.\d+$/.test(deno) || !runtimeVersionOk(version, deno)) {
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
    // The CLI and denort archives are toolchainPinFromRelease's to check.
    if (file.startsWith(CLI_PREFIX) || file.startsWith(DENORT_PREFIX)) continue;
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
  const tsgo = cliTsgo(where, a.typescript_check, "tsgo");
  const tsgoLsp = cliTsgo(where, a.typescript_lsp, "tsgoLsp");
  return {
    ...artifact,
    ...(esbuild ? { esbuild } : {}),
    ...(tsgo ? { tsgo } : {}),
    ...(tsgoLsp ? { tsgoLsp } : {}),
  };
}

/** A TypeScript 7 release (`7.0.2`) or a dated nightly (`7.1.0-dev.20261017.1`). */
const TS_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * A CLI entry's `tsgo` / `tsgoLsp` (`typescript_check` / `typescript_lsp`; absent before native
 * type checking, and `typescript_lsp` while the manifest doesn't record it), checked for shape.
 */
function cliTsgo(where: string, t: Loose, name: string): PinTsgo | undefined {
  if (t === undefined || t === null) return undefined;
  const version = String(t.version ?? "");
  const sha256 = String(t.sha256 ?? "");
  const treeSha256 = String(t.tree_sha256 ?? "");
  if (!TS_VERSION.test(version)) fail(`${where}: bad ${name} version ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`${where}: bad ${name} sha256`);
  if (!/^[0-9a-f]{64}$/.test(treeSha256)) fail(`${where}: bad ${name} tree_sha256`);
  return { version, sha256, treeSha256 };
}

/** One denort archive entry, checked like {@linkcode cliArtifact} (a zip holding `denort[.exe]`). */
function denortArtifact(ctx: ReleaseCtx, target: string, a: Loose): DenortPinArtifact {
  const where = `denort ${target}`;
  const binary = target.includes("windows") ? "denort.exe" : "denort";
  if (a?.binary !== undefined && a.binary !== binary) {
    fail(`${where}: binary ${a.binary}, expected ${binary}`);
  }
  return checkedArtifact(ctx, where, `${DENORT_PREFIX}${ctx.version}-${target}.zip`, "zip", a);
}

/**
 * A manifest section of per-target zips (`cli`, `denort`) as the pin's `<os>-<arch>` map, every
 * archive cross-checked against SHA256SUMS, and every SHA256SUMS archive named `prefix…` pinned.
 * `undefined` when the release has no such section (then SHA256SUMS may list none either).
 */
function sectionPin<A extends PinArtifact>(
  ctx: ReleaseCtx,
  name: string,
  section: Loose,
  prefix: string,
  artifact: (ctx: ReleaseCtx, triple: string, a: Loose) => A,
): Record<string, A> | undefined {
  const listed = [...ctx.sums.keys()].filter((f) => f.startsWith(prefix));
  if (section === undefined || section === null) {
    if (listed.length > 0) fail(`${listed[0]} is in SHA256SUMS only`);
    return undefined;
  }
  if (section.version !== ctx.version) {
    fail(`${name} version ${section.version}, expected ${ctx.version}`);
  }
  const out = sectionTargets(ctx, name, section.targets ?? {}, artifact);
  const pinned = new Set(Object.values(out).map((a) => a.file));
  for (const file of listed) {
    if (!pinned.has(file)) fail(`${file} is in SHA256SUMS only`);
  }
  return out;
}

/** A section's `targets`, keyed by `<os>-<arch>` in key order; at least one. */
function sectionTargets<A extends PinArtifact>(
  ctx: ReleaseCtx,
  name: string,
  targets: Loose,
  artifact: (ctx: ReleaseCtx, triple: string, a: Loose) => A,
): Record<string, A> {
  const out: Array<[string, A]> = [];
  for (const triple of Object.keys(targets).sort()) {
    const key = TOOLCHAIN_TARGETS[triple];
    if (!key) fail(`${name}: unknown target ${triple}`);
    out.push([key, artifact(ctx, triple, targets[triple])]);
  }
  if (out.length === 0) fail(`the manifest's ${name} section lists no archives`);
  return Object.fromEntries(out.sort(([a], [b]) => a < b ? -1 : 1));
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
 * section (and its `denort` section, 2.9.7-denext.20 on), cross-checking every CLI and denort
 * archive against SHA256SUMS. A release without a `cli` section (before 2.9.7-denext.15) gives
 * `null`. Throws on any inconsistency.
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
  const ctx = { tag, version, sums: parseSha256Sums(sumsText) };
  const targets = sectionPin(ctx, "cli", m.cli, CLI_PREFIX, cliArtifact);
  const denort = sectionPin(ctx, "denort", m.denort, DENORT_PREFIX, denortArtifact);
  if (!targets) {
    if (denort) fail("the manifest has a denort section but no cli section");
    return null;
  }
  checkCliIdentity(version, m.cli);
  return {
    schema: 1,
    version,
    tag,
    repository: `https://github.com/${REPO}`,
    deno,
    targets,
    ...(denort ? { denort } : {}),
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

/** The pin's archives, in target then backend order (then the CLI and denort archives, when given). */
function pinArchives(
  pin: PinFile,
  cli?: ToolchainPinFile | null,
): (PinArtifact & { esbuild?: PinEsbuild; tsgo?: PinTsgo; tsgoLsp?: PinTsgo })[] {
  return [
    ...Object.values(pin.targets).flatMap((t) => BACKENDS.flatMap((b) => t[b] ? [t[b]!] : [])),
    ...Object.values(cli?.targets ?? {}),
    ...Object.values(cli?.denort ?? {}),
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

/**
 * The `typescript-check/` and `typescript-lsp/` inside a CLI zip must hash to their pinned
 * SHA-256s (checked in a temp dir). A `typescript-lsp/` the manifest did not record is pinned
 * from the archive (`a.tsgoLsp` is set): its `typescript.json` must name role `lsp`, a version and
 * the binary's own SHA-256.
 */
async function checkZipTsgo(a: CliPinArtifact | PinArtifact, path: string, tmp: string) {
  const cli = a as CliPinArtifact;
  // A CLI zip with native type checking carries the language server too (2.9.7-denext.22 on).
  if (!a.file.startsWith(CLI_PREFIX) || (!cli.tsgo && !cli.tsgoLsp)) return;
  const out = await Deno.makeTempDir({ dir: tmp, prefix: "x-" });
  try {
    const dest = join(out, "x");
    await extractArchive(path, "zip", dest);
    const exe = a.file.includes("windows") ? "tsc.exe" : "tsc";
    if (cli.tsgo) await checkTsDir(a.file, join(dest, "typescript-check"), exe, cli.tsgo);
    const lspDir = join(dest, "typescript-lsp");
    if (cli.tsgoLsp) await checkTsDir(a.file, lspDir, exe, cli.tsgoLsp);
    else {
      const recorded = await recordTsDir(a.file, lspDir, exe, "lsp");
      if (recorded) cli.tsgoLsp = recorded;
    }
  } finally {
    await Deno.remove(out, { recursive: true }).catch(() => {});
  }
}

/** One extracted TypeScript directory must hash to `pinned` (binary + tree). */
async function checkTsDir(file: string, dir: string, exe: string, pinned: PinTsgo) {
  const name = dir.split(/[\\/]/).pop()!;
  const got = await sha256File(join(dir, exe)).catch(() =>
    fail(`${file}: the manifest pins it, the archive has no ${name}/${exe}`)
  );
  if (got !== pinned.sha256) {
    fail(`${file}: ${name}/${exe} sha256 ${got} != pinned ${pinned.sha256}`);
  }
  const tree = await tsgoTreeSha256(dir);
  if (tree !== pinned.treeSha256) {
    fail(`${file}: ${name}/ tree sha256 ${tree} != pinned ${pinned.treeSha256}`);
  }
}

/**
 * The pin of an extracted TypeScript directory the manifest does not record, from the attested
 * archive: `undefined` when the archive has none; else its `typescript.json` must name `role`, a
 * version and the binary's actual SHA-256.
 */
export async function recordTsDir(
  file: string,
  dir: string,
  exe: string,
  role: string,
): Promise<PinTsgo | undefined> {
  const name = dir.split(/[\\/]/).pop()!;
  const got = await sha256File(join(dir, exe)).catch(() => null);
  if (got === null) return undefined;
  const info: Loose = await Deno.readTextFile(join(dir, "typescript.json")).then(
    JSON.parse,
    () => fail(`${file}: ${name}/ has no readable typescript.json`),
  );
  const version = String(info?.version ?? "");
  if (info?.role !== role) {
    fail(`${file}: ${name}/typescript.json role ${info?.role}, expected ${role}`);
  }
  if (!TS_VERSION.test(version)) fail(`${file}: ${name}/typescript.json bad version ${version}`);
  if (info.sha256 !== got) {
    fail(`${file}: ${name}/${exe} sha256 ${got} != its typescript.json's ${info.sha256}`);
  }
  return { version, sha256: got, treeSha256: await tsgoTreeSha256(dir) };
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
      await checkZipTsgo(a, path, tmp);
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
    const denort = Object.keys(cli.denort ?? {}).length;
    console.log(
      `wrote ${toolchainOut}: deno toolchain ${cli.version}, ` +
        `${Object.keys(cli.targets).length} CLI archives` +
        (denort > 0 ? `, ${denort} denort archives` : ""),
    );
  }
  const count = Object.values(pin.targets).reduce(
    (n, t) => n + BACKENDS.filter((b) => t[b]).length,
    0,
  );
  console.log(`wrote ${out}: runtime ${pin.version} (deno ${pin.deno}), ${count} archives`);
}

if (import.meta.main) await main(Deno.args);
