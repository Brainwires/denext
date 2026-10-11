// A Server Component rendering one client island, whose module is instrumented (it awaits).
import { Loader } from "./loader.tsx";

export default function Page() {
  return (
    <main>
      <h1>async context</h1>
      <Loader />
    </main>
  );
}
