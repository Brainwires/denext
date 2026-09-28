import { SSR_IMPLS, SSR_KINDS, SSR_SIZES, ssrCellPath } from "../../shared/ssr-cells.ts";

// Every cell of the server-rendered bench as a link (`/list/<impl>?kind=…&n=…`).
export default function Menu() {
  return (
    <div className="sb-menu">
      <h1>denext scroll bench: server-rendered lists</h1>
      {SSR_IMPLS.filter((d) => !d.spa).map((d) => (
        <div key={d.id}>
          <h2>{d.label} ({d.id})</h2>
          {SSR_KINDS.map((kind) => (
            <div key={kind}>
              {kind}:{" "}
              {SSR_SIZES.map((n) => (
                <a key={n} href={ssrCellPath(d.id, kind, n)}>{n.toLocaleString("en-US")}</a>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
