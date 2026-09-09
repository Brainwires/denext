// Whether production builds minify their output.

/**
 * Whether a production build (`denext build` / `export` / `desktop`) minifies its
 * client output.
 *
 * Set `DENEXT_NO_MINIFY=1` to emit readable (unminified) production bundles — the
 * fastest way to read a real error message or stack trace off a built artifact, since
 * minified frames mangle component and hook names (this is how the Base UI
 * "Cannot call an event handler while rendering" crash was diagnosed). It does NOT turn
 * on source maps, so an unminified build still ships no `.map` and no original `.tsx`
 * source.
 *
 * Build-time only: read on the machine running the build, it never affects a deployed
 * server at request time and cannot be flipped by a request. Minification is not a
 * security control — the client receives the whole program either way — so disabling it
 * exposes nothing; it only makes the bundle larger and slower. Leave it OFF for shipping
 * builds.
 */
export function prodMinify(): boolean {
  return !Deno.env.get("DENEXT_NO_MINIFY");
}
