import type { PageProps } from "denext/server";
import { parseSsrQuery } from "../../../../shared/ssr-cells.ts";
import { VirtualIsland } from "../../../components/virtual-island.tsx";

// `virtual-island-visible`: the list sits below the fold, under an intro one and a half
// viewports tall, as a `client:visible` island: it hydrates when it scrolls into view.
export const dynamic = "force-dynamic";

export default function Page({ searchParams }: PageProps) {
  return (
    <>
      <section className="sb-intro">
        <h1>Below the fold</h1>
        <p>
          The list below is server-rendered (its first window) and hydrates only when it scrolls
          into view.
        </p>
      </section>
      <VirtualIsland {...parseSsrQuery(searchParams.raw)} client:visible />
    </>
  );
}
