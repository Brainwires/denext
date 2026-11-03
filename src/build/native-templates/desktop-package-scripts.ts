// The desktop packaging scripts `denext create --desktop` scaffolds (and `denext desktop package
// --regenerate-scripts` rewrites), as one record of the docs-corpus pack. NOT published: `deno
// task gen:native-templates` (scripts/gen-native-templates.ts) packs the record below, which
// src/build/scaffold.ts reads. The scripts' readable source is src/build/desktop-package-scripts.ts
// (not published either); edit them there, then regenerate. tests/native-templates-packed.test.ts
// fails while the packed copy differs.

import {
  LINUX_PACKAGE_SCRIPT,
  MACOS_PACKAGE_SCRIPT,
  WINDOWS_PACKAGE_SCRIPT,
} from "../desktop-package-scripts.ts";

/** The scaffolded packaging scripts, by their path under the project's `scripts/`. */
export const DESKTOP_PACKAGE_SCRIPTS: Readonly<Record<string, string>> = {
  "package-macos.ts": MACOS_PACKAGE_SCRIPT,
  "package-linux.ts": LINUX_PACKAGE_SCRIPT,
  "package-windows.ts": WINDOWS_PACKAGE_SCRIPT,
};
