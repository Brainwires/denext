// Resolving a page's props: getServerSideProps / getStaticProps (with getStaticPaths
// gating + Preview Mode), or the legacy getInitialProps fallback.

import type { PageComponent } from "../render.ts";
import { previewCookieFrom, previewSecrets, readPreview } from "../preview.ts";
import {
  type AppModule,
  type DataOutcome,
  getInitialPropsOf,
  type HandlerState,
  makeRes,
  type PageModule,
  type PageRequest,
  paramsListed,
  type StaticPathsResult,
} from "./shared.ts";

/** Load a module's default export (a component), or null. */
export async function loadDefault(
  st: HandlerState,
  filePath: string | null,
): Promise<PageComponent | null> {
  if (!filePath) return null;
  return (await st.opts.load(filePath) as AppModule).default ?? null;
}

/** Resolve a page's props (running gSSP/gSP + getStaticPaths gating). */
export async function resolveData(
  st: HandlerState,
  mod: PageModule,
  req: PageRequest,
  appFile: string | null,
  resHeaders: Headers,
  allowFallbackShell: boolean,
): Promise<DataOutcome> {
  // Preview Mode: a valid signed preview cookie makes getStaticProps run LIVE with
  // `context.preview`/`previewData` (and skips the static-paths gating below), so a
  // CMS draft renders. An absent/forged cookie → normal behavior.
  const previewData = await readPreview(
    previewCookieFrom(req.request.headers.get("cookie")),
    previewSecrets(),
  );
  const preview = previewData !== null;
  if (!preview) {
    const gated = await staticPathsGate(mod, req, allowFallbackShell);
    if (gated) return gated;
  }
  const fetcher = mod.getServerSideProps ?? mod.getStaticProps;
  // No gSSP/gSP → fall back to legacy getInitialProps (page and/or _app).
  if (!fetcher) return await resolveInitialProps(st, mod.default, appFile, req);
  const result = await fetcher({
    params: req.params,
    query: req.query,
    req: req.request,
    // `res` lets gSSP set cookies/headers (Next parity); it collects into `resHeaders`,
    // which the caller merges onto the outgoing response.
    res: makeRes(resHeaders),
    resolvedUrl: req.pathname + req.url.search,
    locale: req.locale,
    locales: st.opts.i18n?.locales,
    defaultLocale: st.opts.i18n?.defaultLocale,
    // Preview Mode (Next parity): `preview` + `previewData` when a valid preview
    // cookie is present (both are absent otherwise).
    preview: preview || undefined,
    previewData: preview ? previewData : undefined,
  });
  if (result.redirect) {
    return {
      kind: "redirect",
      destination: result.redirect.destination,
      permanent: !!result.redirect.permanent,
    };
  }
  if (result.notFound) return { kind: "notFound" };
  return { kind: "props", pageProps: result.props ?? {}, isServer: mod.getServerSideProps != null };
}

/**
 * getStaticPaths gating for an unlisted param set (skipped in preview mode):
 *   fallback: false      → 404
 *   fallback: true       → serve a props-less shell on the HTML path (the client
 *                          then fetches real props via the data endpoint, where
 *                          allowFallbackShell is false so getStaticProps runs)
 *   fallback: "blocking" → fall through and render live (getStaticProps runs now)
 * Returns null when the page is not gated (or the params are listed).
 */
async function staticPathsGate(
  mod: PageModule,
  req: PageRequest,
  allowFallbackShell: boolean,
): Promise<DataOutcome | null> {
  if (!mod.getStaticProps || typeof mod.getStaticPaths !== "function") return null;
  const gsp = await (mod.getStaticPaths as () => Promise<StaticPathsResult>)();
  if (!gsp || paramsListed(req.params, gsp.paths)) return null;
  if (gsp.fallback === false) return { kind: "notFound" };
  if (gsp.fallback === true && allowFallbackShell) return { kind: "fallback" };
  return null;
}

/**
 * Legacy `getInitialProps` fallback. If `_app` defines `getInitialProps`, it owns
 * the flow (`App.getInitialProps({ Component, ctx })` → `{ pageProps }`), matching
 * Next — a custom `_app` is responsible for calling the page's. Otherwise the page's
 * own `getInitialProps(ctx)` runs. Presence of either makes the route dynamic.
 */
async function resolveInitialProps(
  st: HandlerState,
  page: PageComponent | undefined,
  appFile: string | null,
  req: PageRequest,
): Promise<DataOutcome> {
  const pageGip = getInitialPropsOf(page);
  const appGip = getInitialPropsOf(await loadDefault(st, appFile));
  if (!appGip && !pageGip) {
    return { kind: "props", pageProps: {}, isServer: false };
  }
  // `pathname` is the route pattern (Next parity); `asPath` is the real URL.
  const ctx = {
    pathname: req.routePath,
    query: req.query,
    asPath: req.pathname + req.url.search,
    req: req.request,
    params: req.params,
    locale: req.locale,
  };
  let pageProps: Record<string, unknown>;
  if (appGip) {
    const appProps = await appGip({ Component: page, ctx });
    pageProps = (appProps?.pageProps as Record<string, unknown> | undefined) ?? {};
  } else {
    pageProps = (await pageGip!(ctx)) ?? {};
  }
  return { kind: "props", pageProps, isServer: true };
}
