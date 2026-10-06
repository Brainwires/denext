// The kitchen sink: a Server Component shell around the client component that runs the checks.
import { KitchenSink } from "./kitchen-sink.tsx";

export default function Home() {
  return (
    <section>
      <h1 data-kitchen-page="home">denext desktop kitchen sink</h1>
      <p>
        Every shipped Deno Desktop capability, called from this page through the same APIs an app
        uses. <code>deno task test:window</code>{" "}
        packages the app, launches it and asserts every row. A plain link to a{" "}
        <a href="/second" id="kitchen-to-second">second page</a> is the navigation phase's.
      </p>
      <KitchenSink />
    </section>
  );
}
