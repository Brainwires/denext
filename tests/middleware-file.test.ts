// The root middleware file fails closed: a `proxy.tsx` / `middleware.jsx` (any extension Next
// accepts) gates the app instead of being skipped, and a middleware file that exports no handler
// stops the app from starting rather than letting every request through unchecked.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { inChild } from "./helpers/isolated.ts";

// Each test crawls and builds an app: in a bounded child process (`inChild`), since an in-process
// build that stalls (CI windows-tests, runtime 3.0.0-rc.5) can't be stopped.
const TESTING =
  `import { createTestApp, createTestClient, probeApp } from "@repo/src/testing/mod.ts";`;

const JSX = new URL("../src/jsx/jsx-runtime.ts", import.meta.url).href;

const GATE = `export function proxy(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/admin")) return new Response("blocked", { status: 401 });
}
export const config = { matcher: ["/admin/:path*"] };
`;

/** A temp app with a home and an /admin page, plus `extra` files at its root. */
async function withApp<T>(
  extra: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mw_file_" });
  const files: Record<string, string> = {
    "app/layout.ts": `import { h } from "${JSX}";
export const metadata = { title: "Gate" };
export default function Root({ children }) { return h("main", null, children); }`,
    "app/page.ts": `import { h } from "${JSX}";
export default function Home() { return h("p", null, "home"); }`,
    "app/admin/page.ts": `import { h } from "${JSX}";
export default function Admin() { return h("p", null, "admin secrets"); }`,
    ...extra,
  };
  try {
    for (const [rel, src] of Object.entries(files)) {
      const path = join(dir, rel);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, src);
    }
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

for (const file of ["proxy.tsx", "proxy.jsx", "middleware.tsx", "middleware.mjs"]) {
  Deno.test(`a root ${file} gates its matcher`, async () => {
    await withApp({ [file]: GATE }, async (dir) => {
      const { value } = await inChild<{ admin: [number, string]; home: number }>({
        imports: TESTING,
        body: `const client = createTestClient(await createTestApp(${JSON.stringify(dir)}));
        const admin = await client.get("/admin");
        return { admin: [admin.status, admin.text], home: (await client.get("/")).status };`,
      });
      assertEquals(value.admin, [401, "blocked"]);
      assertEquals(value.home, 200);
    });
  });
}

Deno.test("a middleware file that exports no handler stops the app from starting", async () => {
  for (
    const [file, src] of [
      ["proxy.ts", `export const config = { matcher: ["/admin/:path*"] };\n`],
      // Next 16's rename done halfway: the function kept a name denext doesn't read.
      ["proxy.ts", `export function guard() { return new Response("no", { status: 401 }); }\n`],
      ["middleware.ts", `export default { matcher: ["/admin/:path*"] };\n`],
    ]
  ) {
    await withApp({ [file]: src }, async (dir) => {
      const { value } = await inChild<{ app: string | null; probe: string | null }>({
        imports: TESTING,
        body: `const refusal = (p) => p.then(() => null, (err) => String(err?.message ?? err));
        return {
          app: await refusal(createTestApp(${JSON.stringify(dir)})),
          probe: await refusal(probeApp(${JSON.stringify(dir)})),
        };`,
      });
      assertStringIncludes(value.app ?? "(started)", `${file} must export a function`);
      // denext doctor (probeApp) refuses it too.
      assertStringIncludes(value.probe ?? "(passed)", "must export a function");
    });
  }
});
