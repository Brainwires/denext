// Every type a public desktop type refers to is exported from the entry point that exposes it, so
// `deno doc --lint` passes on `denext/desktop` and `denext/desktop/client` linted alone (it
// reported `private-type-ref` for these when each module was linted on its own). The type imports
// below fail `deno check` when one of them stops being exported.

import { assertEquals } from "@std/assert";
import type {
  DesktopLinuxDesktopEntryConfig,
  DesktopUpdaterConfig,
  DesktopWindowLevel,
  SpaProxyConfig,
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
  TrayEventType,
  TrayModifiers,
  TrayMouseDetail,
} from "../src/build/desktop.ts";
import type { SidecarExit, SidecarExposedValue } from "../src/desktop/client.ts";

/** Names each type once, so an unexported one is a type error here. */
type Referenced = [
  DesktopLinuxDesktopEntryConfig,
  DesktopUpdaterConfig,
  DesktopWindowLevel,
  SpaProxyConfig,
  StandardIssue,
  StandardResult<unknown>,
  StandardSchemaV1,
  TrayEventType,
  TrayModifiers,
  TrayMouseDetail,
  SidecarExit,
  SidecarExposedValue,
];

Deno.test("desktop entry points export every type their public types refer to", () => {
  const count: Referenced["length"] = 12;
  assertEquals(count, 12);
});

Deno.test({
  name: "deno doc --lint: the desktop entry points pass when linted one at a time",
  // Spawns `deno doc` four times on the local sources; no network once the graph is cached.
  fn: async () => {
    for (
      const entry of [
        "src/build/desktop.ts",
        "src/desktop/client.ts",
        "src/desktop/window.ts",
        "src/desktop/app.ts",
      ]
    ) {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["doc", "--lint", entry],
        cwd: new URL("../", import.meta.url),
        stdout: "piped",
        stderr: "piped",
        env: { NO_COLOR: "1" },
      }).output();
      const text = new TextDecoder().decode(out.stderr) + new TextDecoder().decode(out.stdout);
      assertEquals(
        text.split("\n").filter((l) => l.includes("private-type-ref")),
        [],
        entry,
      );
      assertEquals(out.code, 0, `${entry}: ${text.slice(-2000)}`);
    }
  },
});
