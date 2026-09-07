// The docs page `@denext/openapi` serves at `/docs`. Three renderers:
//
//   builtin  — a server-rendered reference (no JavaScript, no network): every operation
//              with its parameters, request body, responses and schemas. Works unchanged
//              under a strict `script-src 'self'` CSP; its stylesheet is served from the
//              same origin at `<docsPath>.css`.
//   scalar   — Scalar's API reference loaded from a CDN (the default `cdn` is jsDelivr).
//   swagger  — Swagger UI loaded from a CDN (the default is unpkg's swagger-ui-dist@5).
//
// The CDN variants are interactive ("try it") but need the CDN host in the app's CSP.

import type { JsonSchema, OpenApiDocument, OpenApiOperation } from "./spec.ts";

/** Which docs renderer to serve. */
export type DocsUi = "builtin" | "scalar" | "swagger";

/** Options for {@linkcode renderDocsHtml}. */
export interface DocsHtmlOptions {
  /** The URL the spec is served at (`/openapi.json`). */
  specUrl: string;
  /** The renderer. */
  ui: DocsUi;
  /** Override the CDN script URL (scalar) or dist base URL (swagger). */
  cdn?: string;
  /** The stylesheet URL for the builtin renderer. */
  styleUrl?: string;
}

/** Default CDN locations for the interactive renderers. */
export const DOCS_CDN: Record<Exclude<DocsUi, "builtin">, string> = {
  // Pinned to an exact version: a floating tag would run whatever the CDN serves next on the
  // app's own origin. Bump deliberately; or self-host and point `cdn` at your copy.
  scalar:
    "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.67.0/dist/browser/standalone.min.js",
  swagger: "https://unpkg.com/swagger-ui-dist@5.32.15",
};

const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Render the docs page for a document. */
export function renderDocsHtml(doc: OpenApiDocument, options: DocsHtmlOptions): string {
  const title = esc(doc.info.title);
  const head =
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>`;
  if (options.ui === "scalar") {
    const src = esc(options.cdn ?? DOCS_CDN.scalar);
    return `<!doctype html><html lang="en"><head>${head}</head><body>` +
      `<script id="api-reference" data-url="${esc(options.specUrl)}"></script>` +
      `<script src="${src}"></script></body></html>`;
  }
  if (options.ui === "swagger") {
    const base = esc((options.cdn ?? DOCS_CDN.swagger).replace(/\/$/, ""));
    return `<!doctype html><html lang="en"><head>${head}` +
      `<link rel="stylesheet" href="${base}/swagger-ui.css"></head><body><div id="swagger-ui"></div>` +
      `<script src="${base}/swagger-ui-bundle.js" crossorigin></script>` +
      `<script>window.onload=()=>{window.ui=SwaggerUIBundle({url:${
        JSON.stringify(options.specUrl).replace(/</g, "\\u003c")
      },dom_id:"#swagger-ui"})}</script></body></html>`;
  }
  const style = options.styleUrl ? `<link rel="stylesheet" href="${esc(options.styleUrl)}">` : "";
  return `<!doctype html><html lang="en"><head>${head}${style}</head><body>` +
    renderReference(doc, options.specUrl) + `</body></html>`;
}

// ── builtin ──────────────────────────────────────────────────────────────────

const METHOD_ORDER = ["get", "post", "put", "patch", "delete", "options"];

type Entry = { path: string; method: string; op: OpenApiOperation };

function entries(doc: OpenApiDocument): Entry[] {
  const out: Entry[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHOD_ORDER) {
      if (item[method]) out.push({ path, method, op: item[method] });
    }
  }
  return out;
}

function anchor(e: Entry): string {
  return String(e.op.operationId ?? `${e.method}-${e.path}`).replace(/[^A-Za-z0-9_-]+/g, "-");
}

function renderReference(doc: OpenApiDocument, specUrl: string): string {
  const all = entries(doc);
  const groups = new Map<string, Entry[]>();
  for (const e of all) {
    const tag = Array.isArray(e.op.tags) && e.op.tags.length ? String(e.op.tags[0]) : "default";
    (groups.get(tag) ?? groups.set(tag, []).get(tag)!).push(e);
  }
  const nav = [...groups].map(([tag, list]) =>
    `<li><strong>${esc(tag)}</strong><ul>${
      list.map((e) =>
        `<li><a href="#${anchor(e)}"><code class="m ${e.method}">${e.method.toUpperCase()}</code> ${
          esc(e.path)
        }</a></li>`
      ).join("")
    }</ul></li>`
  ).join("");
  const header =
    `<header><h1>${esc(doc.info.title)} <small>v${esc(doc.info.version)}</small></h1>` +
    (doc.info.description ? `<p>${esc(doc.info.description)}</p>` : "") +
    `<p><a href="${esc(specUrl)}">openapi.json</a> · ${all.length} operation${
      all.length === 1 ? "" : "s"
    }</p></header>`;
  return `${header}<div class="wrap"><nav><ul>${nav}</ul></nav><main>${
    all.map(renderOperation).join("")
  }</main></div>`;
}

function renderOperation(e: Entry): string {
  const { op } = e;
  const params = Array.isArray(op.parameters) ? op.parameters as Record<string, unknown>[] : [];
  const body = (op.requestBody as { content?: Record<string, { schema?: JsonSchema }> } | undefined)
    ?.content?.["application/json"]?.schema;
  return `<section id="${
    anchor(e)
  }"><h2><code class="m ${e.method}">${e.method.toUpperCase()}</code> ` +
    `<code class="p">${esc(e.path)}</code></h2>` +
    (op.summary ? `<p class="summary">${esc(op.summary)}</p>` : "") +
    (op.description ? `<p>${esc(op.description)}</p>` : "") +
    (params.length ? `<h3>Parameters</h3>${renderParams(params)}` : "") +
    (body ? `<h3>Request body</h3>${renderSchema(body, 0)}` : "") +
    `<h3>Responses</h3>${renderResponses(op.responses as Record<string, unknown> ?? {})}</section>`;
}

