import type { PageProps } from "denext/server";
import { parseSsrQuery } from "../../../../shared/ssr-cells.ts";
import { StaticList } from "../../../components/static-list.tsx";

// `static`: every row as plain server HTML. Zero client JS for the list.
export const dynamic = "force-dynamic";

export default function Page({ searchParams }: PageProps) {
  return <StaticList {...parseSsrQuery(searchParams.raw)} cv={false} />;
}
