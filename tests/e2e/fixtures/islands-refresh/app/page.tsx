import { Bump } from "./bump.tsx";
import { Counter } from "./counter.tsx";
import { readHits } from "./store.ts";

export const dynamic = "force-dynamic";

export default function Home() {
  const hits = readHits();
  return (
    <section>
      <p data-testid="server" className={`hits-${hits}`}>server hits: {hits}</p>
      <Counter client:load />
      <Bump client:load />
      {hits > 0 ? <p data-testid="bumped">bumped</p> : null}
    </section>
  );
}
