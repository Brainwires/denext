// The seam between denext's request pipeline and the `@denext/auth` plugin. `auth()`,
// `requireAuth()` and `requireSession()` live in `denext/server` so any server code can read
// the session, but the session itself is the plugin's: `denextAuth()` registers its runtime
// here when it is created. With no plugin registered they throw an error that names the fix.
//
// The registry is keyed on a global symbol, like the request context, so a second copy of this
// module (an app and a library that resolved denext separately) still sees the one runtime.

import type { AuthSession } from "./auth-session.ts";

/** Options for {@link requireAuth}. */
export interface RequireAuthOptions {
  /** Where to send unauthenticated users (default: the config `pages.signIn` or `/`). */
  signInPath?: string;
  /**
   * Require at least one of these roles (`AuthUser.roles`) — any-of. A signed-in
   * user without a listed role is redirected to the sign-in page with `?error=forbidden`.
   */
  role?: string | string[];
}

/**
 * What an auth plugin provides to `denext/server` (`@denext/auth`'s `denextAuth()` registers
 * one). The wrappers in `denext/server` call through it.
 */
export interface AuthRuntime {
  /** The current request's complete session, or `null`. */
  auth(): Promise<AuthSession | null>;
  /** The middleware guard: a redirect `Response`, or `null` to continue. */
  requireAuth(request: Request, options: RequireAuthOptions): Promise<Response | null>;
  /** The session, slid forward when its `updateAge` has elapsed, or `null`. */
  updateAuthSession(): Promise<AuthSession | null>;
}

const REGISTRY_KEY = Symbol.for("denext.auth.runtime");

type RegistryHolder = { [REGISTRY_KEY]?: AuthRuntime };

/**
 * Install the auth runtime `auth()`, `requireAuth()` and `requireSession()` call through.
 * `denextAuth()` does this when it is created; the last registration wins.
 *
 * @param runtime The plugin's runtime.
 */
export function registerAuthRuntime(runtime: AuthRuntime): void {
  (globalThis as RegistryHolder)[REGISTRY_KEY] = runtime;
}

/**
 * The registered auth runtime, or `undefined` when no auth plugin has been created — for code
 * that treats "no auth" as "signed out" instead of an error.
 *
 * @returns The runtime, or `undefined`.
 */
export function peekAuthRuntime(): AuthRuntime | undefined {
  return (globalThis as RegistryHolder)[REGISTRY_KEY];
}

/**
 * Forget the registered runtime (tests).
 *
 * @internal
 */
export function resetAuthRuntimeForTesting(): void {
  delete (globalThis as RegistryHolder)[REGISTRY_KEY];
}

/**
 * What `auth()`, `requireAuth()` and `requireSession()` throw when no auth plugin is registered:
 * the message names `@denext/auth` and how to add it. Catch it to treat "no auth configured" as
 * signed out.
 */
export class AuthPluginMissingError extends Error {
  /**
   * An error for `caller`, naming `@denext/auth` and how to add it.
   *
   * @param caller The function that needed the plugin (`auth()`).
   */
  constructor(caller: string) {
    super(
      `${caller}: no auth plugin is registered. The auth layer is the @denext/auth package: ` +
        `add it (\`deno add jsr:@denext/auth\`, or \`denext plugin add @denext/auth\`) and put ` +
        `denextAuth({ … }) from "@denext/auth" in the plugins of denext.config.ts. ` +
        `See https://denext.dev/docs/auth`,
    );
    this.name = "AuthPluginMissingError";
  }
}

/**
 * The registered runtime, or a thrown error that names `@denext/auth` and how to add it.
 *
 * @param caller The function the error is about (`auth()`).
 */
function requireRuntime(caller: string): AuthRuntime {
  const runtime = peekAuthRuntime();
  if (runtime) return runtime;
  throw new AuthPluginMissingError(caller);
}

/**
 * Read the current request's auth session, or `null` when signed out. Call from a
 * Server Component, a `route.ts` handler, or `middleware.ts` — anywhere inside the
 * request context.
 *
 * The session comes from the `denextAuth()` plugin (`@denext/auth`); without it this throws an
 * error that says how to add it. A session that has passed the first factor but not the second
 * reads as `null` — it **fails closed**, so every guard built on `auth()` (requireAuth,
 * requireSession, Live `authorize`, Server Actions) refuses it without having to know MFA exists.
 *
 * @returns The {@link AuthSession}, or `null`.
 */
export async function auth(): Promise<AuthSession | null> {
  return await requireRuntime("auth()").auth();
}

/**
 * Middleware guard: allow the request through when signed in, otherwise return a
 * redirect to the sign-in page carrying a `callbackUrl` back to the target.
 *
 * Four checks, in order: no session → the sign-in page; a session still owing a second
 * factor → `pages.mfa` (or the sign-in page); `role` not held → the sign-in page with
 * `?error=forbidden`; then `callbacks.authorized({ session, request })` — `false` refuses
 * exactly like a missing session, and a returned `Response` is passed through verbatim.
 * A request that passes all four also slides the session's expiry forward when
 * `session.updateAge` is configured.
 *
 * Needs the `denextAuth()` plugin (`@denext/auth`). Use in `middleware.ts` (matcher-gated):
 * ```ts
 * export async function middleware(request: Request) {
 *   return await requireAuth(request); // returns a Response to redirect, or null to continue
 * }
 * export const config = { matcher: ["/dashboard/:path*"] };
 * ```
 *
 * @param request The incoming request.
 * @param options Optional sign-in path override and `role` requirement.
 * @returns A redirect `Response` when unauthenticated, or `null` to continue.
 */
export async function requireAuth(
  request: Request,
  options: RequireAuthOptions = {},
): Promise<Response | null> {
  return await requireRuntime("requireAuth()").requireAuth(request, options);
}

/**
 * The session slid forward when stale, for the `requireSession()` guard.
 *
 * @returns The (possibly refreshed) session, or `null`.
 */
export async function updatedSession(): Promise<AuthSession | null> {
  return await requireRuntime("requireSession()").updateAuthSession();
}

/**
 * Whether a session carries at least one of the required roles (any-of).
 *
 * `undefined` means "no requirement" and allows everything. An **empty array** does not:
 * `role: []` names a set of acceptable roles that is empty, so nothing satisfies it and
 * this returns `false`. That is the fail-closed reading, and the one that matters — an
 * empty list is what a computed requirement (`role: user.requiredRoles`) degrades to when
 * the computation goes wrong, and it used to let every caller through. Use `undefined`
 * (or simply omit `role`) to mean "anyone signed in".
 *
 * A requirement against a session with no `roles` always refuses.
 *
 * @param session The live session.
 * @param role The required role, or roles (any one of which suffices).
 * @returns `true` when the session may proceed.
 */
export function hasRole(session: AuthSession, role: string | string[] | undefined): boolean {
  if (role === undefined) return true;
  const required = Array.isArray(role) ? role : [role];
  if (required.length === 0) return false;
  const held = session.user.roles;
  return !!held && required.some((r) => held.includes(r));
}
