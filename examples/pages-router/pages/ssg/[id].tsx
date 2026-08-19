import { Link } from "@denext/pages-router/link";

// A statically-generated route: getStaticPaths enumerates the pages to prerender
// at build; getStaticProps supplies their props. `revalidate` opts into ISR.
export function getStaticPaths(): {
  paths: Array<{ params: { id: string } }>;
  fallback: boolean;
} {
  return { paths: [{ params: { id: "1" } }, { params: { id: "2" } }], fallback: false };
}

export function getStaticProps(
  { params }: { params: { id: string } },
): { props: { id: string; builtAt: string }; revalidate: number } {
  return { props: { id: params.id, builtAt: "static" }, revalidate: 60 };
}

export default function SsgPage({ id, builtAt }: { id: string; builtAt: string }) {
  return (
    <main>
      <h1 className="ssg">SSG #{id} ({builtAt})</h1>
      <Link href="/">Home</Link>
    </main>
  );
}
