# Font fixtures

`Geist-Regular.ttf` and `geist-latin.woff2` are Geist by Vercel, copied unmodified from the
`next` npm package (`dist/compiled/@vercel/og/Geist-Regular.ttf`,
`dist/next-devtools/server/font/geist-latin.woff2`). `Geist-Regular.woff` is
`Geist-Regular.ttf` repackaged as WOFF 1.0 (each table zlib-compressed, glyph data unchanged).

Geist is licensed under the SIL Open Font License, Version 1.1
(https://openfontlicense.org, https://github.com/vercel/geist-font/blob/main/LICENSE.TXT).
Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font).

They are test inputs for `next/font/local`'s metric-matched fallback faces
(`tests/next-font-local-fallback.test.ts`).
