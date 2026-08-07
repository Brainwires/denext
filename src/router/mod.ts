// Router public surface.

export {
  type ApiRoute,
  type PageRoute,
  type RouteManifest,
  patternToPath,
  scanRoutes,
} from "./manifest.ts";
export {
  type ApiMatch,
  matchApi,
  matchPage,
  type PageMatch,
} from "./match.ts";
export {
  matchSegments,
  parsePattern,
  parseSegment,
  type RouteParams,
  type Segment,
  splitPath,
} from "./segments.ts";
