// Regenerate `src/build/gleam-toolchain-pin.json` — the Gleam compiler denext downloads on first
// need (src/build/gleam-toolchain.ts) — from a gleam-lang/gleam GitHub release. A pin bump is this
// one command plus a commit:
//
//   deno task gleam:pin <version>              # e.g. 1.18.1
//   deno task gleam:pin <version> --allow-new  # a release under two weeks old (refused otherwise)
//
// Every pinned asset (`gleam-v<version>-<triple>.tar.gz`, Windows `.zip`) is downloaded and hashed
// here; the hash must equal both the release's `.sha256` sidecar and the digest GitHub records for
// the asset, and the archive must hold a top-level `gleam[.exe]`. Nothing is written unless every
// target passes. The output is deterministic; commit it, with the version named on
// site/app/docs/gleam/content.md (tests/gleam-toolchain.test.ts checks the two agree).

import { encodeHex } from "@std/encoding/hex";
import { fromFileUrl, join } from "@std/path";
import { extractArchive } from "../src/build/safe-extract.ts";
import { GLEAM_TARGET_TRIPLES } from "../src/build/gleam-toolchain.ts";

const REPO = "gleam-lang/gleam";
const MIN_AGE_DAYS = 14;
const OUT = fromFileUrl(new URL("../src/build/gleam-toolchain-pin.json", import.meta.url));

interface Asset {
  name: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return await res.json() as T;
}

async function getBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The release asset named `name` (throws when the release lacks it). */
function assetNamed(assets: Asset[], name: string): Asset {
  const asset = assets.find((a) => a.name === name);
  if (!asset) throw new Error(`the release has no ${name}`);
  return asset;
}

/** The SHA-256 the release's `.sha256` sidecar lists for `asset`. */
async function sidecarSha256(asset: Asset, assets: Asset[]): Promise<string> {
  const sidecar = assetNamed(assets, `${asset.name}.sha256`);
  const text = new TextDecoder().decode(await getBytes(sidecar.browser_download_url));
  return text.trim().split(/\s+/)[0].toLowerCase();
}

/** Check a download's SHA-256 against the release's `.sha256` sidecar and GitHub's digest. */
async function crossCheck(asset: Asset, assets: Asset[], bytes: Uint8Array, sha256: string) {
  const claims: [string, string][] = [
    ["its .sha256", await sidecarSha256(asset, assets)],
    ["GitHub's digest", (asset.digest ?? `sha256:${sha256}`).replace(/^sha256:/, "")],
  ];
  const wrong = claims.filter(([, claimed]) => claimed !== sha256);
  if (wrong.length > 0 || bytes.byteLength !== asset.size) {
    const says = wrong.map(([who, claimed]) => `${who} says ${claimed}`).join("; ");
    throw new Error(`${asset.name}: sha256 ${sha256}, ${bytes.byteLength} bytes; ${says}`);
  }
}

/** Check the archive holds a top-level `exe` (extracted into a scratch dir, then removed). */
async function checkArchive(
  file: string,
  bytes: Uint8Array,
  format: "zip" | "tar.gz",
  exe: string,
) {
  const scratch = await Deno.makeTempDir({ prefix: "denext-gleam-pin-" });
  try {
    const archive = join(scratch, file);
    await Deno.writeFile(archive, bytes);
    const { files } = await extractArchive(archive, format, join(scratch, "x"));
    if (!files[exe]) throw new Error(`${file} has no top-level ${exe}`);
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}

/** Download, hash and cross-check one target's asset; its pin entry. */
async function pinTarget(version: string, target: string, triple: string, assets: Asset[]) {
  const windows = target.startsWith("windows-");
  const format = windows ? "zip" : "tar.gz";
  const asset = assetNamed(assets, `gleam-v${version}-${triple}.${format}`);
  const bytes = await getBytes(asset.browser_download_url);
  const sha256 = encodeHex(await crypto.subtle.digest("SHA-256", bytes));
  await crossCheck(asset, assets, bytes, sha256);
  await checkArchive(asset.name, bytes, format, windows ? "gleam.exe" : "gleam");
  console.log(`  ${target.padEnd(16)} ${sha256}  ${asset.name}`);
  const url = asset.browser_download_url;
  return { file: asset.name, url, sha256, size: bytes.byteLength, format };
}

/** The release for `version`: a final release at least {@linkcode MIN_AGE_DAYS} old. */
async function releaseFor(version: string, allowNew: boolean) {
  const release = await getJson<{ published_at: string; prerelease: boolean; assets: Asset[] }>(
    `https://api.github.com/repos/${REPO}/releases/tags/v${version}`,
  );
  if (release.prerelease) throw new Error(`v${version} is a prerelease`);
  const ageDays = (Date.now() - Date.parse(release.published_at)) / 86_400_000;
  if (ageDays < MIN_AGE_DAYS && !allowNew) {
    throw new Error(
      `v${version} was published ${release.published_at} (${ageDays.toFixed(1)} days ago); ` +
        `pin a release at least ${MIN_AGE_DAYS} days old, or pass --allow-new`,
    );
  }
  return release;
}

async function main(args: string[]): Promise<void> {
  const version = args.find((a) => !a.startsWith("--"))?.replace(/^v/, "");
  if (!version) throw new Error("usage: deno task gleam:pin <version> [--allow-new]");
  const release = await releaseFor(version, args.includes("--allow-new"));
  const targets: Record<string, unknown> = {};
  for (const [target, triple] of Object.entries(GLEAM_TARGET_TRIPLES)) {
    targets[target] = await pinTarget(version, target, triple, release.assets);
  }
  const pin = {
    schema: 1,
    version,
    tag: `v${version}`,
    repository: `https://github.com/${REPO}`,
    published: release.published_at,
    targets,
  };
  await Deno.writeTextFile(OUT, JSON.stringify(pin, null, 2) + "\n");
  console.log(`wrote ${OUT}`);
}

if (import.meta.main) await main(Deno.args);
