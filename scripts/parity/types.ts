// Shared normalized shapes for the parity tool. Both extractors — the real side
// (TypeScript compiler API, `extract-real.ts`) and the denext side (`deno doc`,
// `extract-denext.ts`) — emit `Surface` records so `diff.ts` can compare them without
// caring which toolchain produced them.

/** One call signature reduced to what structural parity checks. */
export interface CallSig {
  /** Total declared parameter count (including optional and rest). */
  arity: number;
  /** Count of leading required parameters (before the first optional/rest). */
  requiredArity: number;
  /** Whether the signature ends in a rest parameter (`...args`). */
  restParam: boolean;
}

/** A single exported symbol, normalized across toolchains. */
export interface SurfaceSymbol {
  name: string;
  /**
   * Coarse kind for reporting. Note that denext frequently exports callables as
   * `const` (deno doc: `variable`); the diff treats value-ness, not this label, as
   * the contract — see {@link SurfaceSymbol.isValue}.
   */
  kind: string;
  /** Present as a runtime value (importable at runtime, not type-only). */
  isValue: boolean;
  /** Present as a type (interface/type alias/namespace-as-type). */
  isType: boolean;
  /**
   * Resolved call signatures, or `undefined` when the toolchain could not resolve
   * them (e.g. denext's `export const x: typeof impl = impl`). `undefined` means
   * "unknown", and the diff skips arity checks rather than inventing a mismatch.
   */
  callSignatures?: CallSig[];
  /** Type-parameter count, or `undefined` when unresolved. */
  typeParamCount?: number;
  /**
   * Member names for object/namespace/interface exports (e.g. `Children.map`), or
   * `undefined` when unresolved. `undefined` skips the member check.
   */
  members?: string[];
}

/** The full surface of one specifier. */
export interface Surface {
  specifier: string;
  /** Absent when the real specifier does not resolve in the installed version. */
  resolved: boolean;
  symbols: Record<string, SurfaceSymbol>;
}

/** The committed real-side baseline: pinned versions + one surface per specifier. */
export interface Baseline {
  /** Exact resolved versions of the real packages at capture time. */
  versions: Record<string, string>;
  /** ISO date the baseline was captured (passed in; scripts can't read the clock). */
  capturedAt?: string;
  surfaces: Surface[];
}
