// The check listing and findings shared by `denext mobile doctor` and `denext desktop doctor`.

/** One problem with its fix, as both doctors report it. */
export interface DoctorFindingLike {
  /** The check that found it. */
  readonly check: string;
  /** `error` or `warning`. */
  readonly level: "error" | "warning";
  /** What is wrong. */
  readonly message: string;
  /** How to fix it. */
  readonly fix: string;
}

/**
 * A doctor report's lines: one mark per check (✔ / ! / ✖), each finding with its fix, then the
 * totals.
 *
 * @param checks The checks that ran, in order.
 * @param findings What they found.
 * @returns The lines, without a trailing newline.
 */
export function formatDoctorFindings(
  checks: readonly string[],
  findings: readonly DoctorFindingLike[],
): string[] {
  const lines = checks.map((id) => {
    const found = findings.filter((f) => f.check === id);
    const mark = found.some((f) => f.level === "error") ? "✖" : found.length > 0 ? "!" : "✔";
    return `  ${mark} ${id}`;
  });
  for (const f of findings) {
    lines.push(
      "",
      `  ${f.level === "error" ? "ERROR  " : "WARNING"} [${f.check}] ${f.message}`,
      `          fix: ${f.fix}`,
    );
  }
  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.length - errors;
  lines.push(
    "",
    errors + warnings === 0
      ? "  All checks passed."
      : `  ${errors} error(s), ${warnings} warning(s).`,
  );
  return lines;
}
