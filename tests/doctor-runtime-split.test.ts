// `denext doctor`'s runtime split check (src/cli/commands/doctor.ts `runtimeSplitCheck`): with no
// project pin, a user default makes this machine run another runtime release than a container or
// a deploy adapter's host, which has none and runs the bundled pin.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { runtimeSplitCheck } from "../src/cli/commands/doctor.ts";
import {
  BUNDLED_RUNTIME,
  type RuntimeRelease,
  RuntimeSelectError,
} from "../src/build/runtime-select.ts";

const release = (over: Partial<RuntimeRelease>): () => RuntimeRelease => () => ({
  ...BUNDLED_RUNTIME,
  source: "bundled",
  version: BUNDLED_RUNTIME.toolchain.version,
  integrity: null,
  notices: [],
  ...over,
});

Deno.test("runtimeSplitCheck: a user default warns only when the project ships through a container or an adapter", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-split-" });
  try {
    const onDefault = release({ source: "default", version: "3.0.0-denext.31" });
    // Nothing ships elsewhere: no check.
    assertEquals(await runtimeSplitCheck(dir, {}, onDefault), null);
    // A deploy adapter.
    const adapter = await runtimeSplitCheck(
      dir,
      { deploy: { adapter: { name: "fly" } } },
      onDefault,
    );
    assertEquals([adapter?.name, adapter?.ok, adapter?.critical], ["runtime split", false, false]);
    assertStringIncludes(adapter!.detail, "3.0.0-denext.31");
    assertStringIncludes(adapter!.detail, "denext runtime use <version> --project");
    // A Dockerfile.
    await Deno.writeTextFile(join(dir, "Dockerfile"), "FROM scratch\n");
    assertEquals((await runtimeSplitCheck(dir, {}, onDefault))?.ok, false);
    // The project pins its runtime, the bundled pins run, or the default IS the bundled release.
    assertEquals(
      await runtimeSplitCheck(dir, {}, release({ source: "project", version: "3.0.0-denext.31" })),
      null,
    );
    assertEquals(await runtimeSplitCheck(dir, {}, release({})), null);
    assertEquals(await runtimeSplitCheck(dir, {}, release({ source: "default" })), null);
    // A broken selection is the toolchain check's to report.
    const broken = () => {
      throw new RuntimeSelectError("broken pin");
    };
    assertEquals(await runtimeSplitCheck(dir, {}, broken), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
