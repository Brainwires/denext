// Image codec parity: @denext/photon (first-party JSR, built with wasmbuild) vs
// the npm @cf-wasm/photon it replaces. BOTH wrap the same photon-rs 0.3.3 Rust
// code, so this proves the Deno-native build didn't regress — expect them within
// noise, and byte-identical output (same codec).
//
//   deno bench -A --config deno.json bench/packages/image_bench.ts
//
// Pipeline per iter: decode a 256×256 PNG → resize to 128×128 (Lanczos3) → encode
// WebP — the exact path denext's image optimizer runs.

import * as denextPhoton from "../../packages/photon/mod.ts";
// bench-only: the npm package @denext/photon replaces. Deliberately NOT a denext
// dependency, so it's referenced inline here rather than mapped in deno.json.
// deno-lint-ignore no-import-prefix
import * as cfPhoton from "npm:@cf-wasm/photon@0.4.0";

// deno-lint-ignore no-explicit-any
type PhotonModule = any;

const src = Deno.readFileSync(new URL("./sample-256.png", import.meta.url));

function encodeWebp(mod: PhotonModule, bytes: Uint8Array): Uint8Array {
  const img = mod.PhotonImage.new_from_byteslice(bytes);
  const out = mod.resize(img, 128, 128, mod.SamplingFilter.Lanczos3);
  const webp = out.get_bytes_webp();
  img.free();
  out.free();
  return webp;
}

// One-time output-parity check (logged — Deno.bench can't assert).
const a = encodeWebp(denextPhoton, src);
const b = encodeWebp(cfPhoton, src);
const identical = a.length === b.length && a.every((v, i) => v === b[i]);
console.error(
  `parity: @denext/photon webp=${a.length}B  @cf-wasm/photon webp=${b.length}B  byte-identical=${identical}`,
);

Deno.bench({
  name: "@denext/photon (JSR, wasmbuild)",
  group: "decode + resize 256→128 + webp",
  baseline: true,
  fn: () => {
    encodeWebp(denextPhoton, src);
  },
});

Deno.bench({
  name: "@cf-wasm/photon (npm, wasm-pack)",
  group: "decode + resize 256→128 + webp",
  fn: () => {
    encodeWebp(cfPhoton, src);
  },
});
