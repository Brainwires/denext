// Dynamic route /blog/:slug — mirrors examples/hello/app/blog/[slug]/page.tsx.
// Async server component that "fetches" before rendering; generateStaticParams
// pre-renders the same two slugs. No client JS.
import type { Metadata } from "next";

export function generateStaticParams(): Array<{ slug: string }> {
  return [{ slug: "hello-world" }, { slug: "static-generation" }];
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  return { title: `denext — blog: ${slug}` };
}

interface Post {
  title: string;
  body: string;
}

async function getPost(slug: string): Promise<Post> {
  await Promise.resolve();
  return {
    title: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    body: `This is the post rendered for the "${slug}" slug, produced on the ` +
      `server as an async component.`,
  };
}

export default async function BlogPost(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const post = await getPost(slug);
  return (
    <article>
      <h1>{post.title}</h1>
      <p className="slug">
        slug: <code>{slug}</code>
      </p>
      <p>{post.body}</p>
    </article>
  );
}
