// The parity comparison. Given the real baseline surfaces and denext's extracted
// surfaces, report every structural deviation, classified by severity, with the
// waiver list subtracted.
//
// Severity model (matches the "same surface, internals may vary" promise):
//   error  — a real RUNTIME value that denext lacks, exposes as type-only, gives an
//            incompatible arity, or whose object/namespace members it is missing.
//            These break `import { x } from "react"` or a real call site. The test
//            fails on any unwaived error.
//   warn   — a real TYPE-only export denext does not surface. denext intentionally
//            under-exports Next's large type universe, so these are surfaced but do
//            not fail the build; promote specific ones by removing a waiver / raising
//            them if they matter.
//   info   — a denext-only export (extra surface). Never a problem.

import type { CallSig, Surface, SurfaceSymbol } from "./types.ts";
import { isWaived, type Waiver } from "./waivers.ts";

export type Severity = "error" | "warn" | "info";
export type Category =
  | "MISSING_VALUE"
  | "VALUE_AS_TYPE_ONLY"
  | "ARITY_MISMATCH"
  | "MEMBER_MISSING"
  | "MISSING_TYPE"
  | "EXTRA";

export interface Finding {
  specifier: string;
  symbol: string;
  category: Category;
  severity: Severity;
  detail: string;
  /** Suppressed by an intentional (permanent-policy) waiver. */
  waived: boolean;
  /** Suppressed by the known-gaps ledger — a real, tracked, not-yet-closed deviation. */
  knownGap: boolean;
}

export interface DiffResult {
  findings: Finding[];
  /** Unexpected error findings — neither waived nor a known gap. Must be empty. */
  errors: Finding[];
  ok: boolean;
}

/** Stable key for a finding, used to match known-gaps ledger entries. */
export function findingKey(specifier: string, symbol: string, category: Category): string {
  return `${specifier}#${symbol}#${category}`;
}

const SEVERITY: Record<Category, Severity> = {
  MISSING_VALUE: "error",
  VALUE_AS_TYPE_ONLY: "error",
  ARITY_MISMATCH: "error",
  MEMBER_MISSING: "error",
  MISSING_TYPE: "warn",
  EXTRA: "info",
};

/** Envelope of a symbol's overload set: the loosest requirement callers face. */
function envelope(sigs: CallSig[]): { minRequired: number; maxArity: number; anyRest: boolean } {
  return {
    minRequired: Math.min(...sigs.map((s) => s.requiredArity)),
    maxArity: Math.max(...sigs.map((s) => s.arity)),
    anyRest: sigs.some((s) => s.restParam),
  };
}

/** Can a caller of the real signature call denext's without an arity error? */
function arityCompatible(real: CallSig[], den: CallSig[]): { ok: boolean; detail: string } {
  const r = envelope(real);
  const d = envelope(den);
  // denext must not demand more required args than the real minimum requires.
  if (d.minRequired > r.minRequired) {
    return {
      ok: false,
      detail:
        `denext requires ${d.minRequired} arg(s) but React/Next requires as few as ${r.minRequired}`,
    };
  }
  // denext must accept at least as many positional args as real allows.
  if (!d.anyRest && d.maxArity < r.maxArity) {
    return {
      ok: false,
      detail: `denext accepts up to ${d.maxArity} arg(s) but React/Next allows ${r.maxArity}`,
    };
  }
  return { ok: true, detail: "" };
}

function compareSymbol(
  specifier: string,
  name: string,
  real: SurfaceSymbol,
  den: SurfaceSymbol | undefined,
): Finding[] {
  const out: Finding[] = [];
  const add = (category: Category, detail: string) =>
    out.push({
      specifier,
      symbol: name,
      category,
      severity: SEVERITY[category],
      detail,
      waived: false,
      knownGap: false,
    });

  const realIsValue = real.isValue;
  if (!den) {
    if (realIsValue) add("MISSING_VALUE", "runtime export missing from denext");
    else add("MISSING_TYPE", "type export missing from denext");
    return out;
  }
  if (realIsValue && !den.isValue) {
    add("VALUE_AS_TYPE_ONLY", "React/Next exports a runtime value; denext exposes it as type-only");
  }
  // Arity — only when both toolchains resolved call signatures.
  if (real.callSignatures?.length && den.callSignatures?.length) {
    const a = arityCompatible(real.callSignatures, den.callSignatures);
    if (!a.ok) add("ARITY_MISMATCH", a.detail);
  }
  // Members — only when both resolved a member list.
  if (real.members && den.members) {
    const have = new Set(den.members);
    const missing = real.members.filter((m) => !have.has(m));
    if (missing.length) add("MEMBER_MISSING", `missing member(s): ${missing.join(", ")}`);
  }
  return out;
}

