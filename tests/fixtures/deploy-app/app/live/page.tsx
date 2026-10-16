// Forced per-request rendering.
export const dynamic = "force-dynamic";
export default function Live() {
  return <h1>{Date.now()}</h1>;
}
