// Private channels (`config.private: true`), authorized as Supabase does: by the row-level-security
// policies on `realtime.messages`, evaluated AS the joining user with `realtime.topic()` set to the
// channel's topic. In one transaction that is always rolled back, the connecting role inserts one
// probe message per extension (`broadcast`, `presence`), the transaction switches to the user's
// role and claims, and
//   - read:  `SELECT` of the probes — what the user's SELECT policies let through;
//   - write: an `INSERT` per extension, each in a savepoint — what their INSERT policies accept.
// Nothing is ever committed: the probes and the user's inserts roll back with the transaction.

import type { SqlClient } from "@denext/denext/server";
import { RLS_SETUP, type RlsScope } from "./rls.ts";

/** What a user may do on one private topic. */
export interface ChannelPermissions {
  /** Receive broadcasts. */
  readBroadcast: boolean;
  /** Receive presence. */
  readPresence: boolean;
  /** Send broadcasts. */
  writeBroadcast: boolean;
  /** Track presence. */
  writePresence: boolean;
}

/** Every permission (a public channel). */
export const PUBLIC_PERMISSIONS: ChannelPermissions = {
  readBroadcast: true,
  readPresence: true,
  writeBroadcast: true,
  writePresence: true,
};

/** Thrown to roll the probe transaction back. */
const ROLLBACK = Symbol("rollback");

/** Run `text` in a savepoint: its rows, or `null` when it failed (rolled back to the savepoint). */
async function attempt<T>(tx: SqlClient, text: string, params: unknown[]): Promise<T[] | null> {
  await tx.unsafe("savepoint denext_realtime_probe");
  try {
    const rows = await tx.unsafe<T>(text, params);
    await tx.unsafe("release savepoint denext_realtime_probe");
    return rows;
  } catch {
    await tx.unsafe("rollback to savepoint denext_realtime_probe");
    return null;
  }
}

/**
 * Evaluate the `realtime.messages` policies for `scope` on `topic`.
 *
 * @param sql The connecting role's client (`db.service()`).
 * @param scope Who is joining.
 * @param topic The topic (`realtime:` stripped).
 * @param timeoutMs The probe transaction's `statement_timeout`.
 * @returns The permissions (all false when the policies cannot be evaluated).
 */
export async function channelPermissions(
  sql: SqlClient,
  scope: RlsScope,
  topic: string,
  timeoutMs = 5_000,
): Promise<ChannelPermissions> {
  // The secret key bypasses row-level security, here as everywhere.
  if (scope.role === "service_role") return { ...PUBLIC_PERMISSIONS };
  let result: ChannelPermissions = {
    readBroadcast: false,
    readPresence: false,
    writeBroadcast: false,
    writePresence: false,
  };
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("select set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
      const probes = await tx.unsafe<{ id: string; extension: string }>(
        "insert into realtime.messages (topic, extension, private) values " +
          "($1, 'broadcast', true), ($1, 'presence', true) returning id::text as id, extension",
        [topic],
      );
      await tx.unsafe(RLS_SETUP, [scope.role, scope.claims]);
      await tx.unsafe("select set_config('realtime.topic', $1, true)", [topic]);
      const visible = await attempt<{ extension: string }>(
        tx,
        "select extension from realtime.messages where id in " +
          "(select jsonb_array_elements_text($1::jsonb)::uuid)",
        [JSON.stringify(probes.map((probe) => probe.id))],
      ) ?? [];
      const write = async (extension: string) =>
        (await attempt(
          tx,
          "insert into realtime.messages (topic, extension, private) values ($1, $2, true)",
          [topic, extension],
        )) !== null;
      result = {
        readBroadcast: visible.some((row) => row.extension === "broadcast"),
        readPresence: visible.some((row) => row.extension === "presence"),
        writeBroadcast: await write("broadcast"),
        writePresence: await write("presence"),
      };
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return result;
}
