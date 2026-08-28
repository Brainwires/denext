// Metadata-convention augmentation shared by the served path (app.ts) and static
// export (build/export.ts) so both emit identical og:image / icon / twitter:image
// links and automatic hreflang. The only difference between the two is how a
// root-relative path becomes absolute: SSR resolves it against the request Host
// (or a configured canonical origin); static export resolves it against the page's
// `metadataBase`. That difference is injected as `absolutize`.

import type { Metadata } from "./types.ts";
import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import { type I18nConfig, localeHref, type PeeledLocale } from "./i18n.ts";
import {
  APPLE_ICON_PATH,
  ICON_PATH,
  OPENGRAPH_IMAGE_PATH,
  TWITTER_IMAGE_PATH,
} from "./metadata-files.ts";

/** Inputs for {@link augmentMetadataConventions}. */
export interface AugmentMetadataOptions {
  /** The scanned route manifest (root-level image conventions live here). */
  manifest: RouteManifest;
  /** The matched page route (carries the nearest nested image, if any). */
  route: PageRoute;
  /**
   * Absolutize a root-relative path (`/opengraph-image`, `/fr/about`) to a full
   * URL. Return `null` when no base is available — `og:image` then stays relative
   * and hreflang/canonical are skipped (they require absolute URLs). SSR passes a
   * Host/canonicalOrigin resolver; static export passes a `metadataBase` resolver.
   */
  absolutize: (path: string) => string | null;
  /** The i18n config, when the app is internationalized. */
  i18n?: I18nConfig;
  /** The peeled locale + locale-free path for this request/page. */
  localeInfo?: PeeledLocale | null;
  /**
   * Called after a URL is generated from a non-stable origin (the SSR Host), so
   * the caller can mark the render dynamic (not cacheable). Omitted for static
   * export, where the origin (`metadataBase`) is stable.
   */
  onHostDerived?: () => void;
}

/**
 * Fill in metadata that comes from file conventions and i18n config, without ever
 * overriding a value the page set itself: `og:image` (nearest nested image, else
 * the root one), `icon`/`apple-icon`, `twitter:image`, and — when i18n is
 * configured and not opted out — `hreflang` alternates (one per locale + a
 * `x-default`) plus a per-locale canonical.
 */
export function augmentMetadataConventions(
  metadata: Metadata,
  opts: AugmentMetadataOptions,
): void {
  const { manifest, route, absolutize, i18n, localeInfo, onHostDerived } = opts;

  // og:image — the page's nearest nested opengraph-image wins over the root one.
  // Crawlers want an absolute URL; if no base is available it stays relative.
  const ogPath = route.openGraphImage ??
    (manifest.openGraphImage ? OPENGRAPH_IMAGE_PATH : undefined);
  if (ogPath && !metadata.openGraph?.image) {
    const abs = absolutize(ogPath);
    metadata.openGraph = { ...metadata.openGraph, image: abs ?? ogPath };
    if (abs) onHostDerived?.();
  }
  if (manifest.icon && !metadata.icon && !metadata.icons?.icon) {
    metadata.icons = { ...metadata.icons, icon: ICON_PATH };
  }
  if (manifest.appleIcon && !metadata.icons?.apple) {
    metadata.icons = { ...metadata.icons, apple: APPLE_ICON_PATH };
  }
  // twitter:image — nested route image wins; kept relative (metadataBase resolves
  // it at render), matching the historical behavior.
  const twPath = route.twitterImage ??
    (manifest.twitterImage ? TWITTER_IMAGE_PATH : undefined);
  if (twPath && !metadata.twitter?.image) {
    metadata.twitter = { ...metadata.twitter, image: twPath };
  }

  // Automatic hreflang alternates + per-locale canonical (opt-out via
  // i18n.hreflang:false). The core i18n config is as-needed (default locale
  // unprefixed), so localeHref reconstructs each locale's URL from the locale-free
  // path. A page that set its own alternates.languages always wins.
  if (i18n && i18n.hreflang !== false && localeInfo) {
    // Only generate when absolute URLs are available (hreflang requires them).
    if (absolutize(localeHref(i18n.defaultLocale, localeInfo.rest, i18n))) {
      const abs = (loc: string) => absolutize(localeHref(loc, localeInfo.rest, i18n))!;
      let derived = false;
      if (!metadata.alternates?.languages) {
        const languages: Record<string, string> = {};
        for (const loc of i18n.locales) languages[loc] = abs(loc);
        languages["x-default"] = abs(i18n.defaultLocale);
        metadata.alternates = { ...metadata.alternates, languages };
        derived = true;
      }
      if (!metadata.alternates?.canonical && !metadata.canonical) {
        metadata.alternates = { ...metadata.alternates, canonical: abs(localeInfo.locale) };
        derived = true;
      }
      if (derived) onHostDerived?.();
    }
  }
}
