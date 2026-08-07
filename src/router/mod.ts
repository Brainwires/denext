// Router public surface.

export {
  type ApiRoute,
  type PageRoute,
  patternToPath,
  type RouteManifest,
  scanRoutes,
} from "./manifest.ts";
export { type ApiMatch, matchApi, matchPage, type PageMatch } from "./match.ts";
export {
  matchSegments,
  parsePattern,
  parseSegment,
  type RouteParams,
  type Segment,
  type SegmentKind,
  splitPath,
} from "./segments.ts";
