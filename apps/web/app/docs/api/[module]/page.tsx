import type { Metadata, PageProps } from "denext/server";
import { DocsShell } from "../../../../components/ui.tsx";
import { SymbolBadges } from "../../../../components/api.tsx";
import { byKind, groupForSlug, GROUPS, moduleSlug } from "../../../../lib/api.ts";

/** Pre-render one static page per module during `denext export`. */
export function generateStaticParams(): Array<{ module: string }> {
  return GROUPS.map((g) => ({ module: moduleSlug(g.module) }));
}

export function metadata(props: PageProps): Metadata {
  const g = groupForSlug(String(props.params.module));
  return {
    title: g ? `${g.module} — API reference` : "API reference",
    description: g
      ? `Every public export of ${g.module}, grouped by kind and generated from the source with deno doc.`
      : "",
  };
}

export default function ApiModule(props: PageProps) {
  const g = groupForSlug(String(props.params.module));
  if (!g) {
    return (
      <DocsShell active="api" title="API reference">
        <p>
          Unknown module. <a href="/docs/api">← all modules</a>
        </p>
      </DocsShell>
    );
  }
  const sections = byKind(g.symbols);
  const denextOnly = g.symbols.filter((s) => s.denextOnly).length;
  return (
    <DocsShell
      active="api"
      title={g.module}
      lead={`${g.symbols.length} public exports (${denextOnly} unique to denext), grouped by kind. Select a symbol for its full signature, docs, and examples.`}
      toc={sections.map((s) => ({
        id: s.id,
        href: `#kind-${s.id}`,
        text: s.label,
        level: 2 as const,
        children: s.symbols.map((sym) => ({
          id: `sym-${sym.slug}`,
          text: sym.name,
        })),
      }))}
    >
      <nav class="api-modnav" aria-label="API modules">
        <a href="/docs/api">All modules</a>
        {GROUPS.map((m) => (
          <a
            key={m.module}
            href={`/docs/api/${moduleSlug(m.module)}`}
            class={m.module === g.module ? "active" : undefined}
            aria-current={m.module === g.module ? "page" : undefined}
          >
            <code>{m.module}</code>
          </a>
        ))}
      </nav>
      <div class="api-sections">
        {sections.map((section) => (
          <section
            key={section.id}
            id={`kind-${section.id}`}
            class="api-section"
          >
            <h2>
              {section.label} <span class="api-section-count">{section.symbols.length}</span>
            </h2>
            <ul class="api-list">
              {section.symbols.map((s) => (
                <li key={s.slug} id={`sym-${s.slug}`} class="api-list-item">
                  <span class="api-list-head">
                    <a
                      class="api-list-name"
                      href={`/docs/api/${moduleSlug(g.module)}/${s.slug}`}
                    >
                      <code>{s.name}</code>
                    </a>
                    <SymbolBadges symbol={s} />
                  </span>
                  {s.doc ? <span class="api-list-doc">{s.doc}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </DocsShell>
  );
}
