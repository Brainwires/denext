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
  RedirectType,
  unauthorized,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
} from "../../../mod.ts";
// `useServerInsertedHTML` + its context — CSS-in-JS registries (styled-components,
// emotion) import them from `next/navigation`.
export {
  ServerInsertedHTMLContext,
  useServerInsertedHTML,
} from "../../runtime/server-inserted-html.ts";

export { ReadonlyURLSearchParams } from "../../client/navigation.ts";
