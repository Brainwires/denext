// The dev watcher drops the history macOS's FSEvents replays to a new watch: a change event, in
// the first moments after the watchers start, for a file last written before they started.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import { startupReplay, watchProjectStructure } from "../src/build/platform-watch.ts";

const START = 1_000_000;
const mtimes = (m: Record<string, number | null>) => (p: string) => m[p] ?? null;

Deno.test("startupReplay: a file written before the start is a replay while the start is recent", () => {
  const before = mtimes({ "/p/app/page.tsx": START - 5 });
  assert(startupReplay("/p/app/page.tsx", START, START + 300, before));
  // A write just before the watch opens can share its millisecond.
  assert(startupReplay("/a.ts", START, START + 10, mtimes({ "/a.ts": START })));
  assert(startupReplay("/p/app/page.tsx", START, START + 2000, before));
  // Later, the same event is an edit (an extracted archive keeps old mtimes on purpose).
  assertFalse(startupReplay("/p/app/page.tsx", START, START + 2001, before));
});

Deno.test("startupReplay: an edit after the start, or a file that is gone, always counts", () => {
  assertFalse(startupReplay("/a.ts", START, START + 10, mtimes({ "/a.ts": START + 1 })));
  assertFalse(startupReplay("/a.ts", START, START + 10, mtimes({ "/a.ts": START + 7 })));
  assertFalse(startupReplay("/gone.ts", START, START + 10, mtimes({})));
});

Deno.test("startupReplay: reads the file's real modification time by default", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_watch_replay_" });
  try {
    const file = join(dir, "page.tsx");
    await Deno.writeTextFile(file, "export default 1;\n");
    const mtime = (await Deno.stat(file)).mtime!.getTime();
    assert(startupReplay(file, mtime + 1, mtime + 2), "written before the start");
    assert(startupReplay(file, mtime, mtime + 2), "written in the start's millisecond");
    assertFalse(startupReplay(file, mtime - 1, mtime + 2), "written after the start");
    assertFalse(startupReplay(join(dir, "missing.tsx"), mtime + 1, mtime + 2), "gone");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("watchProjectStructure: what a scaffold wrote before the watch is no change; a new file is", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_watch_replay_" }));
  const controller = new AbortController();
  try {
    // A project written just before the server starts: on macOS each of these (the folder too,
    // which would forget the platform scan) comes back as an event of the new watch.
    await Deno.mkdir(join(dir, "components"));
    await Deno.writeTextFile(join(dir, "components", "Badge.tsx"), "export const a = 1;\n");
    await Deno.writeTextFile(join(dir, "components", "Badge.ios.tsx"), "export const a = 2;\n");
    const created: string[] = [];
    const edited: string[] = [];
    watchProjectStructure(
      dir,
      (paths) => created.push(...paths),
      controller.signal,
      (paths) => edited.push(...paths),
    );
    // Past FSEvents's latency (about 100 ms, already long on an idle machine).
    await new Promise((r) => setTimeout(r, 600));
    assertEquals(created, []);
    assertEquals(edited, []);
    const added = join(dir, "components", "Pill.ios.tsx");
    await Deno.writeTextFile(added, "export const b = 1;\n");
    for (let i = 0; i < 100 && !(created.includes(added) && edited.includes(added)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(created.includes(added), `a new file is reported: ${created}`);
    assert(edited.includes(added), `a new file is an edit: ${edited}`);
  } finally {
    controller.abort();
    await new Promise((r) => setTimeout(r, 0));
    await Deno.remove(dir, { recursive: true });
  }
});
