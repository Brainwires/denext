// A NextAuth.js v4 `authOptions`, written for Next.js: Credentials (with v4's `authorize(credentials,
// req)`), a custom OAuth provider, and the jwt / session callbacks. The test runs it on denext
// unchanged.
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      authorize(credentials, req) {
        const agent = req.headers?.["user-agent"] ?? "unknown";
        if (credentials?.username === "ada" && credentials?.password === "correct horse") {
          return { id: "u-ada", name: "Ada", email: "ada@example.com", role: "admin", agent };
        }
        return null;
      },
    }),
    {
      id: "mock",
      name: "Mock IdP",
      type: "oauth",
      authorization: {
        url: `${process.env.MOCK_IDP_URL}/authorize`,
        params: { scope: "profile email" },
      },
      token: `${process.env.MOCK_IDP_URL}/token`,
      userinfo: `${process.env.MOCK_IDP_URL}/userinfo`,
      clientId: process.env.MOCK_CLIENT_ID,
      clientSecret: process.env.MOCK_CLIENT_SECRET,
      profile(profile) {
        return { id: String(profile.id), name: profile.name, email: profile.email, role: "reader" };
      },
    },
  ],
  session: { strategy: "jwt" },
  callbacks: {
    jwt({ token, user, account }) {
      if (user) token.role = (user as { role?: string }).role;
      if (account) token.provider = account.provider;
      return token;
    },
    session({ session, token }) {
      return { ...session, role: token.role, provider: token.provider };
    },
  },
};
