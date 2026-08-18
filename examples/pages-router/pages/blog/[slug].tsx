import { Link } from "@denext/pages-router/link";

// getServerSideProps runs on the server for every request — including the JSON
// fetch a soft navigation makes — so the slug is resolved server-side, not baked
// into the client bundle.
export function getServerSideProps(
  { params }: { params: { slug: string } },
): { props: { slug: string; via: string } } {
  return { props: { slug: params.slug, via: "gssp" } };
}

export default function Post({ slug, via }: { slug: string; via: string }) {
  return (
    <main>
      <h1 className="post">Post: {slug} ({via})</h1>
      <Link href="/">Home</Link>
    </main>
  );
}
