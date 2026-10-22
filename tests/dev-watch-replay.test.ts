// The dev watcher drops the history macOS's FSEvents replays to a new watch: a change event, in
// the first moments after the watchers start, for a file last written before they started.

import { assert, assertFalse } from "@std/assert";
import { join } from "@std/path";
import { startupReplay } from "../src/build/dev-server/watch.ts";

const START = 1_000_000;
const mtimes = (m: Record<string, number | null>) => (p: string) => m[p] ?? null;

Deno.test("startupReplay: a file written before the start is a replay while the start is recent", () => {
  const before = mtimes({ "/p/app/page.tsx": START - 5 });
  assert(startupReplay("/p/app/page.tsx", START, START + 300, before));
  assert(startupReplay("/p/app/page.tsx", START, START + 2000, before));
  // Later, the same event is an edit (an extracted archive keeps old mtimes on purpose).
  assertFalse(startupReplay("/p/app/page.tsx", START, START + 2001, before));
});

Deno.test("startupReplay: an edit after the start, or a file that is gone, always counts", () => {
  assertFalse(startupReplay("/a.ts", START, START + 10, mtimes({ "/a.ts": START })));
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
    assertFalse(startupReplay(file, mtime, mtime + 2), "written at the start");
    assertFalse(startupReplay(join(dir, "missing.tsx"), mtime + 1, mtime + 2), "gone");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
