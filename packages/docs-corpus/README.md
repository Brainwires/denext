# @denext/docs-corpus

The offline denext documentation corpus behind `denext mcp`'s `denext_search_docs` and
`denext_read_docs` tools: every page of the denext docs site chunked by heading, the root guides,
every example's README and one chunk per API symbol, as Brotli-compressed JSON in base64.

You do not import it yourself. `@denext/denext` loads it on the first docs search or read through a
literal dynamic `import("@denext/docs-corpus")`, so `deno cache` of denext caches it too and the
tools work offline. It ships as its own package because the corpus is more than a megabyte, and
JSR caps a package at 20 MiB.

```ts
import { CORPUS_BROTLI_BASE64, CORPUS_SOURCE_HASH } from "@denext/docs-corpus";
```

It also carries generated data `@denext/denext` reads, for the same reason: the native templates
`denext mobile add` writes (`./native-templates`), the `denext.config.ts` JSON Schema the project
UI renders its forms from (`./config-schema`), the CLI's verb descriptions (`./cli-commands`) and
the Google Fonts family list behind `next/font/google` (`./google-font-families`).

## Versioning

The version is denext's: `@denext/denext` X.Y.Z imports exactly `jsr:@denext/docs-corpus@X.Y.Z`
(no caret), the corpus generated from the denext X.Y.Z tree, and every denext release, rc versions
included, publishes the matching corpus version before its own tag. The modules are generated in
the denext repository (`deno task docs:corpus`, `gen:native-templates`, `gen:config-schema`,
`gen:command-table`, `gen:google-fonts`); do not edit them.
