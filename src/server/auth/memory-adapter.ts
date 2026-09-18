/**
 * The per-process, in-memory {@link ./adapter.ts | AuthAdapter} — the reference
 * implementation of the persistence port. It exists for three jobs: getting an
 * adapter-backed sign-in flow running with zero setup, the test double every auth test
 * can use, and the executable definition of the contract (the shared suite in
 * `tests/helpers/auth-adapter-contract.ts` runs against it first).
 *
 * **Not for production.** Nothing survives a restart and nothing is shared between
 * replicas — a user created on one process is invisible to the others, exactly like
 * {@link ./session-store.ts | inMemorySessionStore}. Use
 * {@link ./sqlite-adapter.ts | sqliteAuthAdapter} (or your own adapter) for a real
 * deployment.
 *
 * Shape notes:
 * - Every map is **bounded** (`maxUsers`, default 10 000) and evicts the oldest row, so a
 *   long-running dev server or a fuzzed test can't grow it without limit. Evicting a row
 *   also clears what hangs off it (`onEvict`): an evicted user takes its email index
 *   entry, password hash and TOTP factor with it, and an evicted API token its hash
 *   index. The remaining lookups are verified on read, so a stale one heals itself.
 * - A user's **email is unique**, exactly as the SQLite adapter's unique index makes it:
 *   creating or updating a second user onto an address another user already holds throws.
 * - The three **consume-once** methods are atomic. `useVerificationToken` and
 *   `claimTotpStep` run to completion synchronously, which on one JS isolate *is* the
 *   critical section; `consumeBackupCode` has to `await` the caller's comparison, so it
 *   runs under a per-user promise lock instead.
 * - `sessions` is an {@link ./session-store.ts | inMemorySessionStore}, but configuring an
 *   adapter never by itself makes sessions stateful — that is `session.strategy`.
 *
 * @module
 */

import type {
  AdapterAccount,
  AdapterAccountRef,
  AdapterUser,
  ApiTokenRecord,
  AuthAdapter,
  MfaRecord,
  VerificationTokenRecord,
  VerificationTokenRef,
} from "./adapter.ts";
import { emailKey } from "./email-key.ts";
import { inMemorySessionStore, type SessionStore } from "./session-store.ts";

/** Options for {@linkcode inMemoryAuthAdapter}. */
export interface InMemoryAuthAdapterOptions {
  /**
   * Max rows held per table (users, verification tokens, API tokens) before the oldest
   * are evicted. Default 10000.
   */
  maxUsers?: number;
  /**
   * Clock override, in **epoch seconds** — what expiry is measured against. Defaults to
   * the system clock; tests pass their own to age a token without sleeping.
   */
  now?: () => number;
}

/** Default row cap per table, matching `inMemorySessionStore`'s. */
const DEFAULT_MAX_ENTRIES = 10_000;
/** Key separator: illegal in an email, a provider id and a hex hash alike. */
const SEP = "\u0000";

/** A bounded, insertion-ordered map: past `maxEntries` the oldest row is evicted. */
interface Table<T> {
  /** The rows, oldest first — iterate for a scan. */
  readonly rows: Map<string, T>;
  /** The row under `key`, or `undefined`. */
  get(key: string): T | undefined;
  /** Store `value`, refreshing the row's position and evicting the oldest past the cap. */
  set(key: string, value: T): void;
  /** Drop a row. */
  delete(key: string): boolean;
}

/**
 * Build a {@link Table} capped at `maxEntries` rows.
 *
 * `onEvict` is what keeps the adapter's claim that every map is bounded true: the tables
 * themselves always were, but the SECONDARY indexes hanging off them (email → id, token
 * hash → id, password hashes, TOTP factors) were plain `Map`s that only ever grew. The
 * hook lets each table clear its own satellites as a row leaves.
 *
 * @param maxEntries The row cap.
 * @param onEvict Called with each row dropped to stay under the cap.
 * @returns The table.
 */
function table<T>(maxEntries: number, onEvict?: (key: string, value: T) => void): Table<T> {
  const rows = new Map<string, T>();
  return {
    rows,
    get: (key) => rows.get(key),
    delete: (key) => rows.delete(key),
    set(key, value) {
      rows.delete(key); // re-insert so a rewritten row is the youngest, never the next evicted
      rows.set(key, value);
      while (rows.size > maxEntries) {
        const oldest = rows.keys().next().value as string;
        const evicted = rows.get(oldest) as T;
        rows.delete(oldest);
        onEvict?.(oldest, evicted);
      }
    },
  };
}

