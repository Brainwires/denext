import { createFileRoute, Link } from "@tanstack/react-router";
import { listPosts } from "../../data.ts";

export const Route = createFileRoute("/posts/")({
  loader: listPosts,
  component: () => (
    <section id="posts">
      <h1>Posts</h1>
      <ul>
        {Route.useLoaderData().map(({ id, title }) => (
          <li key={id}>
            <Link to="/posts/$postId" params={{ postId: id }}>{title}</Link>
          </li>
        ))}
      </ul>
    </section>
  ),
});
