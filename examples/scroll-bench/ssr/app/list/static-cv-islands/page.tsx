import type { PageProps } from "denext/server";
import { parseSsrQuery } from "../../../../shared/ssr-cells.ts";
import { StaticList } from "../../../components/static-list.tsx";
import { TrackedLike } from "../../../components/like.tsx";

// `static-cv-islands`: `static-cv` + one `client:load` island per row (the like button). Every
// island is hydrated on load, each on its own.
export const dynamic = "force-dynamic";

export default function Page({ searchParams }: PageProps) {
  return (
    <StaticList
      {...parseSsrQuery(searchParams.raw)}
      cv
      control={() => <TrackedLike client:load />}
    />
  );
}
