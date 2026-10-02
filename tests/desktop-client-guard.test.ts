// Import guards for the desktop page side: the client modules never touch Deno APIs (they ship
// in the browser bundle), and `denext/mobile` reaches them only through a dynamic `import()`, so
// web and mobile bundles never load the desktop code.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { stripComments } from "../src/utils/strip-comments.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const CLIENT_FILES = [
  "src/desktop/client.ts",
  "src/desktop/bridge-client.ts",
  "src/desktop/native.ts",
  "src/desktop/window.ts",
  "src/desktop/app.ts",
  "src/desktop/app-actions.ts",
  "src/desktop/pull.ts",
  "src/mobile/desktop-branch.ts",
  "src/mobile/local-notifications.ts",
  "src/mobile/notification-trigger.ts",
  "src/mobile/quick-actions.ts",
  "src/mobile/context-menu.ts",
  "src/mobile/permissions.ts",
  "src/mobile/push.ts",
  "src/mobile/clipboard.ts",
  "src/mobile/shell.ts",
  "src/mobile/file-dialogs.ts",
];

Deno.test("desktop client modules use no Deno APIs", async () => {
  for (const file of CLIENT_FILES) {
    const code = stripComments(await Deno.readTextFile(ROOT + file));
    assertEquals(code.match(/\bDeno\.\w+/g), null, `${file} must stay browser-only`);
  }
});

Deno.test("denext/mobile imports the desktop modules only lazily", async () => {
  for await (const entry of Deno.readDir(ROOT + "src/mobile")) {
    if (!entry.name.endsWith(".ts")) continue;
    const code = stripComments(await Deno.readTextFile(`${ROOT}src/mobile/${entry.name}`));
    const staticImports = [...code.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)]
      .map((m) => m[1]);
    for (const spec of staticImports) {
      assert(!spec.includes("../desktop/"), `${entry.name} statically imports ${spec}`);
    }
  }
});

Deno.test("the desktop client modules never import the runtime (src/build/desktop.ts)", async () => {
  for (const file of CLIENT_FILES) {
    const code = stripComments(await Deno.readTextFile(ROOT + file));
    assert(!/build\/desktop/.test(code), `${file} must not reach the desktop runtime`);
  }
});
