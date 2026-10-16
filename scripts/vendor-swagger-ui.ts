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
import { encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { dirname, fromFileUrl, join } from "@std/path";

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

/** Hex SHA-256 of `bytes`. */
const digestHex = async (bytes: Uint8Array) =>
  encodeHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

/** The tarball's bytes, checked against the registry's `dist.integrity`. */
async function download(version: string): Promise<Uint8Array> {
  const meta = await (await fetch(`https://registry.npmjs.org/swagger-ui-dist/${version}`)).json();
  const tarball = new Uint8Array(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const integrity = "sha512-" +
    encodeBase64(await crypto.subtle.digest("SHA-512", tarball as BufferSource));
  if (integrity !== meta.dist.integrity) {
    throw new Error(`tarball integrity ${integrity} != registry ${meta.dist.integrity}`);
  }
  return tarball;
}

/** Unpack {@linkcode FILES} from the tarball into the vendor directory. */
async function unpack(tarball: Uint8Array): Promise<void> {
  const work = await Deno.makeTempDir({ prefix: "denext_swagger_" });
  try {
    await Deno.writeFile(join(work, "pkg.tgz"), tarball);
    const tar = await new Deno.Command("tar", { args: ["xzf", "pkg.tgz"], cwd: work }).output();
    if (!tar.success) throw new Error(new TextDecoder().decode(tar.stderr));
    await Deno.mkdir(VENDOR, { recursive: true });
    for (const file of FILES) await Deno.copyFile(join(work, "package", file), join(VENDOR, file));
  } finally {
    await Deno.remove(work, { recursive: true });
  }
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
  await unpack(await download(version));
  await record(version);
  console.log(`vendored swagger-ui-dist ${version} into ${VENDOR}`);
}

if (import.meta.main) await main(Deno.args[0]);
