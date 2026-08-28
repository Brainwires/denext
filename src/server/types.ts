// Contracts between user route modules and the denext server.

import type { VNode } from "../jsx/types.ts";
import type { RouteParams } from "../router/segments.ts";
import type { SegmentConfigExports } from "./segment-config.ts";

/** A single Open Graph image (`og:image` plus optional dimensions/alt). */
export interface OpenGraphImage {
  /** Image URL. */
  url: string;
  /** `og:image:width`. */
  width?: number;
  /** `og:image:height`. */
  height?: number;
  /** `og:image:alt`. */
  alt?: string;
}

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
  /** `og:image` — a URL, a descriptor, or a list of either. */
  image?: string | OpenGraphImage | Array<string | OpenGraphImage>;
  /** `og:site_name`. */
  siteName?: string;
}

/** Twitter Card metadata (`twitter:*` tags). */
export interface TwitterMetadata {
  /** `twitter:card` (e.g. "summary_large_image"). */
  card?: "summary" | "summary_large_image" | "app" | "player";
  /** `twitter:site` (the site's @handle). */
  site?: string;
  /** `twitter:creator` (the author's @handle). */
  creator?: string;
  /** `twitter:title`. */
  title?: string;
  /** `twitter:description`. */
  description?: string;
  /** `twitter:image`. */
  image?: string;
}

/** Alternate-URL metadata (`<link rel="canonical">` and `hreflang` alternates). */
export interface AlternatesMetadata {
  /** Canonical URL. */
  canonical?: string;
  /** Language alternates as `hreflang` → URL. */
  languages?: Record<string, string>;
}

/**
 * A JSON-LD structured-data object (schema.org), serialized to a
 * `<script type="application/ld+json">` in the document head. A lightweight
 * structural type: `@context`/`@type` are hinted, any other schema.org field is
 * allowed. Provide one object or an array of them via {@link Metadata.jsonLd}.
 */
export type JsonLd = {
  /** JSON-LD context, usually `"https://schema.org"`. */
  "@context"?: string;
  /** schema.org type, e.g. `"Article"`, `"Product"`, `"BreadcrumbList"`. */
  "@type"?: string;
  [key: string]: unknown;
};

/** Structured icon metadata (icon / shortcut / apple-touch links). */
export interface IconsMetadata {
  /** `<link rel="icon">` href(s). */
  icon?: string | string[];
  /** `<link rel="shortcut icon">` href(s). */
  shortcut?: string | string[];
  /** `<link rel="apple-touch-icon">` href(s). */
  apple?: string | string[];
}

/** Structured robots directive (serialized to `<meta name="robots">`). */
export interface RobotsMetadata {
  /** Allow indexing (`index` vs `noindex`). */
  index?: boolean;
  /** Allow following links (`follow` vs `nofollow`). */
  follow?: boolean;
  /** Add `noarchive`. */
  noarchive?: boolean;
  /** A separate `<meta name="googlebot">` directive string. */
  googleBot?: string;
}

/** A named author (`<meta name="author">`, optional `<link rel="author">`). */
export interface Author {
  /** Author name. */
  name: string;
  /** Optional author URL. */
  url?: string;
}

/** Viewport + theme metadata (Next.js `viewport`/`generateViewport`). */
export interface Viewport {
  /** `width` (defaults to `device-width`). */
  width?: string;
  /** `initial-scale`. */
  initialScale?: number;
  /** `maximum-scale`. */
  maximumScale?: number;
  /** `user-scalable` (`no` when false). */
  userScalable?: boolean;
  /** `<meta name="theme-color">`. */
  themeColor?: string;
  /** `<meta name="color-scheme">` (e.g. "light dark"). */
  colorScheme?: string;
}

