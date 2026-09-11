import "../../../.denext/content.ts";
import { notFound } from "denext";
import { Content, getEntry } from "@denext/content-collections/runtime";

export default async function Post({ params }: { params: { slug: string } }) {
  const post = await getEntry("blog", params.slug);
  if (!post || post.data.draft) notFound();
  return (
    <article>
      <h1>{post.data.title}</h1>
      <p>
        <small>{post.data.date}</small>
      </p>
      {
        /* `.md` renders through the first-party Markdown renderer, `.mdx` through the module
          compiled at build — both server-side, zero client JS. */
      }
      <Content entry={post} />
    </article>
  );
}
