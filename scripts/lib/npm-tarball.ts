/**
 * Shared by the scripts that vendor an npm package's browser files into a first-party package
 * (`scripts/vendor-swagger-ui.ts`, `scripts/vendor-scalar.ts`): download a release's tarball,
 * check it against the registry's `dist.integrity`, and unpack it into a temporary directory.
 *
 * @module
 */
import { encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";

/** Hex SHA-256 of `bytes`. */
export const digestHex = async (bytes: Uint8Array): Promise<string> =>
  encodeHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

/**
 * The registry metadata of `name@version` and its tarball's bytes, checked against the
 * registry's `dist.integrity` (sha512).
 *
 * @param name The npm package name.
 * @param version The exact version.
 * @returns The metadata (`license`, `dist`, …) and the verified tarball.
 */
export async function downloadTarball(
  name: string,
  version: string,
): Promise<{ meta: { license?: string }; tarball: Uint8Array }> {
  const meta = await (await fetch(`https://registry.npmjs.org/${name}/${version}`)).json();
  const tarball = new Uint8Array(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const integrity = "sha512-" +
    encodeBase64(await crypto.subtle.digest("SHA-512", tarball as BufferSource));
  if (integrity !== meta.dist.integrity) {
    throw new Error(`tarball integrity ${integrity} != registry ${meta.dist.integrity}`);
  }
  return { meta, tarball };
}

/**
 * Unpack `tarball` into a temporary directory, hand its `package/` directory to `use`, and
 * remove the directory afterwards.
 *
 * @param tarball The verified tarball.
 * @param use Copies what it needs out of the unpacked package.
 */
export async function withUnpacked(
  tarball: Uint8Array,
  use: (packageDir: string) => Promise<void>,
): Promise<void> {
  const work = await Deno.makeTempDir({ prefix: "denext_vendor_" });
  try {
    await Deno.writeFile(join(work, "pkg.tgz"), tarball);
    const tar = await new Deno.Command("tar", { args: ["xzf", "pkg.tgz"], cwd: work }).output();
    if (!tar.success) throw new Error(new TextDecoder().decode(tar.stderr));
    await use(join(work, "package"));
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}
