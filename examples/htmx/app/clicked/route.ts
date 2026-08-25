import { h } from "@denext/denext";
import { htmlResponse } from "@denext/htmx";

// A fragment endpoint: htmx POSTs here and swaps the returned HTML into #clicked-out.
// Route handlers are `.ts` (no JSX), so build the fragment with `h()`.
export function POST() {
  const when = new Date().toLocaleTimeString();
  return htmlResponse(h("strong", {}, `Clicked at ${when} ✅`));
}
