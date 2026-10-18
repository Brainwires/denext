/**
 * Re-vendor Swagger UI for `@denext/openapi` (`ui: "swagger"`):
 *
 *     deno run -A scripts/vendor-swagger-ui.ts 5.32.15
 *
 * Downloads `swagger-ui-dist@<version>`'s npm tarball, checks it against the registry's
 * `dist.integrity` (sha512), unpacks the bundle, the stylesheet and the license files into
 * `packages/openapi/vendor/swagger-ui/`, and rewrites the version, SHA-256 and byte length
 * recorded in `packages/openapi/swagger-ui.ts`. `tests/openapi-swagger-ui.test.ts` then holds
 * the vendored bytes to those digests.
 *
 * @module
 */
import { dirname, fromFileUrl, join } from "@std/path";
import { digestHex, downloadTarball, withUnpacked } from "./lib/npm-tarball.ts";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const PACKAGE = join(ROOT, "packages", "openapi");
const VENDOR = join(PACKAGE, "vendor", "swagger-ui");
/** The files copied verbatim from the tarball's `package/` directory. */
const FILES = [
  "swagger-ui-bundle.js",
  "swagger-ui.css",
  "LICENSE",
  "NOTICE",
  "swagger-ui-bundle.js.LICENSE.txt",
];

/** Copy {@linkcode FILES} out of the verified tarball into the vendor directory. */
async function unpack(tarball: Uint8Array): Promise<void> {
  await withUnpacked(tarball, async (pkg) => {
    await Deno.mkdir(VENDOR, { recursive: true });
    for (const file of FILES) await Deno.copyFile(join(pkg, file), join(VENDOR, file));
  });
}

/** Rewrite the version, digests and lengths recorded in `swagger-ui.ts`. */
async function record(version: string): Promise<void> {
  const constants = join(PACKAGE, "swagger-ui.ts");
  let source = (await Deno.readTextFile(constants))
    .replace(/SWAGGER_UI_VERSION = "[^"]+"/, `SWAGGER_UI_VERSION = "${version}"`);
  for (const file of ["swagger-ui-bundle.js", "swagger-ui.css"]) {
    const bytes = await Deno.readFile(join(VENDOR, file));
    const block = new RegExp(
      `(file: "${file.replace(/\./g, "\\.")}",[\\s\\S]*?sha256: ")[0-9a-f]+(",\\s*bytes: )\\d+`,
    );
    source = source.replace(block, `$1${await digestHex(bytes)}$2${bytes.byteLength}`);
  }
  await Deno.writeTextFile(constants, source);
}

async function main(version: string | undefined): Promise<void> {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      "usage: deno run -A scripts/vendor-swagger-ui.ts <exact version, e.g. 5.32.15>",
    );
  }
  await unpack((await downloadTarball("swagger-ui-dist", version)).tarball);
  await record(version);
  console.log(`vendored swagger-ui-dist ${version} into ${VENDOR}`);
}

if (import.meta.main) await main(Deno.args[0]);
