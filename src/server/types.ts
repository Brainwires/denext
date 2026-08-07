// Contracts between user route modules and the denext server.

import type { VNode } from "../jsx/types.ts";
import type { RouteParams } from "../router/segments.ts";

/** Page metadata a page or layout module may export as `metadata`. */
export interface Metadata {
  /** Document title rendered as `<title>`. */
  title?: string;
  /** Page description rendered as `<meta name="description">`. */
  description?: string;
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
  /** Optional metadata, either static or derived from the page props. */
  metadata?: Metadata | ((props: PageProps) => Metadata | Promise<Metadata>);
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
