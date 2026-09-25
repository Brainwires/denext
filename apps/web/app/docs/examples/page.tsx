import { Code, DocsShell } from "../../../components/ui.tsx";
import examplesIndex from "./examples.json" with { type: "json" };

export const metadata = {
  title: "Examples",
  description:
    "Every runnable example in the denext repository — Server Actions, islands, Live, streaming, SPA mode, the ORM and plugin examples — with what each one demonstrates and how it is wired.",
};

const { examples } = examplesIndex;

const RUN = `git clone https://github.com/Brainwires/denext
cd denext/examples/hello
deno task dev          # http://localhost:3000`;

const TAG_LEGEND: [string, string][] = [
  ["app-router", "An app/ directory — the App Router, the default."],
  ["pages-router", "A pages/ directory (the @denext/pages-router plugin)."],
  ["spa", 'mode: "spa" — client-only, no app/ directory.'],
  ["compat", "compatibilityMode: true — react / next/* are aliased to denext."],
  ["plugin:<name>", "A plugin declared in the example's denext.config.ts."],
  ["desktop", "A desktop.ts — the example also packages as a native app."],
  ["mobile", "A capacitor.config.* — the example also runs as an iOS / Android app."],
];

/** The blurb, or an honest stand-in when the example has no README to read one from. */
function whatItShows(e: { blurb: string; title: string; hasReadme: boolean }): string {
  if (e.blurb) return e.blurb;
  return e.hasReadme ? e.title : "No README yet — read the source.";
}

export default function Examples() {
  const toc = [
    { id: "run", text: "Run one", level: 2 as const },
    { id: "all", text: "All examples", level: 2 as const },
    { id: "tags", text: "What the tags mean", level: 2 as const },
  ];
  return (
    <DocsShell
      active="examples"
      title="Examples"
      lead="Every runnable example in the repository — what it demonstrates and how it is wired — generated from the examples' own READMEs."
      toc={toc}
    >
      <p>
        The repository carries {examples.length}{" "}
        examples, each a complete app you can run. They are the executable half of these docs: when
        a page describes a feature, an example here exercises it end to end.
      </p>

      <h2 id="run">Run one</h2>
      <Code lang="bash">{RUN}</Code>
      <p>
        Every example's <code>deno.json</code> defines the usual <code>dev</code> /{" "}
        <code>build</code> / <code>start</code>{" "}
        tasks; a few add their own (database setup, a native package step, an export) — see each
        README.
      </p>

      <h2 id="all">All examples</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Example</th>
              <th>What it shows</th>
              <th>Wired as</th>
            </tr>
          </thead>
          <tbody>
            {examples.map((e) => (
              <tr key={e.name}>
                <td>
                  <a href={e.url}>
                    <code>{e.name}</code>
                  </a>
                </td>
                <td>{whatItShows(e)}</td>
                <td>
                  {e.tags.length
                    ? e.tags.map((t, i) => (
                      <span key={t}>
                        {i > 0 ? " " : ""}
                        <code>{t}</code>
                      </span>
                    ))
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="tags">What the tags mean</h2>
      <p>
        The tags are read out of each example's <code>denext.config.ts</code>{" "}
        and directory layout, so they describe how the app is actually wired:
      </p>
      <ul>
        {TAG_LEGEND.map(([tag, meaning]) => (
          <li key={tag}>
            <code>{tag}</code> — {meaning}
          </li>
        ))}
      </ul>
    </DocsShell>
  );
}
