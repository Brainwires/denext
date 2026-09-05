// Verify the `path:line` evidence citations in FEATURES.md (and any other doc passed on the
// command line) still point at an existing file and a line inside it. Used by `deno task
// doc-lint`; prints every stale citation and exits non-zero when any is found.
//
//   deno run -A scripts/check-doc-refs.ts FEATURES.md

const ROOT = new URL("../", import.meta.url);
// Matches `src/x.ts:12`, `src/x.ts:12–34` and `src/x.ts:12-34`, in or out of backticks.
const CITE =
  /((?:src|scripts|packages|tests|examples|apps)\/[\w./-]+\.(?:ts|tsx|json)):(\d+)(?:[–-](\d+))?/g;

interface Stale {
  doc: string;
  cite: string;
  reason: string;
}

async function lineCount(path: string): Promise<number | null> {
  try {
    return (await Deno.readTextFile(new URL(path, ROOT))).split("\n").length;
  } catch {
    return null;
  }
}

async function checkDoc(doc: string): Promise<Stale[]> {
  const text = await Deno.readTextFile(new URL(doc, ROOT));
  const stale: Stale[] = [];
  const cache = new Map<string, number | null>();
  for (const m of text.matchAll(CITE)) {
    const reason = await citeProblem(m, cache);
    if (reason) stale.push({ doc, cite: m[0], reason });
  }
  return stale;
}

/** Why a citation is stale (missing file, or a line past the end), or null when it is fine. */
async function citeProblem(
  m: RegExpMatchArray,
  cache: Map<string, number | null>,
): Promise<string | null> {
  const [, path, from, to] = m;
  const lines = await cachedLineCount(path, cache);
  if (lines === null) return "file does not exist";
  return Number(to ?? from) > lines ? `file has ${lines} lines` : null;
}

async function cachedLineCount(
  path: string,
  cache: Map<string, number | null>,
): Promise<number | null> {
  if (!cache.has(path)) cache.set(path, await lineCount(path));
  return cache.get(path)!;
}

if (import.meta.main) {
  const docs = Deno.args.length ? Deno.args : ["FEATURES.md"];
  const stale = (await Promise.all(docs.map(checkDoc))).flat();
  for (const s of stale) console.error(`stale citation in ${s.doc}: ${s.cite} — ${s.reason}`);
  console.log(`check-doc-refs: ${docs.join(", ")} — ${stale.length} stale citation(s)`);
  if (stale.length) Deno.exit(1);
}
