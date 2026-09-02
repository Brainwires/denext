// Rendering helpers specific to the generated API reference: JSDoc prose (with inline
// code + `{@link}` cross-references) and the per-symbol badges. Server-only, zero JS.

import type { VNodeChild, VNodeChildren } from "denext";
import { type ApiSymbol, hrefForName, kindLabel } from "../lib/api.ts";

/** Render one JSDoc `{@link}` target as a cross-link (or plain code when unresolved). */
function LinkTag({ raw }: { raw: string }) {
  // `{@link Target}`, `{@link Target | label}`, `{@link Target#member}` or a bare URL.
  const body = raw.trim();
  const pipe = body.indexOf("|");
  const target = (pipe >= 0 ? body.slice(0, pipe) : body).trim();
  const label = (pipe >= 0 ? body.slice(pipe + 1) : body).trim();
  if (/^https?:\/\//.test(target)) {
    return (
      <a href={target}>
        {label}
      </a>
    );
  }
  const name = target.split("#")[0];
  const href = hrefForName(name);
  return href
    ? (
      <a href={href}>
        <code>{label}</code>
      </a>
    )
    : <code>{label}</code>;
}

/** Split plain text into text / inline-`` `code` `` nodes. */
function renderCode(text: string, keyBase: string): VNodeChild[] {
  const out: VNodeChild[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let key = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<code key={`${keyBase}c${key++}`}>{m[1]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Tokenize one paragraph. `{@link}` tags are resolved FIRST (an odd backtick count could
 * otherwise let a code span swallow one), then inline code within the remaining segments.
 */
function renderInline(text: string): VNodeChild[] {
  const out: VNodeChild[] = [];
  const re = /\{@link(?:code|plain)?\s+([^}]+)\}/g;
  let last = 0;
  let key = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(...renderCode(text.slice(last, m.index), `s${key}`));
    out.push(<LinkTag key={`l${key++}`} raw={m[1]} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...renderCode(text.slice(last), `s${key}`));
  return out;
}

/** Render a JSDoc doc string as paragraphs, with inline code and `{@link}` cross-links. */
export function DocText({ text }: { text: string }) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return (
    <>
      {paras.map((p, i) => <p key={i}>{renderInline(p)}</p>)}
    </>
  );
}

/**
 * The two badges beside a symbol: its kind, and — when nothing in React/Next/Remix shares
 * the name — a prominent "denext-only" chip so a migrating dev knows there's no upstream
 * API to compare against.
 */
export function SymbolBadges({ symbol }: { symbol: ApiSymbol }) {
  return (
    <>
      <span class="api-kind">{kindLabel(symbol.kind)}</span>
      {symbol.denextOnly
        ? (
          <span class="api-only" title="No React/Next equivalent — unique to denext">
            denext-only
          </span>
        )
        : null}
    </>
  );
}

/** The full-width "unique to denext" callout shown at the top of a denext-only symbol page. */
export function DenextOnlyCallout({ children }: { children?: VNodeChildren }) {
  return (
    <aside class="callout denext-only-note" aria-label="denext-only API">
      <strong>Unique to denext.</strong>{" "}
      No React or Next.js API shares this name, so there's nothing upstream to cross-reference —
      this is native denext.{children}
    </aside>
  );
}
