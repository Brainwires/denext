---
title: Styling
slug: styling
lead: Global CSS, CSS Modules, Sass, Tailwind, and CSS-in-JS (styled-components/emotion) — all first-party. The build-time options ship 0 KB of JavaScript.
---

## Global CSS

Import a stylesheet from your root layout, or link it from the layout's
`metadata.head`. It's served as a static asset.

```tsx
// app/layout.tsx
export const metadata = {
  head: '<link rel="stylesheet" href="/styles.css">',
};
```

## CSS Modules

Name a file `*.module.css` and import it for locally-scoped class names — no
collisions, no runtime.

```tsx
// button.module.css
.primary { background: #7aa2ff; color: #071021; }

// Button.tsx
import styles from "./button.module.css";

export function Button(props) {
  return <button class={styles.primary} {...props} />;
}
```

> [!NOTE]
> Class names are hashed at build time and the CSS is emitted as a static file —
> the component stays a Server Component and ships no JavaScript.

## Tailwind

Tailwind v4 is supported first-party — denext manages the standalone binary.
Point `tailwind: { input, output }` at a directive stylesheet and the compiled
file to emit; `dev`/`build` compile it automatically. Import the _output_ from
your layout.

```ts
// denext.config.ts
import type { DenextConfig } from "denext/server";

export default {
  tailwind: {
    input: "./app/tailwind.css", // contains: @import "tailwindcss";
    output: "./app/globals.css", // compiled file, imported by your layout
  },
} satisfies DenextConfig;
```

```tsx
export default function Card() {
  return <div class="rounded-xl border p-6 shadow">Hello</div>;
}
```

> [!NOTE]
> Prefer `class` over `className` in denext (both work). See the
> `examples/tailwind` app for a complete setup.

## Sass

`.scss` / `.sass` files (and `*.module.scss` / `*.module.sass` CSS Modules)
compile through the same build-time pipeline as plain CSS — import them exactly
like a stylesheet. No runtime, no JavaScript shipped.

```tsx
// app/layout.tsx
import "./globals.scss";
```

```tsx
// A Sass CSS Module — class names are still locally scoped + hashed.
import styles from "./Card.module.scss";
export default function Card() {
  return <div class={styles.card}>Hello</div>;
}
```

## CSS-in-JS (styled-components / emotion)

Runtime CSS-in-JS libraries work under `compatibilityMode` (the Next.js
drop-in). Server-rendered styles are collected and injected into the document
`<head>` via `useServerInsertedHTML`, so the first paint is fully styled with no
flash — on the streaming, Flight, and buffered SSR paths alike.

```tsx
"use client";
import { useServerInsertedHTML } from "denext/server";
import { ServerStyleSheet, StyleSheetManager } from "styled-components";

export function StyleRegistry({ children }: { children: React.ReactNode }) {
  const [sheet] = useState(() => new ServerStyleSheet());
  useServerInsertedHTML(() => sheet.getStyleElement());
  if (typeof window !== "undefined") return <>{children}</>;
  return <StyleSheetManager sheet={sheet.instance}>{children}</StyleSheetManager>;
}
```

> [!NOTE]
> Unlike the build-time options above, CSS-in-JS ships its runtime to the
> client. Prefer CSS Modules, Sass, or Tailwind for new code; CSS-in-JS is here
> so existing Next.js apps migrate unchanged. The App Router
> `useServerInsertedHTML` registry pattern works as-is; the Pages Router uses
> `_document` + `ServerStyleSheet`.
