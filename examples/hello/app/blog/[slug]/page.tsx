// A dynamic route: /blog/:slug. Also an async (server) component that "fetches"
// data before rendering — this runs only on the server.

import type { Metadata, PageProps } from "denext/server";

/** This route's params: `[slug]` is one path segment. */
type Props = PageProps<{ slug: string }>;

export async function metadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `denext — blog: ${slug}` };
}

// Pre-render these slugs during `denext export` (static generation).
export function generateStaticParams(): Array<{ slug: string }> {
  return [{ slug: "hello-world" }, { slug: "static-generation" }];
}

interface Post {
  title: string;
  body: string;
}

async function getPost(slug: string): Promise<Post> {
  // Stand-in for a real data source (DB, fetch, file read...).
  await Promise.resolve();
  return {
    title: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    body: `This is the post rendered for the "${slug}" slug, produced on the ` +
      `server as an async component.`,
  };
}

export default async function BlogPost({ params }: Props) {
  const { slug } = await params;
  const post = await getPost(slug);
  return (
    <article>
      <h1>{post.title}</h1>
      <p class="slug">
        slug: <code>{slug}</code>
      </p>
      <p>{post.body}</p>
    </article>
  );
}
