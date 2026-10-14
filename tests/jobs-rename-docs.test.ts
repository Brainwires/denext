// denext 4.0 renamed background/scheduled "tasks" to "jobs" with no aliases (`denext task` is
// Deno's `deno task` now). The docs, guides, plugin READMEs and examples must not teach the old
// names: a reader who copies `defineTask` or `scheduledTasks` gets a config that fails to load.
// The CHANGELOG, the jobs page's own rename note, the old /docs/tasks page that points at it and
// the 4.0 upgrade guide are the only places allowed to say them.

import { assertEquals } from "@std/assert";
import { fromFileUrl, join, relative } from "@std/path";
import { walk } from "@std/fs/walk";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** The old 3.x names, each a whole identifier or path. */
const OLD = new RegExp(
  [
    String.raw`\b(?:defineTask|runTask|registerTask|getTask|isTask|taskNames)\b`,
    String.raw`\b(?:Task(?:Context|Definition|Retry|Backoff|RunRecord)|TasksConfig)\b`,
    String.raw`\b(?:sqlite|postgres)TaskHistoryStore\b|\bTaskHistory[A-Z]?\w*\b`,
    String.raw`\bscheduledTasks\b`,
    String.raw`\.denext/tasks\.db\b|\btask_runs\b`,
    String.raw`\btasks/(?:migrate|seed|<name>|cleanup)\.ts\b`,
    String.raw`\bdenext generate task\b`,
    String.raw`/cli task (?:migrate|seed)\b`,
  ].join("|"),
);

/** Files that may name the old spellings: the history and the pages that explain the rename. */
const ALLOWED = new Set([
  "CHANGELOG.md",
  "site/app/docs/jobs/page.tsx",
  "site/app/docs/tasks/page.tsx",
  "site/app/docs/changelog/content.md",
]);

/** The prose a reader learns denext from. */
const ROOTS = [
  "README.md",
  "FEATURES.md",
  "AGENTS.md",
  "ROADMAP.md",
  "MISSION.md",
  "KNOWN-DIFFERENCES.md",
  "KNOWN-LIMITATIONS.md",
  "site/app",
  "packages",
  "examples",
];

const SKIP_DIRS = /(^|\/)(node_modules|lib|vendor|ios|android|\.denext|out|dist)(\/|$)/;

async function* files(): AsyncGenerator<string> {
  for (const entry of ROOTS) {
    const abs = join(ROOT, entry);
    const stat = await Deno.stat(abs).catch(() => null);
    if (stat === null) continue;
    if (stat.isFile) {
      yield abs;
      continue;
    }
    for await (
      const f of walk(abs, {
        includeDirs: false,
        exts: [".md", ".mdx", ".ts", ".tsx"],
        skip: [SKIP_DIRS],
      })
    ) yield f.path;
  }
}

Deno.test("docs, plugin READMEs and examples teach jobs, never the 3.x task names", async () => {
  const hits: string[] = [];
  for await (const path of files()) {
    const rel = relative(ROOT, path).replaceAll("\\", "/");
    if (ALLOWED.has(rel)) continue;
    const lines = (await Deno.readTextFile(path)).split("\n");
    lines.forEach((line, i) => {
      // expo-task-manager's own `defineTask` is a different API.
      if (OLD.test(line) && !line.includes("expo-task-manager")) {
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assertEquals(hits, []);
});
