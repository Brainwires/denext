// Generate the search corpus for the `denext_search_docs` MCP tool.
// Reads the API reference (apps/web/app/docs/api/reference.json) + the authoring guide
// (AGENTS.md) and emits a committed `src/mcp/docs-corpus.json` — one chunk per API symbol
// and per guide section. That JSON ships in the package (src/** publishes; apps/** does
// not), and src/mcp/rag/search.ts BM25-searches it in-process.
//
//   deno task docs:corpus    # regenerate (run after docs:api)
//   deno task docs:build     # regenerate + export the site

const ROOT = new URL("../", import.meta.url).pathname;
const REF = `${ROOT}apps/web/app/docs/api/reference.json`;
const GUIDE = `${ROOT}AGENTS.md`;
const OUT = `${ROOT}src/mcp/docs-corpus.json`;

interface RefSymbol {
  name: string;
  slug: string;
  kind: string;
  signature: string;
  doc: string;
  docFull: string;
  params: { name: string; doc: string }[];
  returns: string;
  denextOnly: boolean;
}
interface RefGroup {
  module: string;
  symbols: RefSymbol[];
}
interface Chunk {
  id: string;
  kind: string;
  title: string;
  module: string;
  url: string;
  text: string;
  denextOnly: boolean;
}

/** `denext/server` → `denext-server` (matches apps/web/lib/api.ts). */
const moduleSlug = (m: string) => m.replace(/\//g, "-");

/** A GitHub-style heading anchor. */
const slugify = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Flatten JSDoc inline markup to plain searchable text (copy of gen-api-reference's). */
function plainText(s: string): string {
  return s
    .replace(/\{@link(?:code|plain)?\s+([^}]+)\}/g, (_m, body: string) => {
      const pipe = body.indexOf("|");
      return (pipe >= 0 ? body.slice(pipe + 1) : body).trim().replace(/#/g, ".");
    })
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** One searchable chunk per API symbol. */
function symbolChunk(module: string, s: RefSymbol): Chunk {
  const seg = moduleSlug(module);
  const body = [s.name, s.signature, s.docFull || s.doc, ...s.params.map((p) => p.doc), s.returns];
  return {
    id: `api:${seg}/${s.slug}`,
    kind: s.kind,
    title: s.name,
    module,
    url: `/docs/api/${seg}/${s.slug}`,
    text: plainText(body.filter(Boolean).join(" ")),
    denextOnly: Boolean(s.denextOnly),
  };
}

/** Every API symbol across every module → chunks. */
function apiChunks(groups: RefGroup[]): Chunk[] {
  return groups.flatMap((g) => g.symbols.map((s) => symbolChunk(g.module, s)));
}

/** One chunk per AGENTS.md H2 section. */
function guideChunks(md: string): Chunk[] {
  const sections = md.split(/\n(?=## )/).filter((s) => s.startsWith("## "));
  return sections.map((seg) => {
    const title = seg.slice(3, seg.indexOf("\n")).trim();
    const anchor = slugify(title);
    return {
      id: `guide:${anchor}`,
      kind: "guide",
      title,
      module: "guide",
      url: `https://github.com/Brainwires/denext/blob/main/AGENTS.md#${anchor}`,
      text: plainText(seg),
      denextOnly: false,
    };
  });
}

const ref = JSON.parse(await Deno.readTextFile(REF)) as { groups: RefGroup[] };
const guide = await Deno.readTextFile(GUIDE);
const chunks = [...apiChunks(ref.groups), ...guideChunks(guide)];

await Deno.writeTextFile(
  OUT,
  JSON.stringify({ chunks }, null, 2) + "\n",
);
console.log(`docs corpus: ${chunks.length} chunks → ${OUT}`);
