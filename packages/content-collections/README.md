# @denext/content-collections

A typed, validated, queryable **content layer** for [denext](https://denext.dev) apps —
MD/MDX/YAML/JSON, in the spirit of Astro's Content Layer and Nuxt Content. Declare collections
with a [Standard Schema](https://standardschema.dev) (Zod/Valibot/ArkType/…) and a loader; the
plugin validates every entry and generates types so `getCollection` / `getEntry` are fully typed.
The store + types regenerate **live in `denext dev`** and at `denext build`.

## Install

```ts
// denext.config.ts
import { contentCollections } from "@denext/content-collections";

export default {
  plugins: [contentCollections()],
};
```

Deno resolves the package from your import map (`jsr:@denext/content-collections`).

## Declare collections

```ts
// content.config.ts
import { defineCollection, defineContentConfig, glob } from "@denext/content-collections/config";
import { z } from "zod";

export default defineContentConfig({
  collections: {
    blog: defineCollection({
      loader: glob({ pattern: "**/*.md", base: "content/blog" }),
      schema: z.object({
        title: z.string(),
        date: z.string(), // NOTE: quote dates in YAML frontmatter, or use z.coerce.date()
        draft: z.boolean().default(false),
      }),
    }),
  },
});
```

- **`glob`** reads local files under `base`. MD/MDX yield YAML frontmatter as `data` + the rest as
  `body`; YAML/JSON yield the parsed object as `data`. The entry `id` is the path under `base`
  without its extension (`guides/intro`).
- Any object with a `load(ctx)` returning entries is a **loader**, so a remote/custom source is a
  plain function — no special API.

## Query (server-only)

```tsx
import "./.denext/content.ts"; // registers the collection types (generated at dev/build)
import { getCollection, getEntry } from "@denext/content-collections/runtime";

export default async function Blog() {
  const posts = await getCollection("blog", (p) => !p.data.draft); // p.data is typed to the schema
  return <ul>{posts.map((p) => <li key={p.id}>{p.data.title}</li>)}</ul>;
}
```

`getCollection(name, filter?)` and `getEntry(name, id)` return `{ id, slug, data, body, format }`
typed to each collection's schema. Call them from Server Components, route handlers, or build code.

## Render

```tsx
import { Content, getEntry } from "@denext/content-collections/runtime";

export default async function Post({ params }: { params: { slug: string } }) {
  const post = await getEntry("blog", params.slug);
  if (!post) notFound();
  return (
    <article>
      <h1>{post.data.title}</h1>
      <Content entry={post} /> {/* .md → first-party renderer; .mdx → module compiled at build */}
    </article>
  );
}
```

`renderContent(entry, { components })` is the function form; `components` reaches an MDX
document (`{ h1: Heading, Callout }`).

## CLI

- `denext content build` — rebuild the store + generated types.
- `denext content list` — list every collection and its entry ids.
- `denext content validate` — build and exit 1 if any entry fails its schema (a CI gate).

## Notes

- **Store:** the built store is `.denext/content-data.json`, read at request time from
  `<cwd>/.denext`. Run your app from the project root (as `deno task dev` / `start` do).
- **Rendering:** `body` is the raw MD/MDX source (render it yourself if you like), and the
  runtime renders it for you: `await renderContent(entry)` or `<Content entry={entry} />`
  (server-only). A `.md` entry renders through the package's first-party, zero-dependency
  Markdown renderer at request time (`@denext/content-collections/markdown` — headings with ids,
  lists, fenced code, blockquotes / `> [!NOTE]` callouts, links, emphasis; raw HTML is escaped,
  `javascript:`/`data:` links are dropped). A `.mdx` entry is compiled **at build** (and at dev
  startup / on change) into a component module under `.denext/content/<collection>/<id>.js`
  with denext's build-time `@mdx-js/mdx` — nothing MDX-related runs at request time — and
  `renderContent(entry, { components })` passes `components` to the document. `format` on each
  entry says which (`"md"` / `"mdx"`; absent for data collections, which have nothing to render).
- **YAML dates:** unquoted `date: 2026-09-01` parses as a `Date`, not a string — quote it, or use a
  date schema.

MIT © denext
