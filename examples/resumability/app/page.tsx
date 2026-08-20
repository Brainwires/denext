import { Counter } from "./counter.tsx";
import { Clock } from "./clock.tsx";

// This one export flips the whole route into resumable rendering: interactive with no
// up-front hydration, every island resumed on demand.
export const resumable = true;

export default function Home() {
  return (
    <section>
      <h1>Resumable by default</h1>
      <p class="lead">
        This page ships its HTML and{" "}
        <strong>hydrates nothing on load</strong>. Open your DevTools console, then interact below —
        each island logs the moment it resumes, and only the island you touch wakes up.
      </p>

      <ol class="steps">
        <li>
          On load the console is <strong>silent</strong> and every counter reads{" "}
          <em>dormant · server HTML</em> — no component has run.
        </li>
        <li>
          Click <strong>one</strong> counter. It flips to{" "}
          <em>resumed ✅</em>, the count updates (the click is replayed to the now-live handler),
          and the console logs that single island — the others stay dormant.
        </li>
        <li>
          The <strong>clock</strong>{" "}
          resumes on its own, on idle: it is interactive via an effect, so the framework wakes it
          without a click.
        </li>
      </ol>

      <div class="grid">
        <Counter id={1} />
        <Counter id={2} />
        <Counter id={3} />
        <Clock />
      </div>

      <p class="foot-note">
        Every counter is plain <code>useState</code> + <code>onClick</code> — no{" "}
        <code>qrl</code>, no <code>client:*</code>{" "}
        directive. The only change from a normal app is the one <code>resumable</code>{" "}
        export at the top of this file.
      </p>
    </section>
  );
}
