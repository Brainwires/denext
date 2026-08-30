import { Link } from "@denext/pages-router/link";
import { useRouter } from "@denext/pages-router/router";

// A `fallback: true` route: only `/product/known` is prerendered; any other id
// serves a props-less shell (router.isFallback === true) that the client swaps for
// real props after fetching getStaticProps.
export function getStaticPaths(): {
  paths: Array<{ params: { id: string } }>;
  fallback: boolean;
} {
  return { paths: [{ params: { id: "known" } }], fallback: true };
}

export function getStaticProps(
  { params }: { params: { id: string } },
): { props: { id: string; name: string } } {
  return { props: { id: params.id, name: `Product ${params.id}` } };
}

export default function Product({ name }: { name?: string }) {
  const router = useRouter();
  return (
    <main>
      <h1 className="product">
        {router.isFallback ? "Loading…" : name}
      </h1>
      <Link href="/">Home</Link>
    </main>
  );
}
