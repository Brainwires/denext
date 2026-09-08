import "../.denext/content.ts"; // registers the collection types (generated at dev/build)
import { Link } from "denext";
import { getCollection } from "@denext/content-collections/runtime";

export default async function Home() {
  const posts = (await getCollection("blog", (p) => !p.data.draft))
    .sort((a, b) => b.data.date.localeCompare(a.data.date));
  return (
    <main>
      <h1>Blog</h1>
      <ul>
        {posts.map((p) => (
          <li key={p.id}>
            <Link href={`/blog/${p.slug}`}>{p.data.title}</Link> <small>{p.data.date}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
