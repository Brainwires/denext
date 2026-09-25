// Intentional, documented parity deviations for the react-native / expo targets — the
// mobile-side twin of `scripts/parity/waivers.ts`. A waiver suppresses one finding so the
// native gate stays green on KNOWN differences while still failing the moment a NEW,
// unexplained deviation appears. Every waiver carries a reason.
//
// The `Waiver` shape and matching logic are reused from the React harness, so the
// semantics (categorical `pattern` vs specific `symbol`, `categories` filter, cross- or
// per-specifier) are identical.

import type { Waiver } from "../waivers.ts";

export const NATIVE_WAIVERS: Waiver[] = [
  // ── Categorical policy (both targets) ────────────────────────────────────────────
  {
    pattern: "^unstable_",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason:
      "unstable_* are unstable react-native-web / Expo APIs; denext does not guarantee their shape.",
  },
  {
    pattern: "^(Unstable_|UNSTABLE_)",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason:
      "Unstable_/UNSTABLE_-prefixed exports are library internals, not stable public surface.",
  },
  {
    pattern: "^experimental_",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason:
      "experimental_* are experimental react-native / Expo APIs; denext does not guarantee their shape.",
  },
  {
    pattern: "^_",
    categories: ["MISSING_VALUE"],
    reason: "Underscore-prefixed exports are library internals, not public surface.",
  },
];
