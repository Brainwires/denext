import type { PageProps } from "denext/server";
import { parseSsrQuery } from "../../../../shared/ssr-cells.ts";
import { StaticList } from "../../../components/static-list.tsx";

// `static-cv`: `static` + `content-visibility: auto` per row, so the browser skips layout and
// paint of the rows off screen.
export const dynamic = "force-dynamic";

export default function Page({ searchParams }: PageProps) {
  return <StaticList {...parseSsrQuery(searchParams.raw)} cv />;
}
