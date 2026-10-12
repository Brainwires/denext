// A throwaway Postgres database and a NON-superuser app role that owns it, for the
// `@denext/backend` integration suites (a superuser can SET ROLE to anything, which would hide a
// missing grant). `drop()` removes both; the cluster-wide `anon` / `authenticated` roles are left
// in place (another database may use them).

import type { SqlClient } from "../../src/server/postgres.ts";

/** A database, its owner's client and the superuser's. */
export interface PostgresEnvironment {
  /** The app role's client (owner of the database). */
  app: SqlClient;
  /** The superuser's client. */
  admin: SqlClient;
  /** The database's name. */
  database: string;
  /** The app role's connection URL (what an app's `DATABASE_URL` would be). */
  url: string;
  /** Drop the database and the role, and close both clients. */
  drop(): Promise<void>;
}

/**
 * Create the environment on the server at `adminUrl` with `Deno.SQL`.
 *
 * @param grant Grant `anon` / `authenticated` to the app role when they already exist.
 * @param SQL The `Deno.SQL` constructor.
 * @param adminUrl A superuser URL (default `DENEXT_TEST_POSTGRES_URL`).
 * @returns The environment.
 */
export async function postgresEnvironment(
  grant = true,
  SQL = (Deno as unknown as { SQL: new (url?: string) => SqlClient }).SQL,
  adminUrl = Deno.env.get("DENEXT_TEST_POSTGRES_URL")!,
): Promise<PostgresEnvironment> {
  const admin = new SQL(adminUrl);
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const role = `dnx_app_${suffix}`;
  const database = `dnx_rls_${suffix}`;
  const password = crypto.randomUUID();
  await admin.unsafe(`CREATE ROLE ${role} LOGIN CREATEROLE PASSWORD '${password}'`);
  await admin.unsafe(`CREATE DATABASE ${database} OWNER ${role}`);
  if (grant) {
    // On a server where anon / authenticated already exist (an earlier run, another app), a new
    // role may not grant them to itself: that is the administrator's step (rlsSetupSql).
    const [existing] = await admin`select count(*)::int as n from pg_roles
      where rolname in ('anon', 'authenticated')`;
    if ((existing as { n: number }).n === 2) {
      await admin.unsafe(`GRANT anon, authenticated TO ${role}`);
    }
  }
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  const app = new SQL(url.toString());
  return {
    app,
    admin,
    database,
    url: url.toString(),
    async drop() {
      await app.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      // The role was granted anon / authenticated (and holds ADMIN on them, as their creator):
      // DROP OWNED removes those grants with everything else it owns.
      await admin.unsafe(`DROP OWNED BY ${role}`);
      await admin.unsafe(`DROP ROLE ${role}`);
      await admin.close();
    },
  };
}
