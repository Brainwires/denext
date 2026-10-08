// The per-module dev loop serves an app's import-map aliases as the app's own modules (`@fs`),
// but never the framework: an app whose `deno.json` maps `denext/` to a local denext checkout
// (the e2e fixtures do, with absolute paths) must still get `denext/devtools` & co. as a
// dependency. Served through `@fs`, the SPA dev entry's `denext/devtools` import loaded a second
// copy of the runtime beside the dependency chunk's — two reconcilers on one page, which broke
// react-native-gesture-handler's ref callback in tests/e2e/reanimated.e2e.test.ts (dev only).
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { resolveFirstParty } from "../src/build/dev-unbundled/resolve.ts";
import { createUnbundledState, norm } from "../src/build/dev-unbundled/state.ts";

const FW = fromFileUrl(new URL("../", import.meta.url)); // the denext checkout

Deno.test("dev aliases: a prefix alias into the framework checkout is not a first-party module", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_fw_alias_" }));
  const shared = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_fw_shared_" }));
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src/main.tsx"), "export {};\n");
    await Deno.writeTextFile(join(dir, "src/util.ts"), "export const u = 1;\n");
    await Deno.writeTextFile(join(shared, "lib.ts"), "export const l = 1;\n");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "denext": `${FW}mod.ts`,
          "denext/": `${FW}src/`,
          "~/": "./src/",
          "@shared/": `${shared}/`,
        },
      }),
    );
    const st = createUnbundledState({
      projectDir: dir,
      appDir: join(dir, "src"),
      configPath: join(dir, "deno.json"),
      outDir: join(dir, ".denext"),
      spaEntry: join(dir, "src/main.tsx"),
    });
    const main = join(dir, "src/main.tsx");
    assertEquals(await resolveFirstParty(st, "denext/devtools", main), null);
    assertEquals(await resolveFirstParty(st, "denext/client/mod.ts", main), null);
    assertEquals(await resolveFirstParty(st, "denext", main), null);
    // The app's own aliases still resolve, inside the project or out of it (a monorepo folder).
    assertEquals(await resolveFirstParty(st, "~/util", main), norm(join(dir, "src/util.ts")));
    assertEquals(await resolveFirstParty(st, "@shared/lib", main), norm(join(shared, "lib.ts")));
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(shared, { recursive: true });
  }
});
