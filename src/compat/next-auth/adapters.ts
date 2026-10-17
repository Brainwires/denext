/**
 * `next-auth/adapters` (NextAuth.js v4's adapter types) on denext: the same Auth.js adapter
 * shapes `next-auth` exports, for an app that types its adapter from here.
 *
 * ```ts
 * import type { Adapter } from "next-auth/adapters";
 * export function MyAdapter(db: Db): Adapter { … }
 * ```
 *
 * @module
 */

export type {
  AuthJsAdapter as Adapter,
  AuthJsAdapterAccount as AdapterAccount,
  AuthJsAdapterSession as AdapterSession,
  AuthJsAdapterUser as AdapterUser,
  AuthJsUserExtension as AdapterUserExtension,
  AuthJsVerificationToken as VerificationToken,
} from "./adapter.ts";
