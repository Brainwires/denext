// A dynamic route: /blog/:slug. Also an async (server) component that "fetches"
// data before rendering — this runs only on the server.

import type { Metadata, PageProps } from "denext/server";

export function metadata(props: PageProps): Metadata {
  return { title: `denext — blog: ${props.params.slug}` };
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

export default async function BlogPost({ params }: PageProps) {
  const post = await getPost(params.slug);
  return (
    <article>
      <h1>{post.title}</h1>
      <p class="slug">slug: <code>{params.slug}</code></p>
      <p>{post.body}</p>
    </article>
  );
}
