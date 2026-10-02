// One page per example (/docs/examples/<name>), pre-rendered at export by generateStaticParams.
// The body is the example's own README.md, rendered by the same Markdown renderer as every
// Markdown-sourced docs page (single source — no copy of the README lives in the site). Its
// relative links resolve against the example's directory: a file becomes its GitHub URL and a
// sibling example (`../notes`) becomes that example's page. Title, summary, category, tags and
// the "Run it" commands come from the generated examples.json (themselves read from the README).

import type { Metadata, PageProps } from "denext/server";
import { Code, DocsShell } from "../../../../components/ui.tsx";
import { renderDoc } from "../../../../lib/markdown.ts";
import { tocFromHtml } from "../../../../lib/toc.ts";
import {
  categoryAnchor,
  categoryById,
  type Example,
  exampleByName,
  exampleHref,
  EXAMPLES,
  examplesNav,
  neighbours,
  readmePath,
  runBlock,
} from "../../../../lib/examples.ts";

/** Pre-render one static page per example during `denext export`. */
export function generateStaticParams(): Array<{ name: string }> {
  return EXAMPLES.map((e) => ({ name: e.name }));
}

export function metadata(props: PageProps): Metadata {
  const e = exampleByName(String(props.params.name));
  return {
    title: e ? `${e.name} — Examples` : "Examples",
    description: e ? e.blurb || e.title : "",
  };
}

/** The example's README rendered to HTML (links rewritten), or "" when it has none. */
async function readmeHtml(e: Example): Promise<string> {
  if (!e.hasReadme) return "";
  const url = new URL(`../../../../../${readmePath(e.name)}`, import.meta.url);
  const { html } = renderDoc(await Deno.readTextFile(url), { sourcePath: readmePath(e.name) });
  return html;
}

function ExampleLink({ e, rel }: { e: Example; rel: string }) {
  return (
    <a href={exampleHref(e.name)} rel={rel}>
      <span class="example-pager-dir">{rel === "prev" ? "← Previous" : "Next →"}</span>
      <code>{e.name}</code>
    </a>
  );
}

export default async function ExamplePage(props: PageProps) {
  const e = exampleByName(String(props.params.name));
  if (!e) {
    return (
      <DocsShell active="examples" title="Examples" navChildren={examplesNav()}>
        <p>
          Unknown example. <a href="/docs/examples">← all examples</a>
        </p>
      </DocsShell>
    );
  }
  const html = await readmeHtml(e);
  const category = categoryById(e.category);
  const related = EXAMPLES.filter((x) => x.category === e.category && x.name !== e.name);
  const { prev, next } = neighbours(e.name);
  const toc = [
    ...tocFromHtml(html),
    ...(related.length
      ? [{ id: "related-examples", text: "Related examples", level: 2 as const }]
      : []),
  ];
  return (
    <DocsShell
      active="examples"
      title={e.title}
      lead={e.blurb || undefined}
      toc={toc}
      navChildren={examplesNav(e.name)}
    >
      <div class="example-meta">
        <p class="example-facts">
          {category
            ? (
              <span>
                Category:{" "}
                <a href={`/docs/examples#${categoryAnchor(category.id)}`}>{category.label}</a>
              </span>
            )
            : null}
          {e.tags.length
            ? (
              <span>
                Wired as: {e.tags.map((t, i) => (
                  <span key={t}>
                    {i > 0 ? " " : ""}
                    <code>{t}</code>
                  </span>
                ))}
              </span>
            )
            : null}
          <span>
            Source: <a href={e.url}>examples/{e.name} on GitHub</a>
          </span>
        </p>
        <p class="example-run-label">Run it</p>
        <Code lang="bash">{runBlock(e)}</Code>
      </div>

      {html
        ? <div class="md" dangerouslySetInnerHTML={{ __html: html }} />
        : <p>This example has no README yet — read the source on GitHub.</p>}

      {related.length
        ? (
          <section class="example-related">
            <h2 id="related-examples">Related examples</h2>
            <ul>
              {related.map((r) => (
                <li key={r.name}>
                  <a href={exampleHref(r.name)}>
                    <code>{r.name}</code>
                  </a>
                  {r.blurb ? ` — ${r.blurb}` : null}
                </li>
              ))}
            </ul>
          </section>
        )
        : null}

      <nav class="example-pager" aria-label="Examples">
        {prev ? <ExampleLink e={prev} rel="prev" /> : <span />}
        {next ? <ExampleLink e={next} rel="next" /> : <span />}
      </nav>
    </DocsShell>
  );
}
