import { Outlet } from "react-router";

// A pathless layout: it wraps `/teams` and `/teams/:id` without adding a URL segment.
export default function Shell() {
  return (
    <section>
      <nav id="shell">Teams</nav>
      <Outlet />
    </section>
  );
}
