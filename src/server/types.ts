// Contracts between user route modules and the denext server.

import type { VNode } from "../jsx/types.ts";
import type { RouteParams } from "../router/segments.ts";
import type { AsyncProps, SearchParams } from "../runtime/async-props.ts";
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
  /** `og:image:type`. */
  type?: string;
}

/** A single Open Graph video/audio (`og:video` / `og:audio`). */
export interface OpenGraphMedia {
  /** Media URL. */
  url: string;
  /** `og:video:width` / `og:audio:width`. */
  width?: number;
  /** `og:video:height`. */
  height?: number;
  /** MIME type (`og:video:type`). */
  type?: string;
}

/** Open Graph metadata (`og:*` tags), Next.js-shaped (`images`, not `image`). */
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
  images?: string | OpenGraphImage | Array<string | OpenGraphImage>;
  /** `og:video` entries. */
  videos?: string | OpenGraphMedia | Array<string | OpenGraphMedia>;
  /** `og:audio` entries. */
  audio?: string | OpenGraphMedia | Array<string | OpenGraphMedia>;
  /** `og:site_name`. */
  siteName?: string;
  /** `og:locale` (e.g. "en_US"). */
  locale?: string;
  /** `og:locale:alternate`. */
  alternateLocale?: string | string[];
  /** `og:determiner`. */
  determiner?: "a" | "an" | "the" | "auto" | "";
  /** `article:published_time`. */
  publishedTime?: string;
  /** `article:modified_time`. */
  modifiedTime?: string;
  /** `article:expiration_time`. */
  expirationTime?: string;
  /** `article:author` URL(s) or name(s). */
  authors?: string | string[];
  /** `article:section`. */
  section?: string;
  /** `article:tag`. */
  tags?: string | string[];
  /** `og:email`. */
  emails?: string | string[];
  /** `og:phone_number`. */
  phoneNumbers?: string | string[];
  /** `og:fax_number`. */
  faxNumbers?: string | string[];
  /** `og:country_name`. */
  countryName?: string;
  /** `og:ttl`. */
  ttl?: number;
}

/** Twitter Card metadata (`twitter:*` tags), Next.js-shaped (`images`, not `image`). */
export interface TwitterMetadata {
  /** `twitter:card` (e.g. "summary_large_image"). */
  card?: "summary" | "summary_large_image" | "app" | "player";
  /** `twitter:site` (the site's @handle). */
  site?: string;
  /** `twitter:site:id`. */
  siteId?: string;
  /** `twitter:creator` (the author's @handle). */
  creator?: string;
  /** `twitter:creator:id`. */
  creatorId?: string;
  /** `twitter:title`. */
  title?: string;
  /** `twitter:description`. */
  description?: string;
  /** `twitter:image` — a URL, a descriptor, or a list of either. */
  images?: string | OpenGraphImage | Array<string | OpenGraphImage>;
}

