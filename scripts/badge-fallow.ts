// Generate the Shields.io endpoint JSON for the fallow health-score badge.
//
//   deno task badge:fallow          # (re)write .github/badges/fallow.json
//
// Runs `fallow health --format json` and records the grade + score. The score is
// NOT a deterministic function of the source (its hotspot penalty is derived from
// git churn), so there is no `--check` gate: regenerate it as part of a release
// (the release checklist in CONTRIBUTING.md) and commit the JSON. See
// CONTRIBUTING.md → "The health score" for what the number means and why ~88 is
// the ceiling for an actively developed repo.

import { fromFileUrl } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));
const BADGE_PATH = `${REPO_ROOT}.github/badges/fallow.json`;

interface HealthScore {
  score: number;
  grade: string;
  penalties: Record<string, number>;
}

/**
 * Run `fallow health` and return its health-score block. The measured coverage map
 * is passed when present so CRAP is scored with real numbers (the score itself does
 * not depend on it, but the findings count printed below does). Exit code 1 means
 * "findings present", not failure — the JSON report is still complete.
 */
async function healthScore(): Promise<HealthScore & { findings: number }> {
  const coverage = `${REPO_ROOT}coverage/coverage-final.json`;
  const withCoverage = await Deno.stat(coverage).then(() => true, () => false);
  const cmd = new Deno.Command("fallow", {
    args: [
      "health",
      "--format",
      "json",
      "--quiet",
      ...(withCoverage ? ["--coverage", coverage] : []),
    ],
    cwd: REPO_ROOT,
    stdout: "piped",
    stderr: "inherit",
  });
  const { code, stdout } = await cmd.output();
  const text = new TextDecoder().decode(stdout);
  if (code > 1 || !text.trim().startsWith("{")) {
    throw new Error(`fallow health exited with ${code} and no report`);
  }
  const report = JSON.parse(text) as { health_score: HealthScore; findings: unknown[] };
  return { ...report.health_score, findings: report.findings.length };
}

/** Shields colors by grade (fallow's own badge palette). */
const COLORS: Record<string, string> = {
  A: "4c1",
  B: "97ca00",
  C: "dfb317",
  D: "fe7d37",
  F: "e05d44",
};

/** The Shields.io "endpoint" badge document. */
function badge(hs: HealthScore): Record<string, unknown> {
  return {
    schemaVersion: 1,
    label: "fallow health",
    message: `${hs.grade} · ${hs.score.toFixed(1)}`,
    color: COLORS[hs.grade] ?? "lightgrey",
  };
}

const hs = await healthScore();
await Deno.writeTextFile(BADGE_PATH, JSON.stringify(badge(hs), null, 2) + "\n");
const penalties = Object.entries(hs.penalties).filter(([, v]) => v > 0)
  .map(([k, v]) => `${k} −${v}`).join(", ") || "none";
console.log(
  `Wrote ${BADGE_PATH}: ${hs.grade} (${hs.score}); ${hs.findings} finding(s); penalties: ${penalties}`,
);
