// Parse a module with `@denext/swc` in the dialect its path implies, for the build-time
// analysis passes that read app and library source (the Reanimated worklet pass, the
// native-module sync-use scan): `.ts` / `.mts` / `.cts` as TypeScript, `.tsx` as TSX, anything
// else as JavaScript with JSX in a module-or-script file. The source is parsed with swc-ast.ts's
// MARKER first, so span offsets map back to the source exactly.

import { extname } from "@std/path";
import { type Ctx, encoder, MARKER, type Node } from "./swc-ast.ts";

type SwcModule = typeof import("@denext/swc");
let swc: Promise<SwcModule> | null = null;

/** The swc parser options for `path`'s extension. */
function dialectOf(path: string) {
  const ext = extname(path);
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
    return { syntax: "typescript" as const, tsx: false };
  }
  if (ext === ".tsx") return { syntax: "typescript" as const, tsx: true };
  return { syntax: "ecmascript" as const, jsx: true, isModule: "unknown" as const };
}

/**
 * Parse `source` for `path`'s dialect.
 *
 * @param path The module's path (only its extension is read).
 * @param source The module source.
 * @returns The byte-offset context and the top-level items (the marker dropped), or null when
 * it does not parse or is empty.
 */
export async function parseModuleForPath(
  path: string,
  source: string,
): Promise<{ ctx: Ctx; body: Node[] } | null> {
  swc ??= import("@denext/swc").then(async (mod) => {
    await mod.default();
    return mod;
  });
  const mod = await swc;
  let ast: Node;
  try {
    ast = await mod.parse(MARKER + source, { ...dialectOf(path), target: "es2022" });
  } catch {
    return null;
  }
  if (!ast.body || ast.body.length === 0) return null;
  return {
    ctx: { bytes: encoder.encode(source), base: ast.body[0].span.start + MARKER.length },
    body: ast.body.slice(1),
  };
}
