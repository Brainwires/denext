// The kitchen sink: a Server Component shell around the client component that runs the checks.
import { KitchenSink } from "./kitchen-sink.tsx";

export default function Home() {
  return (
    <section>
      <h1>denext desktop kitchen sink</h1>
      <p>
        Every shipped Deno Desktop capability, called from this page through the same APIs an app
        uses. <code>deno task test:window</code>{" "}
        packages the app, launches it and asserts every row.
      </p>
      <KitchenSink />
    </section>
  );
}
