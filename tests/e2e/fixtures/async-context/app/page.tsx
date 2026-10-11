// A Server Component rendering one client island, whose module is instrumented (it awaits).
import { Loader } from "./loader.tsx";
import { serverLabel } from "./server-data.ts";

export default async function Page() {
  return (
    <main>
      <h1>async context</h1>
      <p id="server-data">{await serverLabel()}</p>
      <Loader />
    </main>
  );
}
