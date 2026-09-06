// `import href from "./styles.css?url"` — Vite hands the URL of the PROCESSED stylesheet.
// The compat bundler's asset emitter calls this to produce those bytes: a Tailwind input
// (`@tailwind …` v3 directives or v4's `@import "tailwindcss"`) is compiled with the
// project's Tailwind (v3 via its own `tailwindcss` package, v4 via the standalone binary);
// any other stylesheet is emitted as-is.

import { basename, join } from "@std/path";
import { compileTailwind } from "./tailwind.ts";

/** Whether `css` is a Tailwind input stylesheet (v3 directives or a v4 import). */
export function isTailwindInput(css: string): boolean {
  return /^\s*@tailwind\s+\w+/m.test(css) || /@import\s+["']tailwindcss["']/.test(css);
}

/**
 * The bytes a `?url`-imported stylesheet should serve. Compiles a Tailwind input against
 * `projectDir` (its config + content globs); returns other stylesheets unchanged.
 */
export async function compileCssAsset(
  projectDir: string,
  path: string,
  minify = true,
): Promise<Uint8Array> {
  const css = await Deno.readTextFile(path);
  if (!isTailwindInput(css)) return new TextEncoder().encode(css);
  const tmp = await Deno.makeTempDir({ prefix: "denext_css_url_" });
  try {
    const output = join(tmp, basename(path));
    await compileTailwind({ input: path, output, minify, cwd: projectDir, projectDir });
    return await Deno.readFile(output);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}
