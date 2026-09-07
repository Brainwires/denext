import { messages } from "./graphql/channels.ts";
import { history } from "./graphql/store.ts";
import { Room } from "./room.tsx";

export default function Page() {
  return (
    <main>
      <h1>GraphQL on denext</h1>
      <p>
        <code>@denext/graphql</code> mounts GraphQL Yoga at <a href="/graphql">/graphql</a>{" "}
        (GraphiQL in dev). The schema is Pothos; the <code>messages</code>{" "}
        subscription rides a denext channel, so a mutation reaches GraphQL subscribers over SSE and
        this page's <code>useChannel</code> over the Live socket — one publish, two protocols.
      </p>
      <pre>{`curl -s localhost:8000/graphql -H 'content-type: application/json' \\
  -d '{"query":"mutation { post(room: \\"lobby\\", text: \\"hello\\") { text } }"}'`}</pre>
      <Room channel={messages} initial={history("lobby")} />
    </main>
  );
}
