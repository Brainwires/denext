// An Auth.js v5 config with the Prisma adapter and database sessions: a custom OAuth provider
// and Resend magic links (its sender is a dev mailbox). The test runs it on denext unchanged.
import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

/** Where the dev mailbox keeps the links it "sent". */
const mailbox = globalThis as unknown as { devMailbox?: string[] };

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  providers: [
    {
      id: "mock",
      name: "Mock IdP",
      type: "oauth",
      authorization: { url: `${process.env.MOCK_IDP_URL}/authorize`, params: { scope: "email" } },
      token: `${process.env.MOCK_IDP_URL}/token`,
      userinfo: `${process.env.MOCK_IDP_URL}/userinfo`,
      clientId: process.env.AUTH_MOCK_ID,
      clientSecret: process.env.AUTH_MOCK_SECRET,
      profile(profile) {
        return { id: String(profile.id), name: profile.name, email: profile.email };
      },
    },
    Resend({
      from: "auth@app.test",
      sendVerificationRequest({ url }) {
        mailbox.devMailbox = [...(mailbox.devMailbox ?? []), url];
      },
    }),
  ],
  callbacks: {
    session({ session, user }) {
      return { ...session, userId: user.id };
    },
  },
});
