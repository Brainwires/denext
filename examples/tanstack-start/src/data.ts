/** The "backend": a static list, so the example runs with no database and no network. */
export interface Post {
  id: string;
  title: string;
  body: string;
}

const POSTS: Post[] = [
  {
    id: "1",
    title: "Every page arrives rendered",
    body:
      "A request runs the matched routes' loaders on the server and renders the root route's document; the browser hydrates it.",
  },
  {
    id: "2",
    title: "Then the router takes over",
    body:
      "After hydration a <Link> is a client navigation: the next route's loader runs in the browser, as in TanStack Start.",
  },
  {
    id: "3",
    title: "The plugin owns the route tree",
    body:
      "src/routeTree.gen.ts is generated from src/routes by TanStack's own generator, at build and as you edit in dev.",
  },
];

export function listPosts(): Post[] {
  return POSTS;
}

export function getPost(id: string): Post | undefined {
  return POSTS.find((p) => p.id === id);
}
