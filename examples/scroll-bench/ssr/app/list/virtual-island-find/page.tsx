import type { PageProps } from "denext/server";
import { parseSsrQuery } from "../../../../shared/ssr-cells.ts";
import { VirtualIsland } from "../../../components/virtual-island.tsx";

// `virtual-island-find`: `virtual-island` with `findInPage`, so rows outside the window are
// findable with Ctrl/Cmd+F (Chromium; `findInPage.limit` rows around the viewport).
export const dynamic = "force-dynamic";

export default function Page({ searchParams }: PageProps) {
  return <VirtualIsland {...parseSsrQuery(searchParams.raw)} find client:load />;
}
