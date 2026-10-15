// The `platform` fold (denext/platform → the build target's name) as an esbuild plugin, for the
// esbuild paths: SPA mode and React Native mode (after their own source transforms, which fold
// it in the modules they claim) and the drop-in App Router's next-compat bundles.

import type * as esbuild from "./esbuild/mod.ts";
import { foldBuildConstants, PLATFORM_SPECIFIER } from "./feature-transform.ts";
import type { Platform } from "./platform-extensions.ts";
import { firstPartyTsxPlugin } from "./spa-onload.ts";

/** Every first-party source module the `platform` fold may claim. */
const SOURCE_MODULE_FILTER = /\.(?:tsx|jsx|m?ts|m?js)$/;

/**
 * An esbuild plugin folding `platform` (denext/platform) to `platform`'s name in the app's own
 * modules that import it, and nothing else: every other module loads through the next loader
 * untouched. Register it AFTER any plugin whose own `onLoad` claims app modules (that one
 * applies the fold itself).
 *
 * @param projectDir Absolute project root — only first-party source under it is folded.
 * @param platform The build target.
 */
export function platformFoldPlugin(projectDir: string, platform: Platform): esbuild.Plugin {
  return firstPartyTsxPlugin(
    "denext-platform-fold",
    projectDir,
    async (source) => {
      const { code, changed } = await foldBuildConstants(source, { platform });
      return changed ? code : null;
    },
    { filter: SOURCE_MODULE_FILTER, deferUnless: PLATFORM_SPECIFIER },
  );
}
