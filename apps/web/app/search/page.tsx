import { SearchResults } from "./results.tsx";

export const metadata = {
  title: "Search",
  description: "Search the denext guides and API reference.",
  // A results page is not a landing page: keep it (and its `?q=` variants) out of the index.
  robots: { index: false, follow: true },
};

/**
 * The one interactive route on the site: a Server Component shell around the
 * `SearchResults` island. Every other page ships 0 KB of JavaScript.
 */
export default function SearchPage() {
  return <SearchResults />;
}
