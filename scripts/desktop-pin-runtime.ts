// Regenerate `src/build/desktop-runtime-pin.json` — the pinned denext Deno Desktop runtime (the
// prebuilt `libdenort` + laufey backend hosts from https://github.com/Brainwires/deno releases)
// that `denext desktop` and the scaffolded `scripts/package-*.ts` download, verify and hand to the
// stock `deno desktop` CLI (see `src/build/desktop-runtime.ts`).
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
// unless all of them pass. The output is deterministic; commit it.

import { encodeHex } from "@std/encoding/hex";
import { fromFileUrl, join } from "@std/path";
import { runtimeAttestationArgs } from "../src/build/desktop-runtime.ts";

const REPO = "Brainwires/deno";
const OUT = fromFileUrl(new URL("../src/build/desktop-runtime-pin.json", import.meta.url));
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

/** One archive entry, checked against its expected name, format, URL, SHA256SUMS line and size. */
function pinArtifact(
  ctx: { tag: string; version: string; sums: Map<string, string> },
  target: string,
  backend: string,
  a: Loose,
): PinArtifact {
  const format = target.includes("windows") ? "zip" : "tar.gz";
  const file = `deno-desktop-runtime-${ctx.version}-${target}-${backend}.${format}`;
  const where = `${target}/${backend}`;
  if (a.file !== file) fail(`${where}: file ${a.file}, expected ${file}`);
  if (a.format !== format) fail(`${where}: format ${a.format}, expected ${format}`);
  const url = `https://github.com/${REPO}/releases/download/${ctx.tag}/${file}`;
  if (a.url !== url) fail(`${where}: url ${a.url}, expected ${url}`);
  const sha256 = String(a.sha256 ?? "");
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`${file}: bad sha256`);
  const listed = ctx.sums.get(file);
  if (listed === undefined) fail(`${file} is not in SHA256SUMS`);
  if (listed !== sha256) fail(`${file}: manifest sha256 ${sha256} != SHA256SUMS ${listed}`);
  const size = Number(a.size);
  if (!Number.isSafeInteger(size) || size <= 0) fail(`${file}: bad size ${a.size}`);
  return { file, url, sha256, size, format };
}

const RUNTIME_LIBS = ["libdenort.dylib", "libdenort.so", "denort.dll"];

/** One target's entry (its runtime lib + each backend's archive). */
function pinTarget(
  ctx: { tag: string; version: string; sums: Map<string, string> },
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

/** How {@linkcode attestPin} reaches the archives and `gh` (tests pass fakes). */
export interface AttestPinOptions {
  /** A directory holding the archives already (by file name); else each is downloaded. */
  readonly archives?: string;
  /** Download (default `fetch`). */
  readonly fetch?: typeof fetch;
  /** Run `gh` with these args, resolving its exit code (default: a real `gh`, output inherited). */
  readonly run?: GhRun;
}

/** Run `gh` with `args`, resolving its exit code. */
type GhRun = (args: string[]) => Promise<number>;

const runGh: GhRun = async (args) =>
  (await new Deno.Command("gh", { args, stdout: "inherit", stderr: "inherit" }).output()).code;

/** SHA-256 of a file, hex. */
async function sha256File(path: string): Promise<string> {
  return encodeHex(await crypto.subtle.digest("SHA-256", await Deno.readFile(path)));
}

/** The pin's archives, in target then backend order. */
function pinArchives(pin: PinFile): PinArtifact[] {
  return Object.values(pin.targets).flatMap((t) => BACKENDS.flatMap((b) => t[b] ? [t[b]!] : []));
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
    for (const a of pinArchives(pin)) {
      const path = await archiveFile(a, tmp, options);
      await attestArchive(pin, a, path, options.run ?? runGh);
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
 * The CLI: fetch (or read, with `--manifest` / `--sums`) the release's files, build the pin and
 * write it to `out`.
 *
 * @param args The command line (`<tag> [--manifest <file> --sums <file>] [--archives <dir>]`).
 * @param out Where the pin is written (default: `src/build/desktop-runtime-pin.json`).
 * @param attest The archive cross-check run before writing (default {@linkcode attestPin}).
 */
export async function main(
  args: string[],
  out: string = OUT,
  attest: (pin: PinFile, options: AttestPinOptions) => Promise<void> = attestPin,
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
  const pin = pinFromRelease(tag, JSON.parse(manifestText), sumsText);
  await attest(pin, { archives: flag("--archives") });
  await Deno.writeTextFile(out, JSON.stringify(pin, null, 2) + "\n");
  const count = Object.values(pin.targets).reduce(
    (n, t) => n + BACKENDS.filter((b) => t[b]).length,
    0,
  );
  console.log(`wrote ${out}: runtime ${pin.version} (deno ${pin.deno}), ${count} archives`);
}

if (import.meta.main) await main(Deno.args);
