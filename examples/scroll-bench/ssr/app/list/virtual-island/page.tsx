import type { PageProps } from "denext/server";
import { parseSsrQuery } from "../../../../shared/ssr-cells.ts";
import { VirtualIsland } from "../../../components/virtual-island.tsx";

// `virtual-island`: a VirtualList as one `client:load` island. The server renders its first
// window; the client hydrates the list once.
export const dynamic = "force-dynamic";

export default function Page({ searchParams }: PageProps) {
  return <VirtualIsland {...parseSsrQuery(searchParams.raw)} client:load />;
}
