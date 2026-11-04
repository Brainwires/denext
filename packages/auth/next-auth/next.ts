/**
 * `next-auth/next` (NextAuth.js v4) on denext: the default `NextAuth` and `getServerSession`,
 * the same functions `next-auth` exports.
 *
 * ```ts
 * // pages/api/auth/[...nextauth].ts
 * import NextAuth from "next-auth/next";
 * import { authOptions } from "../../../lib/auth";
 * export default NextAuth(authOptions);
 *
 * // pages/account.tsx
 * import { getServerSession } from "next-auth/next";
 * export async function getServerSideProps({ req, res }) {
 *   const session = await getServerSession(req, res, authOptions);
 *   return session ? { props: { session } } : { redirect: { destination: "/api/auth/signin" } };
 * }
 * ```
 *
 * @module
 */

export {
  type AuthOptions,
  default,
  getServerSession,
  type GetServerSessionArgs,
  type NextAuthInstance,
  type NextAuthOptions,
  type NextAuthV4Handler,
  type NodeLikeRequest,
  type NodeLikeResponse,
  unstable_getServerSession,
} from "./index.ts";