/**
 * Diff real baseline surfaces against denext's, apply waivers, and decide parity.
 *
 * @param realSurfaces The committed baseline (real React/Next surface).
 * @param denextSurfaces denext's extracted surface (same specifiers).
 * @param waivers Intentional, documented deviations to suppress.
 */
export function diffSurfaces(
  realSurfaces: Surface[],
  denextSurfaces: Surface[],
  waivers: Waiver[],
  knownGaps: Set<string> = new Set(),
): DiffResult {
  const denBySpec = new Map(denextSurfaces.map((s) => [s.specifier, s]));
  const findings: Finding[] = [];

  for (const real of realSurfaces) {
    if (!real.resolved) continue; // nothing authoritative to require
    const den = denBySpec.get(real.specifier);
    const denSyms = den?.symbols ?? {};

    for (const [name, sym] of Object.entries(real.symbols)) {
      // The default export's *identity* legitimately varies (React's default is a
      // namespace object; Next's are components), and its presence is covered by the
      // behavior tests — so it is not part of the structural signature diff.
      if (name === "default") continue;
      findings.push(...compareSymbol(real.specifier, name, sym, denSyms[name]));
    }
    // Extras (informational): denext exports the real side does not have.
    for (const name of Object.keys(denSyms)) {
      if (name === "default") continue;
      if (!(name in real.symbols)) {
        findings.push({
          specifier: real.specifier,
          symbol: name,
          category: "EXTRA",
          severity: "info",
          detail: "denext-only export (not present in React/Next)",
          waived: false,
          knownGap: false,
        });
      }
    }
  }

  for (const f of findings) {
    f.waived = isWaived(f.specifier, f.symbol, f.category, waivers);
    if (!f.waived) f.knownGap = knownGaps.has(findingKey(f.specifier, f.symbol, f.category));
  }
  const errors = findings.filter((f) => f.severity === "error" && !f.waived && !f.knownGap);
  return { findings, errors, ok: errors.length === 0 };
}

/** Human-readable summary, grouped by specifier, errors first. */
export function formatReport(result: DiffResult): string {
  const lines: string[] = [];
  const errors = result.errors;
  const warns = result.findings.filter((f) => f.severity === "warn" && !f.waived && !f.knownGap);
  const waived = result.findings.filter((f) => f.waived);
  const gaps = result.findings.filter((f) => f.knownGap);
  const extras = result.findings.filter((f) => f.severity === "info");

  lines.push(
    `parity: ${
      result.ok ? "PASS" : "FAIL"
    } — ${errors.length} unexpected error(s), ${warns.length} warning(s), ` +
      `${gaps.length} known gap(s), ${waived.length} waived, ${extras.length} denext-only`,
  );

  const bySpec = (fs: Finding[]) => {
    const m = new Map<string, Finding[]>();
    for (const f of fs) (m.get(f.specifier) ?? m.set(f.specifier, []).get(f.specifier)!).push(f);
    return m;
  };

  if (errors.length) {
    lines.push("\nERRORS (must fix or waive):");
    for (const [spec, fs] of bySpec(errors)) {
      lines.push(`  ${spec}`);
      for (const f of fs) lines.push(`    ✗ ${f.symbol} [${f.category}] — ${f.detail}`);
    }
  }
  if (warns.length) {
    lines.push("\nWARNINGS (missing type-only exports; non-blocking):");
    for (const [spec, fs] of bySpec(warns)) {
      lines.push(`  ${spec}: ${fs.map((f) => f.symbol).join(", ")}`);
    }
  }
  return lines.join("\n");
}
