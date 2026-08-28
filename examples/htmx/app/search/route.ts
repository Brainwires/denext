import { h } from "@denext/denext";
import { htmlResponse } from "@denext/htmx";
import { FRUIT, SearchResults } from "../page.tsx";

// Active-search fragment: filter the list by the posted `q` and return just the
// results markup. Reuses the same `SearchResults` component the page rendered.
export async function POST(request: Request) {
  const form = await request.formData();
  const q = String(form.get("q") ?? "").trim().toLowerCase();
  const items = q ? FRUIT.filter((f) => f.toLowerCase().includes(q)) : FRUIT;
  return htmlResponse(h(SearchResults, { items }));
}
