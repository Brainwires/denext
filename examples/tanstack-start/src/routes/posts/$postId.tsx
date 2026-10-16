import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { getPost } from "../../data.ts";

// The loader runs on the server for a page request, in the browser for a client navigation.
export const Route = createFileRoute("/posts/$postId")({
  loader: ({ params: { postId } }) => getPost(postId) ?? Promise.reject(notFound()),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title ?? "Post" }] }),
  component: () => {
    const { title, body, id } = Route.useLoaderData();
    return (
      <article id="post">
        <h1>{title}</h1>
        <p>{body}</p>
        <footer>
          #{id} — <Link to="/posts">back to the posts</Link>
        </footer>
      </article>
    );
  },
  notFoundComponent: () => <p id="post-missing">No post with that id.</p>,
});