/** Page metadata a page or layout module may export as `metadata`/`generateMetadata`. */
export interface Metadata {
  /**
   * Document title rendered as `<title>`. A string, or Next.js's object form:
   * `default` (segment's own title), `template` (applied to descendant titles,
   * `%s` = child title), `absolute` (ignores any ancestor template). Resolved to a
   * string by {@link mergeMetadata} across the segment chain.
   */
  title?: string | { default?: string; template?: string; absolute?: string };
  /** Page description rendered as `<meta name="description">`. */
  description?: string;
  /** Keywords rendered as `<meta name="keywords">`. */
  keywords?: string[];
  /** Base URL used to resolve relative `openGraph`/`twitter` image URLs. */
  metadataBase?: string;
  /** Robots directive: a raw string or a structured {@link RobotsMetadata}. */
  robots?: string | RobotsMetadata;
  /** Canonical URL rendered as `<link rel="canonical">`. */
  canonical?: string;
  /** Canonical + language alternates (Next.js `alternates`). */
  alternates?: AlternatesMetadata;
  /** Open Graph metadata rendered as `og:*` tags. */
  openGraph?: OpenGraphMetadata;
  /** Twitter Card metadata rendered as `twitter:*` tags. */
  twitter?: TwitterMetadata;
  /** Icon href rendered as `<link rel="icon">` (shorthand for `icons.icon`). */
  icon?: string;
  /** Structured icon links (icon / shortcut / apple-touch). */
  icons?: IconsMetadata;
  /** Author(s) rendered as `<meta name="author">`. */
  authors?: Author | Author[];
  /** Site-verification tokens as `name → content` (e.g. `google`). */
  verification?: Record<string, string>;
  /**
   * JSON-LD structured data. One object or an array; each is emitted as a
   * separate `<script type="application/ld+json">`. Metadata from a layout and
   * its page accumulate (both are emitted), so a layout `Organization` and a
   * page `Article` can coexist. See {@link JsonLd}.
   */
  jsonLd?: JsonLd | JsonLd[];
  /** Extra <meta> tags as name/content pairs. */
  meta?: Record<string, string>;
  /** Extra raw tags injected into <head> (already-trusted HTML). */
  head?: string;
}

/**
 * Props passed to a page component (and to `metadata`/`generateMetadata`/
 * `generateViewport`).
 *
 * The raw `Request` is intentionally **not** exposed here. Per-request data must
 * be read through {@linkcode headers} / {@linkcode cookies} from `denext/server`,
 * which mark the render dynamic so it is never shared from the page cache — a
 * page that reads a cookie off a raw request would otherwise be cached under a
 * key with no per-user component and served to other users. `params` and
 * `searchParams` are part of the cache key, so they are safe to read.
 */
export interface PageProps {
  /** Dynamic route parameters extracted from the pathname. */
  params: RouteParams;
  /** Parsed URL query string. */
  searchParams: URLSearchParams;
}

/** Props passed to a layout component. */
export interface LayoutProps {
  /** The nested page or layout content this layout wraps. */
  children: VNode | VNode[];
  /** Dynamic route parameters extracted from the pathname. */
  params: RouteParams;
}

/** Shape of a page module (default export required). */
export interface PageModule extends SegmentConfigExports {
  /** The page component; renders to a virtual node. */
  default: (props: PageProps) => VNode | Promise<VNode>;
  /** Optional static metadata, or a function deriving it from the page props. */
  metadata?: Metadata | ((props: PageProps) => Metadata | Promise<Metadata>);
  /** Optional async metadata generator (Next.js `generateMetadata`). */
  generateMetadata?: (props: PageProps) => Metadata | Promise<Metadata>;
  /** Optional static viewport/theme metadata. */
  viewport?: Viewport;
  /** Optional viewport generator (Next.js `generateViewport`). */
  generateViewport?: (props: PageProps) => Viewport | Promise<Viewport>;
  /**
   * For dynamic routes, the set of param objects to pre-render at build time
   * (Next.js `generateStaticParams`).
   */
  generateStaticParams?: () =>
    | Array<Record<string, string>>
    | Promise<Array<Record<string, string>>>;
}

/** Shape of a layout module. */
export interface LayoutModule extends SegmentConfigExports {
  /** The layout component; wraps its children and renders to a virtual node. */
  default: (props: LayoutProps) => VNode | Promise<VNode>;
  /** Optional static metadata contributed by this layout. */
  metadata?: Metadata;
  /** Optional async metadata generator (Next.js `generateMetadata`), preferred
   * over static `metadata` when both are present. */
  generateMetadata?: (props: PageProps) => Metadata | Promise<Metadata>;
  /** Optional static viewport/theme metadata contributed by this layout. */
  viewport?: Viewport;
  /** Optional viewport generator (Next.js `generateViewport`), preferred over
   * static `viewport` when both are present. */
  generateViewport?: (props: PageProps) => Viewport | Promise<Viewport>;
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
