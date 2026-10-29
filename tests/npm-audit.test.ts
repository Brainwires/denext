// `deno task audit:npm` (scripts/npm-audit.ts): `deno audit` over the root deno.lock, failing on a
// high or critical advisory unless security/npm-audit-allow.json holds it until a date. ci.yml's
// `cargo-audit` job and `deno task precheck` run it.

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import {
  ALLOW_FILE,
  type Allowed,
  isNpmAuditInput,
  judge,
  parseAllowlist,
  parseAudit,
} from "../scripts/npm-audit.ts";

const ROOT = new URL("../", import.meta.url);

/** `deno audit`'s report with NO_COLOR=1, as Deno 2.9 prints it. */
const REPORT =
  `╭ GraphQL Tools has prototype pollution in well-established utility function \`mergeDeep\`
│ Severity:   high
│ Package:    @graphql-tools/utils
│ Vulnerable: <=12.0.0
╰ Info:       https://github.com/advisories/GHSA-7mx3-vvmw-hjmv

╭ esbuild enables any website to send any requests to the development server and read the response
│ Severity:   moderate
│ Package:    esbuild
│ Vulnerable: <=0.24.2
╰ Info:       https://github.com/advisories/GHSA-67mh-4wv8-2f99

╭ Zod can exhaust memory while validating oversized constrained collections
│ Severity:   critical
│ Package:    zod
│ Vulnerable: <4.6.6
╰ Info:       https://github.com/advisories/GHSA-mrhx-c7xc-m3w5

Found 3 vulnerabilities
Severity: 0 low, 1 moderate, 1 high, 1 critical
`;

Deno.test("npm audit: the report parses into advisories", () => {
  const advisories = parseAudit(REPORT);
  assertEquals(advisories?.map((a) => [a.id, a.package, a.severity]), [
    ["GHSA-7mx3-vvmw-hjmv", "@graphql-tools/utils", "high"],
    ["GHSA-67mh-4wv8-2f99", "esbuild", "moderate"],
    ["GHSA-mrhx-c7xc-m3w5", "zod", "critical"],
  ]);
  assertEquals(advisories?.[0].vulnerable, "<=12.0.0");
  assert(advisories?.[0].title.startsWith("GraphQL Tools has prototype pollution"));
  assertEquals(parseAudit("No known vulnerabilities found\n"), []);
  // A registry error is no report: the audit must not pass on it.
  assertEquals(parseAudit("error: failed to reach the advisory service"), null);
});

Deno.test("npm audit: high and critical fail, moderate passes", () => {
  const verdict = judge(parseAudit(REPORT)!, [], "2026-10-29");
  assertEquals(verdict.failing.map((a) => a.package), ["@graphql-tools/utils", "zod"]);
  assertEquals(verdict.allowed, []);
});

Deno.test("npm audit: an allowlist entry applies through its date, then expires", () => {
  const allow: Allowed[] = [{
    id: "GHSA-mrhx-c7xc-m3w5",
    package: "zod",
    reason: "4.6.6 is under the dependency-age hold",
    until: "2026-10-30",
  }];
  const held = judge(parseAudit(REPORT)!, allow, "2026-10-30");
  assertEquals(held.failing.map((a) => a.package), ["@graphql-tools/utils"]);
  assertEquals(held.allowed.map((a) => a.package), ["zod"]);
  assertEquals(held.expired, []);
  const after = judge(parseAudit(REPORT)!, allow, "2026-10-31");
  assertEquals(after.failing.map((a) => a.package), ["@graphql-tools/utils", "zod"]);
  assertEquals(after.expired, allow);
  // The id must match the package it is reported against.
  const other = judge(parseAudit(REPORT)!, [{ ...allow[0], package: "zod-mini" }], "2026-10-29");
  assertEquals(other.failing.length, 2);
});

Deno.test("npm audit: the allowlist is checked, and the committed one is well formed", async () => {
  const entry = { id: "GHSA-mrhx-c7xc-m3w5", package: "zod", reason: "hold", until: "2026-10-30" };
  assertEquals(parseAllowlist(JSON.stringify({ allow: [entry] })), [entry]);
  assertThrows(() => parseAllowlist(JSON.stringify({ allow: [{ ...entry, id: "CVE-2026-1" }] })));
  assertThrows(() => parseAllowlist(JSON.stringify({ allow: [{ ...entry, reason: " " }] })));
  assertThrows(() => parseAllowlist(JSON.stringify({ allow: [{ ...entry, until: "soon" }] })));
  assertThrows(() => parseAllowlist(JSON.stringify({})));
  parseAllowlist(await Deno.readTextFile(new URL(ALLOW_FILE, ROOT)));
});

Deno.test("npm audit: the precheck inputs are the lockfile, the configs and the allowlist", () => {
  assert(isNpmAuditInput("deno.lock"));
  assert(isNpmAuditInput("deno.json"));
  assert(isNpmAuditInput("packages/graphql/deno.json"));
  assert(isNpmAuditInput(ALLOW_FILE));
  assertFalse(isNpmAuditInput("examples/graphql/deno.lock"));
  assertFalse(isNpmAuditInput("packages/graphql/mod.ts"));
});

Deno.test("npm audit: ci.yml runs it in a job a release needs green", async () => {
  const ci = parseYaml(
    await Deno.readTextFile(new URL(".github/workflows/ci.yml", ROOT)),
  ) as { jobs: Record<string, { steps: { run?: string }[] }> };
  const job = ci.jobs["cargo-audit"];
  assert(job.steps.some((s) => s.run?.includes("deno task audit:npm")));
  const { RELEASE_CI_JOBS } = await import("../scripts/release-ci.ts");
  assert(RELEASE_CI_JOBS.includes("cargo-audit"));
});
