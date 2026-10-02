// Generate the docs corpus behind the `denext_search_docs` + `denext_read_docs` MCP tools.
//
// Sources: the API reference (site/app/docs/api/reference.json, one chunk per symbol), EVERY
// docs-site page under site/app/docs/<slug>/ (chunked by h2/h3, so a hit deep-links to
// `/docs/<slug>#<anchor>`), the root guides the site renders (FEATURES.md, KNOWN-*.md, …, and a
// recent slice of CHANGELOG.md), the authoring guide (AGENTS.md) and README.md. The output,
// `src/mcp/docs-corpus.json`, ships in the package (src/** publishes; site/** does not), so an
// agent can search and read the whole manual offline.
//
// How a page becomes Markdown:
//   - `content.md` pages, and pages that render a root .md file, are taken from the Markdown
//     source itself (frontmatter / leading H1 → title + lead).
//   - JSX pages are RENDERED, not parsed: the page module is imported and its default export
//     called, exactly as the server renderer does, and the resulting VNode tree is walked to
//     Markdown (scripts/lib/docs-corpus.ts `VNodeMarkdown`). Parsing the JSX source would miss
//     everything computed at render time — the MCP and CLI pages are `.map()`s over JSON
//     registries, many pages share constants — so the walker sees what a reader sees.
//
// `sourceHash` fingerprints every input; tests/mcp-docs-corpus.test.ts recomputes it and fails
// when the committed corpus is stale.
//
//   deno task docs:corpus    # regenerate (after docs:api / docs:mcp / docs:cli)
//   deno task docs:build     # regenerates it as part of the site build

import { fromFileUrl } from "@std/path";
import { Callout, Code, DocsShell } from "../site/components/ui.tsx";
import {
  agentsSource,
  changelogSlice,
  chunkMarkdown,
  contentMdPage,
  type CorpusInput,
  type CorpusPage,
  fingerprint,
  type GuideChunk,
  pageChunks,
  rootMdPage,
  VNodeMarkdown,
} from "./lib/docs-corpus.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const DOCS = `${ROOT}site/app/docs/`;
const REF = `${DOCS}api/reference.json`;
/** Where the corpus is written (and read by the staleness test). */
export const CORPUS_OUT = `${ROOT}src/mcp/docs-corpus.json`;
const GITHUB = "https://github.com/Brainwires/denext/blob/main";

interface RefSymbol {
  name: string;
  slug: string;
  kind: string;
  signature: string;
  doc: string;
  docFull: string;
  params: { name: string; doc: string }[];
  returns: string;
  examples?: string[];
  denextOnly: boolean;
}
interface RefGroup {
  module: string;
  symbols: RefSymbol[];
}

/** One API symbol in the corpus. */
interface ApiChunk {
  id: string;
  kind: string;
  title: string;
  module: string;
  text: string;
  denextOnly?: true;
}

/** `denext/server` → `denext-server` (matches site/lib/api.ts). */
const moduleSlug = (m: string) => m.replace(/\//g, "-");

/** An API symbol's full docs as Markdown (signature, prose, params, returns, examples). */
function symbolMarkdown(module: string, s: RefSymbol): string {
  const out = [`\`\`\`ts\n${s.signature}\n\`\`\``];
  const prose = (s.docFull || s.doc).trim();
  if (prose) out.push(prose);
  const params = s.params.filter((p) => p.doc);
  if (params.length) {
    out.push("**Parameters**\n\n" + params.map((p) => `- \`${p.name}\` — ${p.doc}`).join("\n"));
  }
  if (s.returns) out.push(`**Returns** ${s.returns}`);
  for (const ex of s.examples ?? []) out.push(ex.includes("```") ? ex : `\`\`\`ts\n${ex}\n\`\`\``);
  return `# ${s.name} (${s.kind}, \`${module}\`)\n\n${out.join("\n\n")}`;
}

/** One chunk per API symbol across every module. */
function apiChunks(groups: RefGroup[]): ApiChunk[] {
  return groups.flatMap((g) =>
    g.symbols.map((s) => {
      const c: ApiChunk = {
        id: `api:${moduleSlug(g.module)}/${s.slug}`,
        kind: s.kind,
        title: s.name,
        module: g.module,
        text: symbolMarkdown(g.module, s),
      };
      if (s.denextOnly) c.denextOnly = true;
      return c;
    })
  );
}

/** The docs route directories, sorted (dynamic segments such as `api/[module]` excluded). */
async function docSlugs(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(DOCS)) {
    if (e.isDirectory && !e.name.includes("[")) out.push(e.name);
  }
  return out.sort();
}