/** Alternate-URL metadata (`<link rel="canonical">` and `hreflang` alternates). */
export interface AlternatesMetadata {
  /** Canonical URL. */
  canonical?: string;
  /** Language alternates as `hreflang` → URL. */
  languages?: Record<string, string>;
  /** Media alternates as media query → URL (`<link rel="alternate" media=…>`). */
  media?: Record<string, string>;
  /** Type alternates as MIME type → URL (`<link rel="alternate" type=…>`, e.g. an RSS feed). */
  types?: Record<string, string>;
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

/** One icon: a URL, or a descriptor with `sizes`/`type`/`media`/`rel` (Next.js `IconDescriptor`). */
export interface IconDescriptor {
  /** Icon URL. */
  url: string;
  /** `sizes` attribute (e.g. "32x32", "any"). */
  sizes?: string;
  /** MIME type (e.g. "image/png"). */
  type?: string;
  /** `media` query (e.g. "(prefers-color-scheme: dark)"). */
  media?: string;
  /** Override the `rel` (e.g. "mask-icon"). */
  rel?: string;
  /** `color` (for `mask-icon`). */
  color?: string;
}

/** A URL or an {@linkcode IconDescriptor}, or a list of either. */
export type IconInput = string | IconDescriptor | Array<string | IconDescriptor>;

/** Structured icon metadata (icon / shortcut / apple-touch / other links). */
export interface IconsMetadata {
  /** `<link rel="icon">` href(s)/descriptor(s). */
  icon?: IconInput;
  /** `<link rel="shortcut icon">` href(s)/descriptor(s). */
  shortcut?: IconInput;
  /** `<link rel="apple-touch-icon">` href(s)/descriptor(s). */
  apple?: IconInput;
  /** Extra icon links with their own `rel` (e.g. `mask-icon`). */
  other?: IconDescriptor | IconDescriptor[];
}

/** `<meta name="theme-color">` with an optional media query. */
export interface ThemeColorDescriptor {
  /** The color value. */
  color: string;
  /** A media query the color applies under (e.g. `(prefers-color-scheme: dark)`). */
  media?: string;
}

/** `appleWebApp` metadata (`apple-mobile-web-app-*`). */
export interface AppleWebAppMetadata {
  /** `apple-mobile-web-app-capable` (default yes). */
  capable?: boolean;
  /** `apple-mobile-web-app-title`. */
  title?: string;
  /** `apple-mobile-web-app-status-bar-style`. */
  statusBarStyle?: "default" | "black" | "black-translucent";
  /** `<link rel="apple-touch-startup-image">` entries. */
  startupImage?: string | Array<string | { url: string; media?: string }>;
}

/** `format-detection` (`telephone=no` etc.). */
export interface FormatDetectionMetadata {
  /** Auto-link phone numbers (`false` emits `telephone=no`). */
  telephone?: boolean;
  /** Auto-link dates. */
  date?: boolean;
  /** Auto-link addresses. */
  address?: boolean;
  /** Auto-link email addresses. */
  email?: boolean;
  /** Auto-link URLs. */
  url?: boolean;
}

/** `al:*` app-link tags (Next.js `appLinks`); each entry is a record of `al:<platform>:<key>`. */
export type AppLinksMetadata = Record<
  string,
  Record<string, string | number> | Array<Record<string, string | number>>
>;

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
  /** `minimum-scale`. */
  minimumScale?: number;
  /** `viewport-fit` (e.g. "cover"). */
  viewportFit?: "auto" | "contain" | "cover";
  /** `interactive-widget`. */
  interactiveWidget?: "resizes-visual" | "resizes-content" | "overlays-content";
  /** `<meta name="theme-color">` — one color, or per-media-query descriptors. */
  themeColor?: string | ThemeColorDescriptor | ThemeColorDescriptor[];
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
  /** Keywords rendered as `<meta name="keywords">` (a string or a list). */
  keywords?: string | string[];
  /** Base URL used to resolve relative `openGraph`/`twitter` image URLs. */
  metadataBase?: string | URL;
  /** `<meta name="application-name">`. */
  applicationName?: string;
  /** `<meta name="generator">`. */
  generator?: string;
  /** `<meta name="referrer">`. */
  referrer?: string;
  /** `<meta name="creator">`. */
  creator?: string;
  /** `<meta name="publisher">`. */
  publisher?: string;
  /** `<meta name="category">`. */
  category?: string;
  /** `<meta name="classification">`. */
  classification?: string;
  /** `<link rel="manifest">` href. */
  manifest?: string;
  /** `<link rel="archives">` href(s). */
  archives?: string | string[];
  /** `<link rel="assets">` href(s). */
  assets?: string | string[];
  /** `<link rel="bookmarks">` href(s). */
  bookmarks?: string | string[];
  /** `<meta itemprop=…>` tags. */
  itemProp?: Record<string, string>;
  /** `<meta name="apple-mobile-web-app-*">` and startup images. */
  appleWebApp?: boolean | AppleWebAppMetadata;
  /** `<meta name="format-detection">`. */
  formatDetection?: FormatDetectionMetadata;
  /** `al:*` app-link tags. */
  appLinks?: AppLinksMetadata;
  /** Arbitrary `<meta name=… content=…>` pairs (Next.js `other`); a list value emits one tag per item. */
  other?: Record<string, string | number | Array<string | number>>;
  /** Robots directive: a raw string or a structured {@link RobotsMetadata}. */
  robots?: string | RobotsMetadata;
  /** Canonical URL rendered as `<link rel="canonical">`. */
  canonical?: string;
  /** Canonical + language/media/type alternates (Next.js `alternates`). */
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

/** The merged metadata of the segments ABOVE the current one (what `parent` resolves to). */
export type ResolvedMetadata = Metadata;
/** Next.js `ResolvingMetadata`: the parent segments' merged metadata, awaitable. */
export type ResolvingMetadata = Promise<ResolvedMetadata>;
/** Next.js `ResolvingViewport`: the parent segments' merged viewport, awaitable. */
export type ResolvingViewport = Promise<Viewport>;

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
export interface PageProps<P extends RouteParams = RouteParams> {
  /**
   * Dynamic route parameters extracted from the pathname (`[slug]` → string,
   * `[...rest]` → string[]). Readable synchronously AND awaitable (Next.js 15's
   * `Promise` shape): `params.slug` and `(await params).slug` are both fine. Narrow the
   * shape per route: `PageProps<{ slug: string }>`.
   */
  params: AsyncProps<P>;
  /**
   * The URL query as Next.js's record (`?a=1&a=2&b=x` → `{ a: ["1", "2"], b: "x" }`),
   * readable synchronously and awaitable. The underlying `URLSearchParams` is the
   * non-enumerable `searchParams.raw`.
   */
  searchParams: AsyncProps<SearchParams> & { readonly raw: URLSearchParams };
}

/**
 * Props passed to a layout component. `Slots` names the layout's parallel-route slots
 * (`@sidebar` → `LayoutProps<RouteParams, "sidebar">` adds a `sidebar` prop).
 */
export type LayoutProps<P extends RouteParams = RouteParams, Slots extends string = never> = {
  /** The nested page or layout content this layout wraps. */
  children: VNode | VNode[];
  /** Dynamic route parameters extracted from the pathname (sync + awaitable). */
  params: AsyncProps<P>;
} & { [S in Slots]: VNode | VNode[] };

/**
 * `generateStaticParams` — the param sets to pre-render. Called with the parent segments'
 * params (from a layout's own generator, or `{}` at the root), Next.js style; a
 * `[...rest]` value may be a `string[]`.
 */
export type StaticParamsGenerator = (
  context: { params: RouteParams },
) => RouteParams[] | Promise<RouteParams[]>;

/** Shape of a page module (default export required). */
export interface PageModule extends SegmentConfigExports {
  /** The page component; renders to a virtual node. */
  default: (props: PageProps) => VNode | Promise<VNode>;
  /** Optional static metadata, or a function deriving it from the page props. */
  metadata?: Metadata | ((props: PageProps) => Metadata | Promise<Metadata>);
  /** Optional async metadata generator (Next.js `generateMetadata(props, parent)`). */
  generateMetadata?: (props: PageProps, parent: ResolvingMetadata) => Metadata | Promise<Metadata>;
  /** Optional static viewport/theme metadata. */
  viewport?: Viewport;
  /** Optional viewport generator (Next.js `generateViewport(props, parent)`). */
  generateViewport?: (props: PageProps, parent: ResolvingViewport) => Viewport | Promise<Viewport>;
  /**
   * For dynamic routes, the set of param objects to pre-render at build time
   * (Next.js `generateStaticParams`), receiving the parent segments' params.
   */
  generateStaticParams?: StaticParamsGenerator;
}

/** Shape of a layout module. */
export interface LayoutModule extends SegmentConfigExports {
  /** The layout component; wraps its children and renders to a virtual node. */
  default: (props: LayoutProps) => VNode | Promise<VNode>;
  /** Optional static metadata contributed by this layout. */
  metadata?: Metadata;
  /** Optional async metadata generator (Next.js `generateMetadata(props, parent)`), preferred
   * over static `metadata` when both are present. */
  generateMetadata?: (props: PageProps, parent: ResolvingMetadata) => Metadata | Promise<Metadata>;
  /** Optional static viewport/theme metadata contributed by this layout. */
  viewport?: Viewport;
  /** Optional viewport generator (Next.js `generateViewport(props, parent)`), preferred over
   * static `viewport` when both are present. */
  generateViewport?: (props: PageProps, parent: ResolvingViewport) => Viewport | Promise<Viewport>;
  /** A layout may enumerate ITS dynamic segments' params for the routes below it. */
  generateStaticParams?: StaticParamsGenerator;
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
  /** Dynamic route parameters extracted from the pathname (sync + awaitable). */
  params: AsyncProps<RouteParams>;
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
