// Regenerate `src/build/fastlane-toolchain-pin.json` — denext's managed fastlane
// (src/build/fastlane-toolchain.ts): the portable Ruby per host and the Gemfile.lock. A pin bump
// is this one command plus a commit:
//
//   deno task fastlane:pin                          # refresh: Homebrew's current Ruby, same fastlane
//   deno task fastlane:pin --fastlane 2.241.1       # another fastlane (refused under two weeks old)
//   deno task fastlane:pin --ruby 4.0.7_1           # a given portable-ruby version
//   deno task fastlane:pin --upload                 # also upload the tarballs to the mirror
//
// The Ruby: the version Homebrew/brew vendors (`--ruby` overrides it). Its four bottles are read
// from the ghcr.io OCI index (each manifest's `sh.brew.bottle.digest` / `.size`), downloaded,
// hashed and checked against both, and must hold `portable-ruby/<version>/bin/ruby`. The pin
// lists denext's mirror (the `toolchain-assets` release) first and ghcr as the fallback; the
// verified tarballs are left in `--out <dir>` for the mirror (`--upload` runs `gh release upload`).
//
// The lock: `bundle lock` run by this host's new Ruby on a Gemfile pinning fastlane, for the
// four platforms plus `ruby` only, with CHECKSUMS (`--add-checksums`); refused unless every spec
// has a checksum. Nothing is written unless everything passes.

import { encodeHex } from "@std/encoding/hex";
import { fromFileUrl, join } from "@std/path";
import { extractArchive } from "../src/build/safe-extract.ts";
import { denoToolchainTarget } from "../src/build/deno-toolchain.ts";
import {
  type BundleRunner,
  FASTLANE_TOOLCHAIN,
  type FastlaneToolchainPin,
  managedFastlaneEnv,
} from "../src/build/fastlane-toolchain.ts";

const OUT = fromFileUrl(new URL("../src/build/fastlane-toolchain-pin.json", import.meta.url));
const MIN_AGE_DAYS = 14;
const GHCR = "https://ghcr.io/v2/homebrew/core/portable-ruby";
const GHCR_HEADERS = { Authorization: "Bearer QQ==" } as const;
const MIRROR_REPO = "Brainwires/denext";
const MIRROR_TAG = "toolchain-assets";
const BREW_RUBY_VERSION =
  "https://raw.githubusercontent.com/Homebrew/brew/main/Library/Homebrew/vendor/portable-ruby-version";
const RUBYGEMS = "https://rubygems.org/api/v1/versions/fastlane.json";

/** denext's host targets → Homebrew's bottle tags (Homebrew/brew vendor/portable-ruby-*). */
export const RUBY_BOTTLE_TAGS: Readonly<Record<string, string>> = {
  "darwin-aarch64": "arm64_big_sur",
  "darwin-x86_64": "big_sur",
  "linux-aarch64": "arm64_linux",
  "linux-x86_64": "x86_64_linux",
};

/** The platforms the lock lists (`ruby` plus one per host target). */
export const LOCK_PLATFORMS = [
  "aarch64-linux",
  "arm64-darwin",
  "ruby",
  "x86_64-darwin",
  "x86_64-linux",
];

/** Seams and choices for {@linkcode buildFastlanePin}. */
export interface FastlanePinOptions {
  /** The fastlane version (default: the current pin's). */
  readonly fastlane?: string;
  /** The portable-ruby version (default: what Homebrew/brew vendors). */
  readonly ruby?: string;
  /** Accept a fastlane release under two weeks old. */
  readonly allowNew?: boolean;
  /** Where the verified tarballs are written (it must exist). */
  readonly outDir: string;
  /** This machine's target (default the host's): its Ruby runs `bundle lock`. */
  readonly hostTarget?: string;
  readonly fetch?: typeof fetch;
  /** Runs `bundle lock` (default: spawn). */
  readonly run?: BundleRunner;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** What {@linkcode buildFastlanePin} produced. */
export interface FastlanePinResult {
  readonly pin: FastlaneToolchainPin;
  /** The verified tarballs in `outDir`, for the mirror. */
  readonly files: string[];
}

interface OciIndex {
  manifests: { annotations?: Record<string, string> }[];
}

async function getOk(fetchImpl: typeof fetch, url: string, init?: RequestInit) {
  const res = await fetchImpl(url, { redirect: "follow", ...init });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`GET ${url} → ${res.status}`);
  }
  return res;
}

