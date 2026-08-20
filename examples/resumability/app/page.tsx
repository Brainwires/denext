import { useRef } from "denext";
import { Counter } from "./counter.tsx";
import { Clock } from "./clock.tsx";

// This one export flips the whole route into resumable rendering: interactive with no
// up-front hydration, every island resumed on demand.
export const resumable = true;

export default function Home() {
  // This page is a Server Component — it renders once, on the server, and is NEVER
  // shipped to or run on the client. So this count is permanently 1: the shell does
  // zero client work no matter how much you interact below.
  const renders = useRef(0);
  renders.current++;

  return (
    <section>
      <div class="pagestat">
        page shell renders (server-only): <strong>{renders.current}</strong>
      </div>
      <h1>Resumable by default</h1>
      <p class="lead">
        This page ships its HTML and{" "}
        <strong>hydrates nothing on load</strong>. Open your DevTools console, then interact below —
        each island logs the moment it resumes, and only the island you touch wakes up.
      </p>

      <ol class="steps">
        <li>
          On load the console is <strong>silent</strong>{" "}
          — no counter component has run. The page is already rendered and interactive.
        </li>
        <li>
          Click <strong>one</strong>{" "}
          counter. The count updates (the click is replayed to the now-live handler) and the console
          logs <em>that single island</em> resuming — the other counters never ran.
        </li>
        <li>
          The <strong>clock</strong>{" "}
          resumes on its own, on idle: it is interactive via an effect, so the framework wakes it
          without a click. Its time is a <code>useSignal</code>, adopted from the server render.
        </li>
      </ol>
      <p class="lead">
        The components render <strong>identically</strong>{" "}
        on the server and client — resumption is invisible, so there is no hydration mismatch. The
        console and the working buttons are the proof.
      </p>

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
