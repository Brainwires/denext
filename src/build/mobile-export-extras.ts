// What `denext export` adds to an export for mobile apps, in both the App Router and the SPA
// export: the `appLinks` association files (`.well-known/apple-app-site-association`,
// `.well-known/assetlinks.json`) and the Background Runner script compiled from
// `background/*.ts` (`denext-background.js`). Runs before the OTA manifest is stamped, so
// both are listed in it.

import { join } from "@std/path";
import { appLinkFiles } from "../server/app-links.ts";
import type { DenextConfig } from "../server/config.ts";
import { type BackgroundBundler, compileBackgroundRunner } from "./background-runner.ts";

/** What {@linkcode writeMobileExportExtras} wrote, as export-relative paths. */
export interface MobileExportExtras {
  /** The association files written. */
  readonly appLinks: string[];
  /** The runner script, when `background/` has tasks. */
  readonly background: { readonly file: string; readonly tasks: number } | null;
}

/**
 * Write the association files and the Background Runner script into the export `outDir`.
 *
 * @param projectDir The denext project.
 * @param config Its loaded config (for `appLinks`).
 * @param outDir The export (staging) directory.
 * @param bundle The background bundler (tests); default `deno bundle`.
 * @returns What was written.
 */
export async function writeMobileExportExtras(
  projectDir: string,
  config: DenextConfig | null | undefined,
  outDir: string,
  bundle?: BackgroundBundler,
): Promise<MobileExportExtras> {
  const appLinks: string[] = [];
  for (const [path, body] of appLinkFiles(config?.appLinks)) {
    const rel = path.slice(1);
    await Deno.mkdir(join(outDir, ".well-known"), { recursive: true });
    await Deno.writeTextFile(join(outDir, ...rel.split("/")), body);
    appLinks.push(rel);
  }
  const compiled = await compileBackgroundRunner({ projectDir, outDir, bundle });
  const background = compiled
    ? { file: compiled.file.slice(outDir.length + 1), tasks: compiled.tasks }
    : null;
  if (appLinks.length > 0) console.log(`  appLinks: ${appLinks.join(", ")}`);
  if (background) {
    console.log(
      `  background: ${background.file} (${background.tasks} task module${
        background.tasks === 1 ? "" : "s"
      })`,
    );
  }
  return { appLinks, background };
}
