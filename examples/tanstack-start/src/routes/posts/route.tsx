import { createFileRoute, Outlet } from "@tanstack/react-router";

// A layout route: /posts and /posts/$postId render inside it.
export const Route = createFileRoute("/posts")({
  component: () => (
    <div id="posts-layout">
      <p className="crumb">Posts section</p>
      <Outlet />
    </div>
  ),
});
