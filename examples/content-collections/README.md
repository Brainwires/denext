# Content collections

`@denext/content-collections` in one app: a small blog whose posts are **typed Markdown and
MDX files on disk**. `content.config.ts` declares a `blog` collection with the `glob` loader
(`content/blog/**/*.{md,mdx}`) and a **Zod** schema for the frontmatter; the plugin validates
every entry, builds a store and **generates the types** — live under `denext dev`, and again at
`denext build`. A Server Component then queries it typed: `getCollection("blog", …)` on the index,
`getEntry("blog", slug)` on `/blog/[slug]`, and `<Content entry={post} />` to render a body —
`.md` through the first-party Markdown renderer, `.mdx` through a module compiled at build. Both
are server-side, so the whole blog ships **zero client JavaScript**.

```sh
deno task dev          # http://localhost:3000 — the post list; /blog/<slug> for an entry
```

The drafts show the schema doing work: `draft: z.boolean().default(false)` is filled in when a
post omits it, and `draft-post.md` is filtered out of the index and 404s on its route.

## The `denext content` verb

```sh
deno run -A ../../cli.ts content build .      # rebuild the store + generated types
deno run -A ../../cli.ts content list .       # every collection and its entry ids
deno run -A ../../cli.ts content validate .   # exit 1 if any entry fails its schema — a CI gate
```

In a real app these are `denext content build | list | validate`.

Docs: <https://denext.dev/docs/content-collections>.
