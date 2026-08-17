// A tiny static PNG fixture (16×16 solid) for image-optimizer tests. It is decoded
// by the photon codec that denext bundles, so tests get a source image WITHOUT
// depending on the optional `@cf-wasm/og` codec (which used to synthesize the
// fixture via `ImageResponse`, coupling unrelated webp/SSRF tests to an opt-in
// peer dep). Base64 of a valid RGBA PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR42mMwmXH7PyWYYdSAUQNGDRguBgAAMrCmH6BxsuQAAAAASUVORK5CYII=";

/** A small valid PNG (16×16) usable as an image-optimizer source fixture. */
export function samplePng(): Uint8Array {
  const bin = atob(PNG_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
