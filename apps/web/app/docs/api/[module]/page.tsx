import type { Metadata, PageProps } from "denext/server";
import { Code, DocsShell } from "../../../../components/ui.tsx";
import reference from "../reference.json" with { type: "json" };

/** A module name → a URL-safe single segment (`denext/server` → `denext-server`). */
const slug = (m: string) => m.replace(/\//g, "-");
const groupFor = (seg: string) => reference.groups.find((g) => slug(g.module) === seg);

/** Pre-render one static page per module during `denext export`. */
export function generateStaticParams(): Array<{ module: string }> {
  return reference.groups.map((g) => ({ module: slug(g.module) }));
}

export function metadata(props: PageProps): Metadata {
  const g = groupFor(String(props.params.module));
  return {
    title: g ? `${g.module} — API reference` : "API reference",
    description: g
      ? `Every public export of ${g.module}, generated from the source with deno doc.`
      : "",
  };
}

export default function ApiModule(props: PageProps) {
  const g = groupFor(String(props.params.module));
  if (!g) {
    return (
      <DocsShell active="api" title="API reference">
        <p>
          Unknown module. <a href="/docs/api">← all modules</a>
        </p>
      </DocsShell>
    );
  }
  return (
    <DocsShell
      active="api"
      title={g.module}
      lead={`Every public export of ${g.module} (${g.symbols.length} symbols), generated with deno doc.`}
      toc={g.symbols.map((s) => ({
        id: s.name,
        text: s.name,
        level: 3 as const,
      }))}
    >
      <nav class="api-modnav" aria-label="API modules">
        <a href="/docs/api">All modules</a>
        {reference.groups.map((m) => (
          <a
            key={m.module}
            href={`/docs/api/${slug(m.module)}`}
            class={m.module === g.module ? "active" : undefined}
            aria-current={m.module === g.module ? "page" : undefined}
          >
            <code>{m.module}</code>
          </a>
        ))}
      </nav>
      <div class="api-symbols">
        {g.symbols.map((s) => (
          <div key={s.name} class="api-symbol">
            <h3 id={s.name}>
              <code>{s.name}</code> <span class="api-kind">{s.kind}</span>
            </h3>
            <Code lang="ts">{s.signature}</Code>
            {s.doc ? <p>{s.doc}</p> : null}
          </div>
        ))}
      </div>
    </DocsShell>
  );
}
