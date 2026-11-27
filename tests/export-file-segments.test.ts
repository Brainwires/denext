// The file names an export writes for a URL path (pages, route handlers, metadata files and their
// `generateSitemaps` / `generateImageMetadata` ids): each segment decoded as a static host decodes
// it, and a segment that is empty, a dot segment, malformed, or (decoded) holds a separator of
// either kind or a NUL is no file path, on every OS.

import { assertEquals } from "@std/assert";
import { exportFileSegments } from "../src/build/export-pipeline/context.ts";
import { metadataIdSegment } from "../src/build/export-pipeline/static-files.ts";

Deno.test("exportFileSegments: decoded segments; separators of either kind and dot segments are no file path", () => {
  assertEquals(exportFileSegments("/"), []);
  assertEquals(exportFileSegments("/sitemap/0.xml"), ["sitemap", "0.xml"]);
  assertEquals(exportFileSegments("/blog/caf%C3%A9"), ["blog", "café"]);
  assertEquals(exportFileSegments("/opengraph-image/a%20b"), ["opengraph-image", "a b"]);
  for (
    const path of [
      "/sitemap/..\\x.xml", // a generateSitemaps id as written into the path
      "/icon/a\\b",
      "/icon/%5C..",
      "/sitemap/..%5Cx.xml",
      "/x/..",
      "/x/%2e%2e",
      "/x/.",
      "/x//y",
      "/x/a%2Fb",
      "/x/a%00",
      "/x/%E0%A4%A",
    ]
  ) {
    assertEquals(exportFileSegments(path), null, path);
  }
});

Deno.test("metadataIdSegment: a metadata id is exported only when it is one plain path segment", () => {
  assertEquals(metadataIdSegment(0), "0");
  assertEquals(metadataIdSegment("small"), "small");
  assertEquals(metadataIdSegment("café"), "café");
  for (const id of ["", ".", "..", "a/b", "../x", "..\\x", "a\\b", "a%2Fb", "a\0b"]) {
    assertEquals(metadataIdSegment(id), null, JSON.stringify(id));
  }
});
