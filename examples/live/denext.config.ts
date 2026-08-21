import type { DenextConfig } from "denext/server";

export default {
  experimental: {
    // Live Server Components security policy. Presence rooms and `useLive` data
    // subscriptions are DEFAULT-DENY — identically in dev and production — so one
    // client cannot read another user's presence or run registered server actions
    // over the socket. Using a gated hook with no policy raises a clear, actionable
    // error the first time it runs (no dev-only allowance that would break in prod).
    // `allowAnonymous: true` is the one explicit line that opts into open access.
    live: {
      // Gate which presence rooms a connection may join. This hook runs inside the
      // visitor's own request context, so in a real app you would derive the allowed
      // room from the signed-in user — e.g.
      //   canJoinRoom: async (_ctx, room) => {
      //     const session = await getSession();
      //     return room === `doc:${session?.data.currentDocId}`;
      //   }
      canJoinRoom: (_ctx, room) => room === "lobby",
      // The live-data action (`getCount`) is opted in with `liveReadable(...)` in
      // app/live-actions.ts, so no `canSubscribe` policy is needed for it. If you prefer
      // to authorize dynamically instead of marking actions, use:
      //   canSubscribe: (_ctx, sub) => sub.actionId === "live-example#getCount",

      // Optional resource caps (safe defaults apply otherwise):
      // limits: { maxRoomsPerConnection: 8, maxMessageBytes: 32 * 1024 },
    },
  },
} satisfies DenextConfig;
