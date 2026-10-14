// The esbuild version denext's vendored JS API speaks. The binary it spawns must report exactly
// this version (esbuild's own handshake, in ./vendor/common.ts, refuses any other), and every
// binary source pins it: denext's Deno toolchain zip, the npm fallback table in ./binary.ts.

/** The esbuild release denext's vendored wrapper and pinned binaries are. */
export const ESBUILD_VERSION = "0.25.5";
