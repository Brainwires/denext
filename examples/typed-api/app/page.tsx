import { addTodoForm } from "./actions.ts";
import { todoEvents } from "./channels.ts";
import { todoStats } from "./subscriptions.ts";
import { Todos } from "./todos.tsx";
import { LiveTodos } from "./live-todos.tsx";

// A Server Component. The subscription ref is also a one-shot callable, so the initial stats
// are computed here (validated + resolved) and hydrate the live island with no flash. The
// subscription and the channel are handed to the island as PROPS: a server ref crosses Flight
// as an opaque id (`{$:"a"}` / `{$:"ch"}`), exactly like a Server Action.
export default async function Home() {
  const initial = await todoStats({ filter: "all" });

  return (
    <section>
      <h1>Typed API, end to end</h1>
      <p class="lead">
        <code>defineApi</code> route handlers validated by Standard Schemas, called from{" "}
        <code>useApi</code> / <code>createApiClient</code>{" "}
        with types inferred from the routes themselves — plus a validated live query (<code>
          defineSubscription
        </code>) and a server-push channel (<code>createChannel</code>). No tRPC, no codegen client,
        zero npm.
      </p>

      <div class="grid">
        <section class="card">
          <h2>Todos (typed client + batching)</h2>
          <Todos />
        </section>

        <section class="card">
          <h2>Live stats &amp; events</h2>
          <LiveTodos initial={initial} stats={todoStats} events={todoEvents} />
        </section>
      </div>

      <section class="card">
        <h2>No-JS path (typed Server Action)</h2>
        <form action={addTodoForm} class="add">
          <input name="title" placeholder="Add without JavaScript" />
          <button type="submit">Add</button>
        </form>
      </section>

      <p class="foot-note">
        Open a second tab: adding or toggling here updates the list (tag refetch), the counts
        (validated subscription) and the event toast (channel push) there — all over one socket.
      </p>
    </section>
  );
}
