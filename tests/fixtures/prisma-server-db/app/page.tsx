import { listPosts } from "../lib/db.ts";

export const dynamic = "force-dynamic";

export default async function Home() {
  const posts = await listPosts();
  return (
    <main>
      <h1>Prisma on a database server</h1>
      <ul>
        {posts.map((p) => <li key={p.id}>{p.title} by {p.author.name}</li>)}
      </ul>
    </main>
  );
}