/** The repo-root Markdown file a page renders verbatim (`new URL("…/FEATURES.md")`), if any. */
function rootMdOf(pageSrc: string): string | null {
  return pageSrc.match(/new URL\(\s*"(?:\.\.\/)+([A-Z][A-Za-z0-9_-]*\.md)"/)?.[1] ?? null;
}

/** What one page's source files are, for both generation and the fingerprint. */
async function pageSources(slug: string): Promise<{ files: CorpusInput[]; rootMd: string | null }> {
  const files: CorpusInput[] = [];
  for await (const e of Deno.readDir(`${DOCS}${slug}`)) {
    if (!e.isFile || !/\.(md|tsx?|json)$/.test(e.name)) continue;
    const path = `site/app/docs/${slug}/${e.name}`;
    files.push({ path, text: await Deno.readTextFile(`${ROOT}${path}`) });
  }
  const page = files.find((f) => f.path.endsWith("/page.tsx"));
  const hasContent = files.some((f) => f.path.endsWith("/content.md"));
  return { files, rootMd: !hasContent && page ? rootMdOf(page.text) : null };
}

/** A root .md file's text as the corpus uses it (CHANGELOG is sliced to recent releases). */
async function rootMdText(file: string): Promise<string> {
  const src = await Deno.readTextFile(`${ROOT}${file}`);
  return file === "CHANGELOG.md" ? changelogSlice(src) : src;
}

/**
 * Every input the corpus is derived from, with the text as it is consumed. The staleness test
 * fingerprints this list; generation embeds the same fingerprint.
 */
export async function corpusInputs(): Promise<CorpusInput[]> {
  const inputs: CorpusInput[] = [
    { path: "site/app/docs/api/reference.json", text: await Deno.readTextFile(REF) },
    { path: "AGENTS.md", text: agentsSource(await Deno.readTextFile(`${ROOT}AGENTS.md`)) },
    { path: "README.md", text: await Deno.readTextFile(`${ROOT}README.md`) },
    {
      path: "scripts/gen-docs-corpus.ts",
      text: await Deno.readTextFile(`${ROOT}scripts/gen-docs-corpus.ts`),
    },
    {
      path: "scripts/lib/docs-corpus.ts",
      text: await Deno.readTextFile(`${ROOT}scripts/lib/docs-corpus.ts`),
    },
  ];
  for (const slug of await docSlugs()) {
    const { files, rootMd } = await pageSources(slug);
    inputs.push(...files);
    if (rootMd) inputs.push({ path: rootMd, text: await rootMdText(rootMd) });
  }
  return inputs;
}

const SHELL = { shell: DocsShell, code: Code, callout: Callout };

/** One docs-site page → its corpus page + Markdown. */
async function sitePage(slug: string): Promise<{ page: CorpusPage; md: string }> {
  const { files, rootMd } = await pageSources(slug);
  const mod = await import(`${DOCS}${slug}/page.tsx`);
  const meta = (mod.metadata ?? {}) as { title?: string; description?: string };
  const content = files.find((f) => f.path.endsWith("/content.md"));
  if (content) return contentMdPage(slug, content.text);
  if (rootMd) {
    return rootMdPage(slug, await rootMdText(rootMd), {
      title: meta.title,
      lead: meta.description,
    });
  }
  const walker = new VNodeMarkdown(SHELL);
  const { title, lead, md } = await walker.page(await mod.default({ params: {} }));
  return { page: { slug, title: title ?? meta.title ?? slug, lead: lead ?? meta.description }, md };
}

/** Build the whole corpus object. */
export async function buildCorpus(): Promise<{
  version: 2;
  sourceHash: string;
  pages: CorpusPage[];
  chunks: (GuideChunk | ApiChunk)[];
}> {
  const sources: { page: CorpusPage; md: string }[] = [];
  for (const slug of await docSlugs()) sources.push(await sitePage(slug));
  sources.push(
    rootMdPage("agents", agentsSource(await Deno.readTextFile(`${ROOT}AGENTS.md`)), {
      title: "Writing denext apps (AI authoring guide)",
      url: `${GITHUB}/AGENTS.md`,
    }),
    rootMdPage("readme", await Deno.readTextFile(`${ROOT}README.md`), {
      title: "README",
      url: `${GITHUB}/README.md`,
    }),
  );
  const pages: CorpusPage[] = [];
  const guide: GuideChunk[] = [];
  for (const { page, md } of sources) {
    if (!page.lead) delete page.lead;
    pages.push(page);
    guide.push(...pageChunks(page.slug, chunkMarkdown(md)));
  }
  const ref = JSON.parse(await Deno.readTextFile(REF)) as { groups: RefGroup[] };
  return {
    version: 2,
    sourceHash: await fingerprint(await corpusInputs()),
    pages,
    chunks: [...guide, ...apiChunks(ref.groups)],
  };
}

/**
 * Serialize: one page / chunk per line. Compact (no per-field indentation — about a third
 * smaller than pretty-printed) yet line-diffable; the file is excluded from `deno fmt`.
 */
export function serializeCorpus(c: Awaited<ReturnType<typeof buildCorpus>>): string {
  const rows = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join(",\n");
  return `{"version":${c.version},"sourceHash":${JSON.stringify(c.sourceHash)},\n"pages":[\n${
    rows(c.pages)
  }\n],\n"chunks":[\n${rows(c.chunks)}\n]}\n`;
}

if (import.meta.main) {
  const corpus = await buildCorpus();
  const text = serializeCorpus(corpus);
  await Deno.writeTextFile(CORPUS_OUT, text);
  const guide = corpus.chunks.filter((c) => c.kind === "guide").length;
  console.log(
    `docs corpus: ${corpus.pages.length} pages, ${guide} guide sections, ` +
      `${corpus.chunks.length - guide} API symbols, ${
        (text.length / 1024).toFixed(0)
      } KiB → ${CORPUS_OUT}`,
  );
}
