import { createFileRoute, Link } from "@tanstack/react-router";
import { listPosts } from "../../data.ts";

export const Route = createFileRoute("/posts/")({
  loader: () => listPosts(),
  component: Posts,
});

function Posts() {
  const posts = Route.useLoaderData();
  return (
    <section id="posts">
      <h1>Posts</h1>
      <ul>
        {posts.map((p) => (
          <li key={p.id}>
            <Link to="/posts/$postId" params={{ postId: p.id }}>{p.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
