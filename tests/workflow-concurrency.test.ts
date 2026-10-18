// The workflows' triggers and concurrency keep GitHub's job queue short without losing a release's
// coverage.
//
// The account runs at most 20 jobs at once (5 of them macOS), so a push run that a newer push to
// the same branch made stale is cancelled. What a release is gated on is never cancelled: a run on
// `main`, a tag's run, a pull request's, and a dispatch (scripts/release-ci.ts reads dispatched
// ci.yml and desktop-ci.yml runs on HEAD). And no workflow runs on a schedule.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { parse } from "@std/yaml";

const DIR = fromFileUrl(new URL("../.github/workflows/", import.meta.url));

interface Workflow {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean | string };
}

async function workflows(): Promise<[string, Workflow][]> {
  const out: [string, Workflow][] = [];
  for await (const entry of Deno.readDir(DIR)) {
    if (!entry.isFile || !/\.ya?ml$/.test(entry.name)) continue;
    out.push([entry.name, parse(await Deno.readTextFile(join(DIR, entry.name))) as Workflow]);
  }
  return out.toSorted(([a], [b]) => a.localeCompare(b));
}

/** The cancel conditions a push/PR workflow may use: each cancels branch pushes only, never `main`. */
const CANCEL_PUSHES_ONLY = [
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/development' }}",
  "${{ github.event_name == 'push' && github.ref_type == 'branch' && github.ref != 'refs/heads/main' }}",
];

Deno.test("no workflow runs on a schedule", async () => {
  const scheduled = (await workflows()).filter(([, wf]) => wf.on && "schedule" in wf.on);
  assertEquals(scheduled.map(([name]) => name), []);
});

Deno.test("every push / pull_request workflow cancels only a superseded branch push", async () => {
  for (const [name, wf] of await workflows()) {
    const on = wf.on ?? {};
    if (!("push" in on) && !("pull_request" in on)) continue;
    const conc = wf.concurrency;
    assert(conc?.group, `${name}: no concurrency group`);
    assert(conc.group.includes("${{ github.ref }}"), `${name}: the group is not per ref`);
    const cancel = conc["cancel-in-progress"];
    if (cancel === false) continue;
    // A push run must not cancel a dispatched one on the same ref: the event is in the group.
    assert(
      conc.group.includes("${{ github.event_name }}"),
      `${name}: the group lacks the event, so a push would cancel a dispatch`,
    );
    assert(
      typeof cancel === "string" && CANCEL_PUSHES_ONLY.includes(cancel),
      `${name}: cancel-in-progress may cancel a tag, main, PR or dispatch run: ${cancel}`,
    );
  }
});

Deno.test("a tag's publish run is never cancelled", async () => {
  const publish = (await workflows()).find(([name]) => name === "publish.yml")?.[1];
  assert(publish, "publish.yml");
  assertEquals(publish.concurrency?.["cancel-in-progress"], false);
});
