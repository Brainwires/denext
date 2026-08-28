/**
 * `next/navigation` compat — App Router navigation hooks and control-flow
 * helpers, re-exported from denext.
 * @module
 */
export {
  forbidden,
  notFound,
  permanentRedirect,
  redirect,
  unauthorized,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
} from "../../../mod.ts";
// `useServerInsertedHTML` — CSS-in-JS registries (styled-components, emotion) import it
// from `next/navigation`.
export { useServerInsertedHTML } from "../../runtime/server-inserted-html.ts";
