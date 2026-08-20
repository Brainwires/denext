import { Link } from "denext";
import { Counter } from "../counter.tsx";

// A second resumable route, reached from the home page by a SOFT navigation. Its
// island must render its content and become interactive after the client-side nav —
// the Flight soft-nav path re-boots resumability for the new route.
export const resumable = true;

export default function Second() {
  return (
    <section>
      <h1>Second resumable route</h1>
      <p class="lead">
        You got here by a <strong>soft navigation</strong>{" "}
        (no full reload). The counter below is a fresh island on this route — it must show its
        content and work when you click it.
      </p>

      <div class="grid">
        <Counter id={10} />
      </div>

      <p class="foot-note">
        <Link href="/">← back to the home route</Link>
      </p>
    </section>
  );
}
