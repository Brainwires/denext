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

/**
 * `next/navigation`'s `ReadonlyURLSearchParams` — the read-only view of the URL query
 * that `useSearchParams()` returns. It is a real `URLSearchParams` for reads/iteration,
 * but its mutating methods throw (you cannot change the URL by mutating this object;
 * navigate instead).
 */
export class ReadonlyURLSearchParams extends URLSearchParams {
  private static readonly ERROR = (method: string) =>
    new Error(
      `ReadonlyURLSearchParams.${method} is not supported: the search params from ` +
        `useSearchParams() are read-only. Use useRouter().push/replace to change the URL.`,
    );
  /** Not supported — this view is read-only. @throws always. */
  override append(_name: string, _value: string): never {
    throw ReadonlyURLSearchParams.ERROR("append");
  }
  /** Not supported — this view is read-only. @throws always. */
  override delete(_name: string, _value?: string): never {
    throw ReadonlyURLSearchParams.ERROR("delete");
  }
  /** Not supported — this view is read-only. @throws always. */
  override set(_name: string, _value: string): never {
    throw ReadonlyURLSearchParams.ERROR("set");
  }
  /** Not supported — this view is read-only. @throws always. */
  override sort(): never {
    throw ReadonlyURLSearchParams.ERROR("sort");
  }
}
