import type { PageProps } from "denext/server";
import { parseSsrQuery } from "../../../../shared/ssr-cells.ts";
import { StaticLike, StaticList } from "../../../components/static-list.tsx";

// `static-cv-script`: the delegated handler as a plain script from public/ instead of an
// island. The page has no client component, so it carries no Flight payload.
export const dynamic = "force-dynamic";

export default function Page({ searchParams }: PageProps) {
  return (
    <>
      <StaticList {...parseSsrQuery(searchParams.raw)} cv control={() => <StaticLike />} />
      <script type="module" src="/like-delegate.js" />
    </>
  );
}