/** Everything one adapter instance owns. */
interface MemoryState {
  /** Users by id. */
  users: Table<AdapterUser>;
  /** Normalised email → user id (cleared when its user is evicted; verified on read). */
  emails: Map<string, string>;
  /** Linked accounts by `provider\0providerAccountId` (bounded; verified on read). */
  accounts: Table<AdapterAccount>;
  /** Verification tokens by `purpose\0identifier\0tokenHash`. */
  tokens: Table<VerificationTokenRecord>;
  /** Password hashes by user id. */
  credentials: Map<string, string>;
  /** API tokens by token id. */
  apiTokens: Table<ApiTokenRecord>;
  /** Token hash → token id (cleared when its token is evicted; verified on read). */
  apiTokenHashes: Map<string, string>;
  /** TOTP factors by user id. */
  mfa: Map<string, MfaRecord>;
  /** The store `sessions` exposes. */
  sessions: SessionStore;
  /** Epoch seconds. */
  now: () => number;
  /** Serialise an async critical section per key. */
  lock<T>(key: string, run: () => Promise<T>): Promise<T>;
}

/** Allocate the tables, the clock and the per-key lock for one adapter. */
function createState(options: InMemoryAuthAdapterOptions): MemoryState {
  const max = options.maxUsers ?? DEFAULT_MAX_ENTRIES;
  const locks = new Map<string, Promise<unknown>>();
  const state: MemoryState = {
    // The two eviction hooks are what bound the secondary indexes; both only ever run
    // later, so referring to `state` from inside them is safe.
    users: table<AdapterUser>(max, (id, user) => forgetUser(state, id, user)),
    emails: new Map(),
    accounts: table<AdapterAccount>(max),
    tokens: table<VerificationTokenRecord>(max),
    credentials: new Map(),
    apiTokens: table<ApiTokenRecord>(max, (_id, token) => {
      state.apiTokenHashes.delete(token.tokenHash);
    }),
    apiTokenHashes: new Map(),
    mfa: new Map(),
    sessions: inMemorySessionStore(),
    now: options.now ?? (() => Math.floor(Date.now() / 1000)),
    lock<T>(key: string, run: () => Promise<T>): Promise<T> {
      // Chain onto whatever is already queued for this key (settled either way), so two
      // concurrent redemptions of one backup code can never interleave.
      const next = (locks.get(key) ?? Promise.resolve()).then(run, run);
      locks.set(key, next.then(() => {}, () => {}));
      return next;
    },
  };
  return state;
}

/**
 * Everything keyed by a user id that must go when that user's row is evicted: its email
 * index entry, its password hash and its TOTP factor. Linked accounts are a bounded table
 * of their own and heal on read (see {@link userMethods}), so they are not scanned here —
 * eviction stays O(1).
 */
function forgetUser(state: MemoryState, id: string, user: AdapterUser): void {
  if (user.email) {
    const key = emailKey(user.email);
    if (state.emails.get(key) === id) state.emails.delete(key);
  }
  state.credentials.delete(id);
  state.mfa.delete(id);
}

/**
 * Reads hand back a shallow copy, so a caller can never mutate the store by writing to a
 * record it was given — a database-backed adapter can't be mutated that way either, and
 * the shared contract suite has to mean the same thing for both.
 */
function copy<T extends object>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : { ...value };
}

/** The key one linked provider account lives under. */
function accountKey(ref: AdapterAccountRef): string {
  return `${ref.provider}${SEP}${ref.providerAccountId}`;
}

/** The key one verification token lives under (its uniqueness tuple). */
function tokenKey(ref: VerificationTokenRef): string {
  return `${ref.purpose}${SEP}${ref.identifier}${SEP}${ref.tokenHash}`;
}

/**
 * Store a user and keep the email index in step with its (possibly changed) address —
 * refusing an address that already belongs to somebody else.
 *
 * That refusal is not a nicety: the SQLite adapter enforces it with a unique index, and an
 * in-memory adapter that quietly let two users share an address would make the shared
 * contract suite mean two different things — and would make "sign in by email" ambiguous
 * in exactly the flow (account linking) whose whole job is to decide which identity an
 * address belongs to.
 */
