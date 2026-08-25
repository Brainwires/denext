---
title: Styling
slug: styling
lead: Global CSS, CSS Modules, and Tailwind — all first-party, all compiled at build time so your pages still ship 0 KB of JavaScript.
---

## Global CSS

Import a stylesheet from your root layout, or link it from the layout's `metadata.head`. It's served as a static asset.

```tsx
// app/layout.tsx
export const metadata = {
  head: '<link rel="stylesheet" href="/styles.css">',
};
```

## CSS Modules

Name a file `*.module.css` and import it for locally-scoped class names — no collisions, no runtime.

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
> Class names are hashed at build time and the CSS is emitted as a static file — the component stays a Server Component and ships no JavaScript.

## Tailwind

Tailwind v4 is supported first-party — denext manages the standalone binary. Point `tailwind: { input, output }` at a directive stylesheet and the compiled file to emit; `dev`/`build` compile it automatically. Import the _output_ from your layout.

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
> Prefer `class` over `className` in denext (both work). See the `examples/tailwind` app for a complete setup.
