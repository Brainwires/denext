import "../../../.denext/content.ts";
import { notFound } from "denext";
import { getEntry } from "@denext/content-collections/runtime";

export default async function Post({ params }: { params: { slug: string } }) {
  const post = await getEntry("blog", params.slug);
  if (!post || post.data.draft) notFound();
  return (
    <article>
      <h1>{post.data.title}</h1>
      <p>
        <small>{post.data.date}</small>
      </p>
      <pre>{post.body}</pre>
    </article>
  );
}
