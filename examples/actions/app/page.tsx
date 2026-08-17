// A Server Component page: it reads the guestbook on the server and renders it,
// plus two ways to post a Server Action.
//   1. A native <form action={submitEntry}> — works with NO client JavaScript.
//      denext renders the action's secure endpoint URL into the form markup.
//   2. <LiveForm> — a "use client" island layering useActionState / useOptimistic
//      / useFormStatus over the same action for an instant, no-reload experience.

import { getEntries, submitEntry } from "./actions.ts";
import LiveForm from "./live-form.tsx";

export default function Guestbook() {
  const entries = getEntries();
  return (
    <section>
      <h1>Server Actions — a guestbook</h1>
      <p class="lede">
        The form below posts a <code>"use server"</code>{" "}
        function. It works with JavaScript disabled (progressive enhancement) and is protected by a
        same-origin check.
      </p>

      <form action={submitEntry} class="native">
        <div class="fields">
          <input
            name="name"
            placeholder="Your name"
            aria-label="Your name"
            required
          />
          <input
            name="message"
            placeholder="A short message"
            aria-label="Message"
            required
          />
        </div>
        <button type="submit">Sign (no-JS)</button>
      </form>

      <h2>Enhanced with the React 19 form hooks</h2>
      <LiveForm initialEntries={entries} />
    </section>
  );
}
