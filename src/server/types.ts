// Contracts between user route modules and the denext server.

import type { VNode } from "../jsx/types.ts";
import type { RouteParams } from "../router/segments.ts";

/** Open Graph metadata (`og:*` tags). */
export interface OpenGraphMetadata {
  /** `og:title`. */
  title?: string;
  /** `og:description`. */
  description?: string;
  /** `og:type` (e.g. "website", "article"). */
  type?: string;
  /** `og:url`. */
  url?: string;
  /** `og:image`. */
  image?: string;
  /** `og:site_name`. */
  siteName?: string;
}

/** Page metadata a page or layout module may export as `metadata`/`generateMetadata`. */
export interface Metadata {
  /** Document title rendered as `<title>`. */
  title?: string;
  /** Page description rendered as `<meta name="description">`. */
  description?: string;
  /** Keywords rendered as `<meta name="keywords">`. */
  keywords?: string[];
  /** Robots directive rendered as `<meta name="robots">` (e.g. "noindex"). */
  robots?: string;
  /** Canonical URL rendered as `<link rel="canonical">`. */
  canonical?: string;
  /** Open Graph metadata rendered as `og:*` tags. */
  openGraph?: OpenGraphMetadata;
  /** Icon href rendered as `<link rel="icon">`. */
  icon?: string;
  /** Extra <meta> tags as name/content pairs. */
  meta?: Record<string, string>;
  /** Extra raw tags injected into <head> (already-trusted HTML). */
  head?: string;
}

/** Props passed to a page component. */
export interface PageProps {
  /** Dynamic route parameters extracted from the pathname. */
  params: RouteParams;
  /** Parsed URL query string. */
  searchParams: URLSearchParams;
  /** The incoming request. */
  request: Request;
}

/** Props passed to a layout component. */
export interface LayoutProps {
  /** The nested page or layout content this layout wraps. */
  children: VNode | VNode[];
  /** Dynamic route parameters extracted from the pathname. */
  params: RouteParams;
}

/** Shape of a page module (default export required). */
export interface PageModule {
  /** The page component; renders to a virtual node. */
  default: (props: PageProps) => VNode | Promise<VNode>;
  /** Optional static metadata, or a function deriving it from the page props. */
  metadata?: Metadata | ((props: PageProps) => Metadata | Promise<Metadata>);
  /** Optional async metadata generator (Next.js `generateMetadata`). */
  generateMetadata?: (props: PageProps) => Metadata | Promise<Metadata>;
  /**
   * For dynamic routes, the set of param objects to pre-render at build time
   * (Next.js `generateStaticParams`).
   */
  generateStaticParams?: () =>
    | Array<Record<string, string>>
    | Promise<Array<Record<string, string>>>;
}

/** Shape of a layout module. */
export interface LayoutModule {
  /** The layout component; wraps its children and renders to a virtual node. */
  default: (props: LayoutProps) => VNode | Promise<VNode>;
  /** Optional static metadata contributed by this layout. */
  metadata?: Metadata;
}

/** An HTTP method an API route module can handle. */
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

/** Context passed to an API route handler. */
export interface ApiContext {
  /** Dynamic route parameters extracted from the pathname. */
  params: RouteParams;
}

/** A single-method API route handler. */
export type ApiHandler = (
  request: Request,
  context: ApiContext,
) => Response | Promise<Response>;

/** Shape of an API route module: one exported fn per supported method. */
export type ApiModule = Partial<Record<HttpMethod, ApiHandler>>;

/** How the server loads a module given its file path (injectable for tests). */
export type ModuleLoader = (filePath: string) => Promise<unknown>;
