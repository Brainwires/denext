import type { Metadata, PageProps } from "denext/server";
import { Code, DocsShell } from "../../../../../components/ui.tsx";
import { DenextOnlyCallout, DocText, SymbolBadges } from "../../../../../components/api.tsx";
import { type ApiSymbol, groupForSlug, GROUPS, moduleSlug } from "../../../../../lib/api.ts";

/** Pre-render one static page per (module, symbol) during `denext export`. */
export function generateStaticParams(): Array<{ module: string; symbol: string }> {
  return GROUPS.flatMap((g) =>
    g.symbols.map((s) => ({ module: moduleSlug(g.module), symbol: s.slug }))
  );
}

function lookup(params: PageProps["params"]): { module: string; symbol: ApiSymbol } | null {
  const g = groupForSlug(String(params.module));
  if (!g) return null;
  const symbol = g.symbols.find((s) => s.slug === String(params.symbol));
  return symbol ? { module: g.module, symbol } : null;
}

export function metadata(props: PageProps): Metadata {
  const hit = lookup(props.params);
  if (!hit) return { title: "API reference" };
  return {
    title: `${hit.symbol.name} — ${hit.module}`,
    description: hit.symbol.doc ||
      `${hit.symbol.name}, a ${hit.symbol.kind} exported from ${hit.module}.`,
  };
}

/** A single ```lang fenced example → its language + inner source. */
function parseExample(raw: string): { lang: string; code: string } {
  const m = raw.trim().match(/^```([\w-]+)?\n([\s\S]*?)\n```$/);
  return m ? { lang: m[1] ?? "ts", code: m[2] } : { lang: "ts", code: raw.trim() };
}

export default function ApiSymbolPage(props: PageProps) {
  const hit = lookup(props.params);
  if (!hit) {
    return (
      <DocsShell active="api" title="API reference">
        <p>
          Unknown symbol. <a href="/docs/api">← all modules</a>
        </p>
      </DocsShell>
    );
  }
  const { module, symbol } = hit;
  const modSeg = moduleSlug(module);

  const toc = [{ id: "signature", text: "Signature", level: 2 as const }];
  if (symbol.docFull) toc.push({ id: "description", text: "Description", level: 2 as const });
  if (symbol.params.length) toc.push({ id: "parameters", text: "Parameters", level: 2 as const });
  if (symbol.returns) toc.push({ id: "returns", text: "Returns", level: 2 as const });
  if (symbol.examples.length) toc.push({ id: "examples", text: "Examples", level: 2 as const });

  return (
    <DocsShell
      active="api"
      title={symbol.name}
      lead={symbol.doc || undefined}
      toc={toc}
    >
      <nav class="api-crumbs" aria-label="Breadcrumb">
        <a href="/docs/api">API</a>
        <span aria-hidden="true">/</span>
        <a href={`/docs/api/${modSeg}`}>
          <code>{module}</code>
        </a>
        <span aria-hidden="true">/</span>
        <span class="api-crumb-current">{symbol.name}</span>
      </nav>

      <p class="api-detail-badges">
        <SymbolBadges symbol={symbol} />
        <span class="api-detail-import">
          <code>import {`{ ${symbol.name} }`} from "{module}"</code>
        </span>
      </p>

      {symbol.denextOnly ? <DenextOnlyCallout /> : null}

      <h2 id="signature">Signature</h2>
      <Code lang="ts">{symbol.signature}</Code>

      {symbol.docFull
        ? (
          <>
            <h2 id="description">Description</h2>
            <DocText text={symbol.docFull} />
          </>
        )
        : null}

      {symbol.params.length
        ? (
          <>
            <h2 id="parameters">Parameters</h2>
            <dl class="api-params">
              {symbol.params.map((p) => (
                <div key={p.name} class="api-param">
                  <dt>
                    <code>{p.name}</code>
                  </dt>
                  <dd>{p.doc || <span class="api-param-nodoc">—</span>}</dd>
                </div>
              ))}
            </dl>
          </>
        )
        : null}

      {symbol.returns
        ? (
          <>
            <h2 id="returns">Returns</h2>
            <p>{symbol.returns}</p>
          </>
        )
        : null}

      {symbol.examples.length
        ? (
          <>
            <h2 id="examples">Examples</h2>
            {symbol.examples.map((raw, i) => {
              const ex = parseExample(raw);
              return <Code key={i} lang={ex.lang}>{ex.code}</Code>;
            })}
          </>
        )
        : null}

      <p class="api-detail-back">
        <a href={`/docs/api/${modSeg}`}>
          ← all of <code>{module}</code>
        </a>
      </p>
    </DocsShell>
  );
}
