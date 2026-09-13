import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { getPost } from "../../data.ts";

export const Route = createFileRoute("/posts/$postId")({
  loader: ({ params }) => {
    const post = getPost(params.postId);
    if (!post) throw notFound();
    return post;
  },
  component: PostPage,
  notFoundComponent: () => (
    <section id="post-missing">
      <h1>No such post</h1>
      <Link to="/posts">All posts</Link>
    </section>
  ),
});

function PostPage() {
  const post = Route.useLoaderData();
  const { postId } = Route.useParams();
  return (
    <article id="post">
      <h1>{post.title}</h1>
      <p>{post.body}</p>
      <p>
        <small>post #{postId}</small> · <Link to="/posts">All posts</Link>
      </p>
    </article>
  );
}
