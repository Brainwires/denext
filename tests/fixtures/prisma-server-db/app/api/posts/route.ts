import { addPost, listPosts } from "../../../lib/db.ts";

/** Every post, as JSON. */
export async function GET(): Promise<Response> {
  const posts = await listPosts();
  return Response.json(posts.map((p) => ({ title: p.title, author: p.author.name })));
}

/** Insert one post (`{ "title": "…" }`). */
export async function POST(request: Request): Promise<Response> {
  const { title } = await request.json() as { title?: unknown };
  if (typeof title !== "string" || !title.trim()) return new Response("title?", { status: 400 });
  const post = await addPost(title.trim());
  return Response.json({ id: post.id }, { status: 201 });
}
