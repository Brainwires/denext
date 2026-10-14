/**
 * The Postgres client `@denext/backend` installs (`backend({ postgres })`), read structurally
 * from its process-global slot — denext does not depend on the package. The auth state that
 * must hold across replicas (the rate limits, the SAML replay cache) defaults onto it, so an
 * app on that backend never counts or remembers per process.
 *
 * @module
 */

import type { SqlClient } from "../postgres.ts";
import { postgresRateLimitStore } from "./postgres-rate-limit.ts";
import type { RateLimitStore } from "./rate-limit.ts";

const SLOT = Symbol.for("denext.backend.postgres");

/**
 * The backend's client, or `undefined` when `backend({ postgres })` is not set up (or could not
 * open one).
 *
 * @returns The client.
 */
export function backendPostgresClient(): SqlClient | undefined {
  const slot = (globalThis as { [SLOT]?: { sql?: SqlClient } })[SLOT];
  return slot?.sql;
}

const rateLimitStores = new WeakMap<SqlClient, RateLimitStore>();

/**
 * A rate-limit store on the backend's Postgres (`auth_rate_limits`), one per client.
 *
 * @returns The store, or `undefined` without the backend's Postgres.
 */
export function backendRateLimitStore(): RateLimitStore | undefined {
  const sql = backendPostgresClient();
  if (!sql) return undefined;
  let store = rateLimitStores.get(sql);
  if (!store) {
    // The plugin owns the client and closes it on drain.
    store = postgresRateLimitStore({ sql });
    rateLimitStores.set(sql, store);
  }
  return store;
}
