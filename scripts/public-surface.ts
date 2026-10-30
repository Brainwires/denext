// The public export surface of every `deno.json` entry, as `name:kind` lists — the golden
// that tests/public-surface.test.ts pins so an export cannot be added, renamed or removed
// without a deliberate `deno task surface:refresh` (and a CHANGELOG line).
//
//   deno task surface:refresh   # rewrite tests/fixtures/public-surface.json

import { denoDocJsonMany } from "./deno-doc.ts";
import { fromFileUrl } from "@std/path";

const ROOT = new URL("../", import.meta.url);
export const SURFACE_FIXTURE = fromFileUrl(new URL("tests/fixtures/public-surface.json", ROOT));

interface DocSymbol {
  name: string;
  declarations?: Array<{ kind: string }>;
}

/** `{ "denext": ["h:function", …], "denext/server": […], … }` for every export entry. */
export async function publicSurface(): Promise<Record<string, string[]>> {
  const denoJson = JSON.parse(await Deno.readTextFile(new URL("deno.json", ROOT))) as {
    exports: Record<string, string>;
  };
  const entries = Object.entries(denoJson.exports);
  // A few `deno doc` children for every entry, not one each (see denoDocJsonMany).
  const docs = await denoDocJsonMany(entries.map(([, file]) => fromFileUrl(new URL(file, ROOT))));
  const out: Record<string, string[]> = {};
  entries.forEach(([key], i) => {
    const module = key === "." ? "denext" : `denext/${key.slice(2)}`;
    out[module] = symbolsOf(docs[i]);
  });
  return out;
}

/** Sorted `name:kind` entries of a `deno doc --json` document (one kind per name). */
function symbolsOf(doc: unknown): string[] {
  const nodes = (doc as { nodes?: Record<string, { symbols?: DocSymbol[] }> }).nodes ?? {};
  const seen = new Map<string, string>();
  for (const node of Object.values(nodes)) {
    for (const sym of node.symbols ?? []) {
      const kind = sym.declarations?.[0]?.kind ?? "unknown";
      if (!seen.has(sym.name)) seen.set(sym.name, kind);
    }
  }
  return [...seen].map(([n, k]) => `${n}:${k}`).sort();
}

if (import.meta.main) {
  const surface = await publicSurface();
  await Deno.writeTextFile(SURFACE_FIXTURE, JSON.stringify(surface, null, 2) + "\n");
  const total = Object.values(surface).reduce((n, l) => n + l.length, 0);
  console.log(
    `public-surface: ${Object.keys(surface).length} entries, ${total} symbols → ${SURFACE_FIXTURE}`,
  );
}
