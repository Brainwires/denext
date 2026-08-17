// Optional wasm codecs that denext deliberately does NOT bundle — keeping the
// core runtime zero-npm. Image AVIF output (`@jsquash/avif`) and `next/og`
// (`@cf-wasm/og`) are opt-in: a user who wants them adds the package to their
// import map, exactly as `sqliteCacheStore` peer-deps its backend. Until then the
// feature throws a guided error instead of an opaque module-resolution failure.
//
// The specifier is passed as a runtime value (never a literal `import("pkg")`), so
// the package stays out of denext's static module graph — `deno info` and the npm
// guard see no npm here, and `deno check`/`deno publish` need nothing installed.

/**
 * Lazily load an optional peer codec by specifier. Returns the module, or throws a
 * guided error naming the import-map line that enables the feature.
 *
 * @param specifier The bare package specifier to import (a runtime value).
 * @param example An import-map example to show, e.g. `npm:@jsquash/avif@^1.3.0`.
 * @param feature Human-readable feature name for the error, e.g. `AVIF image output`.
 * @returns The imported module, typed as `T`.
 */
export async function loadPeerCodec<T>(
  specifier: string,
  example: string,
  feature: string,
): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (cause) {
    throw new Error(
      `denext: ${feature} requires the optional "${specifier}" codec, which denext ` +
        `does not bundle (keeping the runtime zero-npm). Add it to your import map ` +
        `to enable ${feature} — e.g. "${specifier}": "${example}".`,
      { cause },
    );
  }
}
