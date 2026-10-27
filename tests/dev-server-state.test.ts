// Dev-server state invariants that only show up under concurrency (no browser, no watcher):
// the route-manifest scan is single-flight after a rebuild, and a compat asset request that
// races a rebuild waits for the completed generation instead of answering 404 from a
// half-written directory.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveProject } from "../src/build/paths.ts";
import { compatBuildOf } from "../src/build/dev-server/compat.ts";
import { createDevHandler } from "../src/build/dev-server/handler.ts";
import { getManifest } from "../src/build/dev-server/manifest.ts";
import { createDevState } from "../src/build/dev-server/state.ts";
import { registerRouteSynthesizer } from "../src/router/manifest.ts";
import { defaultLoader } from "../src/server/mod.ts";
import { removeTempDir } from "./helpers/temp.ts";

async function tempApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_state_" });
  const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
      },
    }),
  );
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    `export default function Page() { return <p>hi</p>; }\n`,
  );
  return dir;
}

Deno.test({
  name: "dev getManifest: concurrent first hits share ONE scan (single-flight after a rebuild)",
}, async () => {
  const dir = await tempApp();
  let scans = 0;
  const unregister = registerRouteSynthesizer(() => {
    scans++;
  });
  try {
    const st = createDevState({ paths: await resolveProject(dir), unbundled: false });
    st.load = defaultLoader;
    const [a, b, c] = await Promise.all([getManifest(st), getManifest(st), getManifest(st)]);
    assertEquals(scans, 1, "three concurrent callers → one route scan");
    assert(a === b && b === c, "one manifest object for all callers");
    // A rebuild drops the manifest; the next wave scans exactly once more.
    st.manifest = null;
    await Promise.all([getManifest(st), getManifest(st)]);
    assertEquals(scans, 2);
    // The typed-module emit is fire-and-forget for the requests: let it land (every file of it)
    // before the dir goes away, or Windows refuses the removal of a file still being written
    // (os error 145, a directory not empty).
    assert(st.typedEmit, "the rescan emitted the typed modules");
    await st.typedEmit;
    await Deno.stat(join(dir, ".denext", "api.ts"));
  } finally {
    unregister();
    await removeTempDir(dir);
  }
});

Deno.test({
  name: "dev compat assets: a request racing a rebuild waits for the completed generation",
}, async () => {
  const dir = await tempApp();
  try {
    const st = createDevState({ paths: await resolveProject(dir), unbundled: false });
    st.load = defaultLoader;
    const gen2 = join(dir, ".denext", "dev-compat", "2", "client");
    await Deno.mkdir(join(gen2, "assets"), { recursive: true });
    await Deno.writeTextFile(join(gen2, "assets", "logo.svg"), "<svg/>");
    // A rebuild in flight: the client dir is assigned only when it completes.
    const build = Promise.withResolvers<void>();
    const web = compatBuildOf(st, "web");
    web.building = build.promise.then(() => {
      web.clientDir = gen2;
      web.building = null;
    });
    const handle = createDevHandler(st, () => Promise.resolve(new Response("app")));
    const pending = handle(new Request("http://localhost/_denext/client/assets/logo.svg"));
    const raced = await Promise.race([
      pending.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("waiting"), 60)),
    ]);
    assertEquals(raced, "waiting", "not answered from a half-built generation");
    build.resolve();
    const res = await pending;
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "<svg/>");
    // No compat build at all → falls through to the app handler (no 404 from the asset path).
    web.clientDir = null;
    const none = await handle(new Request("http://localhost/_denext/client/assets/logo.svg"));
    assertEquals(await none.text(), "app");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
