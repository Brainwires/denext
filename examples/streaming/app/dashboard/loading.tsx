// Route-level Suspense fallback (Next.js `loading.tsx`). Shown while the route's
// server work is in flight during a client navigation to /dashboard.

export default function Loading() {
  return (
    <section>
      <h1>Dashboard</h1>
      <div class="grid">
        <div class="widget skeleton">Loading…</div>
        <div class="widget skeleton">Loading…</div>
      </div>
    </section>
  );
}
