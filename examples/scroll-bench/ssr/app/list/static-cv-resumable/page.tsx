import type { PageProps } from "denext/server";
import { parseSsrQuery } from "../../../../shared/ssr-cells.ts";
import { StaticList } from "../../../components/static-list.tsx";
import { Like } from "../../../components/like.tsx";

// `static-cv-resumable`: the same per-row `Like` in a resumable route. Nothing hydrates on
// load; a row's island resumes on its first click (the click is replayed to it).
export const dynamic = "force-dynamic";
export const resumable = true;

export default function Page({ searchParams }: PageProps) {
  return <StaticList {...parseSsrQuery(searchParams.raw)} cv control={() => <Like />} />;
}
