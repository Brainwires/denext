# @denext/htmx

First-class [htmx](https://htmx.org) support for [denext](https://denext.dev),
shipped as a denext plugin. Add it, drop `<Htmx/>` in your layout, and every
`hx-*` attribute just works — server-rendered verbatim, **0 KB of denext client
JS** on pages that use only htmx.

The htmx runtime is **vendored** (currently **v2.0.10**) and served from your own
origin — zero npm, zero CDN, and it works unchanged under a strict
`script-src 'self'` Content-Security-Policy. This package's version tracks the
htmx version it wraps.

## Install

```ts
// denext.config.ts
import { htmx } from "@denext/htmx";

export default {
  plugins: [htmx()],
};
```

```tsx
// app/layout.tsx
import { Htmx } from "@denext/htmx";

export default function Layout({ children }: { children: unknown }) {
  return (
    <html>
      <body>
        {children}
        <Htmx />
      </body>
    </html>
  );
}
```

`<Htmx/>` emits `<script src="/_denext/htmx/htmx.min.js" defer>` — a classic
(non-module) deferred script, exactly what htmx expects. The plugin serves that
path in dev and prod, and emits the file into your export output for static sites.

## Use

A page that ships no denext JS at all:

```tsx
// app/page.tsx
export default function Page() {
  return (
    <div>
      <button hx-post="/clicked" hx-swap="outerHTML" hx-target="#result">Click me</button>
      <div id="result" />
    </div>
  );
}
```

The fragment endpoint — a normal denext `route.ts`, answered with `htmlResponse`:

```ts
// app/clicked/route.ts
import { htmlResponse } from "@denext/htmx";

export function POST() {
  return htmlResponse(<span>Clicked!</span>, { retarget: "#result" });
}
```

### Typed authoring (optional)

Raw `hx-*` attributes always type-check and work. For autocomplete and
typo-safety, spread the `hx()` helper instead:

```tsx
import { hx } from "@denext/htmx";

<button {...hx({ post: "/clicked", swap: "outerHTML", target: "#result" })}>Go</button>;
```

### Reading htmx requests

```ts
import { htmxRequest, isHtmxRequest } from "@denext/htmx";

export function GET(req: Request) {
  if (isHtmxRequest(req)) {
    const { boosted, target, triggerId } = htmxRequest(req);
    // …return a fragment
  }
  // …return the full page
}
```

## CLI

The plugin contributes a `denext htmx` verb:

```
denext htmx info          # print the vendored version and runtime URL
denext htmx eject [dir]   # copy htmx.min.js into your project (default: public/)
```

## Security notes

- The runtime is served from `'self'`, so no CSP change is needed for
  `script-src`. `hx-post`/`hx-get` fetches need `connect-src 'self'` (or the hosts
  you call).
- htmx will fetch whatever URL an `hx-get`/`hx-post` names, including a
  `javascript:`-scheme value — htmx only _fetches_ it (it is not evaluated as
  code), but never interpolate untrusted input into these attributes.

## Vendored runtime

`vendor/htmx.min.js` is the unmodified official htmx build; `vendor/LICENSE` is its
license (0BSD). This package itself is MIT (`LICENSE`). To update htmx, replace the
vendored file and bump both this package's version and `HTMX_VERSION` to match.
