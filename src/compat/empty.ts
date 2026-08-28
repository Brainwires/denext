// A denext empty module. Migrate aliases type-only specifiers that an app imports at
// VALUE syntax (`import { X } from "mdx/types"` rather than `import type { X }`) here, so
// the bundler/loader resolves them to an inert module instead of failing — the symbols
// are only ever used as types, so the runtime never references the (empty) exports.
export {};
