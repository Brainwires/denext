// The escape hatch for config fields the generated schema cannot describe well enough for a
// widget to be chosen automatically.
//
// It ships EMPTY on purpose, and a test asserts it stays that way: every gap is fixed in
// `scripts/gen-config-schema.ts` (J4b) so the schema — the artifact plugins, editors and agents
// all read — is the single source of truth, rather than being patched behind the UI's back.

import type { WidgetKind } from "./widget.ts";

/** Per-path widget overrides, keyed by dotted config path. Intentionally empty. */
export const OVERRIDES: Record<string, WidgetKind> = {};