function saveUser(state: MemoryState, user: AdapterUser): AdapterUser {
  const key = user.email ? emailKey(user.email) : undefined;
  if (key !== undefined) assertEmailFree(state, key, user.id);
  const previous = state.users.get(user.id);
  if (previous?.email) state.emails.delete(emailKey(previous.email));
  state.users.set(user.id, { ...user });
  if (key !== undefined) state.emails.set(key, user.id);
  return { ...user };
}

/** Throw when `key` is already indexed to a LIVE user other than `userId`. */
function assertEmailFree(state: MemoryState, key: string, userId: string): void {
  const owner = state.emails.get(key);
  if (owner === undefined || owner === userId) return;
  if (!state.users.get(owner)) {
    state.emails.delete(key); // the indexed user was evicted — the address is free again
    return;
  }
  throw new Error(
    `inMemoryAuthAdapter: that email address already belongs to user ${JSON.stringify(owner)} ` +
      "— one account per address (sqliteAuthAdapter's unique index refuses it too).",
  );
}

/** Resolve the email index, healing an entry whose user was evicted. */
function userByEmail(state: MemoryState, email: string): AdapterUser | undefined {
  const key = emailKey(email);
  const id = state.emails.get(key);
  if (id === undefined) return undefined;
  const user = state.users.get(id);
  if (!user) state.emails.delete(key);
  return user;
}

/** The five required user methods. */
function userMethods(
  state: MemoryState,
): Pick<
  AuthAdapter,
  "createUser" | "getUser" | "getUserByEmail" | "getUserByAccount" | "updateUser"
> {
  return {
    createUser(user) {
      const { id, ...rest } = user;
      return saveUser(state, { ...rest, id: id ?? crypto.randomUUID() });
    },
    getUser: (id) => copy(state.users.get(id)),
    getUserByEmail: (email) => copy(userByEmail(state, email)),
    getUserByAccount(ref) {
      const key = accountKey(ref);
      const userId = state.accounts.get(key)?.userId;
      if (userId === undefined) return undefined;
      const user = state.users.get(userId);
      if (!user) state.accounts.delete(key); // its user was evicted: heal the dangling row
      return copy(user);
    },
    updateUser(patch) {
      const current = state.users.get(patch.id);
      if (!current) {
        throw new Error(`inMemoryAuthAdapter: no user with id ${JSON.stringify(patch.id)}`);
      }
      const next = { ...current };
      // An absent field means "unchanged", so `undefined` never clears a stored value.
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) Reflect.set(next, key, value);
      }
      return saveUser(state, next);
    },
  };
}

/** Link / unlink / list provider accounts. */
function accountMethods(
  state: MemoryState,
): Pick<AuthAdapter, "linkAccount" | "unlinkAccount" | "listAccounts"> {
  return {
    linkAccount(account) {
      state.accounts.set(accountKey(account), { ...account });
    },
    unlinkAccount(ref) {
      state.accounts.delete(accountKey(ref));
    },
    listAccounts: (userId) =>
      [...state.accounts.rows.values()]
        .filter((account) => account.userId === userId)
        .map((account) => ({ ...account })),
  };
}

/** Issue and redeem single-use verification tokens. */
function verificationMethods(
  state: MemoryState,
): Pick<AuthAdapter, "createVerificationToken" | "useVerificationToken"> {
  return {
    createVerificationToken(token) {
      state.tokens.set(tokenKey(token), { ...token });
    },
    useVerificationToken(ref) {
      const key = tokenKey(ref);
      const record = state.tokens.get(key);
      if (!record) return undefined;
      // Consume first, answer second: an expired token is spent too (it is never worth
      // retrying), but it never resolves — a stale link fails closed.
      state.tokens.delete(key);
      return record.expires <= state.now() ? undefined : record;
    },
  };
}

/** Password-hash storage for the Credentials provider. */
function credentialMethods(
  state: MemoryState,
): Pick<AuthAdapter, "getCredential" | "setCredential" | "deleteCredential"> {
  return {
    getCredential: (userId) => state.credentials.get(userId),
    setCredential(userId, hash) {
      state.credentials.set(userId, hash);
    },
    deleteCredential(userId) {
      state.credentials.delete(userId);
    },
  };
}

/** Whether a bearer token may still authenticate (neither revoked nor expired). */
function tokenLive(state: MemoryState, token: ApiTokenRecord): boolean {
  if (token.revokedAt !== undefined) return false;
  return token.expiresAt === undefined || token.expiresAt > state.now();
}