function renderParams(params: Record<string, unknown>[]): string {
  const rows = params.map((p) =>
    `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.in)}</td><td>${
      p.required ? "yes" : "no"
    }</td><td>${renderSchema(p.schema as JsonSchema ?? {}, 0)}</td></tr>`
  ).join("");
  return `<table><thead><tr><th>Name</th><th>In</th><th>Required</th><th>Schema</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
}

function renderResponses(responses: Record<string, unknown>): string {
  return `<dl>${
    Object.entries(responses).map(([status, r]) => {
      const res = r as { description?: string; content?: Record<string, { schema?: JsonSchema }> };
      const schema = res.content?.["application/json"]?.schema;
      return `<dt><code class="s s${status[0]}">${esc(status)}</code> ${
        esc(res.description ?? "")
      }</dt>` +
        `<dd>${schema ? renderSchema(schema, 0) : "<em>no body</em>"}</dd>`;
    }).join("")
  }</dl>`;
}

/** A compact tree for a JSON Schema (depth-capped; `$ref`s shown by name). */
export function renderSchema(schema: JsonSchema, depth: number): string {
  if (depth > 6) return "<em>…</em>";
  if (typeof schema.$ref === "string") {
    return `<code>${esc(schema.$ref.replace("#/components/schemas/", ""))}</code>`;
  }
  const combo = (["allOf", "oneOf", "anyOf"] as const).find((k) => Array.isArray(schema[k]));
  if (combo) {
    return `<span class="combo">${combo}</span><ul>${
      (schema[combo] as JsonSchema[]).map((s) => `<li>${renderSchema(s, depth + 1)}</li>`).join("")
    }</ul>`;
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => `<code>${esc(JSON.stringify(v))}</code>`).join(" | ");
  }
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
  if (type === "object" || (type === undefined && schema.properties)) {
    return renderObject(schema, depth);
  }
  if (type === "array") {
    const items = (schema.items as JsonSchema | undefined) ?? {};
    return `${renderSchema(items, depth + 1)}<code>[]</code>`;
  }
  if (type === undefined) return "<em>any</em>";
  const facets = ["format", "minLength", "maxLength", "minimum", "maximum", "pattern"]
    .filter((k) => schema[k] !== undefined).map((k) => `${k}: ${esc(schema[k])}`);
  return `<code>${esc(type)}</code>${
    facets.length ? ` <small>(${facets.join(", ")})</small>` : ""
  }`;
}

function renderObject(schema: JsonSchema, depth: number): string {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const rows = Object.entries(props).map(([name, s]) =>
    `<li><code>${esc(name)}</code>${required.has(name) ? "" : "<sup>?</sup>"}: ${
      renderSchema(s, depth + 1)
    }${s.description ? ` <small>— ${esc(s.description)}</small>` : ""}</li>`
  );
  if (!rows.length) return "<code>object</code>";
  return `<ul class="obj">${rows.join("")}</ul>`;
}

/** The builtin renderer's stylesheet (served same-origin, so a strict CSP needs no change). */
export const DOCS_CSS = `
:root{color-scheme:light dark;--fg:#1c1c1c;--bg:#fff;--mute:#666;--line:#e3e3e3;--code:#f4f4f5}
@media(prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#111;--mute:#999;--line:#2a2a2a;--code:#1d1d1f}}
body{margin:0;font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
header{padding:1.25rem 1.5rem;border-bottom:1px solid var(--line)}
header h1{margin:0;font-size:1.4rem}header small{color:var(--mute);font-weight:400}
header p{margin:.25rem 0 0;color:var(--mute)}
.wrap{display:grid;grid-template-columns:minmax(200px,260px) 1fr;gap:1.5rem;padding:1.5rem}
@media(max-width:800px){.wrap{grid-template-columns:1fr}}
nav ul{list-style:none;padding:0;margin:0}nav li li{margin:.15rem 0 .15rem .5rem;font-size:.9rem}
nav a{color:inherit;text-decoration:none}nav a:hover{text-decoration:underline}
section{padding:1rem 0 1.25rem;border-bottom:1px solid var(--line)}
h2{font-size:1.1rem;margin:0 0 .25rem}h3{font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:1rem 0 .25rem}
.summary{margin:0;font-weight:500}
code{font:.85em ui-monospace,Menlo,monospace;background:var(--code);padding:.05em .3em;border-radius:3px}
code.m{color:#fff;font-weight:700;font-size:.7em;text-transform:uppercase;padding:.15em .45em}
.m.get{background:#2f7d32}.m.post{background:#1565c0}.m.put,.m.patch{background:#ef6c00}.m.delete{background:#c62828}.m.options{background:#616161}
code.s{font-weight:700}.s2{color:#2f7d32}.s4{color:#ef6c00}.s5{color:#c62828}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;padding:.3rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
ul.obj{list-style:none;margin:.15rem 0;padding-left:1rem;border-left:2px solid var(--line)}
dl{margin:0}dt{margin-top:.5rem}dd{margin:.15rem 0 0 1rem}sup{color:var(--mute)}.combo{color:var(--mute);font-style:italic}
`;
