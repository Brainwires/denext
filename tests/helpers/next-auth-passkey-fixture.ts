// A next-compat (`compatibilityMode`) Next.js app on Auth.js v5 using the Passkey provider, written
// as an Auth.js app is: `next-auth/providers/passkey` beside Credentials, an Auth.js adapter (an
// in-memory one with the authenticator methods), and a client component that calls
// `next-auth/webauthn`'s `signIn("passkey", …)`. No import map: the compat build's aliases reach
// denext's shim, and a decoy `next-auth` package throws if anything loads it instead.

import { DECOY_MARKER, writeFixtureFiles } from "./next-auth-compat-fixture.ts";

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify({ nodeModulesDir: "manual", imports: {} }),
  "package.json": JSON.stringify({
    name: "next-auth-passkey-app",
    private: true,
    dependencies: { "next-auth": "5.0.0-beta.32" },
  }),
  "denext.config.ts": "export default { compatibilityMode: true };\n",
  "auth.ts": `import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Passkey from "next-auth/providers/passkey";

// An Auth.js adapter in memory, with the authenticator methods the Passkey provider needs.
const users = new Map([["u-ada", {
  id: "u-ada",
  name: "Ada",
  email: "ada@example.com",
  emailVerified: new Date(),
}]]);
const accounts = new Map();
const authenticators = new Map();
const adapter = {
  createUser: (u) => (users.set(u.id, u), u),
  getUser: (id) => users.get(id) ?? null,
  getUserByEmail: (email) => [...users.values()].find((u) => u.email === email) ?? null,
  getUserByAccount: ({ provider, providerAccountId }) => {
    const account = accounts.get(provider + ":" + providerAccountId);
    return account ? users.get(account.userId) ?? null : null;
  },
  updateUser: (u) => {
    const row = { ...users.get(u.id), ...u };
    users.set(u.id, row);
    return row;
  },
  linkAccount: (a) => void accounts.set(a.provider + ":" + a.providerAccountId, a),
  getAuthenticator: (id) => authenticators.get(id) ?? null,
  createAuthenticator: (a) => (authenticators.set(a.credentialID, a), a),
  listAuthenticatorsByUserId: (userId) =>
    [...authenticators.values()].filter((a) => a.userId === userId),
  updateAuthenticatorCounter: (id, counter) => {
    const row = { ...authenticators.get(id), counter };
    authenticators.set(id, row);
    return row;
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: "next-auth-passkey-fixture-secret-32-chars-plus",
  adapter,
  session: { strategy: "jwt" },
  experimental: { enableWebAuthn: true },
  providers: [
    Credentials({
      credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
      authorize: (c) =>
        c.email === "ada@example.com" && c.password === "pw"
          ? { id: "u-ada", name: "Ada", email: "ada@example.com" }
          : null,
    }),
    Passkey,
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
import PasskeyView from "./passkey-view";
export default function Page() {
  return h("main", null, h(PasskeyView, null));
}
`,
  "app/passkey-view.tsx": `"use client";
import { createElement as h, useState } from "react";
import { signIn as signInWith, signOut, useSession } from "next-auth/react";
import { signIn } from "next-auth/webauthn";
export default function PasskeyView() {
  const { data, status } = useSession();
  const [result, setResult] = useState("-");
  const run = (label, call) => async () => {
    const res = await call();
    setResult(label + ":" + (res?.ok ? "ok" : "failed:" + (res?.code ?? res?.error)));
  };
  return h("section", null,
    h("p", { id: "client" }, "CLIENT:" + status + ":" + (data?.user?.name ?? "-")),
    h("p", { id: "result" }, result),
    h("button", {
      id: "sign-in",
      type: "button",
      onClick: run("password", () =>
        signInWith("credentials", { email: "ada@example.com", password: "pw", redirect: false })),
    }, "Sign in"),
    h("button", {
      id: "register",
      type: "button",
      onClick: run("register", () => signIn("passkey", { action: "register", redirect: false })),
    }, "Add a passkey"),
    h("button", {
      id: "passkey",
      type: "button",
      onClick: run("passkey", () => signIn("passkey", { redirect: false })),
    }, "Sign in with a passkey"),
    h("button", { id: "sign-out", type: "button", onClick: () => signOut({ redirect: false }) },
      "Sign out"));
}
`,
  "node_modules/next-auth/package.json": JSON.stringify({
    name: "next-auth",
    version: "5.0.0-beta.32",
    type: "module",
    exports: {
      ".": "./index.js",
      "./react": "./index.js",
      "./webauthn": "./index.js",
      "./providers/credentials": "./index.js",
      "./providers/passkey": "./index.js",
    },
  }),
  "node_modules/next-auth/index.js": `throw new Error("${DECOY_MARKER}");\n`,
};

/**
 * Write the fixture into `dir`.
 *
 * @param dir An empty directory.
 */
export async function writeNextAuthPasskeyFixture(dir: string): Promise<void> {
  await writeFixtureFiles(dir, FILES);
}
