/**
 * `@denext/content-collections` — a typed, validated, queryable content layer for denext apps
 * (MD/MDX/YAML/JSON), in the spirit of Astro's Content Layer and Nuxt Content. Declare collections
 * in `content.config.ts` with a Standard Schema and a loader; the plugin validates every entry and
 * generates types so `getCollection`/`getEntry` are fully typed — regenerated live in `denext dev`
 * and at `denext build`.
 *
 * ```ts
 * // denext.config.ts
 * import { contentCollections } from "@denext/content-collections";
 * export default { plugins: [contentCollections()] };
 * ```
 *
 * Author collections in `content.config.ts` (see {@link "@denext/content-collections/config"}), query
 * them from Server Components (see {@link "@denext/content-collections/runtime"}), and run
 * `denext content build | list | validate` from the CLI.
 *
 * @module
 */

import type { DenextPlugin, PluginContext } from "@denext/denext/server";
import { buildContent } from "./build.ts";
import { createContentCommand } from "./command.ts";

export { buildContent } from "./build.ts";
export type { ContentBuildContext, ContentBuildReport, ContentDiagnostic } from "./build.ts";
export { createContentCommand } from "./command.ts";
export type { ContentCommandIo } from "./command.ts";

/** Options for the {@linkcode contentCollections} plugin. */
export interface ContentCollectionsOptions {
  /**
   * Glob patterns (relative to the project root) whose changes regenerate the store + types in
   * `denext dev`. Defaults to `content.config.ts` and a `content/**` tree; override if your content
   * lives elsewhere.
   */
  readonly watch?: string[];
}

/** Log a completed content build (or its validation diagnostics) to the console. */
async function runAndReport(projectRoot: string, outDir: string): Promise<void> {
  const report = await buildContent({ projectRoot, outDir });
  if (!report.configured) return; // no content.config.ts — nothing to do
  if (report.diagnostics.length > 0) {
    console.error(
      `denext content: ${report.diagnostics.length} invalid entr(ies) (dropped from the store):`,
    );
    for (const d of report.diagnostics) {
      console.error(
        `  ✗ ${d.collection}/${d.id}${d.filePath ? ` (${d.filePath})` : ""}: ${
          d.messages.join("; ")
        }`,
      );
    }
  } else {
    const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
    const n = Object.keys(report.counts).length;
    console.log(
      `denext content: ${total} entr${total === 1 ? "y" : "ies"} in ${n} collection${
        n === 1 ? "" : "s"
      }`,
    );
  }
}

/**
 * The content-collections plugin. Registers a prepare step (build the store + generate types at dev
 * startup / build, and on content changes in dev) and the `denext content` CLI verb.
 */
export function contentCollections(options: ContentCollectionsOptions = {}): DenextPlugin {
  const watch = options.watch ?? ["content.config.ts", "content/**"];
  return {
    name: "@denext/content-collections",
    setup(ctx: PluginContext) {
      ctx.addPrepareStep(({ projectRoot, outDir }) => runAndReport(projectRoot, outDir), { watch });
      ctx.addCommand(createContentCommand());
    },
  };
}
