// A next-compat (`compatibilityMode`) Next.js app on Auth.js v5, with NO import map: `next-auth`,
// `next-auth/react` and the providers reach denext's shim only through the compat build's own
// aliases. A client component uses `useSession` / `signIn` / `signOut`, and so does a library in
// `node_modules` (`auth-badge`) that imports `next-auth/react` itself. A decoy `next-auth`
// package sits in `node_modules` too: anything that loads it instead of the shim throws
// `REAL_NEXT_AUTH_LOADED`. Shared by the integration test and the Chromium e2e.

import { join } from "@std/path";

/** The marker the decoy `next-auth` package carries. */
export const DECOY_MARKER = "REAL_NEXT_AUTH_LOADED";

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify({ nodeModulesDir: "manual", imports: {} }),
  "package.json": JSON.stringify({
    name: "next-auth-compat-app",
    private: true,
    dependencies: { "next-auth": "5.0.0-beta.29", "auth-badge": "1.0.0" },
  }),
  "denext.config.ts": "export default { compatibilityMode: true };\n",
  "auth.ts": `import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: "next-auth-compat-fixture-secret-32-chars-plus",
  providers: [
    Credentials({
      credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
      authorize: (c) =>
        c.email === "ada@example.com" && c.password === "pw"
          ? { id: "u-ada", name: "Ada", email: "ada@example.com" }
          : null,
    }),
  ],
});
`,
  "app/api/auth/[...nextauth]/route.ts": `import { handlers } from "../../../../auth";
export const { GET, POST } = handlers;
`,
  "app/layout.tsx": `import { createElement as h } from "react";
import Providers from "./providers";
export default function RootLayout({ children }) {
  return h("html", null, h("body", null, h(Providers, null, children)));
}
`,
  "app/providers.tsx": `"use client";
import { createElement as h } from "react";
import { SessionProvider } from "next-auth/react";
export default function Providers({ children }) {
  return h(SessionProvider, null, children);
}
`,
  "app/page.tsx": `import { createElement as h } from "react";
import { auth } from "../auth";
import SessionView from "./session-view";
export const dynamic = "force-dynamic";
export default async function Page() {
  const session = await auth();
  return h("main", null,
    h("p", { id: "server" }, "SERVER:" + (session?.user?.email ?? "anonymous")),
    h(SessionView, null));
}
`,
  "app/session-view.tsx": `"use client";
import { createElement as h } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { AuthBadge } from "auth-badge";
export default function SessionView() {
  const { data, status } = useSession();
  return h("section", null,
    h("p", { id: "client" }, "CLIENT:" + status + ":" + (data?.user?.name ?? "-")),
    h(AuthBadge, null),
    h("button", {
      id: "sign-in",
      type: "button",
      onClick: () => signIn("credentials", { email: "ada@example.com", password: "pw", redirect: false }),
    }, "Sign in"),
    h("button", { id: "sign-out", type: "button", onClick: () => signOut({ redirect: false }) }, "Sign out"));
}
`,
  "node_modules/auth-badge/package.json": JSON.stringify({
    name: "auth-badge",
    version: "1.0.0",
    type: "module",
    main: "./index.js",
    exports: { ".": "./index.js" },
    peerDependencies: { "next-auth": "*", "react": "*" },
  }),
  "node_modules/auth-badge/index.js": `"use client";
import { createElement as h } from "react";
import { useSession } from "next-auth/react";
export function AuthBadge() {
  const { status } = useSession();
  return h("span", { id: "badge" }, "BADGE:" + status);
}
`,
  "node_modules/next-auth/package.json": JSON.stringify({
    name: "next-auth",
    version: "5.0.0-beta.29",
    type: "module",
    exports: {
      ".": "./index.js",
      "./react": "./react.js",
      "./jwt": "./index.js",
      "./providers/credentials": "./index.js",
    },
  }),
  "node_modules/next-auth/index.js": `throw new Error("${DECOY_MARKER}");\n`,
  "node_modules/next-auth/react.js": `throw new Error("${DECOY_MARKER}");\n`,
};

/**
 * Write the fixture into `dir`.
 *
 * @param dir An empty directory.
 */
export async function writeNextAuthCompatFixture(dir: string): Promise<void> {
  for (const [name, src] of Object.entries(FILES)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
}
