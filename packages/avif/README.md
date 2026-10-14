# @denext/avif

A Deno-native **AVIF encoder and decoder** — denext's first-party, zero-npm
replacement for the `@jsquash/avif` peer codec its image optimizer used to lazily
import.

It forks the **prebuilt single-threaded libavif (AOM/AV1) WebAssembly encoder and
decoder**
from [jSquash](https://github.com/jamsinclair/jSquash)'s `@jsquash/avif@2.1.1`
(itself repackaged from Google's
[Squoosh](https://github.com/GoogleChromeLabs/squoosh), Apache-2.0) and drives
it through the emscripten module's `instantiateWasm` hook, so it runs under Deno
with **zero npm dependencies** and no `--unstable-*` flag.

```ts
import { encode } from "@denext/avif";

// rgba: row-major RGBA bytes, length = width * height * 4
const avif = await encode({ data: rgba, width: 128, height: 128 }, {
  quality: 60,
});
// → ArrayBuffer of an AVIF file (ISOBMFF `ftypavif`)

import { decode } from "@denext/avif";

const { data, width, height } = await decode(await Deno.readFile("photo.avif"));
// → 8-bit RGBA pixels (a still image, or an image sequence's first frame)
```

denext decodes AVIF sources with `decode` (every other source format with
[`@denext/photon`](https://jsr.io/@denext/photon)). The decoder allocates the
whole raster, so check an untrusted file's declared size first (denext's image
pipeline reads it from the `ispe` box). Each `decode` call runs in a fresh wasm
instance, so a large image's memory is released afterwards. It is a server-only
codec and is never shipped to the browser.

## Permissions

The wasm is compiled from
`fetch(new URL("./lib/avif_enc.wasm", import.meta.url))` (and `avif_dec.wasm`),
so a consumer needs
**`--allow-read`** when the package is resolved from a local file (workspace /
cached JSR), or **`--allow-net`** when loaded directly over https. denext's
image optimizer already runs with file read access, so no extra grant is
required.

## Versioning

`@denext/avif` uses **independent semver** (starting at 0.1.0). The wrapped
upstream version is recorded here and in the CHANGELOG, not encoded in the
package version:

| `@denext/avif` | libavif encoder vendored from |
| -------------- | ----------------------------- |
| 0.1.0          | `@jsquash/avif@2.1.1`         |
| 0.1.1          | `@jsquash/avif@2.1.1`         |
| 0.1.2          | `@jsquash/avif@2.1.1`         |
| 0.2.0          | `@jsquash/avif@2.1.1`         |

## Updating the codec

The publishable artifact is the vendored `lib/avif_enc.{js,wasm}` and
`lib/avif_dec.{js,wasm}` (committed). To refresh them against a newer libavif
(e.g. after an upstream CVE):

```sh
# fetch the target @jsquash/avif release (check the tarball against the registry's
# dist.integrity), then copy its single-threaded encoder and decoder:
#   package/codec/enc/avif_enc.js   → lib/avif_enc.js
#   package/codec/enc/avif_enc.wasm → lib/avif_enc.wasm
#   package/codec/dec/avif_dec.js   → lib/avif_dec.js
#   package/codec/dec/avif_dec.wasm → lib/avif_dec.wasm
```

Do **not** vendor the multi-threaded (`_mt`) variant — it needs a Web Worker +
`SharedArrayBuffer`, which the single-threaded server path avoids. Bump the
version, record the new upstream in the table above, and re-publish.

## License

Apache-2.0, inherited from `@jsquash/avif` / Squoosh (see `LICENSE`). The
encoder itself compiles in **libavif** (BSD-2-Clause) and **libaom** 3.7.0
(BSD-2-Clause + the Alliance for Open Media Patent License 1.0), and
`lib/avif_enc.js` carries the emscripten (MIT) runtime — see
`THIRD-PARTY-LICENSES.md` for the inventory and full texts. Refresh it when the
vendored codec changes.