/** The bearer API-token group. Revoked and expired tokens are invisible to every read. */
function apiTokenMethods(
  state: MemoryState,
): Pick<
  AuthAdapter,
  "createApiToken" | "getApiTokenByHash" | "touchApiToken" | "revokeApiToken" | "listApiTokens"
> {
  return {
    createApiToken(token) {
      state.apiTokens.set(token.id, { ...token });
      state.apiTokenHashes.set(token.tokenHash, token.id);
    },
    getApiTokenByHash(tokenHash) {
      const id = state.apiTokenHashes.get(tokenHash);
      if (id === undefined) return undefined;
      const token = state.apiTokens.get(id);
      if (!token) {
        state.apiTokenHashes.delete(tokenHash);
        return undefined;
      }
      return tokenLive(state, token) ? copy(token) : undefined;
    },
    touchApiToken(id, lastUsedAt) {
      const token = state.apiTokens.get(id);
      if (token) token.lastUsedAt = lastUsedAt;
    },
    revokeApiToken(id) {
      const token = state.apiTokens.get(id);
      if (!token) return;
      token.revokedAt = state.now();
      state.apiTokenHashes.delete(token.tokenHash);
    },
    listApiTokens: (userId) =>
      [...state.apiTokens.rows.values()]
        .filter((token) => token.userId === userId && tokenLive(state, token))
        .map((token) => ({ ...token })),
  };
}

/** The TOTP factor group, including the two consume-once guards. */
function mfaMethods(
  state: MemoryState,
): Pick<AuthAdapter, "getMfa" | "setMfa" | "deleteMfa" | "consumeBackupCode" | "claimTotpStep"> {
  return {
    deleteMfa(userId) {
      state.mfa.delete(userId);
    },
    getMfa(userId) {
      const record = state.mfa.get(userId);
      return record && { ...record, backupCodeHashes: [...record.backupCodeHashes] };
    },
    setMfa(record) {
      state.mfa.set(record.userId, { ...record, backupCodeHashes: [...record.backupCodeHashes] });
    },
    consumeBackupCode: (userId, matches) =>
      state.lock(`mfa:${userId}`, async () => {
        const record = state.mfa.get(userId);
        if (!record) return false;
        for (const [index, hash] of record.backupCodeHashes.entries()) {
          if (!await matches(hash)) continue;
          record.backupCodeHashes.splice(index, 1);
          return true;
        }
        return false;
      }),
    claimTotpStep(userId, step) {
      const record = state.mfa.get(userId);
      if (!record) return false;
      // Strictly monotonic: the step a code verified against is spent, and so is every
      // older one — replaying a still-valid code inside its window can't succeed twice.
      if (record.lastStep !== undefined && step <= record.lastStep) return false;
      record.lastStep = step;
      return true;
    },
  };
}

/** Drop every row and release the session store (idempotent). */
function closeState(state: MemoryState): void {
  state.users.rows.clear();
  state.emails.clear();
  state.accounts.rows.clear();
  state.tokens.rows.clear();
  state.credentials.clear();
  state.apiTokens.rows.clear();
  state.apiTokenHashes.clear();
  state.mfa.clear();
  state.sessions.close?.();
}

/**
 * Build a per-process, in-memory {@link ./adapter.ts | AuthAdapter}: every method group
 * (users, accounts, verification tokens, credentials, API tokens, MFA) plus a
 * `sessions` store and `close()`. Ids are `crypto.randomUUID()` unless the caller
 * supplies one; emails are matched case-insensitively and whitespace-trimmed.
 *
 * Nothing persists across a restart and nothing is shared between replicas — use it for
 * development, tests and single-process demos, and
 * {@link ./sqlite-adapter.ts | sqliteAuthAdapter} for anything real.
 *
 * @param options Row cap and clock override.
 * @returns The adapter, ready to pass as `denextAuth({ adapter })`.
 */
export function inMemoryAuthAdapter(options: InMemoryAuthAdapterOptions = {}): AuthAdapter {
  const state = createState(options);
  return {
    ...userMethods(state),
    ...accountMethods(state),
    ...verificationMethods(state),
    ...credentialMethods(state),
    ...apiTokenMethods(state),
    ...mfaMethods(state),
    sessions: state.sessions,
    close: () => closeState(state),
  };
}
