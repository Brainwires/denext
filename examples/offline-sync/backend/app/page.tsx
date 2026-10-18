// The backend serves the API only; the app is the SPA one folder up (and its Capacitor shell).
export default function Home() {
  return (
    <main>
      <h1>offline-sync backend</h1>
      <p>
        <code>POST /api/data</code> applies uploads; <code>GET /api/changes?since=N</code>{" "}
        lists what changed.
      </p>
    </main>
  );
}
