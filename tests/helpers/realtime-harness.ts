// A Live channel hub driven directly (no socket) for `@denext/backend` realtime tests: the real
// `createChannelHub` over the real channel transport, with connections that carry a cookie (so
// the channel's `authorize` runs in that viewer's session, as over the socket) and record every
// frame sent to them. Shared by the fake-client unit tests and the real-Postgres integration
// tests.

import { type ChannelConn, createChannelHub } from "../../src/server/live-channels.ts";
import { watchChannelTransport } from "../../src/runtime/channel.ts";
import { createRequestContext, runWithContext } from "../../src/server/request-context.ts";
import { credentials } from "../../src/server/auth/providers.ts";
import { issueAuthSession } from "../../src/server/auth/session.ts";
import type { AuthConfig } from "../../src/server/auth/types.ts";
import {
  encodeSubscriptionKey,
  newNonce,
  parseFilter,
  REALTIME_CHANNEL_ID,
  type TableChange,
  type TableChangesFrame,
  type TableFilter,
} from "../../packages/backend/src/realtime-shared.ts";

const ORIGIN = "https://app.test";

/** The auth config both suites install with `denextAuth`. */
export const authConfig: AuthConfig = {
  secret: "realtime-secret-at-least-32-characters!",
  canonicalOrigin: ORIGIN,
  providers: [credentials({ authorize: () => null })],
};

/** A signed-in user's session cookie (`name=value`). */
export async function cookieFor(id: string, email = `${id.slice(-4)}@x.test`): Promise<string> {
  const issuing = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(issuing, () => issueAuthSession(authConfig, { id, email }, "credentials"));
  return issuing.outgoingHeaders.getSetCookie().find((c) => c.startsWith("__Host-denext_auth="))!
    .split(";")[0];
}

/** A test connection. */
export interface TestConn extends ChannelConn {
  /** The viewer's cookie (empty: signed out). */
  cookie: string;
  /** Every `channel` frame's value, in order. */
  frames: TableChangesFrame[];
  /** Every refusal / error code. */
  errors: string[];
  /** `channel-ready` acks. */
  readies: number;
}

/** The hub and its helpers. */
export interface Harness {
  /** Open a connection as the viewer with this cookie. */
  conn(cookie?: string): TestConn;
  /** Subscribe; resolves with the key and whether it was acknowledged. */
  subscribe(
    conn: TestConn,
    table: string,
    options?: { filter?: TableFilter; key?: string; subId?: string },
  ): Promise<{ key: string; ok: boolean }>;
  /** Unsubscribe one sub id. */
  unsubscribe(conn: TestConn, subId?: string): void;
  /** Close a connection (drops its subscriptions). */
  drop(conn: TestConn): void;
  /** Stop the hub. */
  dispose(): void;
}

let peers = 0;

/**
 * Build the harness.
 *
 * @returns The harness.
 */
export function realtimeHarness(): Harness {
  const hub = createChannelHub<TestConn>({
    limits: () => ({ maxChannelsPerConnection: 64, channelAuthTtlSeconds: 300 }),
    sendFrame: (conn, text) => {
      const msg = JSON.parse(text);
      if (msg.type === "channel") conn.frames.push(msg.value);
      if (msg.type === "channel-ready") conn.readies++;
    },
    sendError: (conn, code) => conn.errors.push(code),
    refuse: (conn, decision) => conn.errors.push(decision),
    withConnContext: (conn, fn) => {
      const headers: HeadersInit = conn.cookie ? { cookie: conn.cookie } : {};
      return Promise.resolve(
        runWithContext(createRequestContext(new Request(`${ORIGIN}/`, { headers })), fn),
      );
    },
    connContext: (conn) => ({ origin: ORIGIN, url: "", cookie: conn.cookie, peerId: conn.peerId }),
    isConnected: () => true,
    withRenderSlot: (fn) => fn(),
    backPressured: () => false,
    armRecover: () => {},
  });
  const { current, stop } = watchChannelTransport(() => {});
  const unsubscribe = current.subscribe((ev) => hub.deliver(ev));
  return {
    conn(cookie = "") {
      return {
        socket: {} as WebSocket,
        channelSubs: new Map(),
        peerId: `peer-${++peers}`,
        cookie,
        frames: [],
        errors: [],
        readies: 0,
      };
    },
    async subscribe(conn, table, options = {}) {
      const key = options.key ??
        encodeSubscriptionKey({ table, nonce: newNonce(), filter: parseFilter(options.filter) });
      const before = conn.readies;
      await hub.subscribe(conn, {
        subId: options.subId ?? "s1",
        channelId: REALTIME_CHANNEL_ID,
        key,
      });
      return { key, ok: conn.readies > before };
    },
    unsubscribe: (conn, subId = "s1") => hub.unsubscribe(conn, subId),
    drop: (conn) => hub.drop(conn),
    dispose() {
      unsubscribe();
      stop();
      hub.dispose();
    },
  };
}

/** Every change a connection has received, flattened. */
export function changesOf(conn: TestConn): TableChange[] {
  return conn.frames.flatMap((frame) => frame.changes ?? []);
}

/** Wait until `done()` (bounded), polling every 5 ms. */
export async function until(done: () => boolean, ms = 3_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let timers run for `ms`. */
export function settle(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
