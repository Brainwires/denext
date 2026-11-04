// Content-hashed asset file names: Rollup's `[name]-[hash][extname]` for a file a plugin emits
// by `name` alone (`this.emitFile({ type: "asset", name, source })`), and the hash the compat
// bundler names its emitted assets with (src/build/next-compat.ts).
//
// Kept free of heavy imports: `denext/plugin-kit/vite-emitter` (loaded by `denext.config.ts`,
// which a Deno Desktop app's `desktop.ts` imports at runtime) names its assets through it.

import { normalizeSpaAssetsDir } from "../server/config-validate/spa.ts";

/** esbuild's `[hash]` alphabet (RFC 4648 base32). */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * A content hash for an emitted file name in esbuild's `[hash]` shape — 8 base32 characters
 * (40 bits of two FNV-1a passes) — so a `name-HASH.ext` asset reads as content-hashed to the
 * immutable-cache check (`isContentHashed`) and to a server written for a Vite build.
 *
 * @param bytes The file's contents.
 * @returns Eight base32 characters.
 */
export function contentHash8(bytes: Uint8Array): string {
  let a = 2166136261 >>> 0;
  let b = 0x9747b28c;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 16777619) >>> 0;
    b = Math.imul(b ^ bytes[i], 16777619) >>> 0;
  }
  // 32 bits of `a` and the low 8 of `b`: eight 5-bit digits.
  let out = "";
  for (let i = 0; i < 6; i++) out += BASE32[(a >>> (27 - 5 * i)) & 31];
  out += BASE32[((a & 3) << 3) | ((b >>> 5) & 7)];
  out += BASE32[b & 31];
  return out;
}

/**
 * The directory a hashed asset is published in: the SPA's `spa.assetsDir` (Vite's
 * `build.assetsDir`) when set, else Vite's default `assets`.
 *
 * @param config The project config (only `spa.assetsDir` is read).
 */
function hashedAssetsDir(
  config: { readonly spa?: { readonly assetsDir?: string } },
): string {
  const dir = config.spa?.assetsDir;
  return (dir === undefined ? null : normalizeSpaAssetsDir(dir)) ?? "assets";
}

/**
 * The file name Rollup's default `assetFileNames` (`assets/[name]-[hash][extname]`) gives an
 * asset emitted by `name`: `name`'s last path segment, its stem sanitized to `[\w.-]`, then `-`,
 * {@linkcode contentHash8} of the contents and the extension, in {@linkcode hashedAssetsDir}.
 *
 * @param name The asset's `name` (`"logo.svg"`, `"icons/app.png"`).
 * @param source The contents (text is hashed as UTF-8).
 * @param config The project config (`spa.assetsDir` places the file).
 * @returns The site-root-relative file name (`assets/logo-ABCDEFGH.svg`).
 */
export function hashedAssetFileName(
  name: string,
  source: string | Uint8Array,
  config: { readonly spa?: { readonly assetsDir?: string } },
): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot).replace(/[^\w.-]+/g, "_") : "";
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
  const safe = stem.replace(/[^\w.-]+/g, "_") || "asset";
  return `${hashedAssetsDir(config)}/${safe}-${contentHash8(bytes)}${ext}`;
}
