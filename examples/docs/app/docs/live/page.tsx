import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Live Server Components",
  description:
    "Push server-rendered updates to a subtree over a WebSocket when a cache tag is invalidated — no polling, no client data fetching.",
};

export default function LiveComponents() {
  return (
    <DocsShell
      active="live"
      title="Live Server Components"
      lead="Wrap a server-rendered subtree in <Live>. When one of its cache tags is invalidated — from anywhere — the server re-renders just that boundary and pushes it over a WebSocket, reconciled in place. No polling, no client-side data fetching, and Next.js has no equivalent."
    >
      <h2>The idea</h2>
      <p>
        A normal Server Component renders once, on request. <code>{"<Live>"}</code>{" "}
        keeps a subtree connected: it declares the cache <code>tags</code>{" "}
        it depends on, and whenever any of those tags is invalidated with{" "}
        <code>revalidateTag</code>/<code>updateTag</code>{" "}
        — from a Server Action, a webhook, a cron job, another user's request — the server
        re-renders{" "}
        <em>that boundary</em>, under the viewer's own session, and pushes the new HTML tree to
        every connected client. The client reconciles it in place: inputs keep focus, scroll
        position holds, sibling component state is untouched. There is no navigation and no
        client-side fetch.
      </p>

      <Callout kind="note">
        <code>{"<Live>"}</code> is imported from a dedicated entrypoint,{" "}
        <code>@denext/denext/live</code>, so an app that never uses it bundles none of the real-time
        transport. It needs a route that renders through the Flight (RSC) boundary.
      </Callout>

      <h2>Usage</h2>
      <p>
        Wrap the subtree and list the tags it reads. Everything inside should derive its output from
        that tagged, cached data.
      </p>
      <Code lang="tsx">
        {`import { Live } from "@denext/denext/live";
import { cacheTag, unstable_cache } from "@denext/denext/server";

const getOrders = unstable_cache(
  async () => db.orders.recent(),
  ["orders"],
  { tags: ["orders"] },
);

export default async function Dashboard() {
  return (
    <main>
      <h1>Orders</h1>
      <Live tags={["orders"]}>
        <OrderList orders={await getOrders()} />
      </Live>
    </main>
  );
}`}
      </Code>
      <p>
        Now any code that runs <code>revalidateTag("orders")</code>{" "}
        — most often a Server Action that just wrote an order — updates the list on every open
        dashboard, live:
      </p>
      <Code lang="tsx">
        {`"use server";
import { revalidateTag } from "@denext/denext/server";

export async function placeOrder(form: FormData) {
  await db.orders.insert(form);
  revalidateTag("orders"); // every <Live tags={["orders"]}> refreshes
}`}
      </Code>

      <h2>The subtree must be self-contained</h2>
      <p>
        A push re-renders the boundary as a fresh request, so its output must depend only on things
        a fresh request can see: its <code>tags</code>-keyed cached data, <code>params</code>,{" "}
        <code>cookies()</code>/<code>headers()</code>, and the cache. Don't read a mutable variable
        captured from an outer closure — it won't be there on the re-render.
      </p>

      <h2>How it holds up</h2>
      <ul>
        <li>
          <strong>Per-viewer.</strong>{" "}
          Each connection re-renders under its own cookies, so two users watching the same page see
          their own authorized content — never each other's.
        </li>
        <li>
          <strong>Safe fallback.</strong>{" "}
          If a boundary can't be located on re-render (the route changed, or a session expired), the
          client falls back to refreshing the current route rather than showing stale content. With
          no client runtime — SSR, or a crawler — <code>{"<Live>"}</code>{" "}
          simply renders its children.
        </li>
        <li>
          <strong>Cheap when idle.</strong> The WebSocket opens only once a <code>{"<Live>"}</code>
          {" "}
          boundary mounts and closes when the last one unmounts. Invalidation bursts are coalesced,
          and a disconnected client reconnects with backoff and catches up on what it missed.
        </li>
      </ul>

      <Callout kind="note">
        Same-origin only: the WebSocket handshake is rejected cross-origin, and — because every push
        is produced by re-rendering under the connection's own cookies — a client can never use a
        tag name to read content it isn't authorized to see.
      </Callout>

      <h2>Live data — useLive</h2>
      <p>
        Where <code>{"<Live>"}</code> keeps a server-rendered subtree live, <code>useLive</code>
        {" "}
        keeps a piece of <em>data</em>{" "}
        live in a client component. Pair a server function (a Server Action, used as a query) with
        the cache tags it depends on; when any of them is invalidated, the server re-runs the
        function <strong>under the viewer's own session</strong>{" "}
        and pushes the result over the same socket — no polling, no client fetch library.
      </p>
      <Code lang="tsx">
        {`"use client";
import { useLive } from "@denext/denext/live";
import { recentOrders } from "./actions.ts"; // a serverAction, used as a query

export function Orders({ initial }: { initial: Order[] }) {
  const orders = useLive(recentOrders, [], { tags: ["orders"], initial });
  return <ul>{orders?.map((o) => <li key={o.id}>{o.total}</li>)}</ul>;
}`}
      </Code>
      <p>
        Any code that runs <code>revalidateTag("orders")</code>{" "}
        — a form submit, a webhook, a cron — updates every subscribed client. Pass a <em>read</em>
        {" "}
        action, and (as always) have it authorize its own access.
      </p>

      <h2>Presence — usePresence</h2>
      <p>
        <code>usePresence</code>{" "}
        gives who's-online, cursors, and typing indicators over the same socket — orthogonal to
        cache tags. Join a room, publish your state, and receive everyone else's.
      </p>
      <Code lang="tsx">
        {`"use client";
import { usePresence } from "@denext/denext/live";

export function Cursors({ docId }: { docId: string }) {
  const { others, setState } = usePresence<{ x: number; y: number }>(docId, {
    initialState: { x: 0, y: 0 },
  });
  return (
    <div onPointerMove={(e) => setState({ x: e.clientX, y: e.clientY })}>
      {others.map((p) => <Cursor key={p.id} at={p.state} />)}
    </div>
  );
}`}
      </Code>
      <p>
        You get <code>{"{ self, others, peers, setState }"}</code>. For optimistic mutations,{" "}
        <code>useLiveOptimistic(value, reducer)</code>{" "}
        shows a local update immediately and reconciles it when the authoritative value arrives over
        the socket.
      </p>

      <Callout kind="note">
        A Convex / Liveblocks / PartyKit-class real-time layer with zero npm and zero extra infra —
        the socket is shared with <code>{"<Live>"}</code> and only opens once a live feature mounts.
      </Callout>

      <h2>Securing presence &amp; live data</h2>
      <p>
        Presence rooms and <code>useLive</code>{" "}
        subscriptions share one socket, so the server decides who may join a room and which actions
        may be read. In production they are{" "}
        <strong>default-deny</strong>: without a policy the hub refuses joins and subscriptions, so
        one client cannot read another user&#39;s presence or run arbitrary registered actions.
        Declare a policy in <code>denext.config</code>:
      </p>
      <Code lang="ts">
        {`// denext.config.ts — experimental.live
export default {
  experimental: {
    live: {
      // Gate a presence-room join. Runs in the visitor's session, so getSession() works here.
      canJoinRoom: (ctx, room) => room === "doc:" + currentDocFor(ctx),
      // Gate which live-data subscriptions may run (which action + args).
      canSubscribe: (ctx, sub) => sub.actionId === "dashboard#stats",
      // Resource caps — all optional; safe defaults apply otherwise.
      limits: { maxRoomsPerConnection: 16, maxMessageBytes: 32 * 1024 },
    },
  },
};`}
      </Code>
      <p>
        Or, instead of a <code>canSubscribe</code>{" "}
        policy, mark individual read-only fetchers as readable over the live channel:
      </p>
      <Code lang="ts">
        {`import { liveReadable, serverAction } from "@denext/denext";

export const stats = liveReadable(
  serverAction("dashboard#stats", async () => ({ online: await countOnline() })),
);`}
      </Code>
      <Callout kind="note">
        Dev keeps presence and live data open (with a one-time warning) so the zero-config demo just
        runs. Set <code>experimental.live.allowAnonymous: true</code>{" "}
        to keep them open in production for genuinely public collaboration.
      </Callout>
    </DocsShell>
  );
}
