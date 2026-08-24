// Regression: loadDenextConfig must carry EVERY DenextConfig field through — it
// previously dropped `compatibilityMode` and `classComponents` (silently), so the
// explicit `compatibilityMode: true` override never reached detectNextCompat. SPA
// mode's npm-React path depends on that override, and the App Router shared the bug.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveProject } from "../src/build/paths.ts";

Deno.test("resolveProject carries compatibilityMode + classComponents + mode/spa through", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_cfg_" });
  try {
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default {
        compatibilityMode: true,
        classComponents: true,
        mode: "spa",
        spa: { entry: "./src/main.tsx", env: { MODE: "prod" } },
      };\n`,
    );
    const paths = await resolveProject(dir);
    assertEquals(paths.config?.compatibilityMode, true);
    assertEquals(paths.config?.classComponents, true);
    assertEquals(paths.config?.mode, "spa");
    assertEquals(paths.config?.spa?.env?.MODE, "prod");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
