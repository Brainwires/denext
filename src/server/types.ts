// Contracts between user route modules and the denext server.

import type { VNode } from "../jsx/types.ts";
import type { RouteParams } from "../router/segments.ts";

/** Page metadata a page or layout module may export as `metadata`. */
export interface Metadata {
  title?: string;
  description?: string;
  /** Extra <meta> tags as name/content pairs. */
  meta?: Record<string, string>;
  /** Extra raw tags injected into <head> (already-trusted HTML). */
  head?: string;
}

/** Props passed to a page component. */
export interface PageProps {
  params: RouteParams;
  searchParams: URLSearchParams;
  request: Request;
}

/** Props passed to a layout component. */
export interface LayoutProps {
  children: VNode | VNode[];
  params: RouteParams;
}

/** Shape of a page module (default export required). */
export interface PageModule {
  default: (props: PageProps) => VNode | Promise<VNode>;
  metadata?: Metadata | ((props: PageProps) => Metadata | Promise<Metadata>);
}

/** Shape of a layout module. */
export interface LayoutModule {
  default: (props: LayoutProps) => VNode | Promise<VNode>;
  metadata?: Metadata;
}

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface ApiContext {
  params: RouteParams;
}

export type ApiHandler = (
  request: Request,
  context: ApiContext,
) => Response | Promise<Response>;

/** Shape of an API route module: one exported fn per supported method. */
export type ApiModule = Partial<Record<HttpMethod, ApiHandler>>;

/** How the server loads a module given its file path (injectable for tests). */
export type ModuleLoader = (filePath: string) => Promise<unknown>;
