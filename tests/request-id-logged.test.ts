// With request logging on (`DENEXT_LOG`, or the app's `onRequest`), every response carries the
// `x-request-id` its log line has, so a client-side report correlates with the access log. With
// logging off the header stays on error responses only (Next sends none).

import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/server/app.ts";
import type { RequestLogInfo } from "../src/server/app-config.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";

function manifest(): RouteManifest {
  return {
    pages: [{
      kind: "page",
      pattern: parsePattern("x"),
      routePath: "/x",
      filePath: "page.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

const load = () => Promise.resolve({ default: () => h("p", null, "ok") });

Deno.test("a logged request's response carries the id its log line has", async () => {
  const logged: RequestLogInfo[] = [];
  const app = createApp({
    getManifest: () => Promise.resolve(manifest()),
    load,
    onRequest: (info) => void logged.push(info),
  });
  for (const path of ["/x", "/missing"]) {
    const res = await app(new Request(`http://localhost${path}`));
    await res.body?.cancel();
    assert(res.status === 200 || res.status === 404, String(res.status));
    await new Promise((r) => setTimeout(r, 0));
    const id = res.headers.get("x-request-id");
    assert(id, `${path}: x-request-id`);
    assertEquals(logged.at(-1)?.requestId, id);
  }
  const quiet = createApp({ getManifest: () => Promise.resolve(manifest()), load });
  const res = await quiet(new Request("http://localhost/x"));
  await res.body?.cancel();
  assertEquals(res.headers.get("x-request-id"), null, "no logging: Next's headers");
});

Deno.test("the Docker image logs requests (DENEXT_LOG=json)", () => {
  for (const mode of ["server", "static"] as const) {
    const file = renderDockerfile({ mode, denoTag: "2.9.7" });
    assert(file.includes("ENV DENEXT_LOG=json") === (mode === "server"), `${mode}:\n${file}`);
  }
});
