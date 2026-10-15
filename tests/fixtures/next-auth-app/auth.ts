// An Auth.js v5 config, written for Next.js: Credentials, a custom OAuth provider, the jwt /
// session / authorized callbacks. The test runs it on denext unchanged.
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";

const MockIdP = {
  id: "mock",
  name: "Mock IdP",
  type: "oauth" as const,
  authorization: { url: "https://idp.mock.test/authorize", params: { scope: "profile email" } },
  token: "https://idp.mock.test/token",
  userinfo: "https://idp.mock.test/userinfo",
  clientId: "mock-client",
  clientSecret: "mock-secret",
  profile(profile: Record<string, unknown>) {
    return {
      id: String(profile.id),
      name: String(profile.name),
      email: String(profile.email),
      role: "reader",
    };
  },
};

export const config = {
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email" },
        password: { label: "Password", type: "password" },
      },
      authorize: (credentials) =>
        credentials.email === "ada@example.com" && credentials.password === "correct horse"
          ? { id: "u-ada", name: "Ada", email: "ada@example.com", role: "admin" }
          : null,
    }),
    MockIdP,
  ],
  callbacks: {
    jwt({ token, user, account }) {
      if (user) token.role = (user as { role?: string }).role;
      if (account) token.provider = account.provider;
      return token;
    },
    session({ session, token }) {
      return {
        ...session,
        user: { ...session.user, role: token.role },
        provider: token.provider,
      };
    },
    authorized({ auth, request }) {
      if (request.nextUrl.pathname.startsWith("/dashboard")) return !!auth;
      return true;
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(config);
