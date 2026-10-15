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
        <code>denext/live</code>, so an app that never uses it bundles none of the real-time
        transport. It needs a route that renders through the Flight (RSC) boundary.
      </Callout>

      <h2>Usage</h2>
      <p>
        Wrap the subtree and list the tags it reads. Everything inside should derive its output from
        that tagged, cached data.
      </p>
      <Code lang="tsx">
        {`import { Live } from "denext/live";
import { unstable_cache } from "denext/server";

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
import { revalidateTag } from "denext/server";

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
import { useLive } from "denext/live";
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
import { usePresence } from "denext/live";

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
        may be read. They are <strong>default-deny</strong>{" "}
        — identically in dev and production — so one client cannot read another user&#39;s presence
        or run arbitrary registered actions. Only the framework can&#39;t know your authorization
        rules, so you declare them once in <code>denext.config</code>{" "}
        (use a gated hook with no policy and you get a clear, actionable error the first time you
        run it locally — never a feature that works in dev and silently breaks in production):
      </p>
      <Code lang="ts">
        {`// denext.config.ts — the top-level \`live\` policy
export default {
  live: {
    // Gate a presence-room join. Runs in the visitor's session, so getSession() works here.
    canJoinRoom: (ctx, room) => room === "doc:" + currentDocFor(ctx),
    // Gate which live-data subscriptions may run (which action + args).
    canSubscribe: (ctx, sub) => sub.actionId === "dashboard#stats",
    // Resource caps — all optional; safe defaults apply otherwise.
    // renderTimeoutSeconds bounds a single re-render/fetcher (default 30, on by default).
    limits: { maxRoomsPerConnection: 16, renderTimeoutSeconds: 20 },
  },
};`}
      </Code>
      <Callout kind="note">
        A <code>&lt;Live&gt;</code> re-render or <code>useLive</code> fetcher holds one of the{" "}
        <code>maxConcurrentRenders</code>{" "}
        slots (default 40) for its whole run, so a hung fetcher would pin its slot. The{" "}
        <code>renderTimeoutSeconds</code>{" "}
        deadline (default 30, on by default) aborts an over-running render — a cooperative{" "}
        <code>AbortSignal</code> reaches the fetcher&#39;s{" "}
        <code>fetch</code>/cache reads — and releases the slot, so one slow fetcher can never stall
        the fleet.
      </Callout>
      <p>
        Every hook above — and a channel&#39;s{" "}
        <code>authorize</code>, a subscription&#39;s resolver, a <code>useLive</code> fetcher and a
        {" "}
        <code>{"<Live>"}</code> re-render — runs with the connection&#39;s client address, so{" "}
        <code>clientIp()</code>{" "}
        answers there what it answered in the upgrade request: the socket peer, or the trusted
        proxy&#39;s last <code>x-forwarded-for</code> hop under <code>trustForwardedHeaders</code>.
        {" "}
        <code>limits.maxConnectionsPerIp</code>{" "}
        (default 64; an IPv6 address counts as its /64) refuses a handshake from an address that
        already holds that many sockets with 429. A connection from a loopback, private, link-local
        or unique-local socket peer is not counted per address (only against{" "}
        <code>maxConnections</code>) unless the proxy is trusted: behind a reverse proxy every
        visitor arrives from the proxy&#39;s address, so the cap would be site-wide. The server
        warns once when that happens — set <code>trustForwardedHeaders</code> (or{" "}
        <code>DENEXT_TRUST_PROXY=1</code>) behind a proxy to cap each visitor&#39;s own address,
        name the header it sets to the client address in <code>rateLimitHeader</code>{" "}
        (<code>cf-connecting-ip</code>), or set <code>rateLimitLocalAddresses: true</code>{" "}
        to cap such a peer by its own address.
      </p>
      <p>
        Or, instead of a <code>canSubscribe</code>{" "}
        policy, mark individual read-only fetchers as readable over the live channel:
      </p>
      <Code lang="ts">
        {`import { liveReadable, serverAction } from "denext";

export const stats = liveReadable(
  serverAction("dashboard#stats", async () => ({ online: await countOnline() })),
);`}
      </Code>
      <Callout kind="note">
        For genuinely public collaboration (no per-user rules), set{" "}
        <code>live.allowAnonymous: true</code>{" "}
        — one explicit line that opts presence rooms open to any same-origin client (there is no
        silent dev-only allowance). It does <em>not</em> open arbitrary data: a <code>useLive</code>
        {" "}
        subscription still requires its action to be <code>liveReadable</code> (or a{" "}
        <code>canSubscribe</code>{" "}
        hook), so enabling anonymous presence never exposes an unmarked or mutating action over the
        socket.
      </Callout>
      <h2>Typed subscriptions — useSubscription</h2>
      <p>
        <code>useLive</code> runs a registered action with the client's raw <code>args</code>{" "}
        and trusts the client's <code>tags</code>. <code>defineSubscription</code> (from{" "}
        <code>denext/server</code>) is the validated form: the input is checked by a Standard Schema
        on every subscribe (rejected → a structured <code>invalid-input</code>{" "}
        with field errors; the resolver never runs), the tags are derived on the server from the
        parsed input, and an optional row-level <code>authorize</code>{" "}
        re-runs on every recompute. Registering a definition is the live opt-in.
      </p>
      <Code lang="ts">
        {`"use server";
import { defineSubscription } from "denext/server";
export const orderStatus = defineSubscription({
  input: z.object({ id: z.string() }),
  tags: ({ id }) => [\`order:\${id}\`],
  authorize: async ({ id }) => (await auth())?.user.id === (await db.orders.owner(id)),
  resolve: ({ id }) => db.orders.status(id),
});

// client
import { useSubscription } from "denext/live";
const { data, error, status } = useSubscription(orderStatus, { id }, { initial });`}
      </Code>

      <h2>Server push — channels</h2>
      <p>
        Everything above is pull-recompute on a tag invalidation. <code>createChannel</code>{" "}
        is the push half: <code>publish(key, payload)</code>{" "}
        from anywhere on the server — an action, a webhook, a cron, <code>after()</code>{" "}
        — reaches every authorized <code>useChannel(ref, key)</code>{" "}
        subscriber over the same socket, no recompute.
      </p>
      <Code lang="ts">
        {`"use server";
import { createChannel } from "denext/server";
export const orderEvents = createChannel<{ status: string }>({
  schema: z.object({ status: z.string() }),                              // validated at the publisher
  authorize: async (_ctx, key) => key === \`user:\${(await auth())?.user.id}\`, // required
});
await orderEvents.publish(\`user:\${userId}\`, { status: "shipped" });

// client
import { useChannel } from "denext/live";
const { data: event } = useChannel(orderEvents, \`user:\${userId}\`);`}
      </Code>

      <p>
        A channel's message type can be a discriminated union; <code>useChannel</code>{" "}
        returns the latest message typed as that union, so <code>match</code> from{" "}
        <code>denext/result</code> handles every member and a missing one is a compile error (see
        {" "}
        <a href="/docs/errors-as-values#typed-channel-messages">Typed channel messages</a>).
      </p>

      <h2 id="restarts">Restarts and per-key publishers</h2>
      <p>
        Both halves can recover from a crash on their own, under the same backoff as{" "}
        <a href="/docs/services">supervised services</a>{" "}
        (default: 5 restarts a minute, 250 ms doubling to 10 s, 20% jitter):
      </p>
      <ul>
        <li>
          <code>defineSubscription({"{ …, restart: true }"})</code> restarts a recompute whose{" "}
          <code>resolve</code> threw, instead of leaving the subscription on a <code>failed</code>
          {" "}
          frame until its next invalidation. The socket stays open and the client keeps its last
          value; past <code>maxRestarts</code> within <code>period</code> (pass{" "}
          <code>{"{ maxRestarts, period, backoff }"}</code> instead of{" "}
          <code>true</code>) the client gets <code>failed</code>{" "}
          as before. A denied, not-found or redirecting resolver is never restarted. Off by default.
        </li>
        <li>
          <code>createChannel({"{ …, publisher }"})</code>{" "}
          runs a producer for each active key: started when the key gets its first subscriber on
          this instance, its <code>signal</code>{" "}
          aborted when the last one leaves. A throw restarts it (<code>publisherRestart</code>{" "}
          takes the same options); the subscribers stay connected throughout.
        </li>
      </ul>
      <Code lang="ts">
        {`export const prices = createChannel<{ price: number }>({
  authorize: () => true,
  publisher: async ({ key, signal, publish }) => {
    for await (const tick of upstreamFeed(key, { signal })) await publish({ price: tick.price });
  },
});`}
      </Code>

      <h2>Delivery semantics &amp; scaling</h2>
      <ul>
        <li>
          <strong>Authorization.</strong> A channel's <code>authorize</code>{" "}
          is required by construction and runs in the subscriber's session at subscribe time, then
          lazily on traffic once <code>live.limits.channelAuthTtlSeconds</code> (300) has passed;
          {" "}
          <code>channel.revoke(key)</code>{" "}
          ends access immediately, cluster-wide. An unknown channel id is <code>denied</code>.
        </li>
        <li>
          <strong>Delivery.</strong>{" "}
          At-most-once; latest-wins per subscription under back-pressure (the last held frame
          replays when the socket drains — no recompute) and within a 16 ms publisher burst; no
          replay on reconnect (compute a cold-start value during SSR and pass it as{" "}
          <code>initial</code>); <code>seq</code> orders frames from one instance only.
        </li>
        <li>
          <strong>Instances.</strong> Channel events, tag-driven pushes and <code>usePresence</code>
          {" "}
          rooms cross instances through a <code>ChannelTransport</code>:{" "}
          <code>redisChannelTransport()</code> (Redis pub/sub, any self-hosted fleet),{" "}
          <code>broadcastChannelTransport()</code>{" "}
          (Deno Deploy isolates, workers) or your own two-method transport via{" "}
          <code>setChannelTransport</code>. Each instance publishes its peers in a room and
          heartbeats them; a dead instance's peers drop out after about 35 seconds.
        </li>
        <li>
          <strong>Tag watches.</strong> <code>useApi({"{ tags }"})</code>{" "}
          refetches over HTTP when a tag is invalidated; the socket carries only tag names, gated by
          {" "}
          <code>live.canWatchTags</code> or <code>allowAnonymous</code>.
        </li>
      </ul>
    </DocsShell>
  );
}
