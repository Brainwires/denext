// The Profiler tab's data side: export a recording as JSON (and read one back), per-component
// totals over a set of commits, the comparison of two such totals, and the component filter.
// Pure (no DOM) so each piece is unit-testable; the tab (./profiler.ts) draws them.

import type { CommitSummary, FlameNode } from "../devtools-inspect.ts";

/** The `format` tag of an exported recording. */
const PROFILE_FORMAT = "denext-profile";

/** One exported commit: its summary and its flamegraph (null when none was kept). */
export interface ExportedCommit extends CommitSummary {
  tree: FlameNode | null;
}

/** An exported Profiler recording (the Export button's JSON file). */
export interface ProfileExport {
  format: typeof PROFILE_FORMAT;
  version: 1;
  commits: ExportedCommit[];
}

/**
 * A recording as its exportable JSON shape.
 *
 * @param commits The recorded commit summaries.
 * @param treeOf The flamegraph of a commit by index.
 * @returns The export.
 */
export function exportRecording(
  commits: CommitSummary[],
  treeOf: (index: number) => FlameNode | null,
): ProfileExport {
  return {
    format: PROFILE_FORMAT,
    version: 1,
    commits: commits.map((c) => ({ ...c, tree: treeOf(c.index) })),
  };
}

/**
 * Read an exported recording back, or null when `text` is not one.
 *
 * @param text The file's text.
 * @returns The recording, or null.
 */
export function parseRecording(text: string): ProfileExport | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const v = value as Partial<ProfileExport> | null;
  if (!v || v.format !== PROFILE_FORMAT || !Array.isArray(v.commits)) return null;
  return v as ProfileExport;
}

/** Whether a component name passes the filter (case-insensitive substring; empty passes all). */
export function matchesFilter(name: string, filter: string): boolean {
  return filter === "" || name.toLowerCase().includes(filter.toLowerCase());
}

/** Every component in a flamegraph, the synthetic root excluded. */
function eachNode(root: FlameNode, fn: (node: FlameNode) => void): void {
  for (const child of root.children) {
    fn(child);
    eachNode(child, fn);
  }
}

/** Whether a commit rendered a component the filter keeps (any commit passes an empty one). */
export function commitMatches(tree: FlameNode | null, filter: string): boolean {
  if (filter === "") return true;
  let hit = false;
  if (tree) eachNode(tree, (n) => (hit ||= n.didRender && matchesFilter(n.name, filter)));
  return hit;
}

/** Self time and render count per component name. */
export type ComponentTotals = Map<string, { selfMs: number; renders: number }>;

/**
 * Self time and render count per component name over a set of commits.
 *
 * @param trees The commits' flamegraphs (a null one is skipped).
 * @returns The totals.
 */
export function totalsOf(trees: ReadonlyArray<FlameNode | null>): ComponentTotals {
  const out: ComponentTotals = new Map();
  for (const tree of trees) {
    if (!tree) continue;
    eachNode(tree, (n) => {
      if (!n.didRender) return;
      const t = out.get(n.name) ?? { selfMs: 0, renders: 0 };
      t.selfMs += n.selfMs;
      t.renders += 1;
      out.set(n.name, t);
    });
  }
  return out;
}

/** One component in a comparison. */
export interface CompareRow {
  name: string;
  /** Self time in the baseline (ms). */
  baseMs: number;
  /** Self time now (ms). */
  nowMs: number;
  /** `nowMs − baseMs`. */
  deltaMs: number;
  /** Renders in the baseline. */
  baseRenders: number;
  /** Renders now. */
  nowRenders: number;
}

/**
 * Compare two sets of totals: every component either rendered, largest change first.
 *
 * @param base The baseline.
 * @param now The current totals.
 * @param filter The component filter (rows it rejects are dropped).
 * @returns The rows.
 */
export function compareTotals(
  base: ComponentTotals,
  now: ComponentTotals,
  filter = "",
): CompareRow[] {
  const rows: CompareRow[] = [];
  for (const name of new Set([...base.keys(), ...now.keys()])) {
    if (!matchesFilter(name, filter)) continue;
    const b = base.get(name), n = now.get(name);
    const baseMs = b?.selfMs ?? 0, nowMs = n?.selfMs ?? 0;
    rows.push({
      name,
      baseMs,
      nowMs,
      deltaMs: nowMs - baseMs,
      baseRenders: b?.renders ?? 0,
      nowRenders: n?.renders ?? 0,
    });
  }
  return rows.sort((a, b) =>
    Math.abs(b.deltaMs) - Math.abs(a.deltaMs) || a.name.localeCompare(b.name)
  );
}
