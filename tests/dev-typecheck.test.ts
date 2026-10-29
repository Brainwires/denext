// The dev loop's background `deno check`: which changed paths it checks, and that the dev
// server's stop signal ends it (a check left running holds the project directory open, which
// Windows then refuses to remove).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  backgroundSettled,
  runTypeCheck,
  trackBackground,
  typeCheck,
  typeCheckFiles,
} from "../src/build/dev-server/dev-endpoints.ts";
import type { DevState } from "../src/build/dev-server/state.ts";
import { removeTempDir } from "./helpers/temp.ts";

Deno.test("typeCheckFiles: TypeScript sources, never .denext output, with either separator", () => {
  assertEquals(
    typeCheckFiles([
      "/p/app/page.tsx",
      "/p/lib/a.ts",
      "/p/app/style.css",
      "/p/.denext/server-cache/x.ts",
      "C:\\p\\app\\page.tsx",
      "C:\\p\\.denext\\server-cache\\x.ts",
    ]),
    ["/p/app/page.tsx", "/p/lib/a.ts", "C:\\p\\app\\page.tsx"],
  );
});

/** A dev session over `dir` with `signal` (only what the check reads). */
function session(dir: string, signal?: AbortSignal) {
  return {
    paths: { projectDir: dir, configPath: "" },
    options: { signal },
  } as unknown as Pick<DevState, "paths" | "options">;
}

Deno.test("runTypeCheck: reports a type error, and the server's stop signal cancels the check", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_typecheck_" });
  try {
    const file = join(dir, "bad.ts");
    await Deno.writeTextFile(file, "export const n: number = 'not a number';\n");
    assertStringIncludes((await runTypeCheck(session(dir), [file])) ?? "", "TS2322");

    const stopped = new AbortController();
    stopped.abort();
    assertEquals(await runTypeCheck(session(dir, stopped.signal), [file]), null);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("typeCheck: the run is tracked until its child has exited, so a stopped server waits", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_typecheck_bg_" });
  try {
    const file = join(dir, "ok.ts");
    await Deno.writeTextFile(file, "export const n: number = 1;\n");
    const stop = new AbortController();
    const st = {
      ...session(dir, stop.signal),
      compatP: Promise.resolve(false),
      typeCheckToken: 0,
      background: new Set<Promise<void>>(),
    } as unknown as DevState;
    // Another test file running in this process may have turned the dev check off
    // (DENEXT_DEV_TYPECHECK=0, read at each edit): then track a check here directly.
    typeCheck(st, [file]);
    if (st.background.size === 0) {
      trackBackground(st, runTypeCheck(st, [file]).then(() => {}));
    }
    assertEquals(st.background.size, 1, "the check runs in the session's background");
    stop.abort(); // the server stops: the check's child is ended
    await backgroundSettled(st);
    // Under the op / resource sanitizers a child still exiting here fails this test.
    assertEquals(st.background.size, 0);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("backgroundSettled waits for runs started while it waits", async () => {
  const st = { background: new Set<Promise<void>>() };
  const order: string[] = [];
  let release!: () => void;
  trackBackground(
    st,
    new Promise<void>((r) => release = r).then(() => {
      order.push("first");
      trackBackground(st, Promise.resolve().then(() => void order.push("second")));
    }),
  );
  const settled = backgroundSettled(st).then(() => order.push("settled"));
  release();
  await settled;
  assertEquals(order, ["first", "second", "settled"]);
  assertEquals(await backgroundSettled({ background: new Set() }), undefined);
});
