// src/build/mobile-paths.ts: the project-relative paths the mobile tooling reports and writes
// into native files are `/`-separated on every host (a `\` in a pbxproj entry breaks the Xcode
// project on a Mac).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { posixRelative, toPosixPath } from "../src/build/mobile-paths.ts";

Deno.test("posixRelative: a nested project path comes back with forward slashes", () => {
  const root = join(Deno.cwd(), "proj");
  assertEquals(
    posixRelative(root, join(root, "ios", "App", "App", "Info.plist")),
    "ios/App/App/Info.plist",
  );
  assertEquals(
    posixRelative(join(root, "apps", "capacitor"), join(root, "pnpm-lock.yaml")),
    "../../pnpm-lock.yaml",
  );
});

Deno.test("toPosixPath: Windows separators become `/`; elsewhere `\\` is a file-name character", () => {
  if (Deno.build.os === "windows") {
    assertEquals(toPosixPath("ios\\App\\App\\Foo.swift"), "ios/App/App/Foo.swift");
  } else {
    assertEquals(toPosixPath("odd\\name.swift"), "odd\\name.swift");
  }
  assertEquals(toPosixPath("ios/App/App/Foo.swift"), "ios/App/App/Foo.swift");
});
