import { Deny } from "./deny.tsx";
import { Vanish } from "./vanish.tsx";

export const dynamic = "force-dynamic";

// A page whose islands call Server Actions that throw `notFound()` / `forbidden()`: the client
// renders this segment's not-found.tsx / forbidden.tsx in place, under the root layout.
export default function Gone() {
  return (
    <section>
      <p data-testid="gone-page">still here</p>
      <Vanish client:load />
      <Deny client:load />
    </section>
  );
}
