// The escape hatch for config fields the generated schema cannot describe well enough for a
// widget to be chosen automatically.
//
// It ships EMPTY on purpose, and a test asserts it stays that way: every gap is fixed in
// `scripts/gen-config-schema.ts` (J4b) so the schema — the artifact plugins, editors and agents
// all read — is the single source of truth, rather than being patched behind the UI's back.

import type { SchemaNode } from "./schema.ts";

/**
 * Per-path schema patches, keyed by the dotted path `pathKey()` produces
 * (`images.remotePatterns[].hostname`). Each entry is shallow-merged over the generated node by
 * `resolveAt()`. Intentionally empty.
 */
export const OVERRIDES: Record<string, Partial<SchemaNode>> = {};
