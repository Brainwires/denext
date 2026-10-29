// Real-browser e2e: plain `denextAuth` under `denext dev` on `http://localhost` — a Credentials
// sign-in from the page must leave a session cookie Chromium keeps, so the next page load is
// signed in. (A `__Host-` cookie is refused over http, even on localhost.)
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { launchBrowser, pollFor, startDevOnDir } from "./harness.ts";

const ROOT = new URL("../../", import.meta.url).href;

/** A native app with the denextAuth plugin and one Credentials user. */
async function writeFixture(dir: string): Promise<void> {
  const files: Record<string, string> = {
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${ROOT}mod.ts`,
        "denext/jsx-runtime": `${ROOT}src/jsx/jsx-runtime.ts`,
        "denext/server": `${ROOT}src/server/mod.ts`,
        "denext/client": `${ROOT}src/client/mod.ts`,
      },
    }),
    "denext.config.ts": `import { credentials, denextAuth } from "denext/server";
export default {
  plugins: [
    denextAuth({
      secret: "auth-dev-http-e2e-secret-at-least-32-chars",
      providers: [
        credentials({
          authorize: ({ email, password }) =>
            email === "ada@example.com" && password === "pw" ? { id: "u1", email } : null,
        }),
      ],
    }),
  ],
};
`,
    "app/layout.tsx": `export default function RootLayout({ children }: { children: unknown }) {
  return <html><body>{children}</body></html>;
}
`,
    "app/page.tsx": `import { auth } from "denext/server";
export const dynamic = "force-dynamic";
export default async function Page() {
  const session = await auth();
  return <main id="who">{"WHO:" + (session?.user.email ?? "anonymous")}</main>;
}
`,
  };
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
}

/** Sign in from the page (same-origin fetch), then reload and read who the server sees. */
const SIGN_IN = `fetch("/auth/callback/credentials", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ email: "ada@example.com", password: "pw" }),
}).then((r) => r.status)`;

Deno.test({
  name: "e2e: denextAuth under denext dev on http://localhost keeps its session cookie",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_auth_dev_http_" });
  await writeFixture(dir);
  const browser = await launchBrowser();
  const server = await startDevOnDir(dir);
  try {
    for (const host of ["localhost", "127.0.0.1"]) {
      const origin = server.origin.replace("127.0.0.1", host);
      const page = await browser.newPage();
      await page.goto(`${origin}/`, { waitUntil: "load" });
      await pollFor(page, `document.getElementById("who")?.textContent === "WHO:anonymous"`);
      assertEquals(await page.evaluate(SIGN_IN), 200, `${host}: the sign-in succeeded`);
      await page.goto(`${origin}/`, { waitUntil: "load" });
      await pollFor(page, `document.getElementById("who")?.textContent === "WHO:ada@example.com"`);
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
