// A Server Component host with raw HTML, beside a client island.
import { Counter } from "./counter.tsx";
import { RAW } from "./raw.ts";

export default function Page() {
  return (
    <div>
      <div id="raw" dangerouslySetInnerHTML={{ __html: RAW }} />
      <Counter />
    </div>
  );
}
