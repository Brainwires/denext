import { Link, Outlet } from "@remix-run/react";

export default function ConcertsLayout() {
  return (
    <div>
      <nav>
        <Link to="/concerts/trending">Trending</Link>
      </nav>
      <Outlet />
    </div>
  );
}
