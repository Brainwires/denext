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
    </DocsShell>
  );
}
