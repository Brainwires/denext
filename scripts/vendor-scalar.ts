/**
 * Re-vendor Scalar's API reference for `@denext/openapi` (`ui: "scalar"`):
 *
 *     deno run -A scripts/vendor-scalar.ts 1.72.4
 *
 * Downloads `@scalar/api-reference@<version>`'s npm tarball, checks it against the registry's
 * `dist.integrity` (sha512), unpacks the standalone browser bundle
 * (`dist/browser/standalone.js`) into `packages/openapi/vendor/scalar/`, writes Scalar's MIT
 * licence beside it (the npm tarball carries none; it is taken from the Scalar repository) with a
 * NOTICE naming the package and version, and rewrites the version, SHA-256 and byte length
 * recorded in `packages/openapi/scalar-ui.ts`. `tests/openapi-scalar.test.ts` then holds the
 * vendored bytes to those digests.
 *
 * @module
 */
import { dirname, fromFileUrl, join } from "@std/path";
import { digestHex, downloadTarball, withUnpacked } from "./lib/npm-tarball.ts";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const PACKAGE = join(ROOT, "packages", "openapi");
const VENDOR = join(PACKAGE, "vendor", "scalar");
const NAME = "@scalar/api-reference";
/** Scalar's licence: one MIT licence for the whole monorepo, at its root. */
const LICENSE_URL = "https://raw.githubusercontent.com/scalar/scalar/main/LICENSE";

/** Unpack the standalone bundle and write the licence + NOTICE into the vendor directory. */
async function unpack(tarball: Uint8Array, version: string): Promise<void> {
  await withUnpacked(tarball, async (pkg) => {
    await Deno.mkdir(VENDOR, { recursive: true });
    const bundle = join(pkg, "dist", "browser", "standalone.js");
    await Deno.copyFile(bundle, join(VENDOR, "standalone.js"));
  });
  const license = await fetch(LICENSE_URL);
  if (!license.ok) throw new Error(`${LICENSE_URL}: ${license.status}`);
  const text = await license.text();
  if (!text.startsWith("MIT License")) throw new Error(`${LICENSE_URL} is not the MIT licence`);
  await Deno.writeTextFile(join(VENDOR, "LICENSE"), text);
  await Deno.writeTextFile(
    join(VENDOR, "NOTICE"),
    `${NAME} ${version} (dist/browser/standalone.js), copied verbatim from the npm package.\n` +
      `Copyright (c) 2023-present Scalar. MIT License: see LICENSE beside this file\n` +
      `(from https://github.com/scalar/scalar). The bundle keeps the licence comments of the\n` +
      `third-party code it includes.\n`,
  );
}

/** Rewrite the version, digest and length recorded in `scalar-ui.ts`. */
async function record(version: string): Promise<void> {
  const constants = join(PACKAGE, "scalar-ui.ts");
  const bytes = await Deno.readFile(join(VENDOR, "standalone.js"));
  const source = (await Deno.readTextFile(constants))
    .replace(/SCALAR_VERSION = "[^"]+"/, `SCALAR_VERSION = "${version}"`)
    .replace(
      /(file: "standalone\.js",[\s\S]*?sha256: ")[0-9a-f]+(",\s*bytes: )\d+/,
      `$1${await digestHex(bytes)}$2${bytes.byteLength}`,
    );
  await Deno.writeTextFile(constants, source);
}

async function main(version: string | undefined): Promise<void> {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("usage: deno run -A scripts/vendor-scalar.ts <exact version, e.g. 1.72.4>");
  }
  const { meta, tarball } = await downloadTarball(NAME, version);
  if (meta.license !== "MIT") throw new Error(`${NAME}@${version} is ${meta.license}, not MIT`);
  await unpack(tarball, version);
  await record(version);
  console.log(`vendored ${NAME} ${version} into ${VENDOR}`);
}

if (import.meta.main) await main(Deno.args[0]);