/** Each target's bottle digest and size, from the ghcr OCI index of `version`. */
export function bottlesFromIndex(
  index: OciIndex,
  version: string,
): Record<string, { sha256: string; size: number; tag: string }> {
  const byRef = new Map<string, Record<string, string>>();
  for (const m of index.manifests ?? []) {
    const ref = m.annotations?.["org.opencontainers.image.ref.name"];
    if (ref) byRef.set(ref, m.annotations!);
  }
  const out: Record<string, { sha256: string; size: number; tag: string }> = {};
  for (const [target, tag] of Object.entries(RUBY_BOTTLE_TAGS)) {
    const a = byRef.get(`${version}.${tag}`);
    const sha256 = a?.["sh.brew.bottle.digest"];
    const size = Number(a?.["sh.brew.bottle.size"]);
    if (!a || !/^[0-9a-f]{64}$/.test(sha256 ?? "") || !Number.isSafeInteger(size)) {
      throw new Error(
        `the ghcr index of portable-ruby ${version} has no usable ${version}.${tag} bottle ` +
          `(it lists: ${[...byRef.keys()].join(", ") || "none"})`,
      );
    }
    out[target] = { sha256: sha256!, size, tag };
  }
  return out;
}

/** Download one bottle, check it against the index, and check its layout. */
async function verifiedBottle(
  fetchImpl: typeof fetch,
  version: string,
  file: string,
  want: { sha256: string; size: number },
  outDir: string,
): Promise<string> {
  const url = `${GHCR}/blobs/sha256:${want.sha256}`;
  const bytes = new Uint8Array(
    await (await getOk(fetchImpl, url, { headers: GHCR_HEADERS })).arrayBuffer(),
  );
  const sha256 = encodeHex(await crypto.subtle.digest("SHA-256", bytes));
  if (sha256 !== want.sha256 || bytes.byteLength !== want.size) {
    throw new Error(
      `${file}: got sha256 ${sha256}, ${bytes.byteLength} bytes; the ghcr index says ` +
        `${want.sha256}, ${want.size} bytes`,
    );
  }
  const path = join(outDir, file);
  await Deno.writeFile(path, bytes);
  const scratch = await Deno.makeTempDir({ prefix: "denext-fastlane-pin-" });
  try {
    const { files } = await extractArchive(path, "tar.gz", join(scratch, "x"));
    if (!files[`portable-ruby/${version}/bin/ruby`]) {
      throw new Error(`${file} has no portable-ruby/${version}/bin/ruby`);
    }
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
  return path;
}

/** The fastlane version's publication date; refused when under two weeks old (unless allowed). */
async function fastlanePublished(
  fetchImpl: typeof fetch,
  version: string,
  allowNew: boolean,
  now: number,
): Promise<string> {
  const versions = await (await getOk(fetchImpl, RUBYGEMS)).json() as {
    number: string;
    created_at: string;
    prerelease?: boolean;
  }[];
  const v = versions.find((x) => x.number === version);
  if (!v) throw new Error(`fastlane ${version} is not on rubygems.org`);
  if (v.prerelease) throw new Error(`fastlane ${version} is a prerelease`);
  const ageDays = (now - Date.parse(v.created_at)) / 86_400_000;
  if (ageDays < MIN_AGE_DAYS && !allowNew) {
    throw new Error(
      `fastlane ${version} was published ${v.created_at} (${ageDays.toFixed(1)} days ago); pin ` +
        `a release at least ${MIN_AGE_DAYS} days old, or pass --allow-new`,
    );
  }
  return v.created_at.slice(0, 10);
}

/** The platforms a lock lists. */
function lockPlatforms(lock: string): string[] {
  const m = /\nPLATFORMS\n((?: {2}\S+\n)+)/.exec(lock);
  return m ? m[1].trim().split(/\s+/) : [];
}

/** Check a generated lock: the fastlane spec, exactly the platforms, a checksum for every spec. */
export function checkLock(lock: string, fastlane: string): void {
  if (!lock.includes(`\n    fastlane (${fastlane})\n`)) {
    throw new Error(`the lock does not resolve fastlane ${fastlane}`);
  }
  const platforms = lockPlatforms(lock).sort();
  if (JSON.stringify(platforms) !== JSON.stringify([...LOCK_PLATFORMS].sort())) {
    throw new Error(`the lock lists the platforms ${platforms.join(", ")}`);
  }
  const specs = [...lock.matchAll(/^ {4}(\S+) \(([^)]+)\)$/gm)].map((m) => `${m[1]} (${m[2]})`);
  const checksums = /\nCHECKSUMS\n((?: {2}.+\n)+)/.exec(lock)?.[1] ?? "";
  const missing = specs.filter((s) => !checksums.includes(`  ${s} sha256=`));
  if (specs.length === 0 || missing.length > 0) {
    throw new Error(`the lock has no CHECKSUMS for ${missing.join(", ") || "any gem"}`);
  }
}

