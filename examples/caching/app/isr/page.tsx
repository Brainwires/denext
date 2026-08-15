// ISR (Incremental Static Regeneration) demo. `export const revalidate = N` opts
// the whole rendered page into the prod server's PageCache: the first request
// renders and stores the HTML, subsequent requests within N seconds are served
// the cached render (see the `x-denext-cache: HIT` response header), and after N
// seconds the next request serves the stale render while regenerating in the
// background (stale-while-revalidate). ISR is active in `deno task start` (prod);
// `deno task dev` always renders fresh.

export const revalidate = 5; // seconds

export default function IsrDemo() {
  return (
    <section>
      <h1>
        ISR — <code>export const revalidate = 5</code>
      </h1>
      <div class="stat big">
        <span class="label">Rendered at</span>
        <span class="value" data-rendered-at>{new Date().toISOString()}</span>
      </div>
      <p class="note">
        In production (<code>deno task start</code>) this timestamp holds for 5s per request window
        — reload quickly and it stays the same (a cache HIT), then updates in the background once
        the window lapses. Check the <code>x-denext-cache</code>{" "}
        response header (MISS → HIT → STALE).
      </p>
    </section>
  );
}
