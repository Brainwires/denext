import type { PageProps } from "denext/server";
import { parseSsrQuery } from "../../../../shared/ssr-cells.ts";
import { StaticLike, StaticList } from "../../../components/static-list.tsx";
import { LikeDelegate } from "../../../components/like-delegate.tsx";

// `static-cv-delegated`: the rows' buttons are plain HTML, and ONE small island handles every
// click through a delegated listener.
export const dynamic = "force-dynamic";

export default function Page({ searchParams }: PageProps) {
  return (
    <>
      <LikeDelegate client:load />
      <StaticList {...parseSsrQuery(searchParams.raw)} cv control={() => <StaticLike />} />
    </>
  );
}