/** Run `bundle lock` with this host's new Ruby; the lock's text. */
async function generateLock(
  rubyTarball: string,
  rubyVersion: string,
  gemfile: string,
  run: BundleRunner,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-fastlane-lock-" });
  try {
    const x = join(dir, "x");
    await extractArchive(rubyTarball, "tar.gz", x);
    await Deno.rename(join(x, "portable-ruby", rubyVersion), join(dir, "ruby"));
    await Deno.writeTextFile(join(dir, "Gemfile"), gemfile);
    const env = managedFastlaneEnv(dir, Deno.env.toObject());
    delete env.BUNDLE_FROZEN;
    const ruby = join(dir, "ruby", "bin", "ruby");
    const bundle = async (...args: string[]) => {
      const r = await run(ruby, ["-S", "bundle", "lock", ...args], { cwd: dir, env });
      if (r.code !== 0) throw new Error(`bundle lock ${args.join(" ")} failed:\n${r.output}`);
    };
    await bundle("--add-platform", ...LOCK_PLATFORMS);
    const lockPath = join(dir, "Gemfile.lock");
    const extra = lockPlatforms(await Deno.readTextFile(lockPath))
      .filter((p) => !LOCK_PLATFORMS.includes(p));
    if (extra.length > 0) await bundle("--remove-platform", ...extra);
    await bundle("--add-checksums");
    return await Deno.readTextFile(lockPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The default runner: spawn, output collected. */
const spawn: BundleRunner = async (command, args, { cwd, env }) => {
  const out = await new Deno.Command(command, {
    args: [...args],
    cwd,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: out.code, output: dec.decode(out.stdout) + dec.decode(out.stderr) };
};

/**
 * Build the next fastlane pin: the Ruby's four bottles verified against the ghcr index (and
 * written to `outDir` for the mirror), the fastlane release's age checked, and a fresh lock with
 * CHECKSUMS from this host's new Ruby.
 *
 * @param options Choices and seams.
 * @returns The pin and the tarballs.
 */
export async function buildFastlanePin(options: FastlanePinOptions): Promise<FastlanePinResult> {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? ((l: string) => console.log(l));
  const fastlane = options.fastlane ?? FASTLANE_TOOLCHAIN.fastlane;
  const rubyVersion = options.ruby ??
    (await (await getOk(fetchImpl, BREW_RUBY_VERSION)).text()).trim();
  const published = await fastlanePublished(
    fetchImpl,
    fastlane,
    options.allowNew === true,
    (options.now ?? Date.now)(),
  );
  const index = await (await getOk(fetchImpl, `${GHCR}/manifests/${rubyVersion}`, {
    headers: { ...GHCR_HEADERS, Accept: "application/vnd.oci.image.index.v1+json" },
  })).json() as OciIndex;
  const bottles = bottlesFromIndex(index, rubyVersion);
  const targets: Record<string, FastlaneToolchainPin["ruby"]["targets"][string]> = {};
  const files: Record<string, string> = {};
  for (const [target, b] of Object.entries(bottles)) {
    const file = `portable-ruby-${rubyVersion}.${b.tag}.bottle.tar.gz`;
    files[target] = await verifiedBottle(fetchImpl, rubyVersion, file, b, options.outDir);
    log(`  ${target.padEnd(16)} ${b.sha256}  ${file}`);
    targets[target] = {
      file,
      url: `https://github.com/${MIRROR_REPO}/releases/download/${MIRROR_TAG}/${file}`,
      sha256: b.sha256,
      size: b.size,
      format: "tar.gz",
      fallbacks: [{ url: `${GHCR}/blobs/sha256:${b.sha256}`, headers: { ...GHCR_HEADERS } }],
    };
  }
  const host = options.hostTarget ?? denoToolchainTarget();
  if (!files[host]) {
    throw new Error(`no portable Ruby for this host (${host}): run on macOS or Linux`);
  }
  const gemfile = `source "https://rubygems.org"\n\ngem "fastlane", "${fastlane}"\n`;
  const gemfileLock = await generateLock(files[host], rubyVersion, gemfile, options.run ?? spawn);
  checkLock(gemfileLock, fastlane);
  const pin: FastlaneToolchainPin = {
    schema: 1,
    fastlane,
    published,
    ruby: {
      version: rubyVersion,
      source: FASTLANE_TOOLCHAIN.ruby.source,
      root: `portable-ruby/${rubyVersion}`,
      targets,
    },
    gemfile,
    gemfileLock,
  };
  return { pin, files: Object.values(files) };
}

/** `--name value` from `args`. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Seams for {@linkcode main} (tests). */
export interface FastlanePinMain {
  /** Default {@linkcode buildFastlanePin}. */
  readonly build?: (options: FastlanePinOptions) => Promise<FastlanePinResult>;
  /** The pin file (default `src/build/fastlane-toolchain-pin.json`). */
  readonly pinFile?: string;
  /** Runs `gh <args>`; whether it succeeded (default: spawn). */
  readonly gh?: (args: string[]) => Promise<boolean>;
  readonly log?: (line: string) => void;
}

/**
 * The task: build the pin, write it, and upload the tarballs to the mirror with `--upload` (else
 * print the command).
 *
 * @param args `--fastlane <v>`, `--ruby <v>`, `--allow-new`, `--out <dir>`, `--upload`.
 * @param seams Test seams.
 */
export async function main(args: string[], seams: FastlanePinMain = {}): Promise<void> {
  const log = seams.log ?? ((l: string) => console.log(l));
  const pinFile = seams.pinFile ?? OUT;
  const outDir = flag(args, "out") ?? await Deno.makeTempDir({ prefix: "denext-ruby-mirror-" });
  await Deno.mkdir(outDir, { recursive: true });
  const { pin, files } = await (seams.build ?? buildFastlanePin)({
    fastlane: flag(args, "fastlane"),
    ruby: flag(args, "ruby"),
    allowNew: args.includes("--allow-new"),
    outDir,
    log,
  });
  await Deno.writeTextFile(pinFile, JSON.stringify(pin, null, 2) + "\n");
  log(`wrote ${pinFile}`);
  const upload = ["release", "upload", MIRROR_TAG, ...files, "--clobber", "-R", MIRROR_REPO];
  if (!args.includes("--upload")) {
    log(`The mirror needs the new tarballs (in ${outDir}):\n  gh ${upload.join(" ")}`);
    return;
  }
  const gh = seams.gh ??
    (async (a: string[]) => (await new Deno.Command("gh", { args: a }).output()).success);
  if (!(await gh(upload))) throw new Error("gh release upload failed");
  log(`uploaded ${files.length} tarballs to ${MIRROR_TAG}`);
}

if (import.meta.main) await main(Deno.args);
