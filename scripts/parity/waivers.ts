// Intentional, documented parity deviations. A waiver suppresses one finding so the
// parity test stays green on *known* differences while still failing the moment a
// NEW, unexplained deviation appears. Every waiver carries a reason.
//
// Two kinds:
//   • categorical patterns (below) — whole classes denext deliberately does not mirror
//     (unstable_/experimental_/internal APIs, the generative per-font exports, removed
//     legacy APIs). These are policy, keyed by a name pattern, optionally cross-specifier.
//   • specific waivers — one named symbol denext intentionally omits or shapes
//     differently, each with a note. Add these as denext's scope is deliberately fixed.
//
// Keep this honest: waive a real React/Next runtime export only when denext genuinely
// does not implement it on purpose, never to hide a bug. Mirrors the
// "scan → assert invariant → waive the known" pattern of `src/build/audit.ts`.

import type { Category } from "./diff.ts";

/** One suppressed deviation. `symbol` xor `pattern`; omit both to match every symbol. */
export interface Waiver {
  /** Restrict to this specifier; omit to apply across all specifiers. */
  specifier?: string;
  /** Exact symbol name to suppress. */
  symbol?: string;
  /** Regex (source string) matched against the symbol name — for whole classes. */
  pattern?: string;
  /** Categories to suppress; omit to suppress every category. */
  categories?: Category[];
  /** Why this deviation is intentional (required). */
  reason: string;
}

export const WAIVERS: Waiver[] = [
  // ── Categorical policy ────────────────────────────────────────────────────────
  {
    pattern: "^unstable_",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason: "unstable_* are unstable React/Next APIs; denext does not guarantee their presence or shape.",
  },
  {
    pattern: "^experimental_",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason:
      "experimental_* (incl. taint APIs) are experimental React APIs; denext does not guarantee shape.",
  },
  {
    pattern: "^_",
    categories: ["MISSING_VALUE"],
    reason: "Underscore-prefixed exports are library internals, not public surface.",
  },
  {
    specifier: "next/font/google",
    pattern: ".",
    categories: ["MISSING_VALUE"],
    reason:
      "next/font/google exposes ~1.8k per-font named exports (ABeeZee, Roboto, …); denext exposes the " +
      "documented font-loader factory shape instead. Loader behavior is covered by tests/next-font.test.ts.",
  },
  {
    specifier: "next/font/local",
    pattern: ".",
    categories: ["MISSING_VALUE"],
    reason:
      "next/font/local's real surface is font-name factories; denext exposes the loader factory shape.",
  },
  // ── Removed / legacy React concepts ───────────────────────────────────────────
  {
    specifier: "react-is",
    pattern: "^(isAsyncMode|AsyncMode|isConcurrentMode|ConcurrentMode)$",
    categories: ["MISSING_VALUE"],
    reason:
      "AsyncMode/ConcurrentMode are removed legacy React modes; denext targets the modern surface.",
  },
];

/** Whether a given finding is covered by a waiver. */
export function isWaived(
  specifier: string,
  symbol: string,
  category: Category,
  waivers: Waiver[] = WAIVERS,
): boolean {
  return waivers.some((w) => {
    if (w.specifier && w.specifier !== specifier) return false;
    if (w.categories && !w.categories.includes(category)) return false;
    if (w.symbol && w.symbol !== symbol) return false;
    if (w.pattern && !new RegExp(w.pattern).test(symbol)) return false;
    return true;
  });
}
