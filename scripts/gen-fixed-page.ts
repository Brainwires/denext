// Generate the "Fixed in denext" docs page from the catalog.
//
// `catalog/fixed-in-denext.json` is the single source of truth: every claim on
// https://denext.dev/docs/fixed comes from it, and tests/catalog-fixed.test.ts checks both that
// each entry's evidence test still exists and that the committed page equals this output.
//
//   deno task docs:fixed     # regenerate site/app/docs/fixed/content.md
//   deno task docs:build     # regenerate everything + export the site

import { dirname, fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
/** The catalog (repo-relative path). */
export const CATALOG_PATH = "catalog/fixed-in-denext.json";
/** Where the generated page is committed. */
export const FIXED_OUT = `${ROOT}site/app/docs/fixed/content.md`;

/** How denext's behaviour relates to the other stack's. */
export type FixKind = "fix" | "difference" | "tradeoff" | "capability";

/** A test that proves an entry: the file and the `Deno.test` name in it. */
export interface Evidence {
  test: string;
  name: string;
}

/** One catalog entry. */
export interface FixEntry {
  id: string;
  title: string;
  group: string;
  kind: FixKind;
  /** The problem as people describe it. */
  problem: string;
  /** Error text, verbatim, as people paste it into a search box. */
  errorText: string[];
  affects: { stack: string; versions: string };
  /** Why it happens. */
  cause: string;
  /** What denext does. */
  denext: string;
  /** For security advisories: the upstream fix to apply first. */
  upstreamFirst: string | null;
  evidence: Evidence[];
  /** The docs page that owns the detail (`/docs/<slug>`). */
  docs: string;
}

/** The catalog file. */
export interface FixCatalog {
  version: number;
  description: string;
  kinds: Record<FixKind, string>;
  groups: Record<string, string>;
  entries: FixEntry[];
}

/** Read the catalog. */
export function readCatalog(): FixCatalog {
  return JSON.parse(Deno.readTextFileSync(`${ROOT}${CATALOG_PATH}`)) as FixCatalog;
}

/** The heading id the docs renderer gives `text` (same rule as its `slugify`). */
export function headingId(text: string): string {
  return text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim()
    .replace(/\s/g, "-");
}

const KIND_LABEL: Record<FixKind, string> = {
  fix: "fix",
  difference: "difference",
  tradeoff: "trade-off",
  capability: "capability",
};

const GITHUB = "https://github.com/Brainwires/denext/blob/main/";

/** A Markdown table with padded columns, as `deno fmt` lays it out (so the output is fmt-stable). */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length), 3));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}

function entrySection(e: FixEntry): string[] {
  const out = [`### ${e.title}`, ""];
  out.push(
    `**Stack:** ${e.affects.stack} (${e.affects.versions}) · **Kind:** ${KIND_LABEL[e.kind]}`,
    "",
  );
  if (e.upstreamFirst) out.push(`**Upgrade first.** ${e.upstreamFirst}`, "");
  out.push(`**The problem.** ${e.problem}`, "");
  if (e.errorText.length) {
    out.push("```text", ...e.errorText, "```", "");
  }
  out.push(`**Why it happens.** ${e.cause}`, "");
  out.push(`**What denext does.** ${e.denext}`, "");
  out.push("**Evidence.**", "");
  for (const ev of e.evidence) {
    out.push(`- [\`${ev.test}\`](${GITHUB}${ev.test}): "${ev.name}"`);
  }
  out.push("", `More: [${e.docs}](${e.docs}).`, "");
  return out;
}

/** The page's Markdown (frontmatter included). */
export function generateFixedPage(catalog: FixCatalog = readCatalog()): string {
  // Entries in page order: by group (catalog order of `groups`), then catalog order.
  const ordered = Object.keys(catalog.groups).flatMap((g) =>
    catalog.entries.filter((e) => e.group === g)
  );
  const out = [
    "---",
    "title: Fixed in denext",
    "slug: fixed",
    "lead: Problems people hit on Next.js, React, Vite and React Native stacks that denext handles, each backed by a named test.",
    `generated: from ${CATALOG_PATH} by deno task docs:fixed (edit the catalog, not this file)`,
    "---",
    "",
    "denext lets you write an app once and ship it to the web, iOS, Android and the desktop. Its API",
    "is surface compatible with React and the Next.js App Router, so existing packages keep working,",
    "and it stays lightweight: its own small React core and no runtime npm dependencies. This page",
    "lists problems teams run into on those stacks and what denext does about each one.",
    "",
    "Every entry names the test in the denext repository that proves it; a CI check fails when one",
    "of those tests disappears or is renamed, so the claims can't go stale silently. Each entry is",
    "labelled:",
    "",
    ...table(
      ["Kind", "Meaning"],
      (Object.keys(KIND_LABEL) as FixKind[]).map((k) => [KIND_LABEL[k], catalog.kinds[k]]),
    ),
    "",
    "For security advisories the fix for an existing app is to upgrade it; those entries say so",
    "first. Search this page for the error text you are seeing.",
    "",
    "## Try it on your project",
    "",
    "`denext migrate --check` reports what `denext migrate` would change in your project, what will",
    "not migrate and why, and an overall verdict. It writes nothing, so it only needs read access",
    "to the project (plus network access to jsr.io, to fetch denext itself):",
    "",
    "```sh",
    "deno run --allow-read --allow-env --allow-net=jsr.io jsr:@denext/denext/cli migrate --check",
    "```",
    "",
    "Add `--json` for a machine-readable report, and `--allow-run` to let it evaluate a",
    "`next.config.*` (in a subprocess that can only read the project). See",
    "[Migrating from Next.js](/docs/migrating) for the migration itself.",
    "",
    "## Index",
    "",
    ...table(
      ["Problem", "Stack", "Kind"],
      ordered.map((e) => [
        `[${e.title}](#${headingId(e.title)})`,
        e.affects.stack,
        KIND_LABEL[e.kind],
      ]),
    ),
    "",
  ];
  for (const [group, label] of Object.entries(catalog.groups)) {
    const entries = catalog.entries.filter((e) => e.group === group);
    if (entries.length === 0) continue;
    out.push(`## ${label}`, "");
    for (const e of entries) out.push(...entrySection(e));
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

if (import.meta.main) {
  const md = generateFixedPage();
  await Deno.mkdir(dirname(FIXED_OUT), { recursive: true });
  await Deno.writeTextFile(FIXED_OUT, md);
  console.log(`fixed page: ${readCatalog().entries.length} entries → ${FIXED_OUT}`);
}
