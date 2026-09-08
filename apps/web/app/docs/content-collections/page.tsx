import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Content collections",
  description:
    "A typed, validated, queryable content layer for Markdown/MDX/YAML/JSON — declare collections with a Standard Schema, query them typed from a Server Component. Astro Content Layer / Nuxt Content for denext.",
};

export default function ContentCollections() {
  return (
    <DocsShell
      active="content-collections"
      title="Content collections"
      lead="Declare your Markdown/MDX/YAML/JSON collections once with a Standard Schema; query them, fully typed, from any Server Component. Entries are validated at build (and live in dev), and the types are generated for you — no ORM, no npm."
    >
      <h2>The idea</h2>
      <p>
        A blog, a docs site, a changelog — content that lives as files in your repo. Content
        collections turn those files into a typed <em>data</em> layer:{" "}
        <code>@denext/content-collections</code> reads them through a{" "}
        <em>loader</em>, validates each entry against a{" "}
        <em>Standard Schema</em>, and generates the types so <code>getCollection</code> and{" "}
        <code>getEntry</code>{" "}
        are checked against your schema — the field names, their types, everything. It's the
        first-party equivalent of Astro's Content Layer or Nuxt Content, built on web standards and
        with zero runtime npm.
      </p>
      <Callout kind="note">
        Content collections are a first-party <strong>package</strong>,{" "}
        <code>@denext/content-collections</code>{" "}
        (on JSR), not part of the core bundle — an app that doesn't use them ships nothing extra.
        The loader is validator-agnostic: Zod, Valibot, ArkType, TypeBox, or a hand-rolled{" "}
        <code>~standard</code> object all work.
      </Callout>

      <h2>Enable the plugin</h2>
      <p>
        Add the plugin to <code>denext.config.ts</code>. It contributes a <em>prepare step</em>{" "}
        that regenerates the store and the types — live in <code>denext dev</code>{" "}
        (re-running when a content file changes) and at <code>denext build</code>.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
import type { DenextConfig } from "denext/server";
import { contentCollections } from "@denext/content-collections";

export default {
  plugins: [contentCollections()],
} satisfies DenextConfig;`}
      </Code>
      <p>
        And add the package to your <code>deno.json</code> imports:
      </p>
      <Code lang="json">
        {`{
  "imports": {
    "@denext/content-collections": "jsr:@denext/content-collections@^0.1.0"
  }
}`}
      </Code>

      <h2>Declare your collections</h2>
      <p>
        In <code>content.config.ts</code> at the project root, describe each collection with a{" "}
        <em>loader</em> (where the entries come from) and a <em>schema</em>{" "}
        (their shape). The built-in <code>glob</code>{" "}
        loader reads local files — MD/MDX yield their YAML frontmatter as <code>data</code>{" "}
        plus the raw <code>body</code>; YAML/JSON yield the parsed object.
      </p>
      <Code lang="ts">
        {`// content.config.ts
import { defineCollection, defineContentConfig, glob } from "@denext/content-collections/config";
import { z } from "zod";

export default defineContentConfig({
  collections: {
    blog: defineCollection({
      loader: glob({ pattern: "**/*.md", base: "content/blog" }),
      schema: z.object({
        title: z.string(),
        date: z.string(),
        draft: z.boolean().default(false),
      }),
    }),
  },
});`}
      </Code>
      <p>
        An entry's <code>id</code> is its source path under the loader's <code>base</code>{" "}
        without the extension (<code>content/blog/hello.md</code> →{" "}
        <code>hello</code>). A file that fails its schema is <strong>dropped and reported</strong>
        {" "}
        as a diagnostic, never silently included — and one malformed file (bad YAML/JSON) is a
        per-file diagnostic, not a build failure that empties the collection.
      </p>

      <h2>Query it, typed</h2>
      <p>
        Import the generated <code>.denext/content.ts</code> once (it registers your{" "}
        <code>content.config.ts</code> type), then <code>getCollection</code> /{" "}
        <code>getEntry</code>{" "}
        are typed to your schemas. Both are server-only — call them from a Server Component or a
        route handler.
      </p>
      <Code lang="tsx">
        {`// app/blog/page.tsx
import "../../.denext/content.ts"; // registers the collection types (type-only; nothing ships)
import { getCollection } from "@denext/content-collections/runtime";

export default async function Blog() {
  // p.data is typed { title: string; date: string; draft: boolean }
  const posts = await getCollection("blog", (p) => !p.data.draft);
  posts.sort((a, b) => b.data.date.localeCompare(a.data.date));
  return (
    <ul>
      {posts.map((p) => <li key={p.id}><a href={\`/blog/\${p.id}\`}>{p.data.title}</a></li>)}
    </ul>
  );
}`}
      </Code>
      <p>
        <code>getEntry("blog", id)</code> returns one entry (or{" "}
        <code>undefined</code>). Each entry is <code>{"{ id, slug, data, body }"}</code> —{" "}
        <code>slug</code> equals <code>id</code>, and <code>body</code>{" "}
        is the raw MD/MDX source for the pages that have one. The array you get back is a fresh
        copy, so sorting or filtering it in place never affects other requests.
      </p>

      <h2>Render Markdown/MDX</h2>
      <p>
        Collections are a <em>data</em> layer: an entry's <code>body</code>{" "}
        is the raw source, which you render with your own MDX setup or a Markdown renderer of your
        choice. There is no first-party render helper — you pick the renderer, denext gives you the
        validated data and the types.
      </p>

      <h2>CLI</h2>
      <p>
        The plugin adds a <code>denext content</code> verb:
      </p>
      <Code lang="bash">
        {`denext content build      # regenerate .denext/content-data.json + content.ts
denext content list       # print each collection's entry ids
denext content validate   # exit 1 on any schema failure — a CI gate`}
      </Code>
      <Callout kind="warn">
        Two v1 notes: the built store is read from{" "}
        <code>&lt;cwd&gt;/.denext/content-data.json</code>, so run the app from its project root (as
        {" "}
        <code>deno task dev</code>/<code>start</code> do); and an <em>unquoted</em>{" "}
        YAML frontmatter date parses as a JS <code>Date</code>{" "}
        — quote it (<code>date: "2026-01-01"</code>) or use a date schema.
      </Callout>

      <h2>Remote sources</h2>
      <p>
        <code>glob</code> is one loader; a loader is any <code>{"{ name, load(ctx) }"}</code>{" "}
        that returns entries, so a collection can just as well come from a CMS, an API, or a
        database. Return <code>{"{ id, data }"}</code>{" "}
        objects and the same validation, typing, and query API apply.
      </p>
    </DocsShell>
  );
}
