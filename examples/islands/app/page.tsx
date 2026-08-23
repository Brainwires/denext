import { Widget } from "./widget.tsx";

// This page is a Server Component. Each <Widget> is a "use client" island carved out
// with a directive, so the route renders on the Flight path and each island hydrates
// on its own schedule instead of all-at-once. The page shell itself never runs on the
// client.
export default function Home() {
  return (
    <section>
      <h1>Island hydration directives</h1>
      <p class="lead">
        Every card below is the same client component, carved out with a different{" "}
        <code>client:*</code> directive. Open the console and watch each island log{" "}
        <em>the moment it hydrates</em>{" "}
        — on load, on idle, when scrolled into view, on first interaction, when a media query
        matches, or (for{" "}
        <code>client:only</code>) as a client-only mount with no server HTML at all.
      </p>

      <div class="grid">
        <Widget label="load" client:load />
        <Widget label="idle" client:idle />
        <Widget label="interaction" client:interaction />
        <Widget label="media" client:media="(min-width: 600px)" />
        <Widget label="only" client:only />
      </div>

      <div class="spacer">
        <p class="hint">
          ↓ scroll down — the <code>client:visible</code>{" "}
          island below is inert until it enters the viewport ↓
        </p>
      </div>

      <div class="grid">
        <Widget label="visible" client:visible />
      </div>

      <p class="foot-note">
        The <code>client:only</code> card has <strong>no server HTML</strong>{" "}
        — it appears only after its client-only mount, so it trades first paint (and SEO for that
        subtree) for a never-runs-on-the-server guarantee.
      </p>
    </section>
  );
}
