// The deferred (resumability) path: the client component hydrates as a `client:load` island.
import { RawClient } from "../client/raw-client.tsx";

export default function Page() {
  return <RawClient client:load />;
}
