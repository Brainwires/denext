// The AuthAdapter contract must not depend on the wall clock standing still. Its cases write a
// timestamp (`at(-1)`, `at(3600)`) and later compare the stored value with `at(...)` again; when a
// second boundary fell between the two reads, CI saw `1792013487` against `1792013488` (the MFA
// and SSO cases, on the in-memory, SQLite and Postgres adapters, 2026-10-14 … 10-19). Here the
// clock jumps forward on every read, so each case crosses many second boundaries.

import { adapterContract } from "./helpers/auth-adapter-contract.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";

Deno.test("the adapter contract holds while the clock ticks between a write and its assertion", async (t) => {
  const realNow = Date.now;
  let now = realNow();
  // A second per read: every pair of reads crosses one; a case's own windows (60 s and more) hold.
  Date.now = () => (now += 1000);
  try {
    await adapterContract(t, () => inMemoryAuthAdapter());
  } finally {
    Date.now = realNow;
  }
});
