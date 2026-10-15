// A Next.js 16 drop-in app gates requests with `proxy.ts` (`export function proxy`, Next 16's
// name for middleware): built through the next-compat pipeline and served by the real prod
// server, the proxy runs, `next/server`'s NextResponse included.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { build } from "../../src/build/build.ts";
import { startProdOrigin } from "../helpers/prod-origin.ts";

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
  "denext.config.ts": "export default { compatibilityMode: true };\n",
  "app/layout.tsx": `import type { ReactNode } from "react";
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "app/page.tsx": `export default function Home() {
  return <h1>home</h1>;
}
`,
  "app/dashboard/page.tsx": `export default function Dashboard() {
  return <h1>dashboard</h1>;
}
`,
  "proxy.ts": `import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (!request.cookies.get("session")) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next({ headers: { "x-proxy": "ran" } });
}

export const config = { matcher: ["/dashboard/:path*"] };
`,
};

Deno.test({
  name: "next-compat: a Next 16 proxy.ts with `export function proxy` gates its matcher",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nc_proxy_" });
  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    for (const [rel, src] of Object.entries(FILES)) {
      await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), src);
    }
    await build(dir);
    const started = await startProdOrigin(dir, controller.signal);
    server = started.server;
    const { origin } = started;

    const refused = await fetch(`${origin}/dashboard`, { redirect: "manual" });
    await refused.body?.cancel();
    assertEquals(refused.status, 307);
    assertEquals(new URL(refused.headers.get("location")!, origin).pathname, "/");

    const allowed = await fetch(`${origin}/dashboard`, { headers: { cookie: "session=1" } });
    assertEquals(allowed.status, 200);
    assertEquals(allowed.headers.get("x-proxy"), "ran");
    await allowed.body?.cancel();

    const outside = await fetch(`${origin}/`);
    assertEquals(outside.status, 200);
    assertEquals(outside.headers.get("x-proxy"), null);
    await outside.body?.cancel();
  } finally {
    controller.abort();
    await server?.finished;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
